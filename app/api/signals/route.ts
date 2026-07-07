// app/api/signals/route.ts — v28.1 "Pure Reader API"
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

export async function GET() {
  const signals = await getSignals();
  const history = await getSignalHistory();
  const marketSnapshots = await getMarketData();

  const currentPrices: Record<string, number> = {};
  for (const pair of TRACKED_PAIRS) {
    try {
      const price = await getCurrentPrice(pair);
      if (price > 0) currentPrices[pair] = price;
    } catch (e) {
      console.error(`[SIGNALS ROUTE] Price fetch failed for ${pair}:`, e);
    }
  }

  const enriched = (Array.isArray(signals) ? signals : []).map((s: any) => {
    const price = currentPrices[s.pair] ?? s.entry;
    const ageMin = Math.floor((Date.now() - s.timestamp) / 60000);
    let status = "ACTIVE";
    let pnl = 0;

    if (s.direction === "LONG") {
      if (price >= s.target) status = "TP_HIT";
      else if (price <= (s.lockedStop || s.stop)) status = "SL_HIT";
      else pnl = ((price - s.entry) / s.entry) * 100;
    } else {
      if (price <= s.target) status = "TP_HIT";
      else if (price >= (s.lockedStop || s.stop)) status = "SL_HIT";
      else pnl = ((s.entry - price) / s.entry) * 100;
    }

    // TTL only applies to pre-entry signals, not active trades
    const isPreEntry = !s.tradeState || s.tradeState === "OPEN";
    if (isPreEntry && ageMin > 12 * 60) status = "EXPIRED";

    return {
      ...s,
      meta: { status, ageMinutes: ageMin, pnl: Number(pnl.toFixed(2)), actionable: status === "ACTIVE" && s.confidence >= 55 },
    };
  });

  // FIX: marketSnapshots is an ARRAY from getMarketData(). Use .find(), not bracket notation.
  const freshMarket = TRACKED_PAIRS.map((pair) => {
    const snapshot = Array.isArray(marketSnapshots) 
      ? marketSnapshots.find((m: any) => m.pair === pair)
      : undefined;
    
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
        stochD: 0 
      };
    }
    
    // Merge current live price with snapshot data
    return {
      ...snapshot,
      price: currentPrices[pair] ?? snapshot.price ?? 0,
    };
  });

  const response = NextResponse.json({ 
    signals: enriched, 
    marketData: freshMarket, 
    history: Array.isArray(history) ? history : [], 
    updatedAt: new Date().toISOString() 
  });
  
  response.headers.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  response.headers.set("Pragma", "no-cache");
  response.headers.set("Expires", "0");
  return response;
}
