/**
 * Live Price Reconciliation (v2.11.0)
 * Uses canonical symbol resolver
 * HARD FAILS on symbol errors (no fallback)
 * Only ticker source, never stale candles
 */

import { resolveSymbol } from "@/lib/symbol-resolver";

export interface LivePriceData {
  livePrice: number;
  source: "ticker";
  timestamp: number;
  bid?: number;
  ask?: number;
}

/**
 * Get live market price from Kraken ticker endpoint
 * Uses canonical resolver → HARD FAILS on invalid symbols
 * No fallback to candle close (that's a stale data poisoner)
 */
export async function getLivePrice(symbol: string): Promise<LivePriceData | null> {
  try {
    // Resolve symbol using canonical resolver (HARD FAILS if invalid)
    let resolved;
    try {
      resolved = resolveSymbol(symbol);
    } catch (err) {
      console.error(`[getLivePrice] HARD FAIL - Symbol resolution failed for ${symbol}:`, err instanceof Error ? err.message : String(err));
      return null; // Return null (not false positive from candle fallback)
    }

    const { krakenTicker, base } = resolved;
    console.log(`[getLivePrice] Fetching ${symbol} → ${krakenTicker} from Kraken ticker`);

    const response = await fetch(
      `https://api.kraken.com/0/public/Ticker?pair=${krakenTicker}`
    );

    if (!response.ok) {
      console.error(`[getLivePrice] Kraken HTTP error for ${base} (${krakenTicker}): ${response.status} ${response.statusText}`);
      return null;
    }

    const data = await response.json();

    if (data.error && data.error.length > 0) {
      console.error(`[getLivePrice] Kraken API error for ${base} (${krakenTicker}):`, data.error);
      return null;
    }

    const tickerData = data.result?.[krakenTicker];
    if (!tickerData) {
      console.error(`[getLivePrice] No ticker data returned for ${base} (${krakenTicker})`);
      return null;
    }

    // Extract price from last trade or bid/ask
    // tickerData format: { a: [ask, ask_volume], b: [bid, bid_volume], c: [close, volume], ... }
    const lastTrade = tickerData.c?.[0];
    const bid = parseFloat(tickerData.b?.[0] ?? 0);
    const ask = parseFloat(tickerData.a?.[0] ?? 0);

    // Use last trade price if available, otherwise use bid/ask midpoint
    let livePrice = lastTrade ? parseFloat(lastTrade) : (bid + ask) / 2;

    if (!livePrice || isNaN(livePrice)) {
      console.error(`[getLivePrice] Invalid price data for ${base} (${krakenTicker}):`, { lastTrade, bid, ask });
      return null;
    }

    console.log(`[getLivePrice] ✓ ${base} (${krakenTicker}): $${livePrice.toFixed(2)} [bid=$${bid.toFixed(2)} ask=$${ask.toFixed(2)}]`);

    return {
      livePrice,
      source: "ticker",
      timestamp: Math.floor(Date.now() / 1000),
      bid,
      ask,
    };
  } catch (err) {
    console.error(`[getLivePrice] Exception for ${symbol}:`, err instanceof Error ? err.message : String(err));
    return null;
  }
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
