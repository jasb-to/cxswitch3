import { NextRequest, NextResponse } from "next/server";
import { generateTradeSignal } from "@/lib/strategy-pure";
import { formatSignalResponse } from "@/lib/signal-api";
import { setSnapshot } from "@/lib/runtime-snapshot";
import type { TradeSignal } from "@/lib/trade-signal-types";
import type { CanonicalSnapshot } from "@/lib/canonical-snapshot";

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
 * 
 * IMPORTANT: This function generates signals but does NOT persist them.
 * The caller (GET handler) is responsible for calling setSnapshot().
 */
async function runExecutionCycle(): Promise<TradeSignal[]> {
  const signals: TradeSignal[] = [];
  const cycleStart = Date.now();

  console.log("[CRON] ========== EXECUTION CYCLE START ==========");
  console.log("[CRON] input symbols:", VALID_SYMBOLS);

  for (const symbol of VALID_SYMBOLS) {
    // Guard: Type-safe validation - symbol is guaranteed to be valid
    if (!validateSymbol(symbol)) {
      console.error(`[CRON] Invalid symbol type: ${typeof symbol}`);
      continue;
    }

    try {
      // Fetch market data - validateSymbol ensures it's in whitelist
      const marketData = await getMarketData(symbol);
      console.log(`[CRON] market data fetched for ${symbol}:`, {
        price: marketData.price,
        emaShort: marketData.emaShort,
        htf4hTrend: marketData.htf4hTrend,
      });

      // Generate signal from market data
      const signal = generateTradeSignal(marketData);
      console.log(`[CRON] raw signal output for ${symbol}:`, {
        state: signal.state,
        reason: signal.reason,
      });

      signals.push(signal);
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
  console.log("[CRON] raw signal output:", signals.map(s => ({ state: s.state, symbol: (s as any).symbol })));
  console.log("[CRON] execution duration ms:", timeMs);
  console.log("[CRON] ========== EXECUTION CYCLE END ==========");

  return signals;
}


/**
 * GET /api/cron - Main entry point
 * CRITICAL: Executes strategy AND persists results to runtime snapshot
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const signals = await runExecutionCycle();
    
    // CRITICAL FIX: Convert TradeSignal[] to CanonicalSnapshot format and persist
    // This ensures /api/signals returns the same data as /api/cron generated
    const snapshot: CanonicalSnapshot = {
      ready: signals.length === 3,
      cards: signals.map(signal => ({
        symbol: (signal as any).symbol || "UNKNOWN",
        signalState: signal.state,
        reason: signal.reason,
        // Add minimal card data from signal for backward compat
        price: (signal as any).entry || 0,
        structure: (signal as any).structure || "UNKNOWN",
        confidence: (signal as any).confidence || 0,
      })) as any,
      setups: [],
      activeSignals: signals.filter(s => s.state === "ACTIVE_TRADE").length,
      activeSnipers: 0,
      signalCount: signals.length,
      updatedAt: new Date().toISOString(),
    };
    
    // PERSIST to runtime snapshot so /api/signals sees it
    setSnapshot(snapshot);
    console.log("[STATE] signals updated:", snapshot.cards.length, "cards, ready:", snapshot.ready);
    
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
