/**
 * Market Data Layer (v4.0.0)
 * Independent, always-on data refresh system
 * Decouples market data fetching from signal generation
 * 
 * ARCHITECTURE:
 * 1. Maintains cached market state for all tracked symbols (BTC, ETH, SOL)
 * 2. Updates on predictable intervals (tickers: 2s, candles: 10s)
 * 3. Global request budget respected (3 req/sec across all symbols)
 * 4. Signal engine consumes cache, never triggers fetches
 * 5. Prevents reload storms caused by retry cascades
 */

import { getPrice, type PriceData } from "./price-router";
import { fetchCandles, type Candle } from "./kraken";
import { resolveSymbol } from "./symbol-resolver";

export type MarketDataCache = {
  symbol: string;
  priceData: PriceData | null;
  candles5m: Candle[] | null;
  candles15m: Candle[] | null;
  candles4h: Candle[] | null;
  lastPriceUpdate: number;
  lastCandlesUpdate: number;
  priceUpdateError?: string;
  candlesUpdateError?: string;
};

// ═══════════════════════════════════════════════════════════════════════════
// GLOBAL CACHE: Market state for all tracked symbols
// ═══════════════════════════════════════════════════════════════════════════
const TRACKED_SYMBOLS = ["BTC", "ETH", "SOL"];
const marketDataCache: Record<string, MarketDataCache> = {};

