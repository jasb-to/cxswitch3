/**
 * SIMPLE IN-MEMORY SIGNAL STORE
 * No persistence, no abstractions, no overhead
 */

export interface Signal {
  symbol: string;
  price: number;
  state: "SNIPER" | "BUILDING" | "DO_NOT_TRADE";
  direction?: "LONG" | "SHORT";
  entry?: number;
  stopLoss?: number;
  takeProfit?: number;
  riskReward?: number;
  confidence?: number;
  reason?: string;
  updated_at: string;
}

const signalStore = new Map<string, Signal>();
const SYMBOLS = ["BTC", "ETH", "SOL"];

/**
 * Create a guaranteed fallback signal for a symbol
 */
function createFallbackSignal(symbol: string): Signal {
  return {
    symbol,
    price: 0,
    state: "DO_NOT_TRADE",
    direction: undefined,
    entry: undefined,
    stopLoss: undefined,
    takeProfit: undefined,
    riskReward: undefined,
    confidence: undefined,
    reason: undefined,
    updated_at: new Date().toISOString(),
  };
}

export function setSignal(signal: Signal): void {
  signalStore.set(signal.symbol, signal);
}

export function getSignal(symbol: string): Signal | undefined {
  return signalStore.get(symbol);
}

/**
 * CRITICAL: Always return 3 signals (BTC, ETH, SOL)
 * If a symbol has no data, return fallback
 */
export function getSignals(): Signal[] {
  const result: Signal[] = [];
  
  for (const symbol of SYMBOLS) {
    const signal = signalStore.get(symbol);
    if (signal) {
      result.push(signal);
    } else {
      // Return fallback to ensure 3 cards always render
      result.push(createFallbackSignal(symbol));
    }
  }
  
  return result;
}

export function getPreviousSignal(symbol: string): Signal | undefined {
  // Get from store (this tracks last state)
  return signalStore.get(symbol);
}
