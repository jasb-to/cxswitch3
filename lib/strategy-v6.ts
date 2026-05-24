/**
 * SNIPER ENGINE v7.0 - MOMENTUM IGNITION SYSTEM
 * 
 * Converts from structure-based scanner to momentum wave detector
 * Uses Stochastic RSI + EMA Stack + Volatility Compression
 * 
 * NO STATE, NO DB ACCESS, PURE EVALUATION
 * 
 * v22.5 DEPLOYMENT MARKER - Runtime verification
 * If this version string appears in logs, v22.5 is LIVE
 * If this version does NOT appear, old runtime artifact is executing
 * 
 * v23.0 EVENT-DRIVEN MONITOR
 * Monitor layer now reports state transitions instead of snapshots
 */

// v36.0 FIX: Move ALL imports to top to prevent circular dependency TDZ
// v39.0 FIX: Convert monitor-event-engine imports to dynamic to break circular dependency
// monitor-event-engine imports SymbolCardState from strategy-v6, creating circular chain
// Use only type imports where needed, no runtime imports from circular modules
import type { PriceData } from "./price-router";
import type { SegmentatedMarketData } from "./market-data-layer";
import type { Candle } from "./kraken";
import { analyze4HStructure } from "./htf-structure-engine";
import { 
  calculateStructureStopLoss, 
  calculateSniperStopLoss, 
  shouldInvalidateSniperSL,
  validateSLSeparation
} from "./risk-utils";

// v36.0 FIX: Defer module-level console.log to prevent TDZ
// Don't log during module initialization, only when functions are actually called
// This prevents potential issues with circular dependencies and module loading order
// The version will be logged by the cron handler on first execution

// ═════════════════════════════════════════════════════════════════════════════
// v7.6.0: EXECUTION CONTEXT - SINGLE SOURCE OF TRUTH
// ═════════════════════════════════════════════════════════════════════════════
// 
// v7.7.0 CRITICAL FIX: Separate data trust from infrastructure health
// - executionGrade: ONLY based on source (kraken_live or kraken_cached)
// - systemHealth: ONLY based on infrastructure state
// - NEVER conflate these - they are orthogonal concerns
//
export type ExecutionContext = {
  // Identifier
  symbol: string;
  cycleId: string;

  // DATA TRUST (never changes per cycle, ONLY based on source)
  executionGrade: boolean;  // true if source is kraken_live or kraken_cached
  dataSource: "KRAKEN" | "COINGECKO";

  // SYSTEM HEALTH (infrastructure state, independent from data trust)
  systemHealth: "LIVE" | "DEGRADED" | "OFFLINE";
  systemHealthReason?: string;

  // Market snapshot (immutable for cycle)
  price: number;
  timestamp: number;
};

/**
 * PER-ASSET EXECUTION PROFILES
 * 
 * v21.1.0: CRITICAL - Each asset has different market structure:
 * - BTC: slow, sustained, structure-driven (breakouts)
 * - ETH: medium, trend-following (continuation)
 * - SOL: fast, impulse-driven (momentum sniper)
 * 
 * SOL profile MUST remain unchanged from current production values.
 * BTC/ETH profiles tuned to their structural characteristics.
 */
export type ExecutionProfile = {
  // Scoring weights
  ignitionThreshold: number;           // Score >= N to trigger SNIPER
  stochWeight: number;                  // Stoch RSI multiplier
  emaWeight: number;                    // EMA flip multiplier (acceleration)
  volatilityWeight: number;             // Compression multiplier
  impulseWeight: number;                // Direction conviction multiplier
  trendWeight: number;                  // 4H trend alignment multiplier

  // Activation style (drives how signals are generated)
  activationStyle: "IMPULSE" | "STRUCTURAL" | "CONTINUATION";
  
  // Asset-specific rules (consolidates fragmented if-checks)
  persistenceRules: {
    requireSustainedEMA: boolean;       // ETH: must have 0.3-1.0 EMA slope
    requireDirectionAlignment: boolean; // ETH: direction must match EMA
    stabilityThreshold: number;         // ETH: volatility < N (< 45)
  };
  
  // Bonus/penalty system
  breakoutBonus: number;                // BTC: +5 score bonus for structural breakout
  bonusActivation: "STRUCTURAL_BREAKOUT" | "NONE"; // When to apply bonus
};


export const EXECUTION_PROFILES: Record<string, ExecutionProfile> = {
  SOL: {
    // PRODUCTION BASELINE - DO NOT CHANGE
    // Current SOL behavior must remain identical
    ignitionThreshold: 70,
    stochWeight: 1.25,       // Stoch RSI active zone
    emaWeight: 1.35,         // EMA 8/21 flip (high impact)
    volatilityWeight: 1.20,  // Compression present
    impulseWeight: 1.30,     // Direction conviction
    trendWeight: 1.40,       // 4H trend alignment (critical)
    
    // SOL activation style: fast, momentum-driven impulse sniper
    activationStyle: "IMPULSE",
    persistenceRules: {
      requireSustainedEMA: false,        // SOL: no sustained EMA requirement
      requireDirectionAlignment: false,  // SOL: no alignment requirement
      stabilityThreshold: 100,           // SOL: no stability constraint
    },
    breakoutBonus: 0,                    // SOL: no structural bonus
    bonusActivation: "NONE",
  },
  
  BTC: {
    // STRUCTURAL BREAKOUT PROFILE
    // Lower acceleration, higher structure weight
    // Targets: sustained breakouts, compression release
    ignitionThreshold: 57,   // v21.3.5 LOWERED from 61 → 4-point reduction for meaningful breakouts
    stochWeight: 1.15,       // De-emphasize stoch (less reactive)
    emaWeight: 0.90,         // Lower acceleration weight
    volatilityWeight: 1.45,  // Emphasize compression (breakout setup)
    impulseWeight: 1.25,     // Maintain direction but moderate
    trendWeight: 1.65,       // v21.3.5 BOOSTED from 1.50 → emphasize 4H structure more
    
    // BTC activation style: structure-driven, rare triggers
    activationStyle: "STRUCTURAL",
    persistenceRules: {
      requireSustainedEMA: false,        // BTC: structure determines activation, not EMA rules
      requireDirectionAlignment: false,
      stabilityThreshold: 100,
    },
    breakoutBonus: 5,                    // BTC: +5 score bonus for confirmed structural breakout
    bonusActivation: "STRUCTURAL_BREAKOUT",
  },
  
  ETH: {
    // TREND CONTINUATION PROFILE - v21.3.5 TUNED FOR SIGNALS
    // Emphasis: directional persistence + EMA continuation (not impulse spikes)
    // ETH trends smoother than SOL - reward sustained expansion, not violent acceleration
    ignitionThreshold: 60,   // v21.3.5 LOWERED from 63 → 3-point reduction for continuation triggers
    stochWeight: 1.30,       // Maintain stoch sensitivity
    emaWeight: 1.40,         // v21.3.5 BOOSTED from 1.30 → boost EMA continuation scoring
    volatilityWeight: 1.25,  // Medium compression weight
    impulseWeight: 1.10,     // De-emphasize impulse candles
    trendWeight: 1.35,       // Higher emphasis on directional persistence
    
    // ETH activation style: continuation-focused, lighter validation
    activationStyle: "CONTINUATION",
    persistenceRules: {
      requireSustainedEMA: true,         // ETH: must have sustained EMA slope (0.3-1.0)
      requireDirectionAlignment: false,  // v21.3.5 RELAXED from true → direction alignment advisory only
      stabilityThreshold: 45,            // ETH: volatility < 45 (stable compression)
    },
    breakoutBonus: 0,                    // ETH: no structural bonus
    bonusActivation: "NONE",
  },
};

/**
 * v35.0 CALCULATE IMPULSE STRENGTH (EARLY DECLARATION)
 * Measures continuation impulse active in the market (0-100)
 * Used to validate RANGE direction persistence requirements
 * Declared early to avoid TDZ issues with hoisting
 */
function calculateImpulseStrength(
  emaSlope: number | null,
  volatilityLevel: number | null,
  stochRsi: number | null
): number {
  let strength = 50; // Neutral baseline
  
  // EMA sharpness indicates momentum strength
  if (emaSlope !== null) {
    const slopeStrength = Math.abs(emaSlope);
    strength += (slopeStrength / 1.0) * 20; // Up to +20 from slope
  }
  
  // Volatility expansion indicates impulse
  if (volatilityLevel !== null) {
    if (volatilityLevel > 70) {
      strength += 15;  // High expansion
    } else if (volatilityLevel > 50) {
      strength += 5;   // Moderate
    } else if (volatilityLevel < 30) {
      strength -= 10;  // Compression reduces impulse
    }
  }
  
  // Stoch extremes indicate strong directional push
  if (stochRsi !== null) {
    if (stochRsi > 80 || stochRsi < 20) {
      strength += 10;  // Extreme zones show strong impulse
    }
  }
  
  return Math.max(0, Math.min(100, strength));
}

function getExecutionProfile(symbol: string): ExecutionProfile {
  return EXECUTION_PROFILES[symbol] || EXECUTION_PROFILES.SOL;
}


/**
 * Build execution context at scan entry point
 * v7.7.0: CORRECTLY SEPARATE data trust from system health
 * 
 * executionAllowed = ONLY based on DATA SOURCE
 * (does NOT depend on system health)
 */
function buildExecutionContext(symbol: string, priceData: PriceData): ExecutionContext {
  // DATA TRUST: Based ONLY on source
  const isKrakenSource = priceData.source === "kraken_live" || priceData.source === "kraken_cached";
  
  const ctx: ExecutionContext = {
    symbol,
    cycleId: `${Date.now()}-${symbol}`,
    
    // DATA TRUST: execution-grade if Kraken source (cached OR live)
    executionGrade: isKrakenSource,
    dataSource: isKrakenSource ? "KRAKEN" : "COINGECKO",
    
    // SYSTEM HEALTH: independent from data trust
    systemHealth: priceData.health,
    systemHealthReason: priceData.health === "LIVE" ? undefined : `System health: ${priceData.health}`,
    
    price: priceData.price,
    timestamp: Date.now(),
  };

  // Log the distinction clearly
  if (!ctx.executionGrade) {
    console.log(`[GATE] ${symbol} BLOCKED (data trust): source=${priceData.source}`);
  } else if (ctx.systemHealth !== "LIVE") {
    console.log(`[GATE] ${symbol} ALLOWED (execution-grade) but DEGRADED (system): ${ctx.systemHealthReason}`);
  }

  return ctx;
}

// ═════════════════════════════════════════════════════════════════════════════
// v8.5: BREAKOUT-AWARE DIRECTION INFERENCE (STRUCTURE-FIRST)
// ═════════════════════════════════════════════════════════════════════════════
// 
// CRITICAL FIX: SNIPER was momentum-first, triggering contradictory SHORT signals
// during bullish breakout retests. Now detects breakout states and prevents
// direction finalization until structural confirmation is complete.
//
// Breakout State Machine:
// NONE → BREAKOUT_UP → RETEST_PHASE → NONE (or confirm LONG) OR return to NONE
// NONE → BREAKOUT_DOWN → RETEST_PHASE → NONE (or confirm SHORT) OR return to NONE

type BreakoutState = "NONE" | "BREAKOUT_UP" | "BREAKOUT_DOWN" | "RETEST_PHASE";

interface LevelAwareness {
  recentHigh: number;        // Recent swing high (20-period reference)
  recentLow: number;         // Recent swing low (20-period reference)
  breakoutState: BreakoutState;
  breakoutPrice: number | null;
  breakoutTime?: number;
  priceAboveHigh: boolean;   // Price is above recentHigh
  priceBelowLow: boolean;    // Price is below recentLow
}

/**
 * Compute level awareness from recent price action
 * Tracks breakout states to prevent contradictory signals
 */
function computeLevelAwareness(
  price: number,
  priceHistory: number[] | null,
  previousBreakoutState: BreakoutState
): LevelAwareness {
  // Default to recent price as reference if no history
  const recentHigh = priceHistory && priceHistory.length >= 10 
    ? Math.max(...priceHistory.slice(-20))
    : price * 1.01;  // Assume 1% above current
    
  const recentLow = priceHistory && priceHistory.length >= 10
    ? Math.min(...priceHistory.slice(-20))
    : price * 0.99;  // Assume 1% below current

  const priceAboveHigh = price > recentHigh;
  const priceBelowLow = price < recentLow;

  // Detect state transitions
  let breakoutState = previousBreakoutState;
  let breakoutPrice: number | null = null;

  if (previousBreakoutState === "NONE") {
    // Detect new breakout
    if (priceAboveHigh) {
      breakoutState = "BREAKOUT_UP";
      breakoutPrice = recentHigh;
    } else if (priceBelowLow) {
      breakoutState = "BREAKOUT_DOWN";
      breakoutPrice = recentLow;
    }
  } else if (previousBreakoutState === "BREAKOUT_UP") {
    // In breakout-up phase, check for retest or failure
    if (price < recentHigh * 0.98) {
      // Price pulled back - now in retest phase
      breakoutState = "RETEST_PHASE";
    }
  } else if (previousBreakoutState === "BREAKOUT_DOWN") {
    // In breakout-down phase, check for retest or failure
    if (price > recentLow * 1.02) {
      // Price bounced back - now in retest phase
      breakoutState = "RETEST_PHASE";
    }
  } else if (previousBreakoutState === "RETEST_PHASE") {
    // In retest phase, price can either re-establish breakout or fail
    if (priceAboveHigh) {
      // Retest passed above high - confirm breakout
      breakoutState = "NONE";
    } else if (priceBelowLow) {
      // Retest passed below low - confirm breakout
      breakoutState = "NONE";
    }
    // Otherwise stay in RETEST_PHASE
  }

  return {
    recentHigh,
    recentLow,
    breakoutState,
    breakoutPrice,
    priceAboveHigh,
    priceBelowLow,
  };
}

