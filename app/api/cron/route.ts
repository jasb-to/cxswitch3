import { NextResponse } from "next/server";
import { SYMBOLS, createSignal } from "@/lib/strategy-core";
import { setSignal } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * DUMB EXECUTOR - fetch market data, evaluate, store to Supabase
 * NO formatting, NO transformation, NO interpretation
 */
export async function GET() {
  try {
    console.log("[CRON] Starting execution cycle");

    // Evaluate each symbol
    for (const symbol of SYMBOLS) {
      const signal = createSignal(symbol);
      await setSignal(signal);
      console.log(`[CRON] ${symbol}: ${signal.state}`);
    }

    console.log("[CRON] Cycle complete");

    return NextResponse.json({
      ok: true,
      message: "Signals evaluated",
    });
  } catch (error) {
    console.error("[CRON] Error:", error);
    return NextResponse.json(
      { ok: false, error: String(error) },
      { status: 500 }
    );
  }
}

export async function POST() {
  return GET();
}
