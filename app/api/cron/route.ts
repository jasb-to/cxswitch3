import { NextResponse } from "next/server";
import { getCandles, getLivePrice } from "@/lib/kraken";
import { generateSignal } from "@/lib/strategy";
import { setSignals } from "@/lib/state";

export const runtime = "nodejs";

export async function GET() {
  const symbols: any[] = ["BTC", "ETH", "SOL"];

  const results = await Promise.all(
    symbols.map(async (symbol) => {
      const candles15m = await getCandles(symbol, 15);
      const price = await getLivePrice(symbol);

      return generateSignal(symbol, candles15m, price);
    })
  );

  setSignals(results);

  console.log("[CRON] signals updated", results.length);

  return NextResponse.json({ ok: true, signals: results });
}
