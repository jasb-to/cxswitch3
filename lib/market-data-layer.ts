/**
 * Market Data Layer (v8.0 - HARD PIPELINE SEGREGATION)
 * 
 * CRITICAL ARCHITECTURAL FIX: Split execution and display pipelines at ingestion
 * 
 * Job:
 * - Fetch prices (all sources)
 * - Cache latest snapshot
 * - SEGREGATE into two separate pipelines:
 *   - Execution Pipeline: Kraken only (executionGrade = true)
 *   - Display Pipeline: Fallback data (executionGrade = false)
 * - NEVER mix these pipelines
 * 
 * RULE: 
 * - ExecutionContext is ONLY built from execution pipeline
 * - Display pipeline goes ONLY to UI rendering
 * - No fallback data ever enters execution scan loop
 */

import { getPrice, type PriceData } from "./price-router";

export type MarketDataCache = {
  symbol: string;
  priceData: PriceData | null;
  lastUpdate: number;
  updateError?: string;
  isExecutionGrade: boolean;
};

// Segregated market data (v8.0)
export type SegregatedMarketData = {
  execution: Record<string, PriceData>;  // Kraken only, can build ExecutionContext
  display: Record<string, PriceData>;     // Fallback data, UI only
};

// ═══════════════════════════════════════════════════════════════════════════
// GLOBAL CACHE: Price data for all tracked symbols
// Always keeps last value, never clears
// ═══════════════════════════════════════════════════════════════════════════
const TRACKED_SYMBOLS = ["BTC", "ETH", "SOL"];
const marketDataCache: Record<string, MarketDataCache> = {};

// Initialize cache for all symbols
for (const symbol of TRACKED_SYMBOLS) {
  marketDataCache[symbol] = {
    symbol,
    priceData: null,
    lastUpdate: 0,
    isExecutionGrade: false,  // FIX: Default to degraded
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// MARKET DATA REFRESH: Cron-triggered only
// Dumb job: fetch → cache → return
// ═══════════════════════════════════════════════════════════════════════════

// v8.1 FIX: Split locks per pipeline (CRITICAL ARCHITECTURE)
// NEVER use shared isUpdating flag - breaks v8.1 independence
// Each pipeline has independent lock to prevent internal duplicate fetches
let executionMarketLock = false;  // Prevents duplicate execution refreshes
let displayMarketLock = false;    // Prevents duplicate display refreshes

/**
 * Refresh all prices and return segregated market pipelines
 * CALLED BY: cron jobs only  
 * Returns: { execution, display } completely separate pipelines
 * RULE: Segregate at ingestion - NEVER mix in same cycle
 * 
 * v8.1 FIX: Pipeline parameter determines which lock applies
 * - "execution": Uses executionMarketLock (can run in parallel with display)
 * - "display": Uses displayMarketLock, ALWAYS allowed (never blocked)
 */
export async function refreshMarketData(pipeline: "execution" | "display" = "execution"): Promise<SegregatedMarketData> {
  // v8.1 RULE: Display is ALWAYS allowed, never waits
  if (pipeline === "execution" && executionMarketLock) {
    console.log("[MARKET] Execution already refreshing, using cache");
    return getMarketSnapshot();
  }

  // Display NEVER blocks, even if execution is running
  if (pipeline === "display" && displayMarketLock) {
    console.log("[MARKET] Display already refreshing, using cache");
    return getMarketSnapshot();
  }

  // Set appropriate lock
  if (pipeline === "execution") {
    executionMarketLock = true;
  } else {
    displayMarketLock = true;
  }

  const now = Date.now();

  try {
    for (const symbol of TRACKED_SYMBOLS) {
      try {
        const priceData = await getPrice(symbol);
        const cache = marketDataCache[symbol];

        if (priceData) {
          cache.priceData = priceData;
          cache.lastUpdate = now;
          delete cache.updateError;
          
          // Mark as execution-grade only if source is Kraken (live or cached)
          cache.isExecutionGrade = priceData.source === "kraken_live" || priceData.source === "kraken_cached";
          
          console.log(
            `[MARKET] ${symbol} ${priceData.source}` + 
            (cache.isExecutionGrade ? " (execution)" : " (display-only)")
          );
        } else {
          cache.isExecutionGrade = false;
          console.log(`[MARKET] ${symbol} fallback only`);
        }
      } catch (err) {
        const cache = marketDataCache[symbol];
        cache.updateError = err instanceof Error ? err.message : String(err);
        cache.isExecutionGrade = false;  // Ensure degraded on error
        console.log(`[MARKET] ${symbol} fallback only (error)`);
      }
    }
  } finally {
    // Release appropriate lock
    if (pipeline === "execution") {
      executionMarketLock = false;
    } else {
      displayMarketLock = false;
    }
  }

  return getMarketSnapshot();
}

// ═══════════════════════════════════════════════════════════════════════════
// CACHE QUERIES: Only strategy engine uses these
// Always return best available value, NEVER null for tracked symbols
// ═══════════════════════════════════════════════════════════════════════════

export function getMarketSnapshot(): SegregatedMarketData {
  const execution: Record<string, PriceData> = {};
  const display: Record<string, PriceData> = {};

  for (const symbol of TRACKED_SYMBOLS) {
    const cache = marketDataCache[symbol];
    const priceData = cache?.priceData;

    if (priceData && cache.isExecutionGrade) {
      // Execution pipeline: Kraken data only
      execution[symbol] = priceData;
    } else if (priceData) {
      // Display pipeline: Fallback data only
      display[symbol] = priceData;
    } else {
      // No data: goes to display pipeline (UI fallback)
      display[symbol] = {
        symbol,
        price: cache?.priceData?.price ?? 0,
        source: "DEGRADED",
        timestamp: cache?.lastUpdate ?? 0,
      } as PriceData;
    }
  }

  return { execution, display };
}

export function getMarketData(symbol: string): PriceData | null {
  const cache = marketDataCache[symbol];
  if (!cache) return null;
  return cache.priceData;
}

export function getAllMarketData(): PriceData[] {
  return TRACKED_SYMBOLS
    .map(symbol => marketDataCache[symbol]?.priceData)
    .filter((priceData): priceData is PriceData => priceData !== null && priceData !== undefined);
}

/**
 * Check if market data is fresh (under 3 seconds old)
 * PURELY informational - signal engine doesn't care, state layer does
 */
export function isMarketDataFresh(symbol: string): boolean {
  const cache = marketDataCache[symbol];
  if (!cache) return false;

  const now = Date.now();
  const dataAge = now - cache.lastUpdate;

  return dataAge < 3000; // 3 seconds
}

/**
 * Get cache status for monitoring
 * NEVER used for decisions, only visibility
 */
export function getCacheStatus(): {
  refreshing: boolean;
  symbols: Record<string, { dataAge: number; fresh: boolean; hasPrice: boolean }>;
} {
  const now = Date.now();
  const symbols: Record<string, any> = {};

  for (const symbol of TRACKED_SYMBOLS) {
    const cache = marketDataCache[symbol];
    const dataAge = now - cache.lastUpdate;
    symbols[symbol] = {
      dataAge,
      fresh: isMarketDataFresh(symbol),
      hasPrice: cache.priceData !== null,
    };
  }

  return {
    refreshing: executionMarketLock || displayMarketLock,  // Either pipeline refreshing
    symbols,
  };
}