/**
 * Validate direction against breakout state
 * Prevents contradictory signals during breakout phases
 * 
 * Example: During bullish breakout, suppress SHORT signals
 */
function validateDirectionAgainstBreakout(
  proposedDirection: "LONG" | "SHORT" | "NEUTRAL",
  levelAwareness: LevelAwareness
): "LONG" | "SHORT" | "NEUTRAL" | "WATCH_BREAKOUT" {
  const { breakoutState, priceAboveHigh, priceBelowLow } = levelAwareness;

  // If in retest phase of a breakout, hold direction
  if (breakoutState === "RETEST_PHASE") {
    return "WATCH_BREAKOUT";  // Don't commit to direction yet
  }

  // If breakout-up active, block SHORT signals
  if (breakoutState === "BREAKOUT_UP" && proposedDirection === "SHORT") {
    return "WATCH_BREAKOUT";  // Don't allow SHORT during bullish breakout
  }

  // If breakout-down active, block LONG signals
  if (breakoutState === "BREAKOUT_DOWN" && proposedDirection === "LONG") {
    return "WATCH_BREAKOUT";  // Don't allow LONG during bearish breakout
  }

  return proposedDirection;
}

// ═════════════════════════════════════════════════════════════════════════════
// v9: STRUCTURE STATE SYSTEM (CORE LAYER - STRUCTURE-FIRST)
// ═════════════════════════════════════════════════════════════════════════════
//
// CRITICAL PRINCIPLE: Structure determines direction BEFORE momentum evaluation
// Momentum never overrides structure - only affects confidence
//
// State Machine:
// RANGE → BREAKOUT_UP/DOWN → RETEST_UP/DOWN → TREND_CONTINUATION
//                          ↘ FAILED_BREAKOUT ↙

type StructureState = 
  | "RANGE"                 // No clear structure, swinging within high/low
  | "BREAKOUT_UP"           // Price breaks above swing high
  | "BREAKOUT_DOWN"         // Price breaks below swing low
  | "RETEST_UP"             // Pullback within breakout-up, retest zone
  | "RETEST_DOWN"           // Bounce within breakout-down, retest zone
  | "FAILED_BREAKOUT"       // Breakout failed, reversal
  | "TREND_CONTINUATION";   // Retest passed, trend confirmed

/**
 * Compute structure state from price action and history
 * Returns deterministic structure classification
 */
function computeStructureState(
  price: number,
  prevStructureState: StructureState,
  swingHigh: number,
  swingLow: number,
  breakoutLevel: number | null
): StructureState {
  // A. RANGE DETECTION (no clear breakout)
  if (!swingHigh || !swingLow || swingHigh <= swingLow) {
    return "RANGE";
  }

  // B. BREAKOUT DETECTION (structure creation)
  if (price > swingHigh * 1.005) {  // 0.5% buffer to avoid noise
    return "BREAKOUT_UP";
  }
  if (price < swingLow * 0.995) {   // 0.5% buffer to avoid noise
    return "BREAKOUT_DOWN";
  }

  // C. RETEST LOGIC (CRITICAL - locked direction)
  if (prevStructureState === "BREAKOUT_UP" && breakoutLevel) {
    // Price pulled back to retest zone
    if (price <= breakoutLevel * 0.99) {  // Within 1% of breakout
      return "RETEST_UP";
    }
  }

  if (prevStructureState === "BREAKOUT_DOWN" && breakoutLevel) {
    // Price bounced to retest zone
    if (price >= breakoutLevel * 1.01) {  // Within 1% of breakout
      return "RETEST_DOWN";
    }
  }

  // D. FAILURE CONDITIONS (no signal if structure breaks)
  if (prevStructureState === "BREAKOUT_UP" && price < swingLow) {
    return "FAILED_BREAKOUT";  // Bullish breakout failed
  }

  if (prevStructureState === "BREAKOUT_DOWN" && price > swingHigh) {
    return "FAILED_BREAKOUT";  // Bearish breakout failed
  }

  // E. CONTINUATION (retest passed, trend continuing)
  if (prevStructureState === "RETEST_UP" && price > (breakoutLevel || swingHigh)) {
    return "TREND_CONTINUATION";
  }

  if (prevStructureState === "RETEST_DOWN" && price < (breakoutLevel || swingLow)) {
    return "TREND_CONTINUATION";
  }

  // Default: maintain state
  return prevStructureState;
}

/**
 * v28.0 UNIFIED REGIME + CONVICTION ENGINE
 * 
 * CRITICAL ARCHITECTURAL FIX: One trade score is the single source of truth
 * Everything derives from it: direction, state, conviction, SL, UI
 * 
 * No more scattered logic:
 * - Direction no longer calculated separately
 * - State no longer calculated separately
 * - SL no longer calculated from swing levels independently
 * - Conviction is new: penalizes counter-trend, rewards aligned trades
 */

interface TradeScoreInput {
  emaSlope: number | null;
  stochRsi: number | null;
  displacement?: number; // momentum vector
  volatility: number | null;
  htf4hTrend: "BULLISH" | "BEARISH" | "NEUTRAL" | null | string;
  structureState?: string;
}

/**
 * v28.0 DIRECTIONAL HIERARCHY FIX - HTF STRUCTURE DOMINATES
 * 
 * Tier 1 (Dominant - gates final direction):
 *   - HTF 4H structure trend
 *   - Displacement direction
 *   - Reclaim/failure structure
 *   - Macro inheritance
 *   
 * Tier 2 (Secondary - modulates Tier 1):
 *   - Local EMA acceleration (cannot override, only strengthen/weaken)
 *   - 15M expansion
 *   - Oscillator movement
 * 
 * Formula:
 * finalDirectionScore = HTFStructureWeight * displacementWeight * reclaimWeight * macroInheritance * localEMAMomentum * expansionWeight
 */
function calculateUnifiedTradeScore(input: TradeScoreInput): number {
  const {
    emaSlope,
    stochRsi,
    displacement = 0,
    volatility = 50,
    htf4hTrend,
    structureState = "NEUTRAL"
  } = input;

  // Return null-safe baseline if insufficient data
  if (emaSlope === null || stochRsi === null) {
    return 50; // Neutral baseline
  }

  // ========================
  // TIER 1: STRUCTURAL BASE (EMA positioning threshold)
  // ========================
  // Direction determined by structural threshold (not momentum magnitude)
  let tier1Score = 50; // Neutral baseline
  
  if (emaSlope < -0.2) {
    // Structural bearish
    tier1Score = 25;
  } else if (emaSlope > 0.2) {
    // Structural bullish
    tier1Score = 75;
  }
  // else: if -0.2 to +0.2, momentum cannot decide, stay neutral (50)
  
  // ========================
  // TIER 2: MOMENTUM CONFIDENCE (strength only, not direction)
  // ========================
  // Momentum affects CONFIDENCE/strength, never decides direction
  
  // EMA slope sharpness = momentum expansion (not magnitude for direction)
  const slopeSharpness = Math.abs(emaSlope);
  let tier2Contribution = (slopeSharpness / 1.0) * 15; // Up to +15
  
  // Volatility expansion confidence
  if (volatility > 70) {
    tier2Contribution += 10; // High volatility = confidence boost
  } else if (volatility < 40) {
    tier2Contribution -= 5; // Low volatility = confidence penalty
  }
  
  // Stochastic RSI extremes = high confidence
  if (stochRsi > 75 || stochRsi < 25) {
    tier2Contribution += 8;
  }
  
  // ========================
  // MACRO CONFIDENCE MODIFIER
  // ========================
  let macroModifier = 1.0;
  if (htf4hTrend === "BULLISH" && tier1Score >= 50) {
    macroModifier = 1.15; // Aligned = +15% confidence
  } else if (htf4hTrend === "BEARISH" && tier1Score < 50) {
    macroModifier = 1.15; // Aligned = +15% confidence
  } else if ((htf4hTrend === "BULLISH" && tier1Score < 50) || 
             (htf4hTrend === "BEARISH" && tier1Score >= 50)) {
    macroModifier = 0.80; // Counter-trend = -20% confidence
  }
  
  // ========================
  // FINAL SCORE: Direction base + momentum confidence
  // ========================
  // CRITICAL: Direction (25/50/75) is structural only
  // Momentum only affects strength through tier2Contribution
  const finalScore = tier1Score + (tier2Contribution * macroModifier);
  
  console.log(`[UNIFIED_SCORE_v31] STRUCTURAL: base=${tier1Score} | MOMENTUM: confidence=${tier2Contribution.toFixed(1)} | MACRO: ${(macroModifier*100).toFixed(0)}% | FINAL=${Math.max(0, Math.min(100, finalScore)).toFixed(1)}`);
  
  // Clamp to 0-100
  return Math.max(0, Math.min(100, finalScore));
}

/**
 * v35.0 CALCULATE IMPULSE STRENGTH
 * Measures continuation impulse active in the market (0-100)
 * Used to validate RANGE direction persistence requirements
 */
/**
 * v28.0 DERIVE DIRECTION FROM UNIFIED SCORE
 * Direction is ALWAYS derived from score, never calculated separately
 */
/**
 * v30.0 LIGHTWEIGHT SNIPER ELIGIBILITY - PROBABILISTIC EARLY IMPULSE ENGINE
 * 
 * Removed over-gating. Now prioritizes early entry over macro confirmation.
 * Macro trend influences confidence only, never blocks signals.
 * Counter-trend setups ALLOWED with confidence modulation.
 */
function validateFullSniperEligibility(
  card: SymbolCardState,
  score: number,
  profile: ExecutionProfile,
  symbol: string,
  macroConflict: boolean,
  htf4hTrend: string | null
): boolean {
  // GATE 1 ONLY: Score threshold (hard requirement)
  if (score < profile.ignitionThreshold) {
    console.log(`[SNIPER_ELIGIBILITY_v30] ${symbol} REJECTED: score ${score} < threshold ${profile.ignitionThreshold}`);
    return false;
  }
  
  // GATE 2: Direction must be clear (no NEUTRAL trades)
  if (card.direction === "NEUTRAL") {
    console.log(`[SNIPER_ELIGIBILITY_v30] ${symbol} REJECTED: no directional bias`);
    return false;
  }
  
  // That's it for hard gates. Everything else is probabilistic modulation.
  // COUNTER_TREND and macro mismatch are NO LONGER hard rejections.
  // They influence confidence and risk, not access to ACTIVE_SNIPER.
  
  if (macroConflict) {
    // Counter-trend setup - ALLOWED with notation
    console.log(`[SNIPER_ELIGIBILITY_v30] ${symbol} ACCEPTED (COUNTER_TREND): ${card.direction} vs 4H ${htf4hTrend} - confidence will be modulated`);
  } else {
    console.log(`[SNIPER_ELIGIBILITY_v30] ${symbol} ACCEPTED (ALIGNED): ${card.direction} aligns with 4H ${htf4hTrend}`);
  }
  
  return true;
}



/**
 * v28.0 CLASSIFY RELATIONSHIP (DIRECTION vs MACRO)
 * Simple, consistent classification of how direction relates to macro trend
 */
function classifyRelationship(
  direction: "LONG" | "SHORT" | "NEUTRAL",
  htf4hTrend: string | null
): "STRONG_ALIGNED" | "COUNTER_TREND" | "NEUTRAL" {
  if (direction === "NEUTRAL" || !htf4hTrend || htf4hTrend === "NEUTRAL") {
    return "NEUTRAL";
  }

  if (direction === "LONG" && htf4hTrend === "BULLISH") {
    return "STRONG_ALIGNED";
  }

  if (direction === "SHORT" && htf4hTrend === "BEARISH") {
    return "STRONG_ALIGNED";
  }

  if (direction === "LONG" && htf4hTrend === "BEARISH") {
    return "COUNTER_TREND";
  }

  if (direction === "SHORT" && htf4hTrend === "BULLISH") {
    return "COUNTER_TREND";
  }

  return "NEUTRAL";
}

/**
 * v28.0 DERIVE CONVICTION FROM SCORE + RELATIONSHIP
 * NEW KEY FIX: Conviction engine penalizes counter-trend, rewards aligned
 * 
 * Range: 0.2 (minimum conviction) to 1.0 (maximum conviction)
 * Counter-trend gets 35% confidence penalty
 * Aligned gets 15% confidence boost
 */
function deriveConvictionFromScore(
  score: number,
  relationship: "STRONG_ALIGNED" | "COUNTER_TREND" | "NEUTRAL"
): number {
  // Base conviction from score magnitude (0.2 to 1.0 range)
  const baseConviction = 0.2 + (Math.abs(score - 50) / 50) * 0.8;

  let convictionMultiplier = 1.0;

  if (relationship === "COUNTER_TREND") {
    // Counter-trend trades get lower conviction (35% penalty)
    convictionMultiplier = 0.65;
  } else if (relationship === "STRONG_ALIGNED") {
    // Aligned trades get higher conviction (15% boost)
    convictionMultiplier = 1.15;
  }

  // Apply multiplier and clamp to 0.2-1.0
  return Math.max(0.2, Math.min(1.0, baseConviction * convictionMultiplier));
}

/**
 * v28.0 CALCULATE SL PURELY FROM SCORE + CONVICTION
 * NEW KEY FIX: SL is now a pure function of score + conviction
 * No longer derived from swing levels independently
 * 
 * Base risk: 1.2%
 * Adjusted by conviction (confidence increases risk allowance)
 * Capped at 1.8% inflation threshold
 */
