import { NextResponse } from "next/server";
import { getSignals } from "@/lib/signal-store";
import { normaliseSignal } from "@/lib/ui-normaliser";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * VIEW LAYER API
 * Returns normalised signals (display contract guaranteed)
 */
export async function GET() {
  try {
    const signals = getSignals();
    const normalisedSignals = signals.map(normaliseSignal);
    return NextResponse.json(normalisedSignals);
  } catch (error) {
    console.error("[API/SIGNALS] Error:", error);
    return NextResponse.json([], { status: 500 });
  }
}



