/**
 * Price Router (v3.1.0)
 * Primary + Secondary + Safety State Architecture
 * 
 * PRIMARY: Kraken ticker (execution-grade)
 * SECONDARY: CoinGecko (fallback-only, for visual continuity)
 * SAFETY: Hard gates prevent trading on degraded data
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

/**
 * Fetch price from Kraken (primary, execution-grade)
 * Returns null if unavailable (allows fallback attempt)
 */
async function getPriceFromKraken(symbol: string): Promise<PriceData | null> {
  try {
    const resolved = resolveSymbol(symbol);
    const { krakenTicker, base } = resolved;

    const response = await fetch(
      `https://api.kraken.com/0/public/Ticker?pair=${krakenTicker}`
    );

    if (!response.ok) {
      console.warn(`[KRAKEN] HTTP ${response.status} for ${base}`);
      return null;
    }

    const data = await response.json();

    if (data.error && data.error.length > 0) {
      console.warn(`[KRAKEN] API error for ${base}:`, data.error[0]);
      return null;
    }

    const tickerData = data.result?.[krakenTicker];
    if (!tickerData) {
      console.warn(`[KRAKEN] No data for ${base}`);
      return null;
    }

    const lastTrade = tickerData.c?.[0];
    const bid = parseFloat(tickerData.b?.[0] ?? 0);
    const ask = parseFloat(tickerData.a?.[0] ?? 0);
    const price = lastTrade ? parseFloat(lastTrade) : (bid + ask) / 2;

    if (!price || isNaN(price)) {
      console.warn(`[KRAKEN] Invalid price for ${base}`);
      return null;
    }

    console.log(`[KRAKEN] ✓ ${base}: $${price.toFixed(2)}`);

    return {
      price,
      source: "kraken",
      health: "LIVE",
      bid,
      ask,
      timestamp: Math.floor(Date.now() / 1000),
    };
  } catch (err) {
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
 * Price Router: Try Kraken first, fallback to CoinGecko
 * Returns explicit health status for gate enforcement
 */
export async function getPrice(symbol: string): Promise<PriceData | null> {
  // Try primary feed (Kraken)
  const krakenPrice = await getPriceFromKraken(symbol);
  if (krakenPrice) {
    return krakenPrice; // LIVE
  }

  console.log(`[PRICE_ROUTER] Kraken failed for ${symbol}, attempting fallback...`);

  // Try secondary feed (CoinGecko)
  const coingeckoPrice = await getPriceFromCoinGecko(symbol);
  if (coingeckoPrice) {
    return coingeckoPrice; // DEGRADED (visual only, no trading)
  }

  // Both feeds failed
  console.error(`[PRICE_ROUTER] All feeds failed for ${symbol}`);
  return null; // OFFLINE
}