// Initialize cache for all symbols
for (const symbol of TRACKED_SYMBOLS) {
  marketDataCache[symbol] = {
    symbol,
    priceData: null,
    candles5m: null,
    candles15m: null,
    candles4h: null,
    lastPriceUpdate: 0,
    lastCandlesUpdate: 0,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// MARKET DATA REFRESH: Periodic updates on fixed intervals
// ═══════════════════════════════════════════════════════════════════════════
const PRICE_UPDATE_INTERVAL_MS = 2000; // 2 seconds for tickers
const CANDLES_UPDATE_INTERVAL_MS = 10000; // 10 seconds for candles
const MAX_CONCURRENT_FETCHES = 1; // Serialize to respect rate budget

let isUpdating = false;
let updateTimers: { price?: NodeJS.Timeout; candles?: NodeJS.Timeout } = {};

/**
 * Start market data refresh timers
 * Call this once at application startup
 */
export function startMarketDataRefresh(): void {
  console.log("[MARKET_DATA] Starting market data refresh layer");

  // Price ticker updates (every 2 seconds)
  updateTimers.price = setInterval(() => {
    refreshAllPrices().catch(err => {
      console.error("[MARKET_DATA] Price refresh error:", err);
    });
  }, PRICE_UPDATE_INTERVAL_MS);

  // Candle updates (every 10 seconds)
  updateTimers.candles = setInterval(() => {
    refreshAllCandles().catch(err => {
      console.error("[MARKET_DATA] Candle refresh error:", err);
    });
  }, CANDLES_UPDATE_INTERVAL_MS);

  // Initial fetch
  refreshAllPrices();
  refreshAllCandles();
}

/**
 * Stop market data refresh timers
 * Call during shutdown
 */
export function stopMarketDataRefresh(): void {
  console.log("[MARKET_DATA] Stopping market data refresh layer");
  if (updateTimers.price) clearInterval(updateTimers.price);
  if (updateTimers.candles) clearInterval(updateTimers.candles);
}

/**
 * Refresh all ticker prices (serialized to respect rate budget)
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
          cache.lastPriceUpdate = now;
          delete cache.priceUpdateError;
          console.log(`[MARKET_DATA] ✓ ${symbol}: $${priceData.price.toFixed(2)} (${priceData.source})`);
        } else {
          cache.priceUpdateError = "Failed to fetch price";
          console.warn(`[MARKET_DATA] ✗ ${symbol}: Price fetch failed`);
        }
      } catch (err) {
        const cache = marketDataCache[symbol];
        cache.priceUpdateError = err instanceof Error ? err.message : String(err);
        console.error(`[MARKET_DATA] ${symbol}: Price error:`, cache.priceUpdateError);
      }
    }
  } finally {
    isUpdating = false;
  }
}

/**
 * Refresh all candles (serialized to respect rate budget)
 */
async function refreshAllCandles(): Promise<void> {
  if (isUpdating) {
    console.log("[MARKET_DATA] Candle refresh already in progress, skipping");
    return;
  }

  isUpdating = true;
  const now = Date.now();

  try {
    for (const symbol of TRACKED_SYMBOLS) {
      try {
        const resolved = resolveSymbol(symbol);
        const base = resolved.base;

        // Fetch all required timeframes
        const [candles5m, candles15m, candles4h] = await Promise.all([
          fetchCandles(base, 5, 50).catch(err => {
            console.warn(`[MARKET_DATA] ${symbol}: 5m candle fetch failed:`, err);
            return null;
          }),
          fetchCandles(base, 15, 50).catch(err => {
            console.warn(`[MARKET_DATA] ${symbol}: 15m candle fetch failed:`, err);
            return null;
          }),
          fetchCandles(base, 240, 100).catch(err => {
            console.warn(`[MARKET_DATA] ${symbol}: 4h candle fetch failed:`, err);
            return null;
          }),
        ]);

        const cache = marketDataCache[symbol];
        cache.candles5m = candles5m;
        cache.candles15m = candles15m;
        cache.candles4h = candles4h;
        cache.lastCandlesUpdate = now;
        delete cache.candlesUpdateError;

        const fetchCount = [candles5m, candles15m, candles4h].filter(c => c !== null).length;
        console.log(`[MARKET_DATA] ✓ ${symbol}: ${fetchCount}/3 candle timeframes`);
      } catch (err) {
        const cache = marketDataCache[symbol];
        cache.candlesUpdateError = err instanceof Error ? err.message : String(err);
        console.error(`[MARKET_DATA] ${symbol}: Candle error:`, cache.candlesUpdateError);
      }
    }
  } finally {
    isUpdating = false;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// CACHE QUERIES: Signal engine reads from cache (never fetches)
// ═══════════════════════════════════════════════════════════════════════════

export function getMarketData(symbol: string): MarketDataCache | null {
  const cache = marketDataCache[symbol];
  if (!cache) return null;

  // Return snapshot of current cache state
  return {
    ...cache,
  };
}

export function getAllMarketData(): MarketDataCache[] {
  return TRACKED_SYMBOLS.map(symbol => marketDataCache[symbol]);
}

/**
 * Check if market data is fresh enough for signal generation
 * Price: within 3 seconds (TTL + staleness threshold)
 * Candles: within 15 seconds
 */
export function isMarketDataFresh(symbol: string): boolean {
  const cache = marketDataCache[symbol];
  if (!cache) return false;

  const now = Date.now();
  const priceAge = now - cache.lastPriceUpdate;
  const candlesAge = now - cache.lastCandlesUpdate;

  const priceFresh = priceAge < 3000; // 3s (ticker TTL + staleness)
  const candlesFresh = candlesAge < 15000; // 15s (reasonable lag)

  return priceFresh && candlesFresh;
}

export function getMarketDataFreshness(symbol: string): {
  symbol: string;
  priceFresh: boolean;
  priceAge: number;
  candlesFresh: boolean;
  candlesAge: number;
  overallFresh: boolean;
} {
  const cache = marketDataCache[symbol];
  const now = Date.now();

  if (!cache) {
    return {
      symbol,
      priceFresh: false,
      priceAge: Infinity,
      candlesFresh: false,
      candlesAge: Infinity,
      overallFresh: false,
    };
  }

  const priceAge = now - cache.lastPriceUpdate;
  const candlesAge = now - cache.lastCandlesUpdate;
  const priceFresh = priceAge < 3000;
  const candlesFresh = candlesAge < 15000;

  return {
    symbol,
    priceFresh,
    priceAge,
    candlesFresh,
    candlesAge,
    overallFresh: priceFresh && candlesFresh,
  };
}

/**
 * Get cache status for monitoring
 */
export function getCacheStatus(): {
  refreshing: boolean;
  symbols: Record<string, { dataAge: number; fresh: boolean; hasPrice: boolean; hasCandles: boolean }>;
} {
  const now = Date.now();
  const symbols: Record<string, any> = {};

  for (const symbol of TRACKED_SYMBOLS) {
    const cache = marketDataCache[symbol];
    const dataAge = Math.max(now - cache.lastPriceUpdate, now - cache.lastCandlesUpdate);
    symbols[symbol] = {
      dataAge,
      fresh: isMarketDataFresh(symbol),
      hasPrice: cache.priceData !== null,
      hasCandles: cache.candles15m !== null && cache.candles4h !== null,
    };
  }

  return {
    refreshing: isUpdating,
    symbols,
  };
}
