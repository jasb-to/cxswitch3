/**
 * v43.1 SIMPLIFIED PRODUCTION ENGINE
 * 
 * ONE SIMPLE TRUTH MODEL - Early Readable Signals
 * 
 * 1. DIRECTION: EMA slope + structure only
 *    Output: LONG | SHORT | NEUTRAL
 *    NO suppression, NO confidence rejection
 * 
 * 2. ACTIVATION: Momentum + 15M expansion only
 *    Output: ACTIVE_SNIPER | BUILDING | DO_NOT_TRADE
 *    NO 4H gating, NO macro penalty, NO alignment rejection
 * 
 * 3. MACRO: Visual context only
 *    NEVER blocks signals, NEVER reduces activation
 * 
 * CRITICAL RULE:
 * If direction exists AND momentum is expanding
 * → ALWAYS show a signal (BUILDING or ACTIVE_SNIPER)
 * 
 * RESULT: No dead dashboards, no silent filtering bugs
 */

import { SymbolCardState, StructureState } from './strategy-v6';

export type CanonicalSignalState = {
  symbol: string;
  direction: "LONG" | "SHORT" | "NEUTRAL";
  activationState: "ACTIVE_SNIPER" | "BUILDING" | "DO_NOT_TRADE";
  baseScore: number;
  macroModifier: number;
  finalScore: number;
  rejectReason: string;
};

/**
 * SIMPLIFIED DIRECTION ENGINE
 * EMA slope + structure only. NO confidence thresholds. NO suppression.
 */
export function directionEngine(
  emaSlope: number | null,
  structureState: StructureState,
  symbol: string
): "LONG" | "SHORT" | "NEUTRAL" {
  
  // Primary: EMA slope (threshold-based)
  if (emaSlope !== null) {
    if (emaSlope < -0.15) {
      console.log(`[DIRECTION] ${symbol} SHORT from EMA (slope=${emaSlope.toFixed(3)})`);
      return "SHORT";
    }
    if (emaSlope > 0.15) {
      console.log(`[DIRECTION] ${symbol} LONG from EMA (slope=${emaSlope.toFixed(3)})`);
      return "LONG";
    }
  }
  
  // Tiebreaker: Structure (when EMA neutral)
  if (structureState === "BREAKOUT_UP" || structureState === "RETEST_UP") {
    console.log(`[DIRECTION] ${symbol} LONG from structure (${structureState})`);
    return "LONG";
  }
  if (structureState === "BREAKOUT_DOWN" || structureState === "RETEST_DOWN") {
    console.log(`[DIRECTION] ${symbol} SHORT from structure (${structureState})`);
    return "SHORT";
  }
  
  // Neutral - no directional structure
  console.log(`[DIRECTION] ${symbol} NEUTRAL (flat EMA, no structure)`);
  return "NEUTRAL";
}

/**
 * SIMPLIFIED MACRO ENGINE
 * Visual context only. NEVER blocks signals. NEVER reduces activation.
 */
export function macroEngine(
  direction: "LONG" | "SHORT" | "NEUTRAL",
  macroTrend: string | null,
  symbol: string
): number {
  
  if (direction === "NEUTRAL" || !macroTrend) {
    return 0;
  }
  
  // Alignment bonus (visual context only)
  if ((macroTrend === "BULLISH" && direction === "LONG") ||
      (macroTrend === "BEARISH" && direction === "SHORT")) {
    console.log(`[MACRO] ${symbol} ${direction} aligned with 4H ${macroTrend} (+2 context)`);
    return 2;
  }
  
  // Conflict noted but NEVER blocks or reduces (visual context only)
  if ((macroTrend === "BULLISH" && direction === "SHORT") ||
      (macroTrend === "BEARISH" && direction === "LONG")) {
    console.log(`[MACRO] ${symbol} ${direction} vs 4H ${macroTrend} (context mismatch, signal still valid)`);
    return 0; // NO penalty
  }
  
  return 0;
}

/**
 * SIMPLIFIED ACTIVATION ENGINE
 * Momentum + 15M expansion only.
 * ALWAYS shows signal if direction exists AND expanding.
 * NO 4H gating, NO macro penalties, NO alignment rejection.
 */
