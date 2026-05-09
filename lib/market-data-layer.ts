/**
 * Market Data Layer (v4.1.0)
 * Independent, always-on data refresh system
 * Decouples market data fetching from signal generation
 * 
 * ARCHITECTURE:
 * 1. Maintains cached PRICE DATA for all tracked symbols (BTC, ETH, SOL)
 * 2. Updates on predictable intervals (2 seconds)
 * 3. Global request budget respected (3 req/sec across all symbols)
 * 4. Signal engine consumes cache only, never triggers fetches
 * 5. Zero external API calls during signal route execution
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
// MARKET DATA REFRESH: Periodic updates on fixed intervals
// ═══════════════════════════════════════════════════════════════════════════
const PRICE_UPDATE_INTERVAL_MS = 2000; // 2 seconds for tickers

let isUpdating = false;
let updateTimers: { price?: NodeJS.Timeout } = {};

/**
 * Start market data refresh timers
 * Call this once at application startup
 */
export function startMarketDataRefresh(): void {
  console.log("[MARKET_DATA] Starting market data refresh layer (v4.1.0 - read-only signal engine)");

  // Price updates every 2 seconds
  updateTimers.price = setInterval(() => {
    refreshAllPrices().catch(err => {
      console.error("[MARKET_DATA] Price refresh error:", err);
    });
  }, PRICE_UPDATE_INTERVAL_MS);

  // Initial fetch
  refreshAllPrices();
}

/**
 * Stop market data refresh timers
 * Call during shutdown
 */
export function stopMarketDataRefresh(): void {
  console.log("[MARKET_DATA] Stopping market data refresh layer");
  if (updateTimers.price) clearInterval(updateTimers.price);
}

/**
 * Refresh all prices from Kraken
 * This is the ONLY place external market data is fetched
 * Called periodically by timer, never by signal engine
 */
async function refreshAllPrices(): Promise<void> {
  if (isUpdating) {
    console.log("[MARKET_DATA] Price refresh already in progress, skipping");
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
