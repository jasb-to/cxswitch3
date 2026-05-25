import { NextResponse } from "next/server";
import { SYMBOLS, createSignal } from "@/lib/strategy-core";
import { setSignal } from "@/lib/db";
import { sendSignalAlert } from "@/lib/telegram";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * EXECUTOR - Fetch live prices, evaluate states, store to Supabase
 * Sends Telegram alerts only on SNIPER state
 */
export async function GET() {
  try {
    console.log("[CRON] Starting execution cycle");
    const results: any[] = [];

    // Evaluate each symbol with live prices
    for (const symbol of SYMBOLS) {
      const signal = await createSignal(symbol);
      await setSignal(signal);
      
      console.log(`[CRON] ${symbol}`);
      console.log(`  STATE: ${signal.state}`);
      console.log(`  PRICE: $${signal.price}`);
      console.log(`  4H: ${signal.bias_4h}`);
      console.log(`  15M: ${signal.bias_15m}`);
      console.log(`  QUALITY: ${signal.signal_quality}%`);
      
      results.push({
        symbol,
        state: signal.state,
        price: signal.price,
        quality: signal.signal_quality,
      });

      // Send Telegram alert ONLY on SNIPER
      if (signal.state === "SNIPER") {
        await sendSignalAlert(symbol, signal.price, signal.state, signal.signal_quality);
      }
    }

    console.log("[CRON SUMMARY]");
    results.forEach((r) => {
      console.log(`${r.symbol} → ${r.state} ($${r.price})`);
    });

    return NextResponse.json({
      ok: true,
      message: "Signals evaluated and stored",
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