export function activationEngine(
  direction: "LONG" | "SHORT" | "NEUTRAL",
  baseScore: number,
  volatilityExpansion: boolean,
  hasExpansion: boolean,
  impulseStrength: number,
  symbol: string
): "ACTIVE_SNIPER" | "BUILDING" | "DO_NOT_TRADE" {
  
  // If no direction, do not trade
  if (direction === "NEUTRAL") {
    console.log(`[ACTIVATION] ${symbol} DO_NOT_TRADE (no direction)`);
    return "DO_NOT_TRADE";
  }
  
  // CRITICAL RULE: If direction exists AND momentum is expanding
  // → ALWAYS show signal (BUILDING or ACTIVE_SNIPER)
  const isExpanding = volatilityExpansion || hasExpansion || impulseStrength > 40;
  
  // SNIPER: strong impulse + expansion
  if ((impulseStrength > 55 || volatilityExpansion) && isExpanding) {
    console.log(`[ACTIVATION] ${symbol} ACTIVE_SNIPER (impulse=${impulseStrength.toFixed(0)}, expanding)`);
    return "ACTIVE_SNIPER";
  }
  
  // BUILDING: direction exists, momentum present OR expanding
  // This ensures we never hide state when movement exists
  if (baseScore >= 20 || isExpanding) {
    console.log(`[ACTIVATION] ${symbol} BUILDING (score=${baseScore.toFixed(0)}, expanding=${isExpanding})`);
    return "BUILDING";
  }
  
  // DO_NOT_TRADE: flat price, no expansion, minimal momentum
  console.log(`[ACTIVATION] ${symbol} DO_NOT_TRADE (flat price, no expansion, score=${baseScore.toFixed(0)})`);
  return "DO_NOT_TRADE";
}

/**
 * SIMPLIFIED CANONICAL STATE BUILDER
 * One immutable source of truth for all presentation layers.
 * Always returns state for all three symbols (BTC/ETH/SOL).
 */
export function buildCanonicalState(
  symbol: string,
  card: SymbolCardState,
  baseScore: number,
  profile: any,
  emaSlope: number | null,
  structureState: StructureState
): CanonicalSignalState {
  
  // Step 1: Pure direction from structure
  const direction = directionEngine(emaSlope, structureState, symbol);
  
  // Step 2: Macro modifier (visual context, never blocks)
  const macroModifier = macroEngine(direction, card.htf4hTrend, symbol);
  
  // Step 3: Activation (momentum-based, direction-dependent)
  const volatilityExpansion = (card.volatilityLevel ?? 0) > 55;
  const hasExpansion = card.execution15mState === "EXPANDING" || card.execution15mState === "BREAKOUT_READY";
  const impulseStrength = card.recentImpulseStrength ?? 0;
  
  const activationState = activationEngine(
    direction,
    baseScore,
    volatilityExpansion,
    hasExpansion,
    impulseStrength,
    symbol
  );
  
  // Step 4: Build canonical state (always returned, never hidden)
  const finalScore = baseScore + macroModifier;
  
  const state: CanonicalSignalState = {
    symbol,
    direction,
    activationState,
    baseScore,
    macroModifier,
    finalScore,
    rejectReason: activationState === "DO_NOT_TRADE" ? "flat_price_no_expansion" : "",
  };
  
  console.log(`[CANONICAL] ${symbol}: ${direction} → ${activationState} (macro=${macroModifier > 0 ? "+" : ""}${macroModifier})`);
  return state;
}

/**
 * ENGINE INITIALIZATION - Confirms simplified mode active
 */
export function initializeV43Engine(): void {
  console.log("[ENGINE_V43.1] ✓ Simplified production-stable engine initialized");
  console.log("[ENGINE_V43.1] ✓ Early readable signals mode ACTIVE");
  console.log("[ENGINE_V43.1] ✓ NO signal dropping | NO gating | NO suppression");
  console.log("[ENGINE_V43.1] ✓ Always display: BTC state, ETH state, SOL state");
}