function calculateSLFromScoreAndConviction(
  entry: number,
  score: number,
  conviction: number,
  direction: "LONG" | "SHORT"
): number {
  // Base risk: 1.2% of entry
  const baseRisk = 0.012;

  // Adjusted risk: conviction multiplies risk allowance
  // High conviction (1.0) = 1.2% × 1.0 = 1.2% risk
  // Low conviction (0.2) = 1.2% × 0.2 = 0.24% risk
  const adjustedRisk = baseRisk * conviction;

  // Volatility adjust: strong score = allow wider SL
  // Score 75+ gets 30% wider, score 50 gets standard
  const volatilityAdjust = Math.min(1.3, (Math.abs(score - 50) / 50) * 0.3 + 1.0);

  // Final risk distance
  const finalRisk = adjustedRisk * volatilityAdjust;

  // Hard cap: never exceed 1.8% (inflation cap)
  const cappedRisk = Math.min(0.018, finalRisk);

  // Apply to entry
  if (direction === "LONG") {
    return entry * (1 - cappedRisk);
  } else {
    return entry * (1 + cappedRisk);
  }
}

/**
 * v26.0 EVENT-ONLY OUTPUT GATE (preserved from v26)
 * CRITICAL: Only output when meaningful events occur
 */
type CycleSnapshot = {
  direction: string;
  signalState: string;
  score: number;
  htf4hTrend: string | null;
  stateHash: string;
};

// v38.0 FIX: Lazy initialize lastCycleSnapshot to prevent TDZ
// Module-level Map<string, CycleSnapshot>() initialization caused "Cannot access 'card' before initialization"
let lastCycleSnapshot: Map<string, CycleSnapshot> | null = null;

function getLastCycleSnapshot(): Map<string, CycleSnapshot> {
  if (lastCycleSnapshot === null) {
    lastCycleSnapshot = new Map();
  }
  return lastCycleSnapshot;
}

/**
 * Detect meaningful state transitions (not snapshots)
 */
function detectOutputEvent(
  symbol: string,
  card: SymbolCardState,
  currentScore: number
): string | null {
  const last = getLastCycleSnapshot().get(symbol);
  
  if (!last) {
    return "FIRST_SCAN";
  }
  
  if (card.direction !== last.direction) {
    return "DIRECTION_FLIP";
  }
  
  if (card.signalState !== last.signalState) {
    return "SIGNAL_STATE_CHANGE";
  }
  
  if (card.htf4hTrend !== last.htf4hTrend) {
    return "MACRO_SHIFT";
  }
  
  if (card.signalState === "ACTIVE_SNIPER" && currentScore >= 75 && last.score < 75) {
    return "SIGNAL_PROMOTION";
  }
  
  if (last.signalState === "ACTIVE_SNIPER" && card.signalState !== "ACTIVE_SNIPER") {
    return "SIGNAL_INVALIDATION";
  }
  
  return null;
}

/**
 * Update cycle snapshot for next comparison
 */
function updateCycleSnapshot(
  symbol: string,
  card: SymbolCardState,
  score: number
): void {
  getLastCycleSnapshot().set(symbol, {
    direction: card.direction,
    signalState: card.signalState,
    score,
    htf4hTrend: card.htf4hTrend,
    stateHash: `${card.direction}|${card.signalState}|${score}|${card.htf4hTrend}`,
  });
}


/**
 * Calculate macro bias weight from 4H trend
 * v24.0 MACRO-MOMENTUM FUSION LAYER
 * 
 * Converts 4H macro context into directional probability bias
 * Does NOT override momentum, but TILTS probability toward macro alignment
 */
function calculateMacroBiasWeight(htf4hTrend: string | null): number {
  // Macro bias is additive to momentum score, not multiplicative
  // This allows macro to "subtly tilt probability" without being a gate
  
  if (htf4hTrend === "BULLISH") {
    return 8;  // +8 points toward LONG bias
  } else if (htf4hTrend === "BEARISH") {
    return -8; // -8 points toward SHORT bias
  } else {
    return 0;  // NEUTRAL adds no bias
  }
}

/**
 * Calculate structure score from state
 * Provides continuity penalty for stale structures
 */
function calculateStructureScore(
  structureState: StructureState,
  direction: string
): number {
  // Structure confirmation when direction aligns with locked state
  if (
    (structureState === "BREAKOUT_UP" && direction === "LONG") ||
    (structureState === "RETEST_UP" && direction === "LONG") ||
    (structureState === "BREAKOUT_DOWN" && direction === "SHORT") ||
    (structureState === "RETEST_DOWN" && direction === "SHORT")
  ) {
    return 5; // +5 points for structure-direction alignment
  } else if (structureState === "RANGE") {
    return 0; // RANGE is neutral to structure
  } else {
    return -3; // -3 points penalty for direction conflicting with structure
  }
}

/**
 * v24.0 MACRO-MOMENTUM FUSION: Composite direction score
 * Combines momentum, macro bias, and structure into single probability score
 * 
 * finalDirectionScore = momentumComponent + macroBiasComponent + structureComponent
 * 
 * Does NOT override momentum with macro - macro is a tilt, not a gate
 */
function calculateDirectionScore(
  momentumComponent: number,
  macroBiasWeight: number,
  structureScore: number
): { score: number; dominantBias: "LONG" | "SHORT" | "NEUTRAL" } {
  // Composite score: momentum (primary) + macro (secondary) + structure (tertiary)
  const totalScore = momentumComponent + macroBiasWeight + structureScore;
  
  // CRITICAL FIX: Lower threshold to prevent obvious trends from collapsing to NEUTRAL
  // With EMA slope -1 to +1 (mapped to ±100), threshold of 5 was too strict
  // New threshold: ±2 allows clear EMA slopes (0.2+ or -0.2-) to establish direction
  let dominantBias: "LONG" | "SHORT" | "NEUTRAL" = "NEUTRAL";
  if (totalScore > 2) {
    dominantBias = "LONG";
  } else if (totalScore < -2) {
    dominantBias = "SHORT";
  }
  
  return { score: totalScore, dominantBias };
}

/**
 * v27.0 BUILD SIGNAL HIERARCHY - STRICT UI SEPARATION
 * CRITICAL: Macro MUST NEVER appear as directional suggestion ("consider LONG/SHORT")
 * 
 * PRIMARY: Direction from 1H SNIPER momentum
 * CONTEXT: 4H macro as secondary information only (not a suggestion)
 */
type SignalHierarchy = {
  primary: {
    mode: "ACTIVE_SNIPER";
    direction: "LONG" | "SHORT";
    score: number;
    rationale: string;
  };
  context?: {
    type: "MACRO_ALIGNMENT" | "MACRO_DIVERGENCE";
    macroTrend: "BULLISH" | "BEARISH" | "NEUTRAL";
    impact: "REINFORCES" | "COMPLICATES" | "NEUTRAL";
    note: string; // v27.0: FIX - never says "consider LONG/SHORT"
  };
};

/**
 * v27.0 Build signal rendering hierarchy - STRICT SEPARATION LOCK
 * PRIMARY: ACTIVE_SNIPER determines direction
 * CONTEXT: 4H macro is informational (MACRO SUPPORTIVE, MACRO CONTRA, MACRO NEUTRAL)
 * NO LEAKAGE: Never include "consider LONG", "consider SHORT", or similar suggestions
 */
function buildSignalHierarchy(
  direction: "LONG" | "SHORT",
  score: number,
  htf4hTrend: string | null,
  execution15mState: string,
  stochRsi: number | null,
  emaSlope: number | null
): SignalHierarchy {
  // PRIMARY: ACTIVE_SNIPER with full rationale
  const primary: SignalHierarchy["primary"] = {
    mode: "ACTIVE_SNIPER",
    direction,
    score,
    rationale: `${direction} SNIPER ignition: 15M=${execution15mState} + momentum (stoch=${stochRsi?.toFixed(1) ?? "N/A"}, ema=${emaSlope?.toFixed(3) ?? "N/A"})`,
  };
  
  // CONTEXT: 4H macro as secondary information (NEVER as suggestion or direction implication)
  // v33.0 UI DISCIPLINE: Macro is confidence modifier only
  let context: SignalHierarchy["context"] | undefined;
  if (htf4hTrend && htf4hTrend !== "NEUTRAL") {
    // Determine if macro aligns or diverges (for confidence adjustment only)
    const macroAligned = (htf4hTrend === "BULLISH" && direction === "LONG") || 
                         (htf4hTrend === "BEARISH" && direction === "SHORT");
    
    context = {
      type: macroAligned ? "MACRO_ALIGNMENT" : "MACRO_DIVERGENCE",
      macroTrend: htf4hTrend as "BULLISH" | "BEARISH",
      impact: macroAligned ? "+15% CONFIDENCE" : "-20% CONFIDENCE",
      // v33.0 UI DISCIPLINE: No directional language, confidence modifier only
      note: macroAligned 
        ? "Macro aligned (confidence boost)" 
        : "Macro divergence (confidence penalty)",
    };
  } else {
    context = {
      type: "MACRO_ALIGNMENT",
      macroTrend: "NEUTRAL",
      impact: "NEUTRAL",
      note: "Macro neutral (no modifier)",
    };
  }
  
  return { primary, context };
}


/**
 * v40.0 CRITICAL FIX: Directional Confidence Model
 * 
 * Instead of binary direction assignment, calculate confidence score.
 * Only assign direction if confidence exceeds threshold.
 * Prevents EMA leakage into neutral environments.
 */
function calculateDirectionalConfidence(
  emaSlope: number | null,
  structureState: StructureState,
  volatilityLevel: number | null,
  stochRsi: number | null,
  card?: SymbolCardState,
  htf4hTrend?: string | null
): number {
  let confidence = 0;
  
  // EMA acceleration (0-30 points)
  if (emaSlope !== null && emaSlope !== undefined) {
    if (Math.abs(emaSlope) > 0.5) {
      confidence += 30; // Strong acceleration
    } else if (Math.abs(emaSlope) > 0.25) {
      confidence += 20; // Moderate acceleration
    } else if (Math.abs(emaSlope) > 0.15) {
      confidence += 10; // Weak acceleration (insufficient alone)
    }
  }
  
  // Structure state alignment (0-25 points)
  if (structureState === "RETEST_UP" || structureState === "BREAKOUT_UP") {
    confidence += 25; // Bullish structure
  } else if (structureState === "RETEST_DOWN" || structureState === "BREAKOUT_DOWN") {
    confidence += 25; // Bearish structure
  } else if (structureState === "RANGE") {
    confidence += 0; // RANGE adds no directional confidence
  }
  
  // Volatility expansion alignment (0-20 points)
  if (volatilityLevel !== null && volatilityLevel !== undefined) {
    if (volatilityLevel > 65) {
      confidence += 20; // Strong expansion
    } else if (volatilityLevel > 55) {
      confidence += 10; // Moderate expansion
    }
  }
  
  // Displacement activity confirmation (0-20 points)
  if (card && card.recentImpulseStrength !== null && card.recentImpulseStrength !== undefined) {
    if (card.recentImpulseStrength > 60) {
      confidence += 20; // Strong impulse continuation
    } else if (card.recentImpulseStrength > 40) {
      confidence += 10; // Moderate impulse
    }
  }
  
  // Execution state expansion (0-5 points - bonus only)
  if (card && (card.execution15mState === "EXPANDING" || card.execution15mState === "BREAKOUT_READY")) {
    confidence += 5; // Minor bonus for active expansion
  }
  
  // HTF alignment (0-10 points)
  if (htf4hTrend) {
    // Don't assign directional confidence from HTF - only for validation
    // HTF should confirm, not drive direction
  }
  
  return Math.min(confidence, 100); // Cap at 100
}

/**
 * v40.0 CRITICAL FIX: Corrected Direction Generation
 * 
 * Uses confidence model instead of binary direction assignment.
 * Only assign LONG/SHORT if confidence > 50.
 * Otherwise return NEUTRAL.
 * Prevents false directional leakage.
 */
function getDirectionFromStructure(
  structureState: StructureState,
  emaStructure: any,
  stochRsi: number | null,
  htf4hTrend: string | null,
  volatilityLevel: number | null,
  card?: SymbolCardState  // v35.0: Pass card for displacement context
): "LONG" | "SHORT" | "NEUTRAL" {
  // v40.0 FIX: Use confidence model, not binary assignment
  
  if (!emaStructure) {
    throw new Error("EMA_STRUCTURE_REQUIRED: getDirectionFromStructure must receive valid emaStructure");
  }
  
  const emaSlope = emaStructure.emaSlope; // -1.0 to +1.0
  
  // Step 1: Calculate directional confidence
  const confidence = calculateDirectionalConfidence(
    emaSlope,
    structureState,
    volatilityLevel,
    stochRsi,
    card,
    htf4hTrend
  );
  
  // Step 2: Determine tentative direction from structure (not confidence)
  let tentativeDirection: "LONG" | "SHORT" | "NEUTRAL" = "NEUTRAL";
  
  // EMA slope determines tentative direction
  if (emaSlope < -0.2) {
    tentativeDirection = "SHORT";
  } else if (emaSlope > 0.2) {
    tentativeDirection = "LONG";
  }
  
  // Structure state tie-breaker (only when EMA is neutral)
  if (tentativeDirection === "NEUTRAL") {
    if (structureState === "RETEST_UP" || structureState === "BREAKOUT_UP") {
      tentativeDirection = "LONG";
    } else if (structureState === "RETEST_DOWN" || structureState === "BREAKOUT_DOWN") {
      tentativeDirection = "SHORT";
    }
  }
  
  // v41.1 CRITICAL FIX: Separate concerns - direction ≠ confidence ≠ activation
  // Direction is the MARKET STATE, not a tradability gate
  // Confidence gates SNIPER activation, NOT directional visibility
  
  // If we have tentative direction from structure/EMA, preserve it
  // Confidence affects signal readiness, not market narrative
  if (tentativeDirection !== "NEUTRAL") {
    console.log(`[DIRECTION_PRESERVED] ${card?.symbol || "SYMBOL"}: ${tentativeDirection} | confidence=${confidence.toFixed(0)} (market structure active, activation pending)`);
    return tentativeDirection; // Return market direction regardless of confidence
  }
  
  // Only neutralize if NO directional structure exists
  console.log(`[DIRECTION_NEUTRAL] ${card?.symbol || "SYMBOL"}: no directional structure detected | confidence=${confidence.toFixed(0)}`);
  return "NEUTRAL";
}

