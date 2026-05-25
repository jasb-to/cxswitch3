import { NextResponse } from "next/server";
import { SYMBOLS, createSignal } from "@/lib/strategy-core";
import { setSignal } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function sendTelegram(symbol: string, price: number, state: string) {
  try {
    const response = await fetch("/api/test-telegram", { method: "POST" });
    if (response.ok) {
      console.log(`[TELEGRAM] Alert sent for ${symbol}: ${state}`);
    }
  } catch (err) {
    console.error(`[TELEGRAM] Failed to send alert for ${symbol}:`, err);
  }
}

/**
 * DUMB EXECUTOR - fetch market data, evaluate, store to Supabase
 * Sends Telegram alert ONLY on SNIPER state
 */
export async function GET() {
  try {
    console.log("[CRON] Starting execution cycle");
    const results: any[] = [];

    // Evaluate each symbol
    for (const symbol of SYMBOLS) {
      const signal = createSignal(symbol);
      await setSignal(signal);
      
      // Log with real data
      console.log(`[CRON] ${symbol}: ${signal.state} - $${signal.price}`);
      
      // Send telegram ONLY on SNIPER
      if (signal.state === "SNIPER") {
        await sendTelegram(symbol, signal.price, signal.state);
      }
      
      results.push({ symbol, state: signal.state, price: signal.price });
    }

    console.log("[CRON COMPLETE]", results);

    return NextResponse.json({
      ok: true,
      message: "Signals evaluated",
      results,
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
