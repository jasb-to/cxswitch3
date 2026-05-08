/**
 * Price Router (v3.3.0)
 * Primary + Secondary + Safety State Architecture with Traffic Control
 * 
 * PRIMARY: Kraken ticker (execution-grade, with retry + backoff + circuit breaker)
 * SECONDARY: CoinGecko (fallback-only, for visual continuity)
 * SAFETY: Hard gates prevent trading on degraded data
 * 
 * STABILITY LAYER (v3.3.0 improvements):
 * - Request throttler: per-symbol staggering, coalescing, global budget
 * - Separate cache TTLs: ticker 1.5s, candles 30s (prevent over-fetch)
 * - Split source into 3 states: "kraken_live" | "kraken_cached" | "coingecko"
 * - Exponential backoff retry (2 retries, 100ms → 500ms)
 * - Differentiated circuit breaker (only escalate on EMPTY_RESPONSE / repeated TIMEOUT)
 * - Staleness flag in cache (prevent false LIVE from stale prices)
 */

import { resolveSymbol } from "@/lib/symbol-resolver";
import { 
  trackRequest, 
  getInFlightRequest, 
  staggerRequest, 
  acquireRequestBudget,
  TICKER_CACHE_TTL_MS,
  STALENESS_THRESHOLD_MS,
} from "@/lib/request-throttler";

export type PriceSource = "kraken_live" | "kraken_cached" | "coingecko" | "none";
export type PriceHealth = "LIVE" | "DEGRADED" | "OFFLINE";
export type KrakenFailureType = "EMPTY_RESPONSE" | "TIMEOUT" | "HTTP_ERROR" | "API_ERROR" | "INVALID_PRICE";

export interface PriceData {
  price: number;
  source: PriceSource;
  health: PriceHealth;
  bid?: number;
  ask?: number;
  timestamp: number;
  isStale?: boolean; // NEW: Flag to prevent false LIVE from stale cache
}

// ═══════════════════════════════════════════════════════════════════════════
// CIRCUIT BREAKER: Differentiated failure tracking for Kraken feed
// Only escalate breaker on real failures (EMPTY_RESPONSE, repeated TIMEOUT)
// ═══════════════════════════════════════════════════════════════════════════
const circuitBreaker: Record<string, { 
  failCount: number; 
  lastFailTime: number; 
  isOpen: boolean;
  recentFailures: KrakenFailureType[];
}> = {};

function getCircuitBreakerState(symbol: string) {
  if (!circuitBreaker[symbol]) {
    circuitBreaker[symbol] = { failCount: 0, lastFailTime: 0, isOpen: false, recentFailures: [] };
  }
  return circuitBreaker[symbol];
}

function isCircuitBreakerOpen(symbol: string): boolean {
  const state = getCircuitBreakerState(symbol);

  // Circuit opens after 5 escalating failures
  if (state.failCount >= 5) {
    // Close after 30s cooldown
    if (Date.now() - state.lastFailTime > 30000) {
      state.failCount = 0;
      state.recentFailures = [];
      state.isOpen = false;
      console.log(`[CIRCUIT_BREAKER] ${symbol}: Recovered after cooldown`);
      return false;
    }
    state.isOpen = true;
    return true;
  }

  return false;
}

/**
 * Record Kraken failure with differentiated type tracking
 * Only escalate circuit breaker on critical failures (EMPTY_RESPONSE, repeated TIMEOUT)
 */