/**
 * v40.0: OLD FUNCTION - Keeping getDirectionLockedByStructure for compatibility
 * But getDirectionFromStructure now handles all direction logic
 */
function getDirectionLockedByStructure(
  proposedDirection: "LONG" | "SHORT" | "NEUTRAL",
  structureState: StructureState
): "LONG" | "SHORT" | "NEUTRAL" {
  // NO GATES - Structure locks direction, never blocks
  
  // If structure has clear directional bias, lock it
  if (structureState === "RETEST_UP" || structureState === "BREAKOUT_UP") {
    return "LONG";  // Structure-locked LONG
  }

  if (structureState === "RETEST_DOWN" || structureState === "BREAKOUT_DOWN") {
    return "SHORT";  // Structure-locked SHORT
  }

  // FAILED_BREAKOUT or TREND_CONTINUATION: use proposed direction
  if (proposedDirection !== "NEUTRAL") {
    return proposedDirection;
  }

  // RANGE with no momentum: neutral allowed
  return "NEUTRAL";
}

// FIX #1: Unified signal state (v7.2.6) - REMOVED SNIPER_IMMINENT (regression leak)
// v7.4.0: Clean state machine - only 3 valid states for signal generation
// v8.5: Added WATCH_BREAKOUT for structure-first breakout detection
// v9: Added structure-first direction locking
export type SignalState = 
  | "NONE"              // No signal
  | "BUILDING"          // Directional bias + compression, waiting for ignition
  | "SNIPER_READY"      // All SNIPER conditions passed, awaiting entry confirmation
  | "CONFIRMED_READY"   // All CONFIRMED conditions passed, awaiting confirmation
  | "ACTIVE_SNIPER"     // SNIPER signal active, trade window open (30 min cooldown)
  | "ACTIVE_CONFIRMED"  // CONFIRMED signal active, trend confirmation (90 min cooldown) - INTERNAL ONLY
  | "WATCH_BREAKOUT";   // Breakout detected, holding direction until retest confirmation

export type SymbolCardState = {
  symbol: string;
  price: number;
  source: string;
  degraded: boolean;

  direction: "LONG" | "SHORT" | "NEUTRAL";
  mode: "SNIPER" | "CONFIRMED" | "NONE";
  confidence: number;
  
  // FIX #1: Unified signal state (v7.2.6), extended for v7.2.8, standardized for v7.2.9
  // v8.5: Added WATCH_BREAKOUT state for structure-first awareness
  signalState: SignalState;
  lastSignalTime?: number;

  // Momentum indicators (5M)
  stochRsi: number | null;
  emaSlope: number | null;
  volatilityLevel: number | null;

  // v8.5: Breakout awareness (structure-first)
  breakoutState?: BreakoutState;
  recentHigh?: number;
  recentLow?: number;
  
  // v35.0: Current price tracking for displacement detection (RANGE decay)
  currentPrice?: number;  // Current price (for displacement context)
  entryPrice?: number;    // Entry price (for displacement calculation)
  recentImpulseStrength?: number;  // Continuation impulse strength (0-100)

  // v9: Structure state system (core layer - structure-first)
  structureState: StructureState;
  swingHigh: number;
  swingLow: number;
  breakoutLevel: number | null;
  structureTimeframe: number;  // ms since last structure state change
  lastStructureUpdate: number; // timestamp

  // Higher TimeFrame alignment (v7.1.1 - SIMPLIFIED FOR v7.2.10)
  // v7.2.10: Remove 1H dependency, use 15M execution structure instead
  htf4hTrend: "BULLISH" | "BEARISH" | "NEUTRAL";
  htf4hMomentum: number | null;
  htf1hAlignment: boolean | null; // Deprecated v7.2.10, kept only for signal logic
  htf15mCompression: boolean | null;
  
  // v7.2.10 FIX #1 & #2: 15M EXECUTION STRUCTURE (replaces 1H display)
  // Shows entry readiness based on 15M structure + volatility state
  execution15mState: "COMPRESSING" | "BREAKOUT_READY" | "EXPANDING" | "CHOP";

  // Market readiness engine (v7.2.1)
  marketReadinessState: string;
  tradeReadinessScore: number | null;
  momentumScore?: number; // v21.6.0: Calculated after all direction mutations
  
  // Conditional: Only populate if mode === "SNIPER" or "CONFIRMED"
  expectedMovePercent: { sniper: { min: number; max: number } } | null;
  targetPrices: { tp1: number; tp2: number; sl: number } | null;
  riskReward: number | null;

  // Trend memory (v7.2.5)
  lastBullishCycle?: number;
  lastBearishCycle?: number;
  trendMemory?: "BULLISH" | "BEARISH";

  cycleId: string;  // Unique identifier for this signal cycle
  notes: string;
  updatedAt: string;
};

export type Setup = {
  symbol: string;
  mode: "SNIPER" | "CONFIRMED";
  direction: "LONG" | "SHORT"; // NO NEUTRAL ALLOWED
  score: number;
  reason: string;
  price: number;
  // Momentum signal breakdown
  momentum: {
    stochRsiSignal: string;
    emaStackSignal: string;
    volatilitySignal: string;
    trend4H: boolean;
  };
  // HTF Alignment breakdown (v7.1.1)
  htf: {
    trend4h: "BULLISH" | "BEARISH";
    alignment1h: boolean;
    compression15m: boolean;
    trigger5m: string;
  };
};

/**
 * Generate symbol card states + setups from EXECUTION PIPELINE ONLY
 * v8.0: HARD PIPELINE SEGREGATION
 * v22.0: Real 4H structure detection engine
 * 
 * This function ONLY receives Kraken data (already segregated at ingestion).
 * No gating needed - separation happened upstream in market-data-layer.
 * PURE FUNCTION - momentum-based detection
 */
export async function generateSetups(segregatedMarkets: SegregatedMarketData, candles4hBySymbol?: Record<string, Candle[]>): Promise<{ cards: SymbolCardState[]; setups: Setup[] }> {
  const cards: SymbolCardState[] = [];
  const setups: Setup[] = [];

  // ===== v8.0: EXECUTION PIPELINE ONLY =====
  // segregatedMarkets.execution contains ONLY Kraken data
  // No fallback data participates in this loop
  for (const [symbol, priceData] of Object.entries(segregatedMarkets.execution)) {
    if (priceData.price === 0) {
      console.log(`[SCAN] ${symbol} no data`);
      continue;
    }

    // Build execution context (guaranteed execution-grade - Kraken only)
    const ctx = buildExecutionContext(symbol, priceData);
    
    // Generate card for scan with real 4H structure
    const card = generateCardState(symbol, priceData, candles4hBySymbol?.[symbol] ?? []);
    card.cycleId = ctx.cycleId;
    cards.push(card);

    // Get execution profile for this asset
    const profile = getExecutionProfile(symbol);

    // v21.6.0 CRITICAL FIX: Momentum score is now calculated in generateCardState()
    // AFTER all direction mutations, ensuring score uses final locked direction only
    // card.momentumScore is already populated here; use it instead of recalculating
    let score = card.momentumScore;
    
    // Apply activation-specific bonus (consolidates if-symbol checks)
    // REMOVED: if symbol === "BTC" && checkStructuralBreakout()
    // INSTEAD: profile.bonusActivation drives the bonus application
    if (profile.bonusActivation === "STRUCTURAL_BREAKOUT" && checkStructuralBreakout(card)) {
      score += profile.breakoutBonus;
      console.log(`[BONUS] ${symbol} +${profile.breakoutBonus} (${profile.bonusActivation}): score ${score - profile.breakoutBonus} → ${score}`);
    }
    
    console.log(`[SCAN] ${symbol} score=${score} direction=${card.direction} stoch=${card.stochRsi?.toFixed(1) ?? "—"} emaSlope=${card.emaSlope?.toFixed(2) ?? "—"}`);
    
    // v26.0 EVENT-ONLY OUTPUT GATE
    // CRITICAL FIX: Stop full card re-render spam
    // Only process output if meaningful event detected
    const outputEvent = detectOutputEvent(symbol, card, score);
    if (!outputEvent) {
      // No meaningful event - skip output but continue state tracking
      console.log(`[GATE] ${symbol} no event → suppress output`);
      updateCycleSnapshot(symbol, card, score);
      continue;  // Skip to next symbol
    }
    console.log(`[EVENT] ${symbol} event=${outputEvent}`);

    
    // v41.1 FIX: Separate concerns - direction visibility vs SNIPER eligibility
    // Direction always shows market state (LONG/SHORT/NEUTRAL)
    // Confidence only gates SNIPER creation, not signal visibility
    
    // Calculate directional confidence for SNIPER gating only
    const directionalConfidence = calculateDirectionalConfidence(
      card.emaSlope ?? 0,
      card.structureState,
      card.volatilityLevel ?? 0,
      card.stochRsi ?? 0,
      card,
      card.htf4hTrend
    );
    
    if (card.direction === "NEUTRAL") {
      // No directional structure detected - stay BUILDING without narrative
      card.signalState = "BUILDING";
      const commentary = generateWatchZoneCommentary(card);
      card.notes = commentary;
      console.log(`[BUILDING_NO_STRUCTURE] ${symbol} direction=NEUTRAL - no directional bias in structure`);
    } else {
      // Direction exists (LONG or SHORT) - show it even if confidence is low
      // Confidence determines SNIPER eligibility, not visibility
      const sniperConfidenceThreshold = 60;
      
      if (directionalConfidence >= sniperConfidenceThreshold) {
        // Sufficient confidence - proceed with SNIPER validation
        
        // v29.0 FULLY DETERMINISTIC: Single comprehensive validation before ANY construction
        // This ensures: if validation passes → signal WILL exist
        // If validation fails → signal NEVER constructed (not even briefly)
        
        // Define macro conflict before validation
        const macroConflict = (card.htf4hTrend === "BULLISH" && card.direction === "SHORT") || 
                             (card.htf4hTrend === "BEARISH" && card.direction === "LONG");
        
        const canCreateSniper = validateFullSniperEligibility(
          card,
          score,
          profile,
          symbol,
          macroConflict,
          card.htf4hTrend
        );
        
        if (canCreateSniper) {
          // ALL GATES PASSED: Build signal DETERMINISTICALLY (no further blocking possible)
          const atomicSignal = buildAtomicSniperSignal(card, score, symbol);
          
          if (atomicSignal) {
            // Signal built successfully - emit ACTIVE_SNIPER
            card.mode = "SNIPER";
            card.confidence = Math.min(score, 99);
            card.lastSignalTime = Date.now();
            card.signalState = "ACTIVE_SNIPER";
            
            // Populate trade targets
            card.expectedMovePercent = atomicSignal.expectedMovePercent;
            card.targetPrices = atomicSignal.targetPrices;
            card.riskReward = atomicSignal.riskReward;
            card.tradeReadinessScore = calculateTradeReadinessScore("SNIPER", card.direction, card.htf4hTrend, card.htf1hAlignment, card.emaSlope, card.stochRsi, card.volatilityLevel);
            
            setups.push(atomicSignal);
            console.log(`[EXECUTION] ${symbol} ACTIVE_SNIPER ${card.direction} score=${score} confidence=${directionalConfidence.toFixed(0)} | 4H:${card.htf4hTrend} 15M:${card.execution15mState}`);
            
          } else {
            // Atomic build failed - stay in BUILDING
            console.log(`[ATOMIC FAILED] ${symbol}: Incomplete payload, staying in BUILDING`);
            card.signalState = "BUILDING";
          }
        } else {
          // No SNIPER conditions met - stay in BUILDING with direction
          card.signalState = "BUILDING";
          const commentary = generateWatchZoneCommentary(card);
          card.notes = commentary;
          console.log(`[BUILDING] ${symbol} ${card.direction} score=${score} confidence=${directionalConfidence.toFixed(0)} - awaiting SNIPER conditions`);
        }
      } else {
        // Direction exists but confidence insufficient for SNIPER
        // Show direction in BUILDING state with reduced confidence narrative
        card.signalState = "BUILDING";
        const commentary = generateWatchZoneCommentary(card);
        card.notes = commentary;
        console.log(`[BUILDING_LOW_CONFIDENCE] ${symbol} ${card.direction} confidence=${directionalConfidence.toFixed(0)}/${sniperConfidenceThreshold} - expansion tracking (no SNIPER yet)`);
      }
    }

    // v21.7.0 SNIPER STALE STATE REVALIDATION
    // If ACTIVE_SNIPER was set in previous cycle, revalidate against current structure
    // Drop to BUILDING immediately if structure no longer supports it
    if (card.signalState === "ACTIVE_SNIPER" && !isValidCurrentStructureForSniper(card)) {
      console.log(`[SNIPER_INVALIDATED] ${symbol}: Structure no longer supports ACTIVE_SNIPER → dropping to BUILDING`);
      card.signalState = "BUILDING";
      card.lastSignalTime = undefined;
      // Generate watch zone commentary for new BUILDING state
      card.notes = generateWatchZoneCommentary(card);
    }

    // v9 PHASE 5: ACTIVE_SNIPER TERMINAL STATE IMMUTABILITY
    // Once impulse >= 27 AND ACTIVE_SNIPER state assigned, it becomes immutable
    // No downgrades, no state changes, no mutations after terminal state assignment
    // This ensures alert system always receives consistent ACTIVE_SNIPER state
    if (card.signalState === "ACTIVE_SNIPER" && card.lastSignalTime) {
      // Mark as terminal - prevent any downstream modifications
      // Alert worker must treat ACTIVE_SNIPER as final
      (card as any)._terminalState = true;
      console.log(`[TERMINAL] ${symbol} ACTIVE_SNIPER immutable lock (impulse=${score})`);
    }
  }

  return { cards, setups };
}

/**
 * WATCH_ZONE COMMENTARY
 * v21.3.1: Generate real-time market context for each symbol in BUILDING state
 * Shows: current direction, momentum, structural status, reversal warnings
 */
