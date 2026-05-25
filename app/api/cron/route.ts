import { NextRequest, NextResponse } from "next/server";
import { generateTradeSignal } from "@/lib/strategy-pure";
import { formatSignalResponse } from "@/lib/signal-api";
import type { TradeSignal } from "@/lib/trade-signal-types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Hard-coded valid symbols only - NEVER ALLOW UNDEFINED
const VALID_SYMBOLS = ["BTC", "ETH", "SOL"] as const;

// Strict symbol validation - fail fast on any invalid input
function validateSymbol(symbol: unknown): symbol is typeof VALID_SYMBOLS[number] {
  if (typeof symbol !== "string") return false;
  if (!symbol || symbol.length === 0) return false;
  return VALID_SYMBOLS.includes(symbol as any);
}


/**
 * Generate market data for a symbol
 * GUARD: Symbol must be type-validated before calling
 * Returns null if data cannot be fetched
 */
async function getMarketData(symbol: string) {
  // Double guard: Reject any undefined or invalid symbol
  if (!symbol || symbol === "undefined" || symbol === "") {
    throw new Error(`[GUARD] Invalid symbol: ${JSON.stringify(symbol)}`);
  }

  // Validate symbol is in whitelist
  if (!VALID_SYMBOLS.includes(symbol as any)) {
    throw new Error(`[GUARD] Unknown symbol: ${symbol}`);
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
  console.log("[CRON] Processing: BTC, ETH, SOL");

  for (const symbol of VALID_SYMBOLS) {
    // Guard: Type-safe validation - symbol is guaranteed to be valid
    if (!validateSymbol(symbol)) {
      console.error(`[CRON] Invalid symbol type: ${typeof symbol}`);
      continue;
    }

    try {
      // Fetch market data - validateSymbol ensures it's in whitelist
      const marketData = await getMarketData(symbol);

      // Generate signal from market data
      const signal = generateTradeSignal(marketData);

      signals.push(signal);
      console.log(`[CRON] ${symbol}: ${signal.state}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[CRON] ${symbol} error: ${message}`);
      // Add explicit DO_NOT_TRADE with error reason
      signals.push({
        state: "DO_NOT_TRADE",
        reason: `Error: ${message}`,
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
