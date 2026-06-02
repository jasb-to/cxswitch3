import { NextResponse } from "next/server";
import { getCandles, getCurrentPrice } from "@/lib/kraken";
import { generateSignal } from "@/lib/strategy";
import { setSignals } from "@/lib/state";

export const runtime = "nodejs";

export async function GET() {
  const symbols = ["BTC", "ETH", "SOL"] as const;

  const results = await Promise.all(
    symbols.map(async (symbol) => {
      const [price, c15, c1h] = await Promise.all([
        getCurrentPrice(symbol),
        getCandles(symbol, 15),
        getCandles(symbol, 60),
      ]);

      if (!price || c15.length < 30) return null;

      return generateSignal(symbol, c15, c1h, price);
    })
  );

  const cleaned = results.filter(Boolean);

  setSignals(cleaned as any);

  console.log(
    "[CRON]",
    cleaned.map(s => `${s.symbol}:${s.state}:${s.confidence}`)
  );

  return NextResponse.json({
    ok: true,
    count: cleaned.length,
  });
}
