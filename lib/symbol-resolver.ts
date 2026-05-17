/**
 * CANONICAL SYMBOL RESOLVER
 * 
 * Single source of truth for all symbol normalization
 * Everything must normalize BEFORE any price/strategy logic
 * 
 * Rules:
 * - Input: any symbol format (BTC/USD, BTC, XBTUSD)
 * - Output: { krakenTicker, base }
 * - If resolver fails: HARD FAIL (no fallback)
 */

export interface ResolvedSymbol {
  /** Kraken ticker symbol (e.g. XBTUSD) */
  krakenTicker: string;
  /** Base symbol (e.g. BTC) */
  base: string;
  /** Internal symbol with suffix (e.g. BTC/USD) */
  internal: string;
}

const SYMBOL_MAP: Record<string, { kraken: string; base: string }> = {
  BTC: { kraken: "XXBTZUSD", base: "BTC" },
  ETH: { kraken: "XETHZUSD", base: "ETH" },
  SOL: { kraken: "SOLUSD", base: "SOL" },
  XRP: { kraken: "XRPUSD", base: "XRP" },
  ADA: { kraken: "ADAUSD", base: "ADA" },
  DOGE: { kraken: "DOGEUSD", base: "DOGE" },
};

/**
 * Resolve any symbol format to canonical Kraken ticker + base
 * 
 * Accepts:
 * - "BTC/USD" → { krakenTicker: "XBTUSD", base: "BTC", internal: "BTC/USD" }
 * - "BTC" → { krakenTicker: "XBTUSD", base: "BTC", internal: "BTC/USD" }
 * - "XBTUSD" → { krakenTicker: "XBTUSD", base: "BTC", internal: "BTC/USD" }
 * 
 * THROWS if symbol is unknown
 */
export function resolveSymbol(symbol: string): ResolvedSymbol {
  if (!symbol || typeof symbol !== "string") {
    throw new Error(`[resolveSymbol] Invalid symbol: ${symbol}`);
  }

  // Strip /USD suffix and uppercase
  const normalized = symbol.replace(/\/USD$/i, "").trim().toUpperCase();

  // Look up in map
  const mapping = SYMBOL_MAP[normalized];
  if (!mapping) {
    const supported = Object.keys(SYMBOL_MAP).join(", ");
    throw new Error(
      `[resolveSymbol] Unknown symbol: ${symbol} (normalized: ${normalized}). Supported: ${supported}`
    );
  }

  return {
    krakenTicker: mapping.kraken,
    base: mapping.base,
    internal: `${mapping.base}/USD`,
  };
}

/**
 * Validate symbol is resolvable (returns true/false instead of throwing)
 */
export function isValidSymbol(symbol: string): boolean {
  try {
    resolveSymbol(symbol);
    return true;
  } catch {
    return false;
  }
}
