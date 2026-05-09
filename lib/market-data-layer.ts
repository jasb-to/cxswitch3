/**
 * Market Data Layer (v4.1.2)
 * Cron-driven refresh only (serverless architecture)
 * Decouples market data fetching from signal generation
 * 
 * ARCHITECTURE:
 * 1. Market refresh triggered ONLY by cron jobs
 * 2. Maintains cached PRICE DATA for all tracked symbols (BTC, ETH, SOL)
 * 3. Global request budget respected (3 req/sec across all symbols)
 * 4. Signal engine consumes cache only, never triggers fetches
 * 5. Zero external API calls during signal route execution
 * 6. No persistent intervals in serverless runtime (prevents duplicate lambdas)
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
// NO background intervals in serverless runtime
// ═══════════════════════════════════════════════════════════════════════════

let isUpdating = false;

/**
 * Refresh all prices from Kraken
 * CALLED BY: cron jobs only
 * This is the ONLY place external market data is fetched
 */
export async function refreshMarketData(): Promise<void> {
  if (isUpdating) {
    console.log("[MARKET_DATA] Refresh already in progress, skipping");
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
          console.log(`[MARKET_DATA] ✓ ${symbol}: $${priceData.price.toFixed(2)} (${priceData.source})`);
        } else {
          cache.updateError = "Failed to fetch price";
          console.warn(`[MARKET_DATA] ✗ ${symbol}: Price fetch failed`);
        }
      } catch (err) {
        const cache = marketDataCache[symbol];
        cache.updateError = err instanceof Error ? err.message : String(err);
        console.error(`[MARKET_DATA] ${symbol}: Price error:`, cache.updateError);
      }
    }
  } finally {
    isUpdating = false;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// CACHE QUERIES: Signal engine reads from cache (never fetches)
// ═══════════════════════════════════════════════════════════════════════════

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
 * Check if market data is fresh enough for signal generation
 * Price: within 3 seconds (ticker cache TTL)
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
