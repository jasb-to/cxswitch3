import { NextResponse } from "next/server";
import { getCandles } from "@/lib/kraken";
import { getCurrentPrice } from "@/lib/kraken";
import { generateSignal } from "@/lib/strategy";
import { setSignals } from "@/lib/state";

export const runtime = "nodejs";

export async function GET() {
  const symbols = ["BTC", "ETH", "SOL"] as const;

  const results = await Promise.all(
    symbols.map(async (symbol) => {
      const [price, candles15m, candles1h] = await Promise.all([
        getCurrentPrice(symbol),
        getCandles(symbol, 15),
        getCandles(symbol, 60),
      ]);

      if (!price || candles15m.length < 30) {
        return null;
      }

      const signal = generateSignal(symbol, candles15m, candles1h, price);

      return signal;
    })
  );

  const cleaned = results.filter(Boolean);

  setSignals(cleaned as any);

  console.log(
    "[CRON] signals updated:",
    cleaned.map((s: any) => `${s.symbol}:${s.state}:${s.confidence}`)
  );

  return NextResponse.json({
    ok: true,
    count: cleaned.length,
  });
}