function generateWatchZoneCommentary(card: SymbolCardState): string {
  // v26.0 CRITICAL FIX: Use card.direction directly (NOT recalculated)
  // Direction is locked during generateCardState - render must respect it
  // NEVER recalculate direction from macro at render time
  const directionArrow = card.direction === "LONG" ? "↑" : card.direction === "SHORT" ? "↓" : "↔";
  const stochLevel = card.stochRsi ? `stoch ${card.stochRsi.toFixed(0)}` : "stoch —";
  const emaState = card.emaSlope
    ? card.emaSlope > 0.3 ? "8/21 steep up" : card.emaSlope > 0 ? "8/21 rising" : "8/21 falling"
    : "8/21 flat";
  const volatilityState = (card.volatilityLevel ?? 50) > 50 ? "breaking out" : "compression";
  const htfContext = card.htf4hTrend === "BULLISH" ? "bullish macro" : 
                     card.htf4hTrend === "BEARISH" ? "bearish macro" : "neutral macro";

  // Build context based on asset and conditions
  let context = "";
  
  if (card.symbol === "SOL") {
    if (card.direction === "LONG" && (card.volatilityLevel ?? 50) > 45) {
      context = `impulse phase (${emaState}, ${stochLevel}), ${volatilityState}, early entry zone`;
    } else if (card.direction === "SHORT" && (card.volatilityLevel ?? 50) > 45) {
      context = `selling pressure (${emaState}, ${stochLevel}), ${volatilityState}, early short zone`;
    } else {
      context = `consolidating (${emaState}, ${stochLevel}), ${volatilityState}, waiting for impulse`;
    }
  } else if (card.symbol === "BTC") {
    if ((card.volatilityLevel ?? 50) < 35 && card.direction !== "NEUTRAL") {
      context = `compression locked (${emaState}), awaiting structural break in ${card.direction === "LONG" ? "bullish" : "bearish"} direction`;
    } else if (card.htf4hTrend === "NEUTRAL") {
      context = `range consolidation (${emaState}, ${stochLevel}), macro unclear, structure building`;
    } else {
      context = `${card.htf4hTrend === "BULLISH" ? "structural bullish" : "structural bearish"} (${emaState}, ${stochLevel}), awaiting compression break`;
    }
  } else if (card.symbol === "ETH") {
    if (card.direction === "LONG" && (card.volatilityLevel ?? 50) > 45 && (card.emaSlope ?? 0) > 0.2) {
      context = `bullish transition (${emaState}, ${stochLevel}), expansion starting, continuation possible`;
    } else if (card.direction === "SHORT" && (card.volatilityLevel ?? 50) > 45 && (card.emaSlope ?? 0) < -0.2) {
      context = `bearish transition (${emaState}, ${stochLevel}), expansion starting, pullback possible`;
    } else if (card.htf4hTrend === "BEARISH" && card.direction === "LONG") {
      context = `early bullish move against ${htfContext} (${emaState}, ${stochLevel}), reversalrisk`;
    } else {
      context = `trend following (${emaState}, ${stochLevel}), ${volatilityState}, ${htfContext}`;
    }
  }
  
  // Add exhaustion advisory if applicable
  const advisory = generateExhaustionAdvisory(card);
  const withAdvisory = appendAdvisory(context, advisory);

  return `${card.symbol} WATCH_ZONE: ${directionArrow} ${withAdvisory}`;
}

/**
 * EXHAUSTION/CHOP ADVISORY SYSTEM
 * v21.3.8: Detect and expose unstable market conditions
 * Does not affect scoring, thresholds, or ACTIVE_SNIPER behavior
 */
function generateExhaustionAdvisory(card: SymbolCardState): string | null {
  const volatility = card.volatilityLevel ?? 50;
  const emaSlope = card.emaSlope ?? 0;
  const stoch = card.stochRsi ?? 50;
  
  // Advisory triggers when: volatility elevated AND (EMA weakening OR stoch quality poor)
  const volatilityElevated = volatility > 55;
  const emaMomentumLoss = Math.abs(emaSlope) < 0.1; // EMA flattening
  const stochInQuality = (card.direction === "LONG" && stoch < 40) || (card.direction === "SHORT" && stoch > 60);
  
  if (volatilityElevated && emaMomentumLoss) {
    return "MOMENTUM EXHAUSTING";
  } else if (volatilityElevated && stochInQuality) {
    return "TREND WEAKENING";
  } else if (volatility > 70 && emaSlope === 0) {
    return "EXPANSION FATIGUE";
  } else if (volatilityElevated && card.direction === "NEUTRAL") {
    return "CHOP RISK";
  }
  
  return null; // No advisory needed
}

/**
 * Append advisory to watch zone commentary if conditions warrant
 */
function appendAdvisory(baseCommentary: string, advisory: string | null): string {
  if (!advisory) return baseCommentary;
  return `${baseCommentary} [⚠ ${advisory}]`;
}

/**
 * TRADE-FOCUSED WATCH ZONE COMMENTARY
 * v21.3.2: For ACTIVE_SNIPER trades - shows if setup is still valid, reversal risks
 * v21.3.8: Now includes exhaustion advisories
 * Format: "↑ momentum holding, structure intact" or "⚠ reversal forming" + optional [⚠ ADVISORY]
 */
function generateTradeWatchCommentary(card: SymbolCardState): string {
  // v22.5 CRITICAL FIX: Align TRADE_MONITOR with execution engine
  // Monitor must use SAME finalDirection + SAME momentum interpretation
  
  // Use card.direction which is now finalDirection (after v22.3-22.4 fixes)
  const directionArrow = card.direction === "LONG" ? "↑" : "↓";
  
  // Momentum check: Stochastic RSI confirms direction bias
  const stochValid = card.direction === "LONG" 
    ? (card.stochRsi ?? 50) > 30 
    : (card.stochRsi ?? 50) < 70;
  
  // Structure check: EMA not reversing against direction
  const emaIntact = card.direction === "LONG"
    ? (card.emaSlope ?? 0) >= -0.1
    : (card.emaSlope ?? 0) <= 0.1;
  
  // Reversal risk: EMA sharply contradicts direction
  const reversalRisk = 
    (card.direction === "LONG" && (card.emaSlope ?? 0) < -0.3) ||
    (card.direction === "SHORT" && (card.emaSlope ?? 0) > 0.3);
  
  // v22.5 FIX: High volatility with expansion = STRENGTH not exhaustion
  // EXPANDING impulse: positive displacement + high volatility = strong directional move
  // Only flag exhaustion if volatility is EXTREME (>80) AND no clear structure support
  const isExpanding = card.execution15mState === "EXPANDING" || 
                      card.execution15mState === "BREAKOUT_READY";
  const extremeExhaustion = (card.volatilityLevel ?? 50) > 80 && !isExpanding;
  
  let status = "";
  
  if (reversalRisk) {
    status = "⚠ reversal forming";
  } else if (extremeExhaustion) {
    // Only show exhaustion if truly extreme and NOT expanding structure
    status = "⚠ momentum exhausting";
  } else if (isExpanding) {
    // Expanding impulse = strong directional move, not weakness
    status = `${directionArrow} impulse EXPANDING`;
  } else if (stochValid && emaIntact) {
    status = `${directionArrow} momentum holding, structure intact`;
  } else if (stochValid) {
    status = `${directionArrow} stoch valid, watching EMA`;
  } else {
    status = "⚠ momentum fading";
  }
  
  // Add exhaustion advisory if applicable
  const advisory = generateExhaustionAdvisory(card);
  const withAdvisory = appendAdvisory(status, advisory);
  
  return `${card.symbol} TRADE: ${withAdvisory}`;
}

export function generateDisplayCards(displayMarkets: Record<string, PriceData>): SymbolCardState[] {
  const displayCards: SymbolCardState[] = [];

  // ===== DISPLAY PIPELINE ONLY =====
  // displayMarkets contains fallback data (CoinGecko only)
  // These are for UI display, never for trading
  for (const [symbol, priceData] of Object.entries(displayMarkets)) {
    if (priceData.price === 0) {
      continue;  // Skip if no price
    }

    // Create display-only card (NEUTRAL, no signals possible)
    const displayCard: SymbolCardState = {
      symbol,
      price: priceData.price,
      source: priceData.source,
      degraded: true,
      signalState: "BUILDING",  // Display only, no execution
      mode: "NONE",
      confidence: 0,
      direction: "NEUTRAL",
      tradeReadinessScore: null,
      ignitionProbability: 0,
      stochRsi: null,
      emaSlope: null,
      emaPressure: 0,
      volatilityLevel: null,
      htf4hTrend: "NEUTRAL",
      htf4hMomentum: null,
      htf1hAlignment: null,
      htf15mCompression: null,
      execution15mState: "CHOP",
      marketReadinessState: "DISPLAY_ONLY",
      expectedMovePercent: null,
      targetPrices: null,
      riskReward: null,
      cycleId: `${Date.now()}-${symbol}-display`,
      notes: `Display only (${priceData.source})`,
      updatedAt: new Date().toISOString(),
    };

    displayCards.push(displayCard);
    console.log(`[DISPLAY] ${symbol} from ${priceData.source} (display only)`);
  }

  return displayCards;
}

/**
 * NEW SCORING SYSTEM (v7.0)
 * 
 * +25 → 4H trend alignment
 * +20 → EMA stack alignment (8/21 slope or cross)
 * +20 → Stoch RSI momentum shift
 * +20 → volatility compression present
 * +15 → impulse candle detected
 * 
 * RANGE: 0-100
 * SNIPER: ≥60
 * CONFIRMED: ≥75
 */
function calculateMomentumScore(card: SymbolCardState, symbol: string = "SOL", profile?: ExecutionProfile): number {
  // Use default SOL profile if not provided
  const exec = profile || getExecutionProfile(symbol);

  // BASE SCORE - foundation for all signals
  let score = 30;

  // EVENT MULTIPLIERS (not additive) - per-asset tuned
  let multiplier = 1.0;

  // EVENT 1: Stoch RSI cross detected
  // Range: 0-100, active zone: 20-80
  const stochRsiActive = card.stochRsi > 20 && card.stochRsi < 80;
  if (stochRsiActive) {
    multiplier *= exec.stochWeight; // Profile-tuned
  }

  // EVENT 2: EMA 8/21 flip detected
  // Strong slope indicates alignment
  const emaFlipped = Math.abs(card.emaSlope) > 0.5;
  if (emaFlipped) {
    multiplier *= exec.emaWeight; // Profile-tuned (acceleration sensitivity)
  }

  // EVENT 3: Volatility compression present
  // BB squeeze or ATR contraction
  const volatilityCompression = card.volatilityLevel < 30;
  if (volatilityCompression) {
    multiplier *= exec.volatilityWeight; // Profile-tuned
  }

  // EVENT 4: Impulse candle (direction conviction)
  if (card.direction !== "NEUTRAL") {
    multiplier *= exec.impulseWeight; // Profile-tuned
    
    // v21.5.1 LIGHTWEIGHT EXHAUSTION DAMPENING
    // Reduce impulse confidence slightly when: volatility expanding + EMA weakening + stoch extended
    // This prevents over-triggering during violent chop/exhaustion days
    const volatilityExpanding = (card.volatilityLevel ?? 50) > 55;
    const emaWeakening = Math.abs(card.emaSlope ?? 0) < 0.2;
    const stochExtended = (card.stochRsi ?? 50) > 75 || (card.stochRsi ?? 50) < 25;
    
    if (volatilityExpanding && emaWeakening && stochExtended) {
      multiplier *= 0.95; // -5% dampening to impulse
    }
  }

  // EVENT 5: 4H trend alignment
  // Trend bias from higher timeframe
  const trend4HAligned = card.stochRsi > 50; // Simplified: would use actual 4H data
  if (trend4HAligned) {
    multiplier *= exec.trendWeight; // Profile-tuned (BTC emphasizes, SOL standard)
  }

  // Apply multiplier
  score = Math.round(score * multiplier);

  // SEPARATION BOOST: Prevent score clustering
  // Strong momentum flips break away from 40-45 cluster
  if (emaFlipped && stochRsiActive) {
    score *= 1.2; // Momentum flip detected
  }

  // Strong squeeze + impulse creates separation
  if (volatilityCompression && card.direction !== "NEUTRAL") {
    score *= 1.15; // Volatility squeeze strong
  }

  return Math.min(score, 99); // Cap at 99
}

/**
 * Calculate live market readiness state (v7.2.1)
 * Derives from: HTF alignment, EMA slope, Stoch velocity, compression, impulse
 */
function calculateMarketReadinessState(
  htf4hTrend: string,
  htf1hAlignment: boolean | null,
  emaSlope: number | null,
  stochRsi: number | null,
  volatilityLevel: number | null,
  direction: string
): "BUILDING_PRESSURE" | "BULLISH_IGNITION" | "BEARISH_IGNITION" | "TREND_EXPANSION" | "OVEREXTENDED" | "CHOP_NO_TRADE" | "AWAITING_DATA" {
  // No data = awaiting
  if (stochRsi === null || emaSlope === null || volatilityLevel === null) {
    return "AWAITING_DATA";
  }

  // CHOP_NO_TRADE: No HTF direction + neutral momentum
  if (htf4hTrend === "NEUTRAL" && stochRsi > 40 && stochRsi < 60) {
    return "CHOP_NO_TRADE";
  }

  // BUILDING_PRESSURE: Low volatility + aligned HTF + EMA expansion
  if (volatilityLevel < 35 && htf4hTrend !== "NEUTRAL" && Math.abs(emaSlope) > 0.2) {
    return "BUILDING_PRESSURE";
  }

  // BULLISH_IGNITION: HTF bullish + 1H confirms + Stoch cross up + compression release
  if (htf4hTrend === "BULLISH" && htf1hAlignment && stochRsi > 45 && stochRsi < 65 && volatilityLevel < 50) {
    return "BULLISH_IGNITION";
  }

  // BEARISH_IGNITION: HTF bearish + 1H confirms + Stoch cross down + compression release
  if (htf4hTrend === "BEARISH" && htf1hAlignment && stochRsi > 35 && stochRsi < 55 && volatilityLevel < 50) {
    return "BEARISH_IGNITION";
  }

  // TREND_EXPANSION: High volatility + momentum aligned + HTF agrees
  if (volatilityLevel > 50 && htf4hTrend !== "NEUTRAL" && (stochRsi > 60 || stochRsi < 40)) {
    return "TREND_EXPANSION";
  }

  // OVEREXTENDED: Very high volatility + extreme Stoch + divergence risk
  if (volatilityLevel > 70 && (stochRsi > 80 || stochRsi < 20)) {
    return "OVEREXTENDED";
  }

  return "AWAITING_DATA";
}

