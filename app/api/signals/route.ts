import { NextResponse } from "next/server";
import { SYMBOLS, createSignal } from "@/lib/strategy-core";
import { toViewModel } from "@/lib/signal-view-model";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * LIVE STRATEGY API
 * Computes signals live and applies hold rules
 * Returns hold-adjusted state with remaining time
 */
export async function GET() {
  try {
    console.log("[API/SIGNALS] Computing live strategy for all symbols");
    
    // COMPUTE LIVE - includes hold rule application
    const signals = await Promise.all(
      SYMBOLS.map(symbol => createSignal(symbol))
    );

    console.log(`[API/SIGNALS] Computed ${signals.length} live signals`);
    signals.forEach(s => {
      console.log(`[API/SIGNALS] ${s.symbol}: state=${s.state}, readiness=${s.readiness_score}, hold_remaining=${s.hold_remaining_ms}ms`);
    });

    const viewModels = signals.map(toViewModel);
    return NextResponse.json(viewModels);
  } catch (error) {
    console.error("[API/SIGNALS] Error:", error);
    return NextResponse.json([], { status: 500 });
  }
}



