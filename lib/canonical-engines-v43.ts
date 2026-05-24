/**
 * v43.0 CANONICAL SIGNAL ENGINES
 * Three independent, non-overlapping systems
 */

import type { SymbolCardState, StructureState, ExecutionProfile } from "./strategy-v6";

/** v43.0 DIRECTION ENGINE - Pure structural analysis */
export function determineDirectionMinimal(
  emaSlope: number | null,
  structureState: StructureState,
  symbol: string
): "LONG" | "SHORT" | "NEUTRAL" {
  // Primary: EMA slope direction
  if (emaSlope !== null) {
    if (emaSlope < -0.2) {
      console.log(`[DIR_ENGINE] ${symbol} SHORT (EMA=${emaSlope.toFixed(3)})`);
      return "SHORT";
    }
    if (emaSlope > 0.2) {
      console.log(`[DIR_ENGINE] ${symbol} LONG (EMA=${emaSlope.toFixed(3)})`);
      return "LONG";
    }
  }
  
  // Tiebreaker: Structure state
  if (structureState === "BREAKOUT_UP" || structureState === "RETEST_UP") {
    console.log(`[DIR_ENGINE] ${symbol} LONG (${structureState})`);
    return "LONG";
  }
  if (structureState === "BREAKOUT_DOWN" || structureState === "RETEST_DOWN") {
    console.log(`[DIR_ENGINE] ${symbol} SHORT (${structureState})`);
    return "SHORT";
  }
  
  console.log(`[DIR_ENGINE] ${symbol} NEUTRAL`);
  return "NEUTRAL";
}

/** v43.0 MACRO ENGINE - Confidence adjustment only, never blocks */
export function calculateMacroModifierMinimal(
  direction: "LONG" | "SHORT" | "NEUTRAL",
  macroTrend: string | null,
  symbol: string
): number {
  if (direction === "NEUTRAL") {
    console.log(`[MACRO_ENGINE] ${symbol}: neutral, no modifier`);
    return 0;
  }
  
  // Alignment bonus
  if (macroTrend === "BULLISH" && direction === "LONG") {
    console.log(`[MACRO_ENGINE] ${symbol} LONG aligned bullish +5`);
    return +5;
  }
  if (macroTrend === "BEARISH" && direction === "SHORT") {
    console.log(`[MACRO_ENGINE] ${symbol} SHORT aligned bearish +5`);
    return +5;
  }
  
  // Conflict penalty (not a blocker)
  if (macroTrend === "BULLISH" && direction === "SHORT") {
    console.log(`[MACRO_ENGINE] ${symbol} SHORT vs bullish -5`);
    return -5;
  }
  if (macroTrend === "BEARISH" && direction === "LONG") {
    console.log(`[MACRO_ENGINE] ${symbol} LONG vs bearish -5`);
    return -5;
  }
  
  return 0;
}

/** v43.0 ACTIVATION ENGINE - Momentum-based, independent of macro */
export function determineActivationMinimal(
  direction: "LONG" | "SHORT" | "NEUTRAL",
  baseScore: number,
  profile: ExecutionProfile,
  macroModifier: number,
  card: SymbolCardState,
  symbol: string
): "ACTIVE_SNIPER" | "BUILDING" | "DO_NOT_TRADE" {
  
  if (direction === "NEUTRAL") {
    console.log(`[ACT_ENGINE] ${symbol} DO_NOT_TRADE: neutral`);
    return "DO_NOT_TRADE";
  }
  
  const finalScore = baseScore + macroModifier;
  const hasExpansion = card.execution15mState === "EXPANDING" || card.execution15mState === "BREAKOUT_READY";
  const hasVolatilityExpansion = (card.volatilityLevel ?? 0) > 55;
  const hasImpulse = (card.recentImpulseStrength ?? 0) > 40;
  
  // SNIPER: momentum + expansion
  if (finalScore >= profile.ignitionThreshold && (hasExpansion || hasVolatilityExpansion || hasImpulse)) {
    console.log(`[ACT_ENGINE] ${symbol} ACTIVE_SNIPER: score=${finalScore.toFixed(1)} >= ${profile.ignitionThreshold} + expansion`);
    return "ACTIVE_SNIPER";
  }
  
  // BUILDING: decent but not ready
  if (finalScore >= 25) {
    console.log(`[ACT_ENGINE] ${symbol} BUILDING: score=${finalScore.toFixed(1)}`);
    return "BUILDING";
  }
  
  console.log(`[ACT_ENGINE] ${symbol} DO_NOT_TRADE: score=${finalScore.toFixed(1)} < 25`);
  return "DO_NOT_TRADE";
}

/** v43.0 CANONICAL STATE - Single immutable source */
export type CanonicalSignalV43 = {
  symbol: string;
  direction: "LONG" | "SHORT" | "NEUTRAL";
  activationState: "ACTIVE_SNIPER" | "BUILDING" | "DO_NOT_TRADE";
  baseScore: number;
  macroModifier: number;
  finalScore: number;
  macroTrend: string | null;
  rejectReason: string;
};

export function buildCanonicalSignalMinimal(
  symbol: string,
  card: SymbolCardState,
  baseScore: number,
  profile: ExecutionProfile,
  emaSlope: number | null,
  structureState: StructureState
): CanonicalSignalV43 {
  
  const direction = determineDirectionMinimal(emaSlope, structureState, symbol);
  const macroModifier = calculateMacroModifierMinimal(direction, card.htf4hTrend, symbol);
  const activationState = determineActivationMinimal(direction, baseScore, profile, macroModifier, card, symbol);
  const finalScore = baseScore + macroModifier;
  
  console.log(`[CANONICAL] ${symbol}: ${direction} | macro=${macroModifier > 0 ? "+" : ""}${macroModifier} | ${activationState} | score=${finalScore.toFixed(1)}`);
  
  return {
    symbol,
    direction,
    activationState,
    baseScore,
    macroModifier,
    finalScore,
    macroTrend: card.htf4hTrend || null,
    rejectReason: activationState === "DO_NOT_TRADE" ? "no_qual" : "",
  };
}
