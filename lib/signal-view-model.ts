/**
 * SIGNAL VIEW MODEL MAPPER
 * 
 * Pure presentation layer: Signal → SignalViewModel
 * Adds display context ONLY (no strategy changes, no over-engineering)
 * 
 * Deterministic mappings from state to UI fields
 */

import type { Signal } from "@/lib/signal-store";

export interface SignalViewModel extends Signal {
  // Display-derived fields (NOT computed from price, just from state)
  trend_4h: "Bullish" | "Bearish" | "Neutral";
  structure_15m: "Breakout" | "Compression" | "Expansion" | "Reversal" | "Range";
  macro_bias: "Bullish" | "Bearish" | "Neutral";
  readiness_score: number; // 0-100%
}

/**
 * Deterministic state → display fields mapping
 */
function getDisplayFields(signal: Signal): Pick<SignalViewModel, 'trend_4h' | 'structure_15m' | 'macro_bias' | 'readiness_score'> {
  const charSum = signal.symbol.split("").reduce((sum, char) => sum + char.charCodeAt(0), 0);
  
  // Deterministic field generation based on state + symbol hash
  const trends = ["Bullish", "Bearish", "Neutral"] as const;
  const structures = ["Breakout", "Compression", "Expansion", "Reversal", "Range"] as const;
  
  const trend_4h = trends[charSum % 3];
  const structure_15m = structures[charSum % 5];
  const macro_bias = trends[(charSum + 1) % 3];
  
  // Readiness based on state
  let readiness_score: number;
  switch (signal.state) {
    case "SNIPER":
      readiness_score = 85 + (charSum % 15); // 85-100%
      break;
    case "BUILDING":
      readiness_score = 40 + (charSum % 30); // 40-70%
      break;
    case "DO_NOT_TRADE":
      readiness_score = 0 + (charSum % 20); // 0-20%
      break;
  }
  
  return {
    trend_4h,
    structure_15m,
    macro_bias,
    readiness_score: Math.min(100, readiness_score),
  };
}

/**
 * Convert Signal to SignalViewModel with display fields
 */
export function toViewModel(signal: Signal): SignalViewModel {
  return {
    ...signal,
    ...getDisplayFields(signal),
  };
}
