/**
 * Live Price Reconciliation (v3.1.0)
 * Uses price router with Primary (Kraken) + Secondary (CoinGecko) architecture
 * Explicit health state for gate enforcement
 */

import { getPrice, type PriceData, type PriceHealth } from "@/lib/price-router";

export interface LivePriceData extends PriceData {
  livePrice: number; // Alias for price (backward compatibility)
}

/**
 * Get live market price using router (Kraken → CoinGecko fallback)
 * Returns explicit health state:
 * - LIVE: Kraken ticker (execution-grade, enables trading)
 * - DEGRADED: CoinGecko fallback (visual only, blocks trading)
 * - null: Both feeds failed (OFFLINE, no signals)
 */
export async function getLivePrice(symbol: string): Promise<LivePriceData | null> {
  const priceData = await getPrice(symbol);
  
  if (!priceData) {
    console.error(`[getLivePrice] All price feeds failed for ${symbol}`);
    return null; // OFFLINE
  }

  // Add backward-compatibility alias
  return {
    ...priceData,
    livePrice: priceData.price, // Backward compatibility with existing code
  };
}

/**
 * Validate market data is fresh
 */
export function validateMarketDataFreshness(timestamps: {
  candle5m?: number;
  candle15m?: number;
  ticker?: number;
}): { valid: boolean; reason?: string } {
  const now = Math.floor(Date.now() / 1000);

  if (timestamps.candle5m && now - timestamps.candle5m > 600) {
    return { valid: false, reason: "5M candle older than 10 minutes" };
  }

  if (timestamps.candle15m && now - timestamps.candle15m > 1200) {
    return { valid: false, reason: "15M candle older than 20 minutes" };
  }

  if (timestamps.ticker && now - timestamps.ticker > 30) {
    return { valid: false, reason: "Ticker data older than 30 seconds" };
  }

  return { valid: true };
}
