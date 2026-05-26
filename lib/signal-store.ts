/**
 * SIMPLE IN-MEMORY SIGNAL STORE
 * No persistence, no abstractions, no overhead
 */

export interface Signal {
  symbol: string;
  price: number;
  state: "SNIPER" | "BUILDING" | "DO_NOT_TRADE";
  
  // Market structure (always present)
  trend_4h: "Bullish" | "Bearish" | "Neutral";
  structure_15m: "Breakout" | "Compression" | "Expansion" | "Reversal" | "Range";
  macro_bias: "Bullish" | "Bearish" | "Neutral";
  
  // Market metrics (always present)
  momentum_percent: number; // 0-100+
  volatility_percent: number; // 0-100+
  
  // Trade readiness 0-100% (always present, never undefined)
  readiness_score: number;
  
  // SNIPER trade details (optional)
  direction?: "LONG" | "SHORT";
  entry?: number;
  stopLoss?: number;
  takeProfit?: number;
  riskReward?: number;
  confidence?: number;
  reason?: string;
  
  // Nested trade object (optional, legacy)
  trade?: {
    direction: "LONG" | "SHORT";
    entry: number;
    sl: number;
    tp: number;
    rr: number;
    confidence: number;
    reason: string;
  };
  
  updated_at: string;
}

const signalStore = new Map<string, Signal>();

export function setSignal(signal: Signal): void {
  signalStore.set(signal.symbol, signal);
}

export function getSignal(symbol: string): Signal | undefined {
  return signalStore.get(symbol);
}

export function getSignals(): Signal[] {
  return Array.from(signalStore.values()).sort((a, b) => a.symbol.localeCompare(b.symbol));
}

export function getPreviousSignal(symbol: string): Signal | undefined {
  // Get from store (this tracks last state)
  return signalStore.get(symbol);
}
