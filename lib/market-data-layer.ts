/**
 * Market Data Layer (v6 - INCLUDE CANDLE HISTORY)
 * 
 * Job:
 * - Fetch prices AND candles
 * - Cache latest snapshot including OHLCV history
 * - NEVER skip symbols
 * - NEVER mark degraded
 * - NEVER make decisions
 * 
 * Always returns last known value, even if broken
 * 
 * RULE: This layer has ZERO logic
 */

import { getPrice, type PriceData } from "./price-router";
import { fetchCandles } from "./kraken";

export type MarketDataCache = {
  symbol: string;
  priceData: PriceData | null;
  lastUpdate: number;
  updateError?: string;
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
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// MARKET DATA REFRESH: Cron-triggered only
// Dumb job: fetch → cache → return
// ═══════════════════════════════════════════════════════════════════════════

let isUpdating = false;

/**
 * Refresh all prices and candles, return market snapshot
 * CALLED BY: cron jobs only  
 * Returns: market snapshot for strategy engine (includes OHLCV history)
 * RULE: NEVER skip symbols, always return all
 */
export async function refreshMarketData(): Promise<Record<string, PriceData>> {
  if (isUpdating) {
    console.log("[MARKET] Already updating");
    return getMarketSnapshot();
  }

  isUpdating = true;
  const now = Date.now();

  try {
    for (const symbol of TRACKED_SYMBOLS) {
      try {
        const priceData = await getPrice(symbol);
        const cache = marketDataCache[symbol];

        if (priceData) {
          // Fetch candles in parallel (15-minute interval for recent history)
          try {
            const candleData = await fetchCandles(symbol, 15, 200);
            priceData.candles = candleData.candles;
          } catch (err) {
            console.log(`[MARKET] ${symbol} candles DEGRADED: ${err instanceof Error ? err.message : String(err)}`);
            // Continue with price-only data if candles fail
          }

          cache.priceData = priceData;
          cache.lastUpdate = now;
          delete cache.updateError;
          console.log(`[MARKET] ${symbol} ${priceData.source} + ${priceData.candles?.length || 0} candles`);
        } else {
          console.log(`[MARKET] ${symbol} DEGRADED`);
        }
      } catch (err) {
        const cache = marketDataCache[symbol];
        cache.updateError = err instanceof Error ? err.message : String(err);
        console.log(`[MARKET] ${symbol} DEGRADED`);
      }
    }
  } finally {
    isUpdating = false;
  }

  return getMarketSnapshot();
}

// ═══════════════════════════════════════════════════════════════════════════
// CACHE QUERIES: Only strategy engine uses these
// Always return best available value, NEVER null for tracked symbols
// ═══════════════════════════════════════════════════════════════════════════

export function getMarketSnapshot(): Record<string, PriceData> {
  const snapshot: Record<string, PriceData> = {};

  for (const symbol of TRACKED_SYMBOLS) {
    const cache = marketDataCache[symbol];
    const priceData = cache?.priceData;

    if (priceData) {
      snapshot[symbol] = priceData;
    } else {
      // NEVER return null - use fallback with last known price
      snapshot[symbol] = {
        symbol,
        price: cache?.priceData?.price ?? 0,
        source: "DEGRADED",
        timestamp: cache?.lastUpdate ?? 0,
      } as PriceData;
    }
  }

  return snapshot;
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
    refreshing: isUpdating,
    symbols,
  };
}

