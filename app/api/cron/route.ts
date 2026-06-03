import { NextResponse } from "next/server";
import { getCandles, getCurrentPrice } from "@/lib/kraken";
import { generateSignal } from "@/lib/strategy";
import { setSignals } from "@/lib/state";
import { sendAlert } from "@/lib/telegram";

export const runtime = "nodejs";

export async function GET() {
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

  console.log("[CRON] FULL SIGNAL SNAPSHOT");

  for (const s of signals) {
    console.log(JSON.stringify(s, null, 2));
  }

  for (const s of signals) {
    if (s.state === "WAIT") continue;

    await sendAlert(s);

    console.log("[ALERT SENT]", {
      symbol: s.symbol,
      state: s.state,
      confidence: s.confidence,
      rr: s.rr,
      sl: s.stopLoss,
      tp: s.takeProfit,
    });
  }

  return NextResponse.json({ ok: true, signals });
}
