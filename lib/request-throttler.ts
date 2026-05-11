/**
 * Request Throttler (v3.3.1)
 * Traffic control layer for Kraken API with retry priority differentiation
 * 
 * Prevents rate limit spikes through:
 * 1. Per-symbol request coalescing (deduplicate in-flight requests)
 * 2. Per-symbol staggered scheduling (BTC: 0ms, ETH: +250ms, SOL: +500ms)
 * 3. Global request budget (max 3 Kraken requests/second)
 * 4. Retry priority differentiation (retries bypass stagger, respect budget)
 * 5. Separate cache TTLs (ticker: 1-2s, candles: 10-60s)
 */

// ═══════════════════════════════════════════════════════════════════════════
// REQUEST COALESCING: Deduplicate in-flight requests per symbol
// ═══════════════════════════════════════════════════════════════════════════
const inFlightRequests: Record<string, Promise<any>> = {};

export function trackRequest<T>(key: string, promise: Promise<T>): Promise<T> {
  inFlightRequests[key] = promise;
  return promise.finally(() => {
    delete inFlightRequests[key];
  });
}

export function getInFlightRequest(key: string): Promise<any> | undefined {
  return inFlightRequests[key];
}

// ═══════════════════════════════════════════════════════════════════════════
// PER-SYMBOL SCHEDULING: Stagger fetch times to avoid rate spikes
// NEW: Retry priority differentiation — retries bypass stagger delay
// v8.0.3 OPTIMIZATION: Reduced stagger delays from 0/250/500 to 0/100/150 for faster market refresh
// ═══════════════════════════════════════════════════════════════════════════
const SYMBOL_STAGGER_MS: Record<string, number> = {
  BTC: 0,
  ETH: 100,    // v8.0.3: Reduced from 250ms
  SOL: 150,    // v8.0.3: Reduced from 500ms
};

export async function staggerRequest<T>(
  symbol: string,
  fn: () => Promise<T>,
  isRetry: boolean = false // NEW: flag to bypass stagger for retries
): Promise<T> {
  // Retries bypass staggering to prevent retry storms from cascading delays
  if (!isRetry) {
    const delay = SYMBOL_STAGGER_MS[symbol] ?? 0;
    if (delay > 0) {
      console.log(`[STAGGER] ${symbol}: Delaying ${delay}ms (fresh request stagger)`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  } else {
    console.log(`[STAGGER] ${symbol}: Bypass stagger (retry, respects budget only)`);
  }
  return fn();
}

// ═══════════════════════════════════════════════════════════════════════════
// GLOBAL REQUEST BUDGET: Cap Kraken requests per second
// Retries still consume budget but don't get delayed queue backlog
// ═══════════════════════════════════════════════════════════════════════════
const MAX_REQUESTS_PER_SECOND = 3;
const requestTimestamps: { timestamp: number; isRetry: boolean }[] = [];

export async function acquireRequestBudget(isRetry: boolean = false): Promise<void> {
  const now = Date.now();
  const windowStart = now - 1000; // Last 1 second

  // Remove old timestamps outside the 1-second window
  while (requestTimestamps.length > 0 && requestTimestamps[0].timestamp < windowStart) {
    requestTimestamps.shift();
  }

  // If we've hit the budget, wait
  if (requestTimestamps.length >= MAX_REQUESTS_PER_SECOND) {
    const oldestRequest = requestTimestamps[0];
    const waitTime = oldestRequest.timestamp + 1000 - now + 10; // Small buffer
    const retryLabel = isRetry ? " (retry)" : "";
    console.log(`[REQUEST_BUDGET] Throttling${retryLabel}: ${requestTimestamps.length}/${MAX_REQUESTS_PER_SECOND} requests in last second, waiting ${waitTime}ms`);
    await new Promise(resolve => setTimeout(resolve, waitTime));
  }

  requestTimestamps.push({ timestamp: Date.now(), isRetry });
  console.log(`[REQUEST_BUDGET] Acquired: ${requestTimestamps.length}/${MAX_REQUESTS_PER_SECOND} (${isRetry ? 'retry' : 'fresh'})`);
}

export function getRequestBudgetStatus(): { current: number; max: number; available: boolean; retryCount: number } {
  const now = Date.now();
  const windowStart = now - 1000;
  const recent = requestTimestamps.filter(t => t.timestamp >= windowStart);
  const retryCount = recent.filter(t => t.isRetry).length;
  return {
    current: recent.length,
    max: MAX_REQUESTS_PER_SECOND,
    available: recent.length < MAX_REQUESTS_PER_SECOND,
    retryCount,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// CACHE TTL MANAGEMENT: Separate ticker from candles
// ═══════════════════════════════════════════════════════════════════════════
export const TICKER_CACHE_TTL_MS = 1500; // 1.5 seconds (aggressive, prevents over-fetch)
export const CANDLES_CACHE_TTL_MS = 30000; // 30 seconds (less frequent, already cached well)
export const STALENESS_THRESHOLD_MS = 750; // 0.75 seconds (half of ticker TTL)

export function getTickerCacheTTL(): number {
  return TICKER_CACHE_TTL_MS;
}

export function getCandlesCacheTTL(): number {
  return CANDLES_CACHE_TTL_MS;
}
