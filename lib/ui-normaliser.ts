/**
 * UI NORMALISER - Display Contract Layer
 * 
 * CRITICAL: This normalises LIVE SIGNALS (from signal-engine)
 * NOT database signals (from strategy.ts/Supabase)
 * 
 * Those are two completely different models:
 * - LIVE: WATCHING_SHIFT, BUILDING, SNIPER (early entry mode)
 * - DB: EARLY_OPEN, CONFIRMED, END (trade history)
 * 
 * This normaliser only works with LIVE signals.
 */

import type { Signal as LiveSignal } from "@/lib/signal-engine";

export interface NormalisedSignal {
  symbol: string;
  price: number;
  state: "SNIPER" | "BUILDING" | "WATCHING_SHIFT";
  updated_at: string;
  
  // Market structure - always present
  bias_4h: "Bullish" | "Bearish" | "Neutral";
  structure_15m: "Shift Forming" | "Expanding" | "Ranging" | "Compressing";
  trigger_5m: "Early Break Up" | "Early Break Down" | "Retest Bullish" | "Retest Bearish" | "Flat";
  
  // Readiness
  confidence: number;
  hold_remaining_ms: number;
  
  // Trade details - null unless SNIPER
  direction?: "LONG" | "SHORT";
  entry?: number;
  stopLoss?: number;
  takeProfit?: number;
  riskReward?: number;
}

/**
 * Normalise a LIVE signal for frontend display
 * Pass-through with type safety
 */
export function normaliseSignal(s: LiveSignal): NormalisedSignal {
  return {
    symbol: s.symbol,
    price: s.price,
    state: s.state,
    updated_at: s.updated_at,
    bias_4h: s.bias_4h || "Neutral",
    structure_15m: s.structure_15m || "Ranging",
    trigger_5m: s.trigger_5m || "Flat",
    confidence: s.confidence || 0,
    hold_remaining_ms: s.hold_remaining_ms || 0,
    direction: s.direction,
    entry: s.entry,
    stopLoss: s.stopLoss,
    takeProfit: s.takeProfit,
    riskReward: s.riskReward,
  };
}

/**
 * Normalise array of live signals
 */
export function normaliseSignals(signals: LiveSignal[]): NormalisedSignal[] {
  return signals.map(normaliseSignal);
}
