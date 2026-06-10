import { NextResponse } from "next/server";
import { getSignals, getMarketData } from "@/lib/state";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const signals = await getSignals();
  const marketData = await getMarketData();

  console.log("[API] Raw signals count:", signals?.length);
  console.log("[API] Raw signals:", JSON.stringify(signals, null, 2));

  const enriched = (Array.isArray(signals) ? signals : []).map((s: any) => {
    const isPrimary = s.type === "PRIMARY";
    const isCheeky = s.type === "CHEEKY";

    return {
      ...s,
      meta: {
        tier: isPrimary ? "PRIMARY" : isCheeky ? "CHEEKY" : "OTHER",
        quality: s.confidence >= 80 ? "A" : s.confidence >= 65 ? "B" : s.confidence >= 50 ? "C" : "D",
        actionable: s.confidence >= 50 && (isPrimary || (isCheeky && s.confidence >= 65)),
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
