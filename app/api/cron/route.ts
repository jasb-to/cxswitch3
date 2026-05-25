import { NextRequest, NextResponse } from "next/server";
import { generateTradeSignal } from "@/lib/strategy-pure";
import { formatSignalResponse } from "@/lib/signal-api";
import type { TradeSignal } from "@/lib/trade-signal-types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Hard-coded valid symbols only
const VALID_SYMBOLS = ["BTC", "ETH", "SOL"];

/**
 * Generate market data for a symbol
 * Returns null if data cannot be fetched
 */
async function getMarketData(symbol: string) {
  // Guard: Validate symbol is in whitelist
  if (!symbol || !VALID_SYMBOLS.includes(symbol)) {
    throw new Error(`Unknown symbol: ${symbol}`);
  }

  // TODO: Fetch real market data from Kraken or data source
  // For now, return mock data to validate the pipeline
  return {
    symbol,
    price: 50000, // Mock price
    emaShort: 49800,
    emaLong: 49500,
    ema1h: 49600,
    ema4h: 49400,
    htf4hTrend: "UPTREND",
    structure: "UPTREND",
    volumeProfile: {
      high: 51000,
      low: 49000,
    },
  };
}

/**
 * CLEAN EXECUTION CYCLE
 * Market Data → generateTradeSignal() → TradeSignal[]
 */
async function runExecutionCycle(): Promise<TradeSignal[]> {
  const signals: TradeSignal[] = [];
  const cycleStart = Date.now();

  console.log("[CRON] Execution cycle started");
  console.log("[CRON] Fetching market data for: BTC, ETH, SOL");

  for (const symbol of VALID_SYMBOLS) {
    try {
      // Fetch market data - this will throw if symbol is invalid
      const marketData = await getMarketData(symbol);

      // Generate signal from market data
      const signal = generateTradeSignal(marketData);

      signals.push(signal);
      console.log(`[CRON] Signal generated for ${symbol}: ${signal.state}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[CRON] Error processing ${symbol}: ${message}`);
      // Add explicit DO_NOT_TRADE with error reason
      signals.push({
        state: "DO_NOT_TRADE",
        reason: `Failed to generate signal: ${message}`,
      });
    }
  }

  const timeMs = Date.now() - cycleStart;
  console.log(`[CRON] Cycle complete: ${signals.length} signals in ${timeMs}ms`);

  return signals;
}

/**
 * GET /api/cron - Main entry point
 * Returns array of TradeSignal objects
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const signals = await runExecutionCycle();
    return NextResponse.json(formatSignalResponse(signals));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[CRON] Fatal error: ${message}`);
    return NextResponse.json(
      {
        ready: false,
        error: message,
        signals: [],
      },
      { status: 500 }
    );
  }
}
