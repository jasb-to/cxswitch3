// app/api/signals/route.ts — v28 FIXED "Pure Reader API"
// ============================================================
// PRINCIPLE: This route ONLY reads from KV. It NEVER recalculates.
// The cron job is the single source of truth.
// ============================================================

import { NextResponse } from "next/server";
import { getSignals, getSignalHistory, getMarketData } from "@/lib/state";
import { getCurrentPrice } from "@/lib/kraken";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

const TRACKED_PAIRS = ["BTC", "ETH", "SOL", "HYPE"] as const;
const TTL_MINUTES = 12 * 60;

export async function GET() {
  // ── 1. READ PERSISTED STATE FROM KV (single source of truth) ──
  const signals = await getSignals();
  const history = await getSignalHistory();
  const marketSnapshots = await getMarketData(); // NEW: reads KV written by cron

  // ── 2. LIGHTWEIGHT PRICE FETCH FOR STATUS/PnL ONLY ──
  // We fetch current price only to determine if TP/SL hit since last cron run.
  // All indicator values come from KV, never recalculated.
  const currentPrices: Record<string, number> = {};
  for (const pair of TRACKED_PAIRS) {
    try {
      const price = await getCurrentPrice(pair);
      if (price > 0) currentPrices[pair] = price;
    } catch (e) {
      console.error(`[SIGNALS ROUTE] Price fetch failed for ${pair}:`, e);
    }
  }

  // ── 3. ENRICH SIGNALS (status, PnL, TTL — derived from price, not recalculated) ──
  const enriched = (Array.isArray(signals) ? signals : []).map((s: any) => {
    const price = currentPrices[s.pair] ?? s.entry;
    const ageMin = Math.floor((Date.now() - s.timestamp) / 60000);
    let status = "ACTIVE";
    let pnl = 0;

    if (s.direction === "LONG") {
      if (price >= s.target) status = "TP_HIT";
      else if (price <= s.stop) status = "SL_HIT";
      else pnl = ((price - s.entry) / s.entry) * 100;
    } else {
      if (price <= s.target) status = "TP_HIT";
      else if (price >= s.stop) status = "SL_HIT";
      else pnl = ((s.entry - price) / s.entry) * 100;
    }

    if (ageMin > TTL_MINUTES && status === "ACTIVE") {
      status = "EXPIRED";
    }

    return {
      ...s,
      meta: {
        status,
        ageMinutes: ageMin,
        ttlRemaining: `${Math.max(0, TTL_MINUTES - ageMin)}m`,
        pnl: Number(pnl.toFixed(2)),
        actionable: status === "ACTIVE" && s.confidence >= 55,
      },
    };
  });

  // ── 4. BUILD MARKET DATA ARRAY FROM KV ──
  // Use KV snapshot directly. No recalculation. No candle fetching.
  const freshMarket = TRACKED_PAIRS.map((pair) => {
    const snapshot = marketSnapshots?.[pair];
    if (!snapshot) {
      return {
        pair,
        price: currentPrices[pair] ?? 0,
        timestamp: Date.now(),
        phase: "NONE",
        trend: "UNKNOWN",
        htfBias: "NEUTRAL",
        adx: 0,
        rsi: 0,
        stochK: 0,
        stochD: 0,
      };
    }
    return snapshot;
  });

  // ── 5. RESPONSE ──
  const response = NextResponse.json({
    signals: enriched,
    marketData: freshMarket,
    history: Array.isArray(history) ? history : [],
    updatedAt: new Date().toISOString(),
  });

  response.headers.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  response.headers.set("Pragma", "no-cache");
  response.headers.set("Expires", "0");

  return response;
}