function recordKrakenFailure(symbol: string, failureType: KrakenFailureType) {
  const state = getCircuitBreakerState(symbol);
  state.recentFailures.push(failureType);

  // Keep last 5 failures for pattern detection
  if (state.recentFailures.length > 5) {
    state.recentFailures.shift();
  }

  // Only escalate breaker on:
  // 1. EMPTY_RESPONSE (persistent missing data)
  // 2. Repeated TIMEOUT (3+ in last 5 failures = broken connection)
  let shouldEscalate = false;

  if (failureType === "EMPTY_RESPONSE") {
    shouldEscalate = true;
    console.log(`[CIRCUIT_BREAKER] ${symbol}: EMPTY_RESPONSE — escalating (critical failure)`);
  } else if (failureType === "TIMEOUT") {
    const recentTimeouts = state.recentFailures.filter(f => f === "TIMEOUT").length;
    if (recentTimeouts >= 3) {
      shouldEscalate = true;
      console.log(`[CIRCUIT_BREAKER] ${symbol}: Repeated TIMEOUT (${recentTimeouts}/5) — escalating`);
    } else {
      console.log(`[CIRCUIT_BREAKER] ${symbol}: TIMEOUT (transient, ${recentTimeouts}/5) — not escalating`);
    }
  } else {
    // HTTP_ERROR, API_ERROR, INVALID_PRICE are transient — don't escalate
    console.log(`[CIRCUIT_BREAKER] ${symbol}: ${failureType} (transient) — not escalating`);
  }

  if (shouldEscalate) {
    state.failCount++;
    state.lastFailTime = Date.now();
    console.log(`[CIRCUIT_BREAKER] ${symbol}: Escalated count: ${state.failCount}/5`);
  }
}

function recordKrakenSuccess(symbol: string) {
  const state = getCircuitBreakerState(symbol);
  state.failCount = 0;
  state.recentFailures = [];
}

// ═══════════════════════════════════════════════════════════════════════════
// PRICE CACHE: Last-known-good prices with staleness tracking (1.5s TTL)
// Downgrade to DEGRADED if price exceeds staleness threshold (0.75s)
// ═══════════════════════════════════════════════════════════════════════════
const priceCache: Record<string, { data: PriceData; cachedAt: number }> = {};
const CACHE_TTL_MS = TICKER_CACHE_TTL_MS; // 1.5 second TTL (prevent over-fetch)
const STALENESS_THRESHOLD = STALENESS_THRESHOLD_MS; // 0.75 second staleness threshold

function getCachedPrice(symbol: string): PriceData | null {
  const cached = priceCache[symbol];
  if (!cached) return null;

  const age = Date.now() - cached.cachedAt;
  
  // Hard TTL: beyond 1.5s, discard
  if (age > CACHE_TTL_MS) {
    delete priceCache[symbol];
    console.log(`[CACHE] ${symbol}: Expired (age: ${age}ms > TTL: ${CACHE_TTL_MS}ms)`);
    return null;
  }

  // Soft staleness: beyond 0.75s, mark as stale (will downgrade to DEGRADED)
  const isStale = age > STALENESS_THRESHOLD;
  const data = {
    ...cached.data,
    isStale,
  };

  if (isStale) {
    console.log(`[CACHE] ${symbol}: Hit but STALE (age: ${age}ms > staleness: ${STALENESS_THRESHOLD}ms)`);
  } else {
    console.log(`[CACHE] ${symbol}: Hit (age: ${age}ms, fresh)`);
  }

  return data;
}

function setCachedPrice(symbol: string, data: PriceData) {
  priceCache[symbol] = { data, cachedAt: Date.now() };
  console.log(`[CACHE] ${symbol}: Set (TTL: ${CACHE_TTL_MS}ms)`);
}

/**
 * Fetch price from Kraken with retry + backoff + differentiated circuit breaker + throttling
 * Uses request coalescing to deduplicate in-flight requests
 * Uses staggering and global budget to prevent rate spikes
 */
