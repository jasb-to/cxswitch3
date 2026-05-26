import { NextResponse } from "next/server";
import { SYMBOLS, createSignal } from "@/lib/strategy-core";
import { toViewModel } from "@/lib/signal-view-model";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * CRITICAL: LIVE STRATEGY COMPUTATION
 * Computes trading signals LIVE on every request
 * NEVER reads cached state from Redis
 * UI always reflects current market state
 */
export async function GET() {
  try {
    console.log("[API/SIGNALS] Computing live strategy for all symbols");
    
    // COMPUTE LIVE - never use cached snapshots
    const signals = await Promise.all(
      SYMBOLS.map(symbol => createSignal(symbol))
    );

    console.log(`[API/SIGNALS] Computed ${signals.length} live signals`);
    signals.forEach(s => {
      console.log(`[API/SIGNALS] ${s.symbol}: state=${s.state}, readiness=${s.readiness_score}`);
    });

    const viewModels = signals.map(toViewModel);
    return NextResponse.json(viewModels);
  } catch (error) {
    console.error("[API/SIGNALS] Error:", error);
    return NextResponse.json([], { status: 500 });
  }
}



