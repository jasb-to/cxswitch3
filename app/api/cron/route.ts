import { getPrices } from "@/lib/prices";
import { generateSignal } from "@/lib/signalEngine";

export const runtime = "nodejs";

let latestSignals: any[] = [];

export async function GET() {
  const prices = await getPrices();

  const signals = Object.entries(prices).map(([symbol, price]) =>
    generateSignal(symbol, price)
  );

  latestSignals = signals;

  console.log(
    "[CRON]",
    signals.map((s) => `${s.symbol}:${s.state} @${s.price}`).join(" | ")
  );

  return Response.json({
    ok: true,
    signalsCount: signals.length,
  });
}