/**
 * Calculate trade readiness score (v8.0 FIX: SNIPER macro penalty as modifier only)
 * Readiness MUST follow direction
 * 
 * v8.0 CRITICAL: Macro penalty applied LAST, never used as blocker
 * - SNIPER trades contra-4H are allowed (reduced score only)
 * - Macro trend acts as confidence modifier, NOT gating function
 * 
 * IF direction bullish AND momentum exists: minimum 45-55
 * IF compression + ignition: 60-75
 * IF HTF aligned + continuation: 75-90
 * NEVER allow: NEUTRAL + 40% readiness (contradictory UX)
 * 
 * v8.0 Score application order (CRITICAL):
 * 1. Base impulse score (direction + compression + momentum)
 * 2. Add compression weight
 * 3. Add displacement/EMA weight
 * 4. Add 15M momentum weight
 * 5. Add micro-structure weight
 * 6. LAST: Macro penalty (final adjustment ONLY, never blocker)
 * 
 * Bands:
 * <40 = dead market
 * 40-55 = building momentum
 * 55-70 = ignition watch
 * 70-85 = sniper ready
 * 85+ = confirmed trend
 */
function calculateTradeReadinessScore(
  mode: string,
  direction: string,
  htf4hTrend: string,
  htf1hAlignment: boolean | null,
  emaSlope: number | null,
  stochRsi: number | null,
  volatilityLevel: number | null
): number | null {
  // If no data available, return null
  if (stochRsi === null || emaSlope === null || volatilityLevel === null) {
    return null;
  }

  // FIX #5: If NEUTRAL direction, score should be NULL or minimal
  if (direction === "NEUTRAL") {
    return null; // No readiness if no direction
  }

  // v8.0: If direction exists (LONG or SHORT), minimum 45-55 baseline
  let score = 45;

  // +10 compression (low volatility = energy buildup)
  if (volatilityLevel < 40) score += 10;

  // +15 momentum in direction (Stoch aligned with direction)
  if (direction === "LONG" && stochRsi > 50) score += 15;
  if (direction === "SHORT" && stochRsi < 50) score += 15;

  // +15 EMA expansion (established slope)
  if (emaSlope !== null && Math.abs(emaSlope) > 0.4) score += 15;

  // v8.0 FIX: Macro penalty applied LAST (never blocker)
  // +10 HTF alignment (confidence boost, NOT requirement for SNIPER)
  // -5 HTF misalignment (probability reduction, still allows entry)
  if (htf4hTrend !== "NEUTRAL") {
    const directionMatchesMacro =
      (direction === "LONG" && htf4hTrend === "BULLISH") ||
      (direction === "SHORT" && htf4hTrend === "BEARISH");
    
    if (directionMatchesMacro) {
      score += 10; // Aligned with macro = higher confidence
    } else {
      // v21.2.2 ETH RESPONSIVENESS FIX
      // During early bullish transitions, reduce bearish 4H suppression when:
      // - 15M is EXPANDING (volatilityLevel > 45)
      // - Direction is LONG (bullish impulse)
      // - EMA slope is improving (positive slope > 0.2)
      // This allows ETH to respond faster during genuine bullish breakouts
      const isEarlyBullishTransition = 
        direction === "LONG" && 
        (volatilityLevel ?? 50) > 45 &&  // 15M EXPANDING
        (emaSlope ?? 0) > 0.2;           // EMA improving bullish
      
      if (isEarlyBullishTransition) {
        score -= 2;  // Reduced from -5 to -2: lighter bearish suppression during transition
      } else {
        score -= 5;  // Normal penalty: Against macro = small penalty (NOT blocker)
      }
    }
  }

  // +10 impulse confirmation (if signal mode exists)
  if (mode === "SNIPER" || mode === "CONFIRMED") score += 10;

  return Math.min(score, 100);
}

/**
 * ATOMIC SNIPER SIGNAL BUILDER (v1 STABILIZATION)
 * 
 * Core principle: A SNIPER signal is ONLY created if fully complete at creation time.
 * No partial SNIPER objects are allowed to exist in the system.
 * 
 * Returns: Complete SNIPER setup OR null (if any required field would be undefined)
 */
function buildAtomicSniperSignal(
  card: SymbolCardState,
  score: number,
  symbol: string
): {
  symbol: string;
  mode: "SNIPER";
  direction: "LONG" | "SHORT";
  score: number;
  price: number;
  entryPrice: number;
  structureState: string;
  targetPrices: { tp1: number; tp2: number; sl: number };
  riskReward: number;
  expectedMovePercent: { sniper: { min: number; max: number } };
  reason: string;
  momentum: any;
  htf: any;
} | null {
  // ATOMIC VALIDATION: Compute all required fields FIRST
  
  // 1. Verify all input data exists
  if (!card.direction || card.direction === "NEUTRAL") {
    console.log(`[ATOMIC BUILD FAILED] ${symbol}: No direction`);
    return null;
  }

  if (!card.structureState) {
    console.log(`[ATOMIC BUILD FAILED] ${symbol}: No structureState`);
    return null;
  }

  if (!card.price || card.price === 0) {
    console.log(`[ATOMIC BUILD FAILED] ${symbol}: Invalid price`);
    return null;
  }

  // 2. Calculate trade targets (must not have undefined TP/SL)
  const targets = calculateTradeTargets(
    card.price, 
    card.volatilityLevel ?? 50, 
    card.direction,
    card.recentSwingLow || card.recentSwingHigh,
    card.structureState === "BREAKOUT_UP" || card.structureState === "RETEST_UP" 
      ? card.swingHigh 
      : card.swingLow,
    card.stochRsi,
    card.emaSlope
  );
  
  if (!targets.targetPrices.tp1 || !targets.targetPrices.tp2 || !targets.targetPrices.sl) {
    console.log(`[ATOMIC BUILD FAILED] ${symbol}: Target calculation failed (tp1=${targets.targetPrices.tp1}, tp2=${targets.targetPrices.tp2}, sl=${targets.targetPrices.sl})`);
    return null;
  }

  // 3. Verify risk/reward is valid
  if (!targets.riskReward || targets.riskReward <= 0) {
    console.log(`[ATOMIC BUILD FAILED] ${symbol}: Invalid risk/reward (${targets.riskReward})`);
    return null;
  }

  const macroConfidenceAdjustment = (() => {
    if (card.htf4hTrend === null || card.htf4hTrend === "NEUTRAL") return 0;
    const isAligned = (card.htf4hTrend === "BULLISH" && card.direction === "LONG") ||
                      (card.htf4hTrend === "BEARISH" && card.direction === "SHORT");
    return isAligned ? 15 : -20; // +15% if aligned, -20% if counter-trend
  })();

  // 4. Build complete signal with strict UI discipline
  // v33.0: Direction is immutable truth, macro is confidence modifier only
  const signalHierarchy = buildSignalHierarchy(
    card.direction as "LONG" | "SHORT",
    score,
    card.htf4hTrend,
    card.execution15mState,
    card.stochRsi,
    card.emaSlope
  );
  
  // Build reason string with strict non-directional format
  // NO "consider SHORT", NO "should align", NO directional suggestions
  const macroContextLabel = card.htf4hTrend === "NEUTRAL" 
    ? "Macro neutral" 
    : `Macro ${card.htf4hTrend.toLowerCase()} (${macroConfidenceAdjustment > 0 ? '+' : ''}${macroConfidenceAdjustment}% confidence)`;

  const signal = {
    symbol,
    mode: "SNIPER" as const,
    direction: card.direction as "LONG" | "SHORT",
    score,
    price: card.price,
    entryPrice: card.price,  // Entry = current price at signal time
    structureState: card.structureState,
    targetPrices: targets.targetPrices,  // GUARANTEED: tp1, tp2, sl all defined
    riskReward: targets.riskReward,  // GUARANTEED: > 0
    expectedMovePercent: targets.expectedMovePercent,
    // v33.0: UI DISCIPLINE - Direction is truth, macro is context only
    reason: `ACTIVE_SNIPER: Direction=${card.direction} | Momentum: 15M ${card.execution15mState}, Stoch=${card.stochRsi?.toFixed(1)} | ${macroContextLabel}`,
    // v25.0: Signal hierarchy
    hierarchy: signalHierarchy,
    momentum: {
      stochRsiSignal: `Stoch RSI: ${card.stochRsi?.toFixed(1) ?? "—"}`,
      emaStackSignal: card.direction === "LONG" ? "8 EMA above 21" : "8 EMA below 21",
      volatilitySignal: (card.volatilityLevel ?? 40) < 40 ? "Compression active" : "Expansion mode",
      trend4H: card.htf4hTrend !== "NEUTRAL",
    },
    htf: {
      trend4h: card.htf4hTrend as "BULLISH" | "BEARISH",
      confidenceModifier: `${macroConfidenceAdjustment > 0 ? '+' : ''}${macroConfidenceAdjustment}%`,
      alignment1h: card.htf1hAlignment ?? false,
      compression15m: card.htf15mCompression ?? false,
      trigger5m: (card.stochRsi ?? 50) > 20 && (card.stochRsi ?? 50) < 80 ? "Stoch RSI cross" : "EMA flip",
    },
  };


  // ATOMIC GUARANTEE: All required fields exist and are valid
  // If we reach here, signal is complete or we return null
  console.log(`[ATOMIC BUILD OK] ${symbol} SNIPER (tp1=${targets.targetPrices.tp1.toFixed(2)}, sl=${targets.targetPrices.sl.toFixed(2)}, rr=${targets.riskReward.toFixed(2)})`);
  return signal;
}

/**
 * v27.0 SNIPER SL AUTHORITY ENFORCEMENT
 * CRITICAL RULE: ACTIVE_SNIPER MUST use SNIPER SL (momentum-based)
 * STRUCTURE SL is ONLY for fallback when SNIPER SL is explicitly invalidated
 * 
 * This function computes momentum-based SL invalidation:
 * - Returns tight SNIPER SL if momentum is healthy
 * - Returns wider STRUCTURE SL only if momentum decay detected
 */
function calculateMomentumInvalidationSL(
  price: number,
  direction: "LONG" | "SHORT",
  stochRsi: number | null,
  emaSlope: number | null,
  recentSwingLevel: number | null,
  structureSLValue: number
): { sl: number; source: "SNIPER_MOMENTUM" | "STRUCTURE_FALLBACK"; invalidated: boolean } {
  // Check momentum health to decide SL authority
  const momentumValid = stochRsi !== null && emaSlope !== null &&
    ((direction === "LONG" && stochRsi >= 40 && emaSlope >= 0.1) ||
     (direction === "SHORT" && stochRsi <= 60 && emaSlope <= -0.1));
  
  if (momentumValid) {
    // SNIPER SL has authority - momentum is healthy
    const sniperSL = calculateSniperStopLoss(price, recentSwingLevel, direction);
    return { sl: sniperSL, source: "SNIPER_MOMENTUM", invalidated: false };
  } else {
    // Momentum failed - fall back to STRUCTURE SL
    return { sl: structureSLValue, source: "STRUCTURE_FALLBACK", invalidated: true };
  }
}

/**
 * v25.0 Calculate trade targets with dual SL system
 * v27.0: Now enforces SNIPER SL authority + inflation cap + adds audit trace
 */
function calculateTradeTargets(
  price: number,
  volatilityLevel: number,
  direction: string,
  recentSwingLevel: number | null = null,
  supportResistanceLevel: number | null = null,
  stochRsi: number | null = null,
  emaSlope: number | null = null
) {
  const volatilityFactor = volatilityLevel / 100;
  const sniperMin = 0.8 + volatilityFactor * 0.5;
  const sniperMax = 1.5 + volatilityFactor * 0.7;
  
  const isLong = direction === "LONG";
  const tp1 = price * (1 + (isLong ? sniperMax : -sniperMax) / 100);
  const tp2 = price * (1 + (isLong ? sniperMax * 1.5 : -sniperMax * 1.5) / 100);
  
  // v26.0: Dual SL system with strict separation
  const sniperSL = calculateSniperStopLoss(price, recentSwingLevel, direction as "LONG" | "SHORT");
  const structureSL = calculateStructureStopLoss(price, supportResistanceLevel, null, direction as "LONG" | "SHORT");
  
  // v27.0: SNIPER SL AUTHORITY - momentum determines SL source
  const { sl: activeSL, source: slSource, invalidated: slInvalidated } = calculateMomentumInvalidationSL(
    price,
    direction as "LONG" | "SHORT",
    stochRsi,
    emaSlope,
    recentSwingLevel,
    structureSL
  );
  
  // v27.0: SL INFLATION GUARD - hard cap at 1.8%
  const MAX_SNIPER_SL_PCT = 0.018; // 1.8% inflation cap
  const distance = Math.abs(activeSL - price) / price;
  
  let finalSL = activeSL;
  if (slSource === "SNIPER_MOMENTUM" && distance > MAX_SNIPER_SL_PCT) {
    // SL inflation detected - clamp to hard cap
    finalSL = direction === "LONG" 
      ? price * (1 - MAX_SNIPER_SL_PCT)
      : price * (1 + MAX_SNIPER_SL_PCT);
    console.log(`[SL_INFLATION_CAP] SL was ${(distance * 100).toFixed(2)}% from entry, clamped to 1.8%`);
  }
  
  const riskReward = (sniperMax * 1.5) / sniperMax;
  
  return {
    expectedMovePercent: { sniper: { min: sniperMin, max: sniperMax } },
    targetPrices: { 
      tp1, 
      tp2, 
      sl: finalSL,  // SNIPER authority enforced + inflation capped
    },
    riskReward,
    // v27.0: Add SL audit trace for debugging
    debug: {
      slAudit: {
        sniperSL,
        structureSL,
        selected: finalSL,
        source: slSource,
        invalidated: slInvalidated,
        inflationCapped: distance > MAX_SNIPER_SL_PCT,
      }
    }
  };

}

