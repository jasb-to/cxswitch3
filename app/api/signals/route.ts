// app/api/signals/route.ts — v14
// ============================================================

import { NextResponse } from "next/server";
import { getSignals, getMarketData } from "@/lib/state";
import { isSignalStillValid } from "@/lib/strategy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const signals = await getSignals();
  const marketData = await getMarketData();

  // Build price lookup from market data
  const currentPrices: Record<string, number> = {};
  for (const m of marketData) {
    if (m.pair && m.price) currentPrices[m.pair] = m.price;
  }

  // Filter expired signals before enriching
  const validSignals = (Array.isArray(signals) ? signals : []).filter((s: any) => {
    const price = currentPrices[s.pair];
    if (!price) {
      // Fallback to age-only if no market data for this pair
      const ageHours = (Date.now() - s.timestamp) / (1000 * 60 * 60);
      const maxAge = s.type === "EARLY" ? 2 : 6;
      return ageHours < maxAge;
    }
    return isSignalStillValid(s, price);
  });

  console.log("[API] Raw signals count:", signals?.length);
  console.log("[API] Valid signals count:", validSignals?.length);

  const enriched = validSignals.map((s: any) => {
    const isSweep = s.type === "SWEEP";
    const isEarly = s.type === "EARLY";

    return {
      ...s,
      meta: {
        tier: isSweep ? "SWEEP" : isEarly ? "EARLY" : "OTHER",
        quality: s.confidence >= 85 ? "A" : s.confidence >= 70 ? "B" : s.confidence >= 55 ? "C" : "D",
        actionable: s.confidence >= 60,
      }
    };
  });

  console.log("[API] Enriched signals count:", enriched.length);

  return NextResponse.json({
    signals: enriched,
    marketData: Array.isArray(marketData) ? marketData : [],
    updatedAt: new Date().toISOString(),
  });
}
