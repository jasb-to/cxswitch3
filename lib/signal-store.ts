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
