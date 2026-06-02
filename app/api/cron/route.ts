import { NextResponse } from "next/server";

import { getLivePrices } from "@/lib/prices";
import { generateSignal } from "@/lib/strategy";
import { setSignals } from "@/lib/state";
import { sendTelegramAlert } from "@/lib/telegram";

export const runtime = "nodejs";

const lastState: Record<string, string> = {};

export async function GET() {
  const prices = await getLivePrices();

  const signals = [
    generateSignal("BTC", prices.BTC),
    generateSignal("ETH", prices.ETH),
    generateSignal("SOL", prices.SOL),
  ];

  setSignals(signals);

  console.log(
    "[CRON]",
    signals.map(s => `${s.symbol}:${s.state}:${s.confidence}`)
  );

  for (const s of signals) {
    const prev = lastState[s.symbol];
    const changed = prev !== s.state;

    if (changed && s.state !== "WAIT") {
      lastState[s.symbol] = s.state;

      await sendTelegramAlert(s);

      console.log(`[ALERT] ${s.symbol} → ${s.state}`);
    }
  }

  return NextResponse.json({ ok: true });
}
