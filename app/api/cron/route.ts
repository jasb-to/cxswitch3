import { NextResponse } from "next/server";
import { getLivePrices } from "@/lib/prices";
import { generateSignal } from "@/lib/strategy";
import { setSignals } from "@/lib/state";

export const runtime = "nodejs";

function round(n: number | null, d = 2) {
  if (n === null || n === undefined) return null;
  const f = Math.pow(10, d);
  return Math.round(n * f) / f;
}

export async function GET() {
  const prices = await getLivePrices();

  const signals = Object.entries(prices).map(([symbol, price]) => {
    const s = generateSignal(symbol as any, price);

    return {
      ...s,
      price: round(s.price),
      adx: round(s.adx, 1),
      stoch: round(s.stoch, 1),
      stopLoss: round(s.stopLoss),
      takeProfit: round(s.takeProfit),
    };
  });

  setSignals(signals);

  console.log("[CRON] updated", signals.length);

  return NextResponse.json({ ok: true });
}
