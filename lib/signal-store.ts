/**
 * EVENT-DRIVEN SIGNAL MODEL
 * Only two states: BUILDING (event triggered) and SNIPER (momentum confirmed)
 * Every update produces a directional read - markets are always active
 */

export interface Signal {
  symbol: string;
  price: number;
  
  // Only two states - no neutral/ranging/watching
  state: "BUILDING" | "SNIPER";
  
  // Direction always inferred from event
  direction: "LONG" | "SHORT";
  
  // Event that triggered this state
  event: "breakout_attempt" | "rejection" | "retest" | "sweep" | "acceleration" | "exhaustion";
  
  // Entry level (derived from event level)
  entry_level: number;
  entry_description: string; // e.g., "Breakout above 77,500", "Rejection at resistance"
  
  // Trade details for SNIPER
  stopLoss?: number;
  takeProfit?: number;
  riskReward?: number;
  confidence?: number;
  
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
  return signalStore.get(symbol);
}

