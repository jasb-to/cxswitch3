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

// Initialize cache for all symbols with bootstrap prices
for (const symbol of TRACKED_SYMBOLS) {
  marketDataCache[symbol] = {
    symbol,
    priceData: {
      symbol,
      price: symbol === "BTC" ? 45000 : symbol === "ETH" ? 2500 : 150, // Bootstrap prices
      source: "none",
      timestamp: 0,
      health: "OFFLINE",
    },
    lastUpdate: 0,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// MARKET DATA REFRESH: Cron-triggered only
// Dumb job: fetch → cache → return
// ═══════════════════════════════════════════════════════════════════════════

let isUpdating = false;

/**
 * Refresh all prices and return market snapshot
 * CALLED BY: cron jobs only  
 * Returns: market snapshot for strategy engine
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
          cache.priceData = priceData;
          cache.lastUpdate = now;
          delete cache.updateError;
          console.log(`[MARKET] ${symbol} ${priceData.source}`);
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

    if (priceData && priceData.price > 0) {
      snapshot[symbol] = priceData;
    } else {
      // Use bootstrap fallback with reasonable prices
      const bootstrapPrices: Record<string, number> = {
        BTC: 45000,
        ETH: 2500,
        SOL: 150,
      };
      
      snapshot[symbol] = {
        symbol,
        price: bootstrapPrices[symbol] ?? 0,
        source: "none",
        timestamp: cache?.lastUpdate ?? 0,
        health: "OFFLINE",
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

