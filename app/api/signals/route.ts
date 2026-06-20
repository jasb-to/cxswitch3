// app/api/signals/route.ts — v23 "FIXED: v23 strategy compatibility"
// ============================================================

import { NextResponse } from "next/server";
import { getSignals, getMarketData, getSignalHistory } from "@/lib/state";
import { isSignalStillValid, shouldHold } from "@/lib/strategy";
import { getCandles } from "@/lib/kraken";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
      const maxAge = s.type === "PULLBACK" ? 2 : 6;
      return ageHours < maxAge;
    }
    return isSignalStillValid(s, price);
  });

  console.log("[API] Raw signals count:", signals?.length);
  console.log("[API] Valid signals count:", validSignals?.length);
  console.log("[API] History entries:", history?.length);

  const enriched = await Promise.all(validSignals.map(async (s: any) => {
    const isBreakout = s.type === "BREAKOUT";
    const isPullback = s.type === "PULLBACK";
    let holdAdvice = null;
    try {
      const candles4h = await getCandles(s.pair, 240);
      const price = currentPrices[s.pair] || s.entry;
      if (candles4h && candles4h.length > 30) {
        // v23: shouldHold only takes (signal, candles4h, currentPrice)
        holdAdvice = shouldHold(s, candles4h, price);
      }
    } catch (err) {
      console.error(`[API] Hold analysis failed for ${s.pair}:`, err);
    }
    return {
      ...s,
      meta: {
        tier: isBreakout ? "BREAKOUT" : isPullback ? "PULLBACK" : "OTHER",
        quality: s.confidence >= 85 ? "A" : s.confidence >= 70 ? "B" : s.confidence >= 55 ? "C" : "D",
        actionable: s.confidence >= 60,
      },
      holdAdvice
    };
  }));

  console.log("[API] Enriched signals count:", enriched.length);

  return NextResponse.json({
    signals: enriched,
    marketData: Array.isArray(marketData) ? marketData : [],
    history: Array.isArray(history) ? history : [],
    updatedAt: new Date().toISOString(),
  });
}
