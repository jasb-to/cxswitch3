import { generateSignal, Signal, Symbol } from "@/lib/strategy";
import { getCandles4H, getCandles15M } from "@/lib/kraken";

export const runtime = "nodejs";

export async function GET() {
  try {
    const symbols: Symbol[] = ["BTC", "ETH", "SOL"];
    const signals: Signal[] = [];

    // Fetch all signals in parallel
    const results = await Promise.all(
      symbols.map(async (symbol) => {
        try {
          const [candles4H, candles15M] = await Promise.all([
            getCandles4H(symbol),
            getCandles15M(symbol),
          ]);

          if (candles4H.length === 0 || candles15M.length === 0) {
            console.warn(`[API] Missing candle data for ${symbol}`);
            return null;
          }

          return generateSignal(symbol, candles4H, candles15M);
        } catch (err) {
          console.error(`[API] Error generating signal for ${symbol}: ${err}`);
          return null;
        }
      })
    );

    results.forEach((signal) => {
      if (signal) signals.push(signal);
    });

    return Response.json({ signals, updatedAt: new Date().toISOString() });
  } catch (err) {
    console.error(`[API] Error: ${err}`);
    return Response.json(
      { error: "Failed to generate signals", signals: [] },
      { status: 500 }
    );
  }
}
