import { NextResponse } from "next/server";
import { readSignals, healthCheck } from "@/lib/persistent-store";
import { toViewModel } from "@/lib/signal-view-model";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * VIEW LAYER API
 * Returns persisted signals from Redis with UI display fields (view-model)
 * Guaranteed symbol presence across serverless invocations
 */
export async function GET() {
  try {
    // Verify Redis connectivity
    const isHealthy = await healthCheck();
    if (!isHealthy) {
      console.error("[API/SIGNALS] Redis not available");
      return NextResponse.json([], { status: 503 });
    }

    const signals = await readSignals();
    console.log("[API/SIGNALS] Retrieved from Redis:", signals.length, "signals");
    signals.forEach(s => {
      console.log(`[API/SIGNALS] ${s.symbol}: state=${s.state}, readiness=${s.readiness_score}, structure=${s.structure_15m}, trend=${s.trend_4h}`);
    });
    
    const viewModels = signals.map(toViewModel);
    console.log("[API/SIGNALS] Returning to UI:", viewModels.length, "viewmodels");
    return NextResponse.json(viewModels);
  } catch (error) {
    console.error("[API/SIGNALS] Error:", error);
    return NextResponse.json([], { status: 500 });
  }
}



