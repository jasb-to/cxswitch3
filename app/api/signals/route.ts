import { NextResponse } from "next/server";
import { getSignals, isReady } from "@/lib/signal-store";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * READ-ONLY API - Returns raw signals from cron
 * NO transformation, NO computation, NO interpretation
 * Pure passthrough of what cron stored
 */
export async function GET() {
  try {
    const signals = getSignals();
    const ready = isReady();

    console.log("[API/SIGNALS] Ready:", ready, "Count:", signals.length);

    return NextResponse.json({
      ready,
      signals: signals.map((s) => ({
        symbol: s.symbol,
        state: s.state,
        timestamp: s.timestamp,
      })),
    });
  } catch (error) {
    console.error("[API/SIGNALS] Error:", error);
    return NextResponse.json(
      { ready: false, signals: [] },
      { status: 500 }
    );
  }
}
