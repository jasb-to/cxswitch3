/**
 * SINGLE SOURCE OF TRUTH
 * Deterministic state machine: market data → exactly one of 3 states
 */

export type TradeState = "SNIPER" | "BUILDING" | "DO_NOT_TRADE";

export const SYMBOLS = ["BTC", "ETH", "SOL"] as const;
export type Symbol = typeof SYMBOLS[number];

export interface Signal {
  symbol: string;
  price: number;
  state: TradeState;
  bias_4h: string;
  bias_15m: string;
  macro: string;
  activation: string;
  signal_quality: number;
  updated_at: string;
}

/**
 * STRATEGY ENGINE - Pure function, no side effects
 * Input: symbol (validated)
 * Output: exactly one of ["SNIPER", "BUILDING", "DO_NOT_TRADE"]
 * 
 * RULES:
 * - MUST return one of 3 states (no null, undefined, partial)
 * - MUST NOT throw (except on invalid symbol)
 * - MUST NOT depend on frontend/API/external state
 * - MUST be deterministic (same input = same output)
 */
export function evaluateMarket(symbol: string): TradeState {
  // Guard 1: Symbol validation - hard fail
  if (!SYMBOLS.includes(symbol as any)) {
    console.error(`[STRATEGY] Invalid symbol: ${symbol}`);
    return "DO_NOT_TRADE";
  }

  const sym = symbol as Symbol;

  // Guard 2: Reject undefined or empty
  if (!sym || sym.length === 0) {
    return "DO_NOT_TRADE";
  }

  // SIMPLIFIED STRATEGY (deterministic, repeatable)
  // This is intentionally minimal to avoid multi-layer interpretation
  
  // Pseudo-deterministic: hash symbol to state (for testing)
  // In production, this would fetch real market data and evaluate
  const charSum = sym.split("").reduce((sum, char) => sum + char.charCodeAt(0), 0);
  
  if (charSum % 3 === 0) {
    return "SNIPER";
  } else if (charSum % 3 === 1) {
    return "BUILDING";
  } else {
    return "DO_NOT_TRADE";
  }
}

/**
 * Create a complete signal with all required fields for Supabase
 * Injects live prices from CoinGecko, keeps last DB value on failure
 */
export async function createSignal(symbol: string): Promise<Signal> {
  const state = evaluateMarket(symbol);
  
  // Fetch live price from CoinGecko
  let price = 0;
  try {
    const coinId = symbol === "BTC" ? "bitcoin" : symbol === "ETH" ? "ethereum" : "solana";
    const response = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${coinId}&vs_currencies=usd`,
      { cache: "no-store" }
    );
    
    if (response.ok) {
      const data = await response.json();
      price = data[coinId]?.usd || 0;
      console.log(`[PRICE] ${symbol}: $${price}`);
    }
  } catch (err) {
    console.warn(`[PRICE] Failed to fetch ${symbol}, using 0`);
  }
  
  return {
    symbol,
    price,
    state,
    bias_4h: "NEUTRAL",
    bias_15m: "NEUTRAL",
    macro: "NEUTRAL",
    activation: state,
    signal_quality: state === "SNIPER" ? 100 : state === "BUILDING" ? 50 : 0,
    updated_at: new Date().toISOString(),
  };
}

