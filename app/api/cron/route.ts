import { NextResponse } from "next/server";
import { getCandles, getCurrentPrice } from "@/lib/kraken";
import { generateSignal } from "@/lib/strategy";
import { setSignals } from "@/lib/state";
import { sendAlert } from "@/lib/telegram";

export const runtime = "nodejs";

export async function GET() {
  try {
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

    const [btcPrice, ethPrice, solPrice] = await Promise.all([
      getCurrentPrice("BTC"),
      getCurrentPrice("ETH"),
      getCurrentPrice("SOL"),
    ]);

    const signals = [
      generateSignal("BTC", btcPrice, btc15, btc1h),
      generateSignal("ETH", ethPrice, eth15, eth1h),
      generateSignal("SOL", solPrice, sol15, sol1h),
    ];

    setSignals(signals);

    // ---------------- LOG FULL TRADE DATA ----------------
    console.log("\n[CRON] SIGNAL SNAPSHOT\n");

    for (const s of signals) {
      console.log({
        symbol: s.symbol,
        state: s.state,
        price: s.price,
        bias: s.bias,
        confidence: s.confidence,
        expectedMove: s.expectedMove,
        stopLoss: s.stopLoss,
        takeProfit: s.takeProfit,
        rr: s.rr,
        rsi: s.rsi,
        stoch: s.stoch,
        adx: s.adx,
      });
    }

    // ---------------- ALERTS ----------------
    for (const s of signals) {
      if (s.state === "WAIT") continue;

      await sendAlert({
        symbol: s.symbol,
        state: s.state,
        price: s.price,
        bias: s.bias,
        confidence: s.confidence,
        expectedMove: s.expectedMove,
        stopLoss: s.stopLoss,
        takeProfit: s.takeProfit,
        rr: s.rr,
        timestamp: s.updatedAt,
      });

      console.log(`[ALERT SENT] ${s.symbol} → ${s.state}`, {
        confidence: s.confidence,
        rr: s.rr,
      });
    }

    return NextResponse.json({
      ok: true,
      count: signals.length,
      signals,
    });
  } catch (err) {
    console.error("[CRON ERROR]", err);
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}
