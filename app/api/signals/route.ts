// app/api/signals/route.ts — v14
// ============================================================

import { NextResponse } from "next/server";
import { getSignals, getMarketData } from "@/lib/state-v14";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const signals = await getSignals();
  const marketData = await getMarketData();

  console.log("[API] Raw signals count:", signals?.length);

  const enriched = (Array.isArray(signals) ? signals : []).map((s: any) => {
    const isSweep = s.type === "SWEEP";
    const isFVG = s.type === "FVG";

    return {
      ...s,
      meta: {
        tier: isSweep ? "SWEEP" : isFVG ? "EARLY" : "OTHER",
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
