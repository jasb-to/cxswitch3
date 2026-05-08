/**
 * Request Throttler (v3.3.0)
 * Traffic control layer for Kraken API
 * 
 * Prevents rate limit spikes through:
 * 1. Per-symbol request coalescing (deduplicate in-flight requests)
 * 2. Per-symbol staggered scheduling (BTC: 0ms, ETH: +250ms, SOL: +500ms)
 * 3. Global request budget (max 3 Kraken requests/second)
 * 4. Separate cache TTLs (ticker: 1-2s, candles: 10-60s)
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
// ═══════════════════════════════════════════════════════════════════════════
const SYMBOL_STAGGER_MS: Record<string, number> = {
  BTC: 0,
  ETH: 250,
  SOL: 500,
};

export async function staggerRequest<T>(
  symbol: string,
  fn: () => Promise<T>
): Promise<T> {
  const delay = SYMBOL_STAGGER_MS[symbol] ?? 0;
  if (delay > 0) {
    await new Promise(resolve => setTimeout(resolve, delay));
  }
  return fn();
}

// ═══════════════════════════════════════════════════════════════════════════
// GLOBAL REQUEST BUDGET: Cap Kraken requests per second
// ═══════════════════════════════════════════════════════════════════════════
const MAX_REQUESTS_PER_SECOND = 3;
const requestTimestamps: number[] = [];

export async function acquireRequestBudget(): Promise<void> {
  const now = Date.now();
  const windowStart = now - 1000; // Last 1 second

  // Remove old timestamps outside the 1-second window
  while (requestTimestamps.length > 0 && requestTimestamps[0] < windowStart) {
    requestTimestamps.shift();
  }

  // If we've hit the budget, wait
  if (requestTimestamps.length >= MAX_REQUESTS_PER_SECOND) {
    const oldestRequest = requestTimestamps[0];
    const waitTime = oldestRequest + 1000 - now + 10; // Small buffer
    console.log(`[REQUEST_BUDGET] Throttling: ${requestTimestamps.length}/${MAX_REQUESTS_PER_SECOND} requests in last second, waiting ${waitTime}ms`);
    await new Promise(resolve => setTimeout(resolve, waitTime));
  }

  requestTimestamps.push(Date.now());
}

export function getRequestBudgetStatus(): { current: number; max: number; available: boolean } {
  const now = Date.now();
  const windowStart = now - 1000;
  const recentRequests = requestTimestamps.filter(t => t >= windowStart).length;
  return {
    current: recentRequests,
    max: MAX_REQUESTS_PER_SECOND,
    available: recentRequests < MAX_REQUESTS_PER_SECOND,
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
