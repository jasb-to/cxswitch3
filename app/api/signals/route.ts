import { NextResponse } from "next/server";
import { getCandles } from "@/lib/kraken";
import { generateSignal } from "@/lib/strategy";

export const runtime = "nodejs";

export async function GET() {
  const [btc15, eth15, sol15] = await Promise.all([
    getCandles("BTC", 15),
    getCandles("ETH", 15),
    getCandles("SOL", 15),
  ]);

  const signals = [
    generateSignal("BTC", btc15.at(-1)?.close ?? 0),
    generateSignal("ETH", eth15.at(-1)?.close ?? 0),
    generateSignal("SOL", sol15.at(-1)?.close ?? 0),
  ];

  return NextResponse.json({
    signals,
    updatedAt: new Date().toISOString(),
  });
}