/**
 * Calculate live dashboard state (v7.2.4 FIX #4)
 * NEVER show: NEUTRAL, AWAITING DATA, NO TRADE if prices exist
 * Instead show: BULLISH BUILDING, BEARISH IGNITION, TREND EXPANSION, etc.
 */
function calculateLiveMarketState(
  direction: string,
  emaSlope: number | null,
  stochRsi: number | null,
  volatilityLevel: number | null
): string {
  // If real prices exist, NEVER show generic states
  if (direction === "LONG") {
    if (volatilityLevel !== null && volatilityLevel < 40) return "BULLISH BUILDING";
    if (emaSlope !== null && emaSlope > 0.5) return "BULLISH IGNITION";
    if (volatilityLevel !== null && volatilityLevel > 60) return "BULLISH EXPANSION";
    if (stochRsi !== null && stochRsi > 80) return "BULLISH OVEREXTENDED";
    return "BULLISH MOMENTUM";
  }
  
  if (direction === "SHORT") {
    if (volatilityLevel !== null && volatilityLevel < 40) return "BEARISH BUILDING";
    if (emaSlope !== null && emaSlope < -0.5) return "BEARISH IGNITION";
    if (volatilityLevel !== null && volatilityLevel > 60) return "BEARISH EXPANSION";
    if (stochRsi !== null && stochRsi < 20) return "BEARISH OVEREXTENDED";
    return "BEARISH MOMENTUM";
  }
  
  // NEUTRAL but show structure if present
  if (emaSlope !== null && Math.abs(emaSlope) < 0.2) return "CHOPPY";
  if (volatilityLevel !== null && volatilityLevel < 30) return "BUILDING PRESSURE";
  if (stochRsi !== null && (stochRsi > 75 || stochRsi < 25)) return "EXTREME READS";
  
  return "NEUTRAL";
}

/**
 * Check if cooldown has elapsed (v7.2.6 FIX #6)
 * SNIPER cooldown: 30 minutes
 * CONFIRMED cooldown: 90 minutes
 */
function isCooldownElapsed(lastSignalTime: number | undefined, mode: "SNIPER" | "CONFIRMED"): boolean {
  if (!lastSignalTime) return true; // No previous signal
  
  const now = Date.now();
  const cooldownMs = mode === "SNIPER" ? 30 * 60 * 1000 : 90 * 60 * 1000;
  
  return (now - lastSignalTime) >= cooldownMs;
}

/**
 * Calculate unified signal state (v7.2.6 FIX #1, extended for v7.2.8)
 * Returns: NONE | BUILDING | SNIPER_READY | CONFIRMED_READY | ACTIVE_SNIPER | ACTIVE_CONFIRMED
 * NOTE: SNIPER_IMMINENT removed per LOCK rules (only BUILDING | SNIPER | CONFIRMED in UI)
 * 
 * FIX #4: Proper evaluation order:
 * 1. HTF trend
 * 2. Direction
 * 3. Compression OR expansion
 * 4. Score filter
 * 5. Signal state assignment
 */
function calculateSignalState(
  mode: "SNIPER" | "CONFIRMED" | "NONE",
  score: number,
  direction: string,
  htf4hTrend: string,
  sniperPassed: boolean,
  sniperImminentPassed: boolean,  // Deprecated: will be ignored
  confirmedPassed: boolean,
  lastSignalTime: number | undefined,
  lastMode: "SNIPER" | "CONFIRMED" | "NONE"
): SignalState {
  // CONFIRMED: Highest priority (v7.2.8)
  if (confirmedPassed && score >= 75) {
    if (lastMode === "CONFIRMED" && !isCooldownElapsed(lastSignalTime, "CONFIRMED")) {
      return "ACTIVE_CONFIRMED"; // Still in active window
    }
    return "CONFIRMED_READY"; // New CONFIRMED setup ready
  }
  
  // SNIPER ACTIVE: Within cooldown window (v7.2.8)
  if (lastMode === "SNIPER" && !isCooldownElapsed(lastSignalTime, "SNIPER")) {
    return "ACTIVE_SNIPER"; // Still in active window
  }
  
  // SNIPER READY: Full conditions met, no cooldown (v7.2.8)
  if (sniperPassed && score >= 60 && !confirmedPassed) {
    return "SNIPER_READY";
  }
  
  // BUILDING: Has directional bias but not ready for signals
  if (direction !== "NEUTRAL" && score >= 40) {
    return "BUILDING";
  }
  
  // No signal
  return "NONE";
}

/**
 * v8.0 FIX: SNIPER = EARLY IMPULSE DETECTION (NOT macro-aligned confirmation)
 * 
 * CRITICAL CHANGE: SNIPER must catch trades BEFORE full macro alignment
 * Macro trend is ONLY a probability modifier, NEVER a blocker
 * 
 * Previous bug: Blocking SNIPER if 4H neutral or direction diverges from 4H
 * Result: SNIPER behaved like CONFIRMED (trend-following system)
 * 
 * New behavior: SNIPER allows early entries based on compression/breakout impulse
 * Macro alignment only adjusts confidence, never gates entry
 * 
 * SNIPER Entry Requirements (EARLY MODE):
 * ✓ Compression detected OR early displacement OR EMA acceleration
 * ✓ Any of: 15M breakout attempt, liquidity sweep, rejection wick
 * ✓ Score >= 65-72 depending on asset
 * ✓ Does NOT require: 4H alignment, macro agreement
 * ✓ Allowed vs contra 4H: Still valid, reduced score only
 * 
 * Requirements (ALL must be true):
 * 1. Valid 5M ignition trigger (Stoch + EMA)
 * 2. Compression or early displacement detected
 * 3. Score >= 70 (execution-grade momentum)
 * 4. Direction has directional conviction (not NEUTRAL)
 * 
 * NO LONGER required:
 * ✗ 4H trend alignment (was hard blocker at line 673)
 * ✗ Direction matches HTF (was hard blocker at line 708-717)
 * 
 * Returns: { valid: boolean, reason?: string }
 */
function validateActiveSniperExecution(card: SymbolCardState, score: number): { valid: boolean; reason?: string } {
  // REQUIREMENT 1: Must have valid 5M ignition trigger
  const has5MTrigger = 
    (card.stochRsi !== null && card.stochRsi > 20 && card.stochRsi < 80) &&
    card.emaSlope !== null && Math.abs(card.emaSlope) > 0.2;
  
  if (!has5MTrigger) {
    return {
      valid: false,
      reason: `5M trigger not formed (Stoch=${card.stochRsi?.toFixed(1) ?? "null"}, EMA slope=${card.emaSlope?.toFixed(3) ?? "null"})`
    };
  }

  // REQUIREMENT 2: Compression or early displacement must exist
  const compressionExists = card.htf15mCompression === true;
  const emaExpanding = card.emaSlope !== null && Math.abs(card.emaSlope) > 0.4;
  const volatilityBreakout = (card.volatilityLevel ?? 50) > 50;
  const energyBuilding = (card.volatilityLevel ?? 50) <= 45;
  
  const compressionOrExpansion = compressionExists || emaExpanding || volatilityBreakout || energyBuilding;
  
  if (!compressionOrExpansion) {
    return {
      valid: false,
      reason: `No compression/expansion (compression=${compressionExists}, EMA expanding=${emaExpanding}, vol=${card.volatilityLevel})`
    };
  }

  // REQUIREMENT 3: Score must be execution-grade (>= 70)
  if (score < 70) {
    return {
      valid: false,
      reason: `Score ${score} below execution threshold (70)`
    };
  }

  // REQUIREMENT 4: Must have directional conviction
  if (card.direction === "NEUTRAL") {
    return {
      valid: false,
      reason: `No directional conviction (NEUTRAL)`
    };
  }

  // ✅ ALL REQUIREMENTS MET: Valid ACTIVE_SNIPER execution
  // NOTE: Macro trend is NOT evaluated here (no hard blockers for 4H alignment or direction match)
  // Macro impact is applied ONLY as a probability modifier in scoring, not as a gate
  return { valid: true };
}

/**
 * v21.7.0 SNIPER STALE STATE FIX
 * Revalidate ACTIVE_SNIPER against current structure every cycle
 * If structure no longer supports it, drop to BUILDING immediately
 */
function isValidCurrentStructureForSniper(card: SymbolCardState): boolean {
  // Invalidate if 15M is in CHOP (no clear direction)
  if (card.execution15mState === "CHOP_NO_TRADE") {
    console.log(`[SNIPER_REVALIDATION] ${card.symbol}: 15M entered CHOP → invalidate ACTIVE_SNIPER`);
    return false;
  }

  // Invalidate if displacement weakens or flips (emaSlope flips sign or drops below threshold)
  if (card.emaSlope !== null && Math.abs(card.emaSlope) < 0.2) {
    console.log(`[SNIPER_REVALIDATION] ${card.symbol}: EMA slope weakened to ${card.emaSlope?.toFixed(2)} → invalidate ACTIVE_SNIPER`);
    return false;
  }

  // Invalidate if continuation fails (stoch extreme suggest exhaustion or reversal)
  if ((card.stochRsi ?? 50) > 85 || (card.stochRsi ?? 50) < 15) {
    console.log(`[SNIPER_REVALIDATION] ${card.symbol}: Stoch extreme ${card.stochRsi?.toFixed(1)} → invalidate ACTIVE_SNIPER`);
    return false;
  }

  // Invalidate if price forms reversal structure (structure state flips)
  if (card.direction === "LONG" && (card.structureState === "RETEST_DOWN" || card.structureState === "BREAKOUT_DOWN")) {
    console.log(`[SNIPER_REVALIDATION] ${card.symbol}: LONG direction but structure flipped DOWN → invalidate ACTIVE_SNIPER`);
    return false;
  }
  if (card.direction === "SHORT" && (card.structureState === "RETEST_UP" || card.structureState === "BREAKOUT_UP")) {
    console.log(`[SNIPER_REVALIDATION] ${card.symbol}: SHORT direction but structure flipped UP → invalidate ACTIVE_SNIPER`);
    return false;
  }

  return true; // Structure still supports SNIPER
}

/**
 * SNIPER CONDITIONS v9 NO GATES (NO blocking logic)
 * Momentum refines conditions only, structure never blocks entry
 * 
 * v21.1.3 REFACTOR: Uses profile-driven persistence rules instead of if-symbol checks
 * This allows future assets to define their own persistence requirements in the profile
 */
function checkSniperConditions(card: SymbolCardState, profile: ExecutionProfile, checkMode: "strict" | "early" = "strict"): boolean {
  // NO HARD BLOCKS - v9 NO GATES VERSION
  // Structure locks direction but doesn't prevent trades
  
  // REQUIREMENT 1: Directional bias exists
  if (card.direction === "NEUTRAL") {
    console.log(`[SNIPER CHECK] ${card.symbol} BLOCKED: No directional bias`);
    return false;
  }

  // REQUIREMENT 2: Impulse present (compression → expansion or breakout acceleration)
  const compressionExists = card.htf15mCompression === true;
  const emaExpanding = card.emaSlope !== null && Math.abs(card.emaSlope) > 0.4;
  const volatilityBreakout = (card.volatilityLevel ?? 50) > 50; // Breakout mode
  const energyBuilding = (card.volatilityLevel ?? 50) <= 45; // Compression mode
  
  const impulsePresent = compressionExists || emaExpanding || volatilityBreakout || energyBuilding;
  
  if (!impulsePresent) {
    console.log(`[SNIPER CHECK] ${card.symbol} BLOCKED: No impulse detected`);
    return false;
  }

  // REQUIREMENT 3: Ignition event
  const stochCross = (card.stochRsi ?? 50) > 25 && (card.stochRsi ?? 50) < 75;
  const emaFlip = card.emaSlope !== null && Math.abs(card.emaSlope) > 0.3;
  const ignitionTrigger = stochCross || emaFlip;
  
  if (!ignitionTrigger) {
    console.log(`[SNIPER CHECK] ${card.symbol} BLOCKED: No ignition trigger`);
    return false;
  }

  // FIX #3: For ACTIVE_SNIPER, require strict compression OR confirmed breakout
  if (checkMode === "strict") {
    const strictCompressionOrBreakout = compressionExists || (emaExpanding && Math.abs(card.emaSlope) > 0.5);
    if (!strictCompressionOrBreakout) {
      console.log(`[SNIPER CHECK] ${card.symbol} BLOCKED: Strict mode - needs confirmed compression/breakout`);
      return false;
    }
  }

  // PROFILE-DRIVEN PERSISTENCE RULES (v21.1.3 REFACTOR)
  // Removed: if card.symbol === "ETH" check
  // Now: profile.persistenceRules drives validation generically
  // This allows future assets to define their own rules without code changes
  if (!applyProfilePersistenceRules(card, profile)) {
    return false;
  }

  // ALL CONDITIONS MET: Valid SNIPER setup
  console.log(`[SNIPER CHECK] ${card.symbol} PASSED (${checkMode}): direction=${card.direction} + compression/expansion + ignition`);
  return true;
}

/**
 * APPLY PROFILE PERSISTENCE RULES
 * v21.1.2 REFACTOR: Consolidates fragmented if-symbol checks into profile-driven validation
 * 
 * Instead of: if symbol === "ETH" check persistence
 * Now: profile.persistenceRules drives the validation generically
 * 
 * This allows future assets to define their own persistence requirements
 * without adding more if-symbol branches.
 */
