import { NextResponse } from "next/server";
import { SYMBOLS, createSignal } from "@/lib/strategy-core";
import { setSignal, getPreviousSignal } from "@/lib/signal-store";
import { signalEvents } from "@/lib/signal-events";
import "@/lib/telegram-listener"; // Initialize listener

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * EXECUTOR - Pure workflow
 * 1. Fetch prices and evaluate signals
 * 2. Store signals
 * 3. Emit events for listeners (Telegram, etc)
 * 
 * No filtering, no fallbacks, no business logic
 */
export async function GET() {
  try {
    console.log("[CRON] Starting execution cycle");

    for (const symbol of SYMBOLS) {
      const signal = await createSignal(symbol);
      const previousSignal = getPreviousSignal(symbol);
      
      setSignal(signal);
      
      // Log signal for debugging
      console.log(`[SIGNAL] ${symbol}: ${signal.state} @ $${signal.price}`);
      
      // Emit event for listeners (Telegram, etc)
      if (signal.state !== previousSignal?.state) {
        console.log(`[EVENT] State change: ${symbol} ${previousSignal?.state} → ${signal.state}`);
        await signalEvents.emit({
          symbol,
          state: signal.state,
          signal,
        });
      }
    }

    return NextResponse.json({ ok: true, message: "Signals executed" });
  } catch (error) {
    console.error("[CRON] Error:", error);
    return NextResponse.json({ ok: false, error: String(error) }, { status: 500 });
  }
}

export async function POST() {
  return GET();
}



