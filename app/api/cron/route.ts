import { NextResponse } from "next/server";
import { getLivePrices } from "@/lib/prices";
import { generateSignal } from "@/lib/strategy";
import { setSignals } from "@/lib/state";

export const runtime = "nodejs";

function round(n: number, decimals = 2) {
  const f = Math.pow(10, decimals);
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
      stochK: round(s.stochK, 1),
      stochD: round(s.stochD, 1),
      stopLoss: s.stopLoss ? round(s.stopLoss) : null,
      takeProfit: s.takeProfit ? round(s.takeProfit) : null,
    };
  });

  setSignals(signals);

  console.log("[CRON] signals updated", signals.length);

  return NextResponse.json({
    ok: true,
    count: signals.length,
  });
}