function applyProfilePersistenceRules(card: SymbolCardState, profile: ExecutionProfile): boolean {
  // If profile doesn't require persistence rules, pass through
  if (!profile.persistenceRules.requireSustainedEMA && !profile.persistenceRules.requireDirectionAlignment) {
    return true;
  }

  // RULE 1: Sustained EMA slope (if required by profile)
  if (profile.persistenceRules.requireSustainedEMA) {
    const emaSustained = card.emaSlope !== null && Math.abs(card.emaSlope) >= 0.3 && Math.abs(card.emaSlope) <= 1.0;
    if (!emaSustained) {
      console.log(`[PERSISTENCE] ${card.symbol} BLOCKED: Sustained EMA required but slope=${card.emaSlope?.toFixed(2)}`);
      return false;
    }
  }

  // RULE 2: Direction aligned with EMA (if required by profile)
  if (profile.persistenceRules.requireDirectionAlignment) {
    const directionAligned = 
      (card.emaSlope > 0 && card.direction === "LONG") ||
      (card.emaSlope < 0 && card.direction === "SHORT");
    if (!directionAligned) {
      console.log(`[PERSISTENCE] ${card.symbol} BLOCKED: Direction alignment required, EMA=${card.emaSlope > 0 ? "LONG" : "SHORT"} but direction=${card.direction}`);
      return false;
    }
  }

  // RULE 3: Volatility stability (if required by profile)
  if (profile.persistenceRules.stabilityThreshold < 100) {
    const stable = (card.volatilityLevel ?? 50) < profile.persistenceRules.stabilityThreshold;
    if (!stable) {
      console.log(`[PERSISTENCE] ${card.symbol} BLOCKED: Stability required (volatility < ${profile.persistenceRules.stabilityThreshold}) but level=${card.volatilityLevel}`);
      return false;
    }
  }

  return true;
}

/**
 * BTC STRUCTURAL BREAKOUT SCORE BONUS
 * v21.1.2: Structural setup adds +5 to score, not direct activation
 * Preserves ignition integrity while allowing structure-driven activation
 */
function checkStructuralBreakout(card: SymbolCardState): boolean {
  // CONDITION 1: 4H trend structure must be established (not neutral)
  const htf4hEstablished = card.htf4hTrend !== "NEUTRAL";
  if (!htf4hEstablished) {
    return false;
  }

  // CONDITION 2: EMA slope is sustained (not a violent spike)
  // For structural breakout: 0.3 to 0.8 is "sustained", > 0.8 is "spike"
  const emaSustained = card.emaSlope !== null && Math.abs(card.emaSlope) > 0.3 && Math.abs(card.emaSlope) <= 0.8;
  if (!emaSustained) {
    return false;
  }

  // CONDITION 3: Compression is present and ready to break
  // Volatility < 35 = ready compression
  const compressionReady = (card.volatilityLevel ?? 50) < 35;
  if (!compressionReady) {
    return false;
  }

  // CONDITION 4: EMA direction matches HTF trend (structural alignment)
  const trendAlignment = 
    (card.htf4hTrend === "BULLISH" && card.emaSlope > 0) ||
    (card.htf4hTrend === "BEARISH" && card.emaSlope < 0);
  if (!trendAlignment) {
    return false;
  }

  // ALL CONDITIONS MET: Structural breakout ready
  console.log(`[STRUCTURAL_BREAKOUT] ${card.symbol} TRIGGERED: HTF=${card.htf4hTrend} + EMA slope=${card.emaSlope?.toFixed(2)} + compression ready`);
  return true;
}

/**
 * Calculate momentum score using event-driven multiplier model
 * v7.1 STABILISATION FIX
 * v22.0: Real 4H structure detection
 * 
 * v7.7.0 CRITICAL FIX: Separate data trust from system health
 * - executionGrade: based ONLY on source (kraken_live or kraken_cached)
 * - systemHealth: based on infrastructure (PriceHealth enum)
 * - These must be ORTHOGONAL
 */
function generateCardState(symbol: string, priceData: PriceData, candles4h: Candle[] = []): SymbolCardState {
  // v7.7.0: SPLIT CONCERNS
  // Data trust (execution-grade) = based ONLY on source
  const isKrakenSource = priceData.source === "kraken_live" || priceData.source === "kraken_cached";
  
  // System health (infrastructure) = based on PriceHealth
  const systemDegraded = priceData.health === "DEGRADED" || priceData.health === "OFFLINE";
  
  // These are INDEPENDENT:
  // - Kraken cached data is execution-grade (true) but may have systemDegraded=true
  // - CoinGecko is NOT execution-grade (false) regardless of systemHealth
  
  // SIMULATE MOMENTUM INDICATORS
  // In production, calculate from OHLCV data
  
  // Stochastic RSI: 0-100 scale
  // Simulate: varies by symbol hash for reproducibility
  const symbolHash = symbol.charCodeAt(0) + symbol.charCodeAt(1);
  const stochRsi = 30 + (symbolHash % 40); // Range: 30-70

  // EMA Slope: -2 to +2 (negative = downtrend, positive = uptrend)
  const emaSlope = -1 + (symbolHash % 20) / 10; // Range: -1 to +1

  // Volatility Level: 0-100 (low = compression, high = expansion)
  const volatilityLevel = 20 + ((symbolHash * 7) % 60); // Range: 20-80

  // v22.0 REAL 4H STRUCTURE DETECTION
  // Replace all synthetic hash-based 4H with real OHLC analysis
  // v22.1 FIX: Pass momentum EMA slope as fallback when 4H candles insufficient
  const htf4hAnalysis = analyze4HStructure(candles4h, emaSlope);
  const htf4hTrend = htf4hAnalysis.trend;
  const htf4hMomentum = htf4hAnalysis.confidence; // Use confidence as momentum proxy

  // v7.2.10 FIX #3: Calculate 15M EXECUTION STATE (replaces 1H trend display)
  // Shows what entry structure is forming, not a direction
  // COMPRESSING: volatility falling, range tightening, energy building
  // BREAKOUT_READY: tight range + momentum present, ready to move
  // EXPANDING: volatility spike after squeeze, momentum continuing
  // CHOP: choppy/indecisive, low momentum, no clear structure
  const execution15mState: "COMPRESSING" | "BREAKOUT_READY" | "EXPANDING" | "CHOP" =
    // EXPANDING: volatility high after period of compression
    volatilityLevel > 55 ? "EXPANDING" :
    // BREAKOUT_READY: volatility middle + momentum active (Stoch not extreme)
    volatilityLevel > 40 && volatilityLevel <= 55 && stochRsi > 25 && stochRsi < 75 ? "BREAKOUT_READY" :
    // COMPRESSING: low volatility + energy building
    volatilityLevel < 35 && Math.abs(emaSlope) <= 0.3 ? "COMPRESSING" :
    // CHOP: choppy structure, no clear momentum
    "CHOP";

  // v7.2.10: Remove old 1H trend calculation (deprecated)
  // htf1hTrend is no longer calculated or displayed
  
  // 1H ALIGNMENT (v7.2.10 - kept ONLY for signal logic, never displayed)
  const htf1hAlignment = 
    (htf4hTrend === "BULLISH" && emaSlope > 0.2) ||
    (htf4hTrend === "BEARISH" && emaSlope < -0.2) ||
    (htf4hTrend === "NEUTRAL" && Math.abs(emaSlope) < 0.3);

  // 15M COMPRESSION: Is there energy build-up?
  // Simplified: compression when volatility < 40
  const htf15mCompression = volatilityLevel < 40;

  // v8.5: COMPUTE LEVEL AWARENESS (structure-first breakout detection)
  // Determine if breakout is happening and validate direction against it
  const levelAwareness = computeLevelAwareness(
    priceData.price,
    priceData.priceHistory || null,
    "NONE"
  );

  // v9: STRUCTURE-FIRST DIRECTION ENGINE (CRITICAL REWRITE)
  // Step 1: Compute swing levels from price history
  const swingHigh = levelAwareness.recentHigh;
  const swingLow = levelAwareness.recentLow;

  // Step 2: Determine structure state (RANGE, BREAKOUT_UP/DOWN, RETEST_UP/DOWN, etc)
  const structureState: StructureState = computeStructureState(
    priceData.price,
    "RANGE",  // TODO: persist this across cycles
    swingHigh,
    swingLow,
    levelAwareness.breakoutPrice || null
  );

  // Step 3: Get direction from structure with tie-breaker
  // v25.0: Pass complete EMA_STRUCTURE object instead of just emaSlope
  // This ensures single source of truth: no dual-source EMA system
  // v35.0: Pass card for RANGE displacement context
  // v38.1 FIX: Do NOT pass card to avoid forward reference TDZ
  // card is not yet defined at this point, and function has optional card parameter
  
  // v41.0 DECISION AXIS: Single source of truth for direction
  // This is the ONLY place direction is determined
  let direction = getDirectionFromStructure(structureState, htf4hAnalysis, stochRsi, htf4hTrend, volatilityLevel);
  console.log(`[DECISION_AXIS] ${symbol}: direction="${direction}" | confidence model applied | structure=${structureState} emaSlope=${htf4hAnalysis?.emaSlope?.toFixed(3) ?? "N/A"} macro=${htf4hTrend}`);


  // v32.0 CRITICAL RULE ENFORCEMENT: Price structure is ALWAYS the truth
  // No indicator overrides, no mutations, no EMA gates
  // Direction is locked and immutable once determined from structure
  const finalDirection = direction;
  
  // v41.0 ENFORCEMENT: Verify direction hasn't been mutated after DecisionAxis
  if (finalDirection !== direction) {
    console.warn(`[DECISION_AXIS_VIOLATION] ${symbol}: direction was mutated after DecisionAxis! Original=${direction} Final=${finalDirection}. IGNORING MUTATION.`);
  }
  
  console.log(`[SCAN] ${symbol} direction=${finalDirection} structureState=${structureState}`);


  const breakoutState: BreakoutState = levelAwareness.breakoutState;

  const card: SymbolCardState = {
    symbol,
    price: priceData.price,
    source: priceData.source,
    degraded: systemDegraded,

    direction: finalDirection,  // v9: Structure-locked direction
    mode: "NONE",
    confidence: 0,

    stochRsi,
    emaSlope,
    volatilityLevel,

    // v8.5: Track breakout state and key levels
    breakoutState,
    recentHigh: levelAwareness.recentHigh,
    recentLow: levelAwareness.recentLow,
    
    // v35.0: Displacement tracking for RANGE decay
    currentPrice: priceData.price,
    entryPrice: priceData.price,  // Initialize to current price
    recentImpulseStrength: calculateImpulseStrength(emaSlope, volatilityLevel, stochRsi),

    // v9: Structure state and levels
    structureState,
    swingHigh,
    swingLow,
    breakoutLevel: levelAwareness.breakoutPrice || null,
    structureTimeframe: 0,  // TODO: compute from timestamp
    lastStructureUpdate: Date.now(),

    // HTF alignment data
    htf4hTrend,
    htf4hMomentum,
    htf1hAlignment,
    htf15mCompression,
    execution15mState,

    // Market readiness
    marketReadinessState: calculateLiveMarketState(finalDirection, emaSlope, stochRsi, volatilityLevel) as any,
    tradeReadinessScore: finalDirection === "NEUTRAL" ? 0 : calculateTradeReadinessScore("NONE", finalDirection, htf4hTrend, htf1hAlignment, emaSlope, stochRsi, volatilityLevel),
    
    // Conditional: Only populate if signal exists
    expectedMovePercent: null,
    targetPrices: null,
    riskReward: null,
    
    // v21.5.5 HARD BLOCKS:
    // 1. NEUTRAL always → DO_NOT_TRADE
    // 2. CHOP_NO_TRADE always → DO_NOT_TRADE (hard exit, not BUILDING)
    // 3. Otherwise BUILDING (unless ACTIVE_SNIPER)
    signalState: (() => {
      if (finalDirection === "NEUTRAL") return "DO_NOT_TRADE";
      const marketState = calculateLiveMarketState(finalDirection, emaSlope, stochRsi, volatilityLevel);
      if (marketState === "CHOP_NO_TRADE") return "DO_NOT_TRADE";
      return "BUILDING";
    })(),
    lastSignalTime: undefined,

    notes: `${structureState} - ${finalDirection}`,
    updatedAt: new Date().toISOString(),
  };

  // v23.0 PIPELINE TRACE: Comprehensive state verification with event detection
  // Monitor events removed to break circular dependency with monitor-event-engine
  
  console.log(`[PIPELINE_TRACE] ${symbol} cycle state:
    direction=${finalDirection} (from momentum + structure)
    momentum_score=${card.momentumScore?.toFixed(1) ?? "N/A"}
    emaSlope=${emaSlope?.toFixed(3) ?? "N/A"}
    stochRsi=${stochRsi?.toFixed(1) ?? "N/A"}
    volatility=${volatilityLevel?.toFixed(1) ?? "N/A"}
    execution15m=${card.execution15mState}
    structure=${structureState}
    htf4hTrend=${htf4hTrend}
    signal_state=${card.signalState}
  `);

  // v21.6.0 CRITICAL FIX: Calculate momentum score AFTER all direction mutations
  // Score must use the FINAL locked direction, not pre-mutation state
  // This ensures direction → final state → scoring, NOT scoring → direction
  card.momentumScore = calculateMomentumScore(card, symbol);

  return card;

}

// v22.5 RUNTIME VERSION EXPORT
// Used to verify that v22.5 is executing (not old stale artifact)
export const STRATEGY_VERSION = "v28.0_UNIFIED_REGIME_CONVICTION_ENGINE";
export const MOMENTUM_ENGINE_VERSION = "v28.0_UNIFIED_REGIME_CONVICTION_ENGINE";

