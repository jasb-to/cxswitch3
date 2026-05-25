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

    // If no signals stored yet, return defaults so UI never sees empty state
    const output = signals.length === 0
      ? [
          { symbol: "BTC", state: "DO_NOT_TRADE" as const, timestamp: Date.now() },
          { symbol: "ETH", state: "DO_NOT_TRADE" as const, timestamp: Date.now() },
          { symbol: "SOL", state: "DO_NOT_TRADE" as const, timestamp: Date.now() },
        ]
      : signals;

    return NextResponse.json({
      ready,
      signals: output.map((s) => ({
        symbol: s.symbol,
        state: s.state,
        timestamp: s.timestamp,
      })),
    });
  } catch (error) {
    console.error("[API/SIGNALS] Error:", error);
    return NextResponse.json(
      {
        ready: false,
        signals: [
          { symbol: "BTC", state: "DO_NOT_TRADE", timestamp: Date.now() },
          { symbol: "ETH", state: "DO_NOT_TRADE", timestamp: Date.now() },
          { symbol: "SOL", state: "DO_NOT_TRADE", timestamp: Date.now() },
        ],
      },
      { status: 500 }
    );
  }
}
