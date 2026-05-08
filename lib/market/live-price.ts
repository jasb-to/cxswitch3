/**
 * Live Price Reconciliation (v2.8.7)
 * Fetches actual bid/ask midpoint from Kraken ticker
 * NEVER uses stale candle close as current price
 */

export interface LivePriceData {
  livePrice: number;
  source: "ticker";
  timestamp: number;
  bid?: number;
  ask?: number;
}

/**
 * Get live market price from Kraken ticker endpoint
 * Uses last trade price or bid/ask midpoint
 */
export async function getLivePrice(symbol: string): Promise<LivePriceData | null> {
  try {
    // Strip /USD suffix if present (e.g., "BTC/USD" -> "BTC")
    const baseSymbol = symbol.replace("/USD", "").trim();
    
    // Convert symbol to Kraken format (e.g., BTC -> XBTUSD)
    let krakenSymbol: string;
    try {
      krakenSymbol = getKrakenSymbol(baseSymbol);
    } catch (err) {
      console.error(`[getLivePrice] Symbol normalization failed for ${symbol}:`, err instanceof Error ? err.message : String(err));
      return null;
    }
    
    console.log(`[getLivePrice] Fetching ${symbol} (mapped to ${krakenSymbol}) from Kraken ticker`);
    
    const response = await fetch(
      `https://api.kraken.com/0/public/Ticker?pair=${krakenSymbol}`
    );

    if (!response.ok) {
      console.error(`[getLivePrice] Kraken HTTP error for ${symbol} (${krakenSymbol}): ${response.status} ${response.statusText}`);
      return null;
    }

    const data = await response.json();

    if (data.error && data.error.length > 0) {
      console.error(`[getLivePrice] Kraken API error for ${symbol} (${krakenSymbol}):`, data.error);
      return null;
    }

    const tickerData = data.result?.[krakenSymbol];
    if (!tickerData) {
      console.error(`[getLivePrice] No ticker data returned for ${symbol} (${krakenSymbol})`);
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
      console.error(`[getLivePrice] Invalid price data for ${symbol} (${krakenSymbol}):`, { lastTrade, bid, ask });
      return null;
    }

    console.log(`[getLivePrice] ✓ ${symbol} (${krakenSymbol}): $${livePrice.toFixed(2)} [bid=$${bid.toFixed(2)} ask=$${ask.toFixed(2)}]`);
    
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
 * Convert internal symbol to Kraken format
 * Maps: BTC -> XBTUSD, ETH -> ETHUSD, SOL -> SOLUSD
 */
function getKrakenSymbol(symbol: string): string {
  const mapping: Record<string, string> = {
    BTC: "XBTUSD",
    ETH: "ETHUSD",
    SOL: "SOLUSD",
    XRP: "XRPUSD",
    ADA: "ADAUSD",
    DOGE: "DOGEUSD",
  };
  
  const krakenSymbol = mapping[symbol.toUpperCase()];
  if (!krakenSymbol) {
    throw new Error(`[getLivePrice] Unknown symbol for Kraken: ${symbol}. Supported: ${Object.keys(mapping).join(", ")}`);
  }
  return krakenSymbol;
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
