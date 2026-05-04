import { NextResponse } from "next/server";
import {
  fetchCandles,
  detect4HBreakout,
  buildChecklist,
  APP_VERSION,
  type SymbolSnapshot,
} from "@/lib/strategy";
import { getSignals } from "@/lib/signal-store";

const SYMBOLS = ["BTC", "ETH", "SOL"];

export async function GET() {
  const snapshots: SymbolSnapshot[] = await Promise.all(
    SYMBOLS.map(async (symbol) => {
      try {
        const [candles4h, candles15m, candles5m] = await Promise.all([
          fetchCandles(symbol, 240, 100),
          fetchCandles(symbol, 15, 100),
          fetchCandles(symbol, 5, 30),
        ]);

        const price = candles4h.length
          ? candles4h[candles4h.length - 1].close
          : 0;

        const breakoutResult = detect4HBreakout(candles4h);
        const direction = breakoutResult?.direction ?? "NONE";

        const checklist = buildChecklist(
          candles4h,
          candles15m,
          candles5m,
          direction
        );

        const activeSignal =
          getSignals().find(
            (s) => s.symbol === symbol && s.state !== "END"
          ) ?? null;

        return {
          symbol,
          price,
          breakout: direction,
          checklist,
          signal: activeSignal,
          scannedAt: Date.now(),
        } satisfies SymbolSnapshot;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[v0] Scan error for ${symbol}:`, msg);
        return {
          symbol,
          price: 0,
          breakout: "NONE",
          checklist: [],
          signal: null,
          scannedAt: Date.now(),
        } satisfies SymbolSnapshot;
      }
    })
  );

  return NextResponse.json({
    snapshots,
    version: APP_VERSION,
    scannedAt: Date.now(),
  });
}
