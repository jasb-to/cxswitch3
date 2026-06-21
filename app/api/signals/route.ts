// app/api/signals/route.ts — v23.5 "FIXED: BREAKOUT + No Cache + Freshness Gate"
// ============================================================

import { NextResponse } from "next/server";
import { getSignals, getMarketData, getSignalHistory } from "@/lib/state";
import { isSignalStillValid, shouldHold } from "@/lib/strategy";
import { getCandles } from "@/lib/kraken";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

const EARLY_FRESHNESS_MIN = 30;

export async function GET() {
  const signals = await getSignals();
  const marketData = await getMarketData();
  const history = await getSignalHistory();

  const currentPrices: Record<string, number> = {};
  for (const m of marketData) {
    if (m.pair && m.price) currentPrices[m.pair] = m.price;
  }

  const validSignals = (Array.isArray(signals) ? signals : []).filter((s: any) => {
    const price = currentPrices[s.pair];
    if (!price) {
      const ageHours = (Date.now() - s.timestamp) / (1000 * 60 * 60);
      const maxAge = s.type === "EARLY" ? 1 : s.type === "BREAKOUT" ? 6 : s.type === "PULLBACK" ? 2 : 6;
      return ageHours < maxAge;
    }
    return isSignalStillValid(s, price).valid;
  });

  console.log("[API] Raw signals count:", signals?.length);
  console.log("[API] Valid signals count:", validSignals?.length);
  console.log("[API] History entries:", history?.length);

  const enriched = await Promise.all(validSignals.map(async (s: any) => {
    const isBreakout = s.type === "BREAKOUT";
    const isPullback = s.type === "PULLBACK";
    const isEarly = s.type === "EARLY";

    const ageMin = (Date.now() - s.timestamp) / (1000 * 60);
    const isFresh = isEarly ? ageMin <= EARLY_FRESHNESS_MIN : true;

    let holdAdvice = null;
    try {
      const candles4h = await getCandles(s.pair, 240);
      const price = currentPrices[s.pair] || s.entry;
      if (candles4h && candles4h.length > 30) {
        holdAdvice = shouldHold(s, candles4h, price);
      }
    } catch (err) {
      console.error(`[API] Hold analysis failed for ${s.pair}:`, err);
    }

    return {
      ...s,
      meta: {
        tier: isBreakout ? "BREAKOUT" : isPullback ? "PULLBACK" : isEarly ? "EARLY" : "OTHER",
        confidenceScore: s.confidence,
        actionable: s.confidence >= 60 && isFresh,
        fresh: isFresh,
        ageMinutes: Math.round(ageMin),
      },
      holdAdvice
    };
  }));

  console.log("[API] Enriched signals count:", enriched.length);

  const response = NextResponse.json({
    signals: enriched,
    marketData: Array.isArray(marketData) ? marketData : [],
    history: Array.isArray(history) ? history : [],
    updatedAt: new Date().toISOString(),
  });

  // Force no-cache headers to prevent Vercel CDN caching
  response.headers.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  response.headers.set("Pragma", "no-cache");
  response.headers.set("Expires", "0");
  response.headers.set("Surrogate-Control", "no-store");

  return response;
}
