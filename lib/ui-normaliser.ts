/**
 * UI NORMALISER - Display Contract Layer
 * 
 * Takes signals from backend and ensures consistent shape for frontend
 * This is NOT fallback generation - it's shape enforcement on existing data
 * 
 * Every signal that exits this normaliser has:
 * - All market structure fields (with sensible defaults)
 * - All readiness fields
 * - Trade details (null if not SNIPER)
 */

export interface Signal {
  symbol: string;
  price: number;
  state: "SNIPER" | "BUILDING" | "DO_NOT_TRADE";
  updated_at: string;
}

export interface NormalisedSignal {
  symbol: string;
  price: number;
  state: "SNIPER" | "BUILDING" | "DO_NOT_TRADE";
  updated_at: string;
  
  // Market structure - always present
  trend_4h: "Bullish" | "Bearish" | "Neutral";
  structure_15m: "Breakout" | "Compression" | "Expansion" | "Reversal" | "Range";
  macro_bias: "Bullish" | "Bearish" | "Neutral";
  
  // Readiness - always present
  readiness_score: number;
  
  // Trade details - null unless SNIPER
  trade: {
    direction: "LONG" | "SHORT";
    entry: number;
    sl: number;
    tp: number;
    rr: number;
    confidence: number;
    reason: string;
  } | null;
}

/**
 * Normalise a signal for frontend display
 * Ensures shape consistency without generating data
 */
export function normaliseSignal(s: any): NormalisedSignal {
  return {
    symbol: s.symbol,
    price: s.price,
    state: s.state,
    updated_at: s.updated_at,
    
    // Market structure with sensible defaults
    trend_4h: s.trend_4h ?? "Neutral",
    structure_15m: s.structure_15m ?? "Range",
    macro_bias: s.macro_bias ?? "Neutral",
    
    // Readiness with default
    readiness_score: s.readiness_score ?? 0,
    
    // Trade details only if SNIPER
    trade: s.state === "SNIPER" && s.direction ? {
      direction: s.direction,
      entry: s.entry ?? 0,
      sl: s.stopLoss ?? 0,
      tp: s.takeProfit ?? 0,
      rr: s.riskReward ?? 0,
      confidence: s.confidence ?? 0,
      reason: s.reason ?? "N/A",
    } : null,
  };
}