async function getPriceFromKraken(symbol: string): Promise<PriceData | null> {
  try {
    const resolved = resolveSymbol(symbol);
    const { base } = resolved;

    // REQUEST COALESCING: If BTC is already being fetched, return that promise
    const coalesceKey = `kraken_ticker_${base}`;
    const inFlight = getInFlightRequest(coalesceKey);
    if (inFlight) {
      console.log(`[KRAKEN] ${base}: Request in-flight, coalescing...`);
      return inFlight;
    }

    // Acquire request budget (throttles if too many requests/second)
    await acquireRequestBudget();

    // Create the fetch promise with staggering and tracking
    const fetchPromise = staggerRequest(base, async () => {
      // Check circuit breaker
      if (isCircuitBreakerOpen(base)) {
        console.warn(`[KRAKEN] Circuit breaker OPEN for ${base} — skipping attempts`);
        return null;
      }

      const { krakenTicker } = resolved;

      // Retry logic with exponential backoff: 2 retries (100ms, 500ms)
      const maxRetries = 2;
      let lastError: Error | null = null;
      let lastFailureType: KrakenFailureType = "HTTP_ERROR";

      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 5000); // 5s timeout

          let response;
          try {
            response = await fetch(
              `https://api.kraken.com/0/public/Ticker?pair=${krakenTicker}`,
              { signal: controller.signal }
            );
          } finally {
            clearTimeout(timeoutId);
          }

          if (!response.ok) {
            lastError = new Error(`HTTP ${response.status}`);
            lastFailureType = "HTTP_ERROR";
            if (attempt < maxRetries) {
              const backoff = attempt === 0 ? 100 : 500;
              console.warn(`[KRAKEN] Attempt ${attempt + 1}/${maxRetries + 1}: ${lastError.message}, retrying in ${backoff}ms`);
              await new Promise(resolve => setTimeout(resolve, backoff));
              continue;
            }
            throw lastError;
          }

          const data = await response.json();

          if (data.error && data.error.length > 0) {
            lastError = new Error(`API error: ${data.error[0]}`);
            lastFailureType = "API_ERROR";
            if (attempt < maxRetries) {
              const backoff = attempt === 0 ? 100 : 500;
              console.warn(`[KRAKEN] Attempt ${attempt + 1}/${maxRetries + 1}: ${lastError.message}, retrying in ${backoff}ms`);
              await new Promise(resolve => setTimeout(resolve, backoff));
              continue;
            }
            throw lastError;
          }

          const tickerData = data.result?.[krakenTicker];
          if (!tickerData) {
            // CRITICAL: Empty response is pattern indicating persistent missing data
            lastError = new Error("No ticker data returned");
            lastFailureType = "EMPTY_RESPONSE";
            if (attempt < maxRetries) {
              const backoff = attempt === 0 ? 100 : 500;
              console.warn(`[KRAKEN] Attempt ${attempt + 1}/${maxRetries + 1}: ${lastError.message}, retrying in ${backoff}ms`);
              await new Promise(resolve => setTimeout(resolve, backoff));
              continue;
            }
            throw lastError;
          }

          const lastTrade = tickerData.c?.[0];
          const bid = parseFloat(tickerData.b?.[0] ?? 0);
          const ask = parseFloat(tickerData.a?.[0] ?? 0);
          const price = lastTrade ? parseFloat(lastTrade) : (bid + ask) / 2;

          if (!price || isNaN(price)) {
            lastError = new Error("Invalid price data");
            lastFailureType = "INVALID_PRICE";
            if (attempt < maxRetries) {
              const backoff = attempt === 0 ? 100 : 500;
              console.warn(`[KRAKEN] Attempt ${attempt + 1}/${maxRetries + 1}: ${lastError.message}, retrying in ${backoff}ms`);
              await new Promise(resolve => setTimeout(resolve, backoff));
              continue;
            }
            throw lastError;
          }

          // Success
          const priceData: PriceData = {
            price,
            source: "kraken_live", // Explicit: live execution feed
            health: "LIVE",
            bid,
            ask,
            timestamp: Math.floor(Date.now() / 1000),
            isStale: false,
          };

          recordKrakenSuccess(base);
          setCachedPrice(base, priceData);
          console.log(`[KRAKEN] ✓ ${base}: $${price.toFixed(2)} (attempt ${attempt + 1}/${maxRetries + 1}, coalesced)`);
          return priceData;
        } catch (err) {
          if (err instanceof Error && err.name === "AbortError") {
            lastError = new Error("Timeout (5s)");
            lastFailureType = "TIMEOUT";
          } else {
            lastError = err instanceof Error ? err : new Error(String(err));
          }
          // Continue to next retry or fallback
        }
      }

      // All retries exhausted — record failure with type
      recordKrakenFailure(base, lastFailureType);
      console.warn(`[KRAKEN] All retries exhausted for ${base}: ${lastError?.message} (type: ${lastFailureType})`);
      return null;
    });

    // Track the fetch promise for coalescing
    return trackRequest(coalesceKey, fetchPromise);
  } catch (err) {
    recordKrakenFailure(symbol, "HTTP_ERROR");
    console.warn(`[KRAKEN] Exception:`, err instanceof Error ? err.message : String(err));
    return null;
  }
}

