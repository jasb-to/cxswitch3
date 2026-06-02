import { NextResponse } from "next/server";
import { getLivePrices } from "@/lib/prices";
import { getCandles } from "@/lib/kraken";
import { generateSignal } from "@/lib/strategy";
import { setSignals } from "@/lib/state";

export const runtime = "nodejs";

export async function GET() {
  const prices = await getLivePrices();

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

  const signals = [
    generateSignal("BTC", btc15, btc1h, prices.BTC),
    generateSignal("ETH", eth15, eth1h, prices.ETH),
    generateSignal("SOL", sol15, sol1h, prices.SOL),
  ];

  setSignals(signals);

  console.log(
    "[CRON] signals updated",
    signals.map(s => `${s.symbol}:${s.state}`)
  );

  return NextResponse.json({ ok: true, count: signals.length });
}
