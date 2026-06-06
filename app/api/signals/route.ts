import { NextResponse } from "next/server";
import { getSignals } from "@/lib/state";

export const runtime = "nodejs";

export async function GET() {
  const signals = getSignals();

  const enriched = (Array.isArray(signals) ? signals : []).map((s: any) => {
    const isPrimary = s.reason?.includes("4H_PRIMARY");
    const isCheeky = s.reason?.includes("1H_CHEEKY");
    
    return {
      ...s,
      meta: {
        tier: isPrimary ? "PRIMARY" : isCheeky ? "CHEEKY" : "OTHER",
        quality: s.confidence >= 80 ? "A" : s.confidence >= 65 ? "B" : s.confidence >= 50 ? "C" : "D",
        actionable: s.confidence >= 50 && (isPrimary || (isCheeky && s.confidence >= 65)),
      }
    };
  });

  return NextResponse.json({
    signals: enriched,
    updatedAt: new Date().toISOString(),
  });
}
