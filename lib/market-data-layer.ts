/**
 * Market Data Layer (v5 - DUMB INPUT ONLY)
 * 
 * Job:
 * - Fetch prices
 * - Cache latest snapshot
 * - NEVER skip symbols
 * - NEVER mark degraded
 * - NEVER make decisions
 * 
 * Always returns last known value, even if broken
 * 
 * RULE: This layer has ZERO logic
 */

import { getPrice, type PriceData } from "./price-router";

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
 * Refresh all prices from Kraken
 * CALLED BY: cron jobs only
 * RULE: NEVER skip symbols, NEVER decide they're degraded
 */
export async function refreshMarketData(): Promise<void> {
  if (isUpdating) {
    console.log("[MARKET] Refresh already in progress, skipping");
    return;
  }

  isUpdating = true;
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
          console.log(`[MARKET] ${symbol}: $${priceData.price.toFixed(2)}`);
        } else {
          console.warn(`[MARKET] ${symbol}: Fetch returned null, keeping last value`);
          // NEVER clear the cache - keep last known price
        }
      } catch (err) {
        const cache = marketDataCache[symbol];
        cache.updateError = err instanceof Error ? err.message : String(err);
        console.warn(`[MARKET] ${symbol}: Error (keeping stale price): ${cache.updateError}`);
        // NEVER clear the cache - keep last known price
      }
    }
  } finally {
    isUpdating = false;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// CACHE QUERIES: Signal engine reads from cache (never fetches)
// Always returns best available value
// ═══════════════════════════════════════════════════════════════════════════

export function getMarketSnapshot(): Record<string, number> {
  const snapshot: Record<string, number> = {};

  for (const symbol of TRACKED_SYMBOLS) {
    const cache = marketDataCache[symbol];
    const price = cache?.priceData?.price ?? 0;
    snapshot[symbol] = price;
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

