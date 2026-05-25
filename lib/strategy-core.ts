/**
 * SINGLE SOURCE OF TRUTH
 * Deterministic state machine: market data → exactly one of 3 states
 */

export type TradeState = "SNIPER" | "BUILDING" | "DO_NOT_TRADE";

export const SYMBOLS = ["BTC", "ETH", "SOL"] as const;
export type Symbol = typeof SYMBOLS[number];

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
 * Raw signal result - used everywhere, no transformation
 */
export interface RawSignal {
  symbol: Symbol;
  state: TradeState;
  timestamp: number;
}

/**
 * Create a raw signal (cron only)
 */
export function createSignal(symbol: string): RawSignal {
  const state = evaluateMarket(symbol);
  return {
    symbol: symbol as Symbol,
    state,
    timestamp: Date.now(),
  };
}