/**
 * Fetch price from CoinGecko (secondary, fallback-only)
 * Only used when Kraken fails. Provides visual continuity but NOT trading-grade.
 */
async function getPriceFromCoinGecko(symbol: string): Promise<PriceData | null> {
  try {
    const resolved = resolveSymbol(symbol);
    const { base } = resolved;

    // CoinGecko coin IDs for common assets
    const coinMap: Record<string, string> = {
      BTC: "bitcoin",
      ETH: "ethereum",
      SOL: "solana",
    };

    const coinId = coinMap[base];
    if (!coinId) {
      console.warn(`[COINGECKO] No mapping for ${base}`);
      return null;
    }

    const response = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${coinId}&vs_currencies=usd`,
      { next: { revalidate: 60 } } // Cache for 60 seconds
    );

    if (!response.ok) {
      console.warn(`[COINGECKO] HTTP ${response.status} for ${base}`);
      return null;
    }

    const data = await response.json();
    const price = data[coinId]?.usd;

    if (!price || isNaN(price)) {
      console.warn(`[COINGECKO] Invalid price for ${base}`);
      return null;
    }

    console.log(`[COINGECKO] ⚠ ${base}: $${price.toFixed(2)} (FALLBACK only, not execution-grade)`);

    return {
      price,
      source: "coingecko",
      health: "DEGRADED", // Always DEGRADED when using CoinGecko
      timestamp: Math.floor(Date.now() / 1000),
    };
  } catch (err) {
    console.warn(`[COINGECKO] Exception:`, err instanceof Error ? err.message : String(err));
    return null;
  }
}

/**
 * Price Router: Try Kraken first, fallback to CoinGecko, use cache for stability
 * NEW: Downgrade stale cached prices to DEGRADED instead of returning as LIVE
 * NEW: Return kraken_cached when using cache, kraken_live when fetching fresh
 * Returns explicit health status for gate enforcement
 */
export async function getPrice(symbol: string): Promise<PriceData | null> {
  const resolved = resolveSymbol(symbol);
  const { base } = resolved;

  // Check cache first (for stability during transient failures)
  const cached = getCachedPrice(base);
  if (cached && (cached.source === "kraken_live" || cached.source === "kraken_cached")) {
    if (cached.isStale) {
      // Downgrade stale cache to DEGRADED to prevent false LIVE status
      console.log(`[PRICE_ROUTER] Using stale Kraken cache for ${base} — downgrading to DEGRADED`);
      return {
        ...cached,
        source: "kraken_cached", // Explicit: this is cached, not live
        health: "DEGRADED",
      };
    }
    // Fresh cache, mark as cached and return as LIVE (but source indicates it's cached)
    return {
      ...cached,
      source: "kraken_cached", // Explicit: this is cached, not live feed
    };
  }

  // Try primary feed (Kraken)
  const krakenPrice = await getPriceFromKraken(base);
  if (krakenPrice) {
    return krakenPrice; // LIVE with kraken_live source
  }

  // Kraken failed, check cache before fallback
  if (cached && (cached.source === "kraken_live" || cached.source === "kraken_cached")) {
    if (cached.isStale) {
      // Downgrade stale cache to DEGRADED
      console.log(`[PRICE_ROUTER] Kraken failed, using stale cache for ${base} — downgrading to DEGRADED`);
      return {
        ...cached,
        source: "kraken_cached", // Explicit: this is cached fallback
        health: "DEGRADED",
      };
    }
    // Cache is fresh, still OK for execution but mark as cached
    console.log(`[PRICE_ROUTER] Kraken failed, using fresh cached price for ${base}`);
    return {
      ...cached,
      source: "kraken_cached", // Explicit: this is cached, not live feed
    };
  }

  console.log(`[PRICE_ROUTER] Kraken failed for ${base}, attempting CoinGecko fallback...`);

  // Try secondary feed (CoinGecko)
  const coingeckoPrice = await getPriceFromCoinGecko(base);
  if (coingeckoPrice) {
    return coingeckoPrice; // DEGRADED (visual only, no trading)
  }

  // Both feeds failed
  console.error(`[PRICE_ROUTER] All feeds failed for ${base}`);
  return null; // OFFLINE
}
