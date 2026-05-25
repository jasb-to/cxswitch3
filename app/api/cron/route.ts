import { NextResponse } from "next/server";
import { SYMBOLS, createSignal } from "@/lib/strategy-core";
import { setSignal, getPreviousSignal } from "@/lib/signal-store";
import { sendSignalAlert } from "@/lib/telegram";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * EXECUTOR - Fetch Kraken prices, evaluate, store in memory
 * Sends Telegram alerts when state changes INTO SNIPER
 */
export async function GET() {
  try {
    console.log("[CRON] Starting execution cycle");
    const results: any[] = [];

    for (const symbol of SYMBOLS) {
      const signal = await createSignal(symbol);
      const previousSignal = getPreviousSignal(symbol);
      const previousState = previousSignal?.state;
      
      setSignal(signal);
      
      // Log full signal details
      console.log(`[CRON]`);
      console.log(`${symbol}`);
      console.log(`STATE: ${signal.state}`);
      
      if (signal.state === "SNIPER" && signal.direction) {
        console.log(`DIRECTION: ${signal.direction}`);
        console.log(`PRICE: ${signal.price}`);
        console.log(`ENTRY: ${signal.entry}`);
        console.log(`SL: ${signal.stopLoss}`);
        console.log(`TP: ${signal.takeProfit}`);
        console.log(`RR: ${signal.riskReward}`);
        console.log(`CONFIDENCE: ${signal.confidence}%`);
        console.log(`REASON: ${signal.reason}`);
      } else {
        console.log(`PRICE: ${signal.price}`);
      }
      
      results.push({
        symbol,
        state: signal.state,
        price: signal.price,
        ...(signal.state === "SNIPER" && signal.direction ? {
          direction: signal.direction,
          entry: signal.entry,
          stopLoss: signal.stopLoss,
          takeProfit: signal.takeProfit,
          riskReward: signal.riskReward,
          confidence: signal.confidence,
        } : {}),
      });

      // Send alert when state changes INTO SNIPER
      if (signal.state === "SNIPER" && previousState !== "SNIPER") {
        console.log(`[ALERT] State changed from ${previousState} to SNIPER`);
        await sendSignalAlert(signal);
      }
    }

    console.log("[CRON SUMMARY]");
    results.forEach((r) => {
      if (r.state === "SNIPER") {
        console.log(`${r.symbol} → SNIPER (${r.direction}) $${r.price}`);
      } else {
        console.log(`${r.symbol} → ${r.state}`);
      }
    });

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


