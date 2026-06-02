import { NextResponse } from "next/server";

import { getLivePrices } from "@/lib/prices";
import { getCandles } from "@/lib/kraken";
import { generateSignal } from "@/lib/strategy";
import { setSignals, getSignals } from "@/lib/state";
import { shouldAlert } from "@/lib/alertState";
import { sendTelegramAlert } from "@/lib/telegram";

export const runtime = "nodejs";

/* -----------------------------
   MAIN CRON
------------------------------ */

export async function GET() {
  try {
    // 1. LIVE PRICES
    const prices = await getLivePrices();

    // 2. CANDLES (STRUCTURE INPUT)
    const [btc15, eth15, sol15] = await Promise.all([
      getCandles("BTC", 15),
      getCandles("ETH", 15),
      getCandles("SOL", 15),
    ]);

    const [btc1h, eth1h, sol1h] = await Promise.all([
      getCandles("BTC", 60),
      getCandles("ETH", 60),
      getCandles("SOL", 60),
    ]);

    // 3. SIGNAL GENERATION (REAL DATA ONLY)
    const signals = [
      generateSignal("BTC", btc15, btc1h, prices.BTC),
      generateSignal("ETH", eth15, eth1h, prices.ETH),
      generateSignal("SOL", sol15, sol1h, prices.SOL),
    ];

    // 4. STORE IN MEMORY
    setSignals(signals);

    // 5. LOG STATE (IMPORTANT FOR DEBUGGING)
    console.log(
      "[CRON] signals updated:",
      signals.map(s => `${s.symbol}:${s.state}:${s.confidence}`)
    );

    // 6. ALERT ENGINE (ONLY ON CHANGE)
    for (const s of signals) {
      const shouldSend = shouldAlert(s.symbol, s.state);

      if (shouldSend && s.state !== "WAIT") {
        await sendTelegramAlert({
          symbol: s.symbol,
          state: s.state,
          price: s.price,

          bias: s.bias,
          confidence: s.confidence,

          adx: s.adx,
          stoch: s.stoch,
          rsi: s.rsi,

          expectedMove: s.expectedMove,

          stopLoss: s.stopLoss,
          takeProfit: s.takeProfit,

          rr: s.rr,
        });

        console.log(`[ALERT SENT] ${s.symbol} → ${s.state}`);
      }
    }

    // 7. RESPONSE
    return NextResponse.json({
      ok: true,
      count: signals.length,
      updatedAt: new Date().toISOString(),
    });
  } catch (err: any) {
    console.error("[CRON ERROR]", err);

    return NextResponse.json(
      {
        ok: false,
        error: err?.message || "unknown error",
      },
      { status: 500 }
    );
  }
}
