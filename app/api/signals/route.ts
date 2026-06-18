// app/api/signals/route.ts — v15 "FIXED: History + Stopped Out Banners"
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
      const maxAge = s.type === "EARLY" ? 2 : 6;
      return ageHours < maxAge;
    }
    return isSignalStillValid(s, price);
  });

  console.log("[API] Raw signals count:", signals?.length);
  console.log("[API] Valid signals count:", validSignals?.length);
  console.log("[API] History entries:", history?.length);

  const enriched = await Promise.all(validSignals.map(async (s: any) => {
    const isSweep = s.type === "SWEEP";
    const isEarly = s.type === "EARLY";

    let holdAdvice = null;
    try {
      const candles1h = await getCandles(s.pair, 60);
      const candles4h = await getCandles(s.pair, 240);
      const price = currentPrices[s.pair] || s.entry;

      if (candles1h && candles4h && candles1h.length > 30 && candles4h.length > 30) {
        holdAdvice = shouldHold(s, candles4h, candles1h, price);
      }
    } catch (err) {
      console.error(`[API] Hold analysis failed for ${s.pair}:`, err);
    }

    return {
      ...s,
      meta: {
        tier: isSweep ? "SWEEP" : isEarly ? "EARLY" : "OTHER",
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
