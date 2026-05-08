/**
 * Price Router (v3.2.1)
 * Primary + Secondary + Safety State Architecture
 * 
 * PRIMARY: Kraken ticker (execution-grade, with retry + backoff + circuit breaker)
 * SECONDARY: CoinGecko (fallback-only, for visual continuity)
 * SAFETY: Hard gates prevent trading on degraded data
 * 
 * STABILITY LAYER:
 * - Exponential backoff retry (2 retries, 100ms → 500ms)
 * - Circuit breaker (after 5 failures, cooldown 30s)
 * - Last-known-good cache (1-5s TTL for execution safety)
 */

import { resolveSymbol } from "@/lib/symbol-resolver";

export type PriceSource = "kraken" | "coingecko" | "none";
export type PriceHealth = "LIVE" | "DEGRADED" | "OFFLINE";

export interface PriceData {
  price: number;
  source: PriceSource;
  health: PriceHealth;
  bid?: number;
  ask?: number;
  timestamp: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// CIRCUIT BREAKER: Track Kraken feed health
// ═══════════════════════════════════════════════════════════════════════════
const circuitBreaker: Record<string, { failCount: number; lastFailTime: number; isOpen: boolean }> = {};

function isCircuitBreakerOpen(symbol: string): boolean {
  const state = circuitBreaker[symbol];
  if (!state) return false;

  // Circuit opens after 5 consecutive failures
  if (state.failCount >= 5) {
    // Close after 30s cooldown
    if (Date.now() - state.lastFailTime > 30000) {
      state.failCount = 0;
      state.isOpen = false;
      console.log(`[CIRCUIT_BREAKER] ${symbol}: Recovered after cooldown`);
      return false;
    }
    state.isOpen = true;
    return true;
  }

  return false;
}

function recordKrakenFailure(symbol: string) {
  if (!circuitBreaker[symbol]) {
    circuitBreaker[symbol] = { failCount: 0, lastFailTime: 0, isOpen: false };
  }
  circuitBreaker[symbol].failCount++;
  circuitBreaker[symbol].lastFailTime = Date.now();
  console.log(`[CIRCUIT_BREAKER] ${symbol}: Failure ${circuitBreaker[symbol].failCount}/5`);
}

function recordKrakenSuccess(symbol: string) {
  if (circuitBreaker[symbol]) {
    circuitBreaker[symbol].failCount = 0;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// PRICE CACHE: Last-known-good prices (1-5s TTL for stability)
// ═══════════════════════════════════════════════════════════════════════════
const priceCache: Record<string, { data: PriceData; timestamp: number }> = {};
const CACHE_TTL_MS = 3000; // 3 second TTL

function getCachedPrice(symbol: string): PriceData | null {
  const cached = priceCache[symbol];
  if (!cached) return null;

  const age = Date.now() - cached.timestamp;
  if (age > CACHE_TTL_MS) {
    delete priceCache[symbol];
    return null;
  }

  console.log(`[CACHE] ${symbol}: Hit (age: ${age}ms, TTL: ${CACHE_TTL_MS}ms)`);
  return cached.data;
}

function setCachedPrice(symbol: string, data: PriceData) {
  priceCache[symbol] = { data, timestamp: Date.now() };
}

/**
 * Fetch price from Kraken with retry + backoff + circuit breaker
 * Returns null if circuit is open or all retries exhausted
 */
async function getPriceFromKraken(symbol: string): Promise<PriceData | null> {
  try {
    // Check circuit breaker
    if (isCircuitBreakerOpen(symbol)) {
      console.warn(`[KRAKEN] Circuit breaker OPEN for ${symbol} — skipping attempts`);
      return null;
    }

    const resolved = resolveSymbol(symbol);
    const { krakenTicker, base } = resolved;

    // Retry logic with exponential backoff: 2 retries (100ms, 500ms)
    const maxRetries = 2;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const response = await fetch(
          `https://api.kraken.com/0/public/Ticker?pair=${krakenTicker}`,
          { signal: AbortSignal.timeout(5000) } // 5s timeout
        );

        if (!response.ok) {
          lastError = new Error(`HTTP ${response.status}`);
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
          lastError = new Error("No ticker data returned");
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
          source: "kraken",
          health: "LIVE",
          bid,
          ask,
          timestamp: Math.floor(Date.now() / 1000),
        };

        recordKrakenSuccess(base);
        setCachedPrice(base, priceData);
        console.log(`[KRAKEN] ✓ ${base}: $${price.toFixed(2)} (attempt ${attempt + 1}/${maxRetries + 1})`);
        return priceData;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        // Continue to next retry or fallback
      }
    }

    // All retries exhausted
    recordKrakenFailure(symbol);
    console.warn(`[KRAKEN] All retries exhausted for ${base}: ${lastError?.message}`);
    return null;
  } catch (err) {
    recordKrakenFailure(symbol);
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
 * Returns explicit health status for gate enforcement
 */
export async function getPrice(symbol: string): Promise<PriceData | null> {
  const resolved = resolveSymbol(symbol);
  const { base } = resolved;

  // Check cache first (for stability during transient failures)
  const cached = getCachedPrice(base);
  if (cached && cached.source === "kraken") {
    return cached; // Use cached LIVE price if available
  }

  // Try primary feed (Kraken)
  const krakenPrice = await getPriceFromKraken(base);
  if (krakenPrice) {
    return krakenPrice; // LIVE
  }

  // Kraken failed, check cache before fallback (still execution-grade if recent)
  if (cached && cached.source === "kraken") {
    console.log(`[PRICE_ROUTER] Kraken failed, using cached price for ${base}`);
    return cached; // Last-known-good, still LIVE for execution
  }

  console.log(`[PRICE_ROUTER] Kraken failed for ${base}, attempting fallback...`);

  // Try secondary feed (CoinGecko)
  const coingeckoPrice = await getPriceFromCoinGecko(base);
  if (coingeckoPrice) {
    return coingeckoPrice; // DEGRADED (visual only, no trading)
  }

  // Both feeds failed
  console.error(`[PRICE_ROUTER] All feeds failed for ${base}`);
  return null; // OFFLINE
}
