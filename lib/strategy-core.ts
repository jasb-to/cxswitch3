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
  signalQuality: number;
  updatedAt: string;
}

/**
 * STRATEGY ENGINE - Pure function, no side effects
 * Input: symbol (validated)
 * Output: exactly one of ["SNIPER", "BUILDING", "DO_NOT_TRADE"]
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

  // Pseudo-deterministic: hash symbol to state (for testing)
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
 * Create a complete signal for Supabase
 */
export function createSignal(symbol: string): Signal {
  const state = evaluateMarket(symbol);
  
  // Mock prices for testing
  const prices: Record<string, number> = {
    BTC: 77250,
    ETH: 2113,
    SOL: 85,
  };

  return {
    symbol,
    price: prices[symbol] || 0,
    state,
    bias_4h: "NEUTRAL",
    bias_15m: "NEUTRAL",
    macro: "NEUTRAL",
    activation: state,
    signalQuality: state === "SNIPER" ? 100 : state === "BUILDING" ? 50 : 0,
    updatedAt: new Date().toISOString(),
  };
}
