/**
 * Market Data Layer (v4.1.0)
 * Independent, always-on data refresh system with full context caching
 * Decouples market data fetching from signal generation
 * 
 * ARCHITECTURE:
 * 1. Maintains FULL MarketContext for all tracked symbols (BTC, ETH, SOL)
 * 2. Updates on predictable intervals (tickers: 2s, candles: 10s)
 * 3. Global request budget respected (3 req/sec across all symbols)
 * 4. Signal engine consumes cache only, never triggers fetches
 * 5. Zero external API calls during signal route execution
 */

import { getPrice, type PriceData } from "./price-router";
import { fetchCandles, type Candle } from "./kraken";
import { resolveSymbol } from "./symbol-resolver";
import { analyzeSymbol, type MarketContext } from "./strategy";

export type MarketDataCache = {
  symbol: string;
  context: MarketContext | null; // FULL context with all analysis
  lastUpdate: number;
  updateError?: string;
};

// ═══════════════════════════════════════════════════════════════════════════
// GLOBAL CACHE: Full market contexts for all tracked symbols
// ═══════════════════════════════════════════════════════════════════════════
const TRACKED_SYMBOLS = ["BTC", "ETH", "SOL"];
const marketDataCache: Record<string, MarketDataCache> = {};

// Initialize cache for all symbols
for (const symbol of TRACKED_SYMBOLS) {
  marketDataCache[symbol] = {
    symbol,
    context: null,
    lastUpdate: 0,
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
  console.log("[MARKET_DATA] Starting market data refresh layer (v4.1.0 - read-only signal engine)");

  // Combined context updates (every 2 seconds for prices, 10s for candles, we'll do both together)
  updateTimers.price = setInterval(() => {
    refreshAllMarketContexts().catch(err => {
      console.error("[MARKET_DATA] Context refresh error:", err);
    });
  }, 2000);

  // Initial fetch
  refreshAllMarketContexts();
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
 * Refresh market data by computing full contexts for all symbols
 * This is the ONLY place external market data is fetched
 * Called periodically by timers, never by signal engine
 */
async function refreshAllMarketContexts(): Promise<void> {
  if (isUpdating) {
    console.log("[MARKET_DATA] Context refresh already in progress, skipping");
    return;
  }

  isUpdating = true;
  const now = Date.now();

  try {
    for (const symbol of TRACKED_SYMBOLS) {
      try {
        // analyzeSymbol computes full context: prices, candles, analysis (ADX, RSI, EMAs, swings)
        const context = await analyzeSymbol(symbol);
        const cache = marketDataCache[symbol];

        if (context && !context.error) {
          cache.context = context;
          cache.lastUpdate = now;
          delete cache.updateError;
          console.log(`[MARKET_DATA] ✓ ${symbol}: Context computed (${context.priceHealth})`);
        } else {
          cache.updateError = context?.setupText || "Failed to compute context";
          console.warn(`[MARKET_DATA] ✗ ${symbol}: Context computation failed - ${cache.updateError}`);
        }
      } catch (err) {
        const cache = marketDataCache[symbol];
        cache.updateError = err instanceof Error ? err.message : String(err);
        console.error(`[MARKET_DATA] ${symbol}: Context error:`, cache.updateError);
      }
    }
  } finally {
    isUpdating = false;
  }
}
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

export function getMarketData(symbol: string): MarketContext | null {
  const cache = marketDataCache[symbol];
  if (!cache) return null;
  return cache.context;
}

export function getAllMarketData(): MarketContext[] {
  return TRACKED_SYMBOLS
    .map(symbol => marketDataCache[symbol]?.context)
    .filter((context): context is MarketContext => context !== null && context !== undefined);
}

/**
 * Check if market data is fresh enough for signal generation
 * Context: within 3 seconds (aggressive, ensures real-time feel)
 */
export function isMarketDataFresh(symbol: string): boolean {
  const cache = marketDataCache[symbol];
  if (!cache) return false;

  const now = Date.now();
  const contextAge = now - cache.lastUpdate;

  return contextAge < 3000; // 3 seconds
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
