/**
 * SNIPER ENGINE v7.0 - MOMENTUM IGNITION SYSTEM
 * 
 * Converts from structure-based scanner to momentum wave detector
 * Uses Stochastic RSI + EMA Stack + Volatility Compression
 * 
 * NO STATE, NO DB ACCESS, PURE EVALUATION
 */

import type { PriceData } from "./price-router";

// v15.0.0: Canonical execution states
// Single source of truth for trade readiness
// NONE → BUILDING → ACTIVE_SNIPER → ACTIVE_CONFIRMED (with possible reversals to earlier states)
export type SignalState = 
  | "NONE"              // No setup present (CHOP, conflicting signals)
  | "BUILDING"          // Setup forming, structural quality insufficient for entry
  | "ACTIVE_SNIPER"     // Entry aligned, ready for execution
  | "ACTIVE_CONFIRMED"; // Trade executed or confirmed with follow-through

// v15.0.0: Market structure classification (replaces SetupClassification)
// Determines execution state eligibility and readiness gates
export type MarketStructureClass = 
  | "TREND_FOLLOWING"   // Direction aligns with 4H HTF, structural support strong
  | "EARLY_REVERSAL"    // Contra-HTF with elite reversal conditions met (displacement, volume, EMA)
  | "COUNTER_TREND"     // Contra-HTF without elite conditions, lower probability, capped at BUILDING
  | "TRANSITION"        // Mixed HTF/LTF conditions, incomplete reversal signal, direction uncertain
  | "RANGE"             // HTF neutral, weak directional expansion, rotational structure
  | "CHOP";             // COMPRESSING state, conflicting signals, no entry possible

export type SymbolCardState = {
  symbol: string;
  price: number;
  source: string;
  degraded: boolean;

  // v17.2.0: CANONICAL EXECUTION STATE - ONLY SOURCE OF TRUTH
  signalState: SignalState;
  
  // v17.2.0: CANONICAL CONTEXTUAL CLASSIFIER
  marketClass: MarketStructureClass;
  
  // v17.2.0: EXECUTION DIRECTION
  direction: "LONG" | "SHORT" | "NEUTRAL";
  
  // v17.2.0: Trade confidence within state band (0-100)
  tradeReadinessScore: number | null;
  
  // v17.2.0: Ignition probability for state derivation
  ignitionProbability: number;

  // Momentum indicators (5M)
  stochRsi: number | null;
  emaSlope: number | null;
  emaPressure: number;
  volatilityLevel: number | null;
  
  // Higher TimeFrame alignment
  htf4hTrend: "BULLISH" | "BEARISH" | "NEUTRAL";
  htf4hMomentum: number | null;
  htf1hAlignment: boolean | null;
  htf15mCompression: boolean | null;
  
  // 15M EXECUTION STRUCTURE
  execution15mState: "COMPRESSING" | "BREAKOUT_READY" | "EXPANDING" | "CHOP";

  // Market readiness
  marketReadinessState: string;
  
  // Conditional: Only populate if signalState === ACTIVE_SNIPER or ACTIVE_CONFIRMED
  expectedMovePercent: { sniper: { min: number; max: number } } | null;
  targetPrices: { tp1: number; tp2: number; sl: number } | null;
  riskReward: number | null;

  // Trend memory
  lastBullishCycle?: number;
  lastBearishCycle?: number;
  trendMemory?: "BULLISH" | "BEARISH";
  
  // Cycle tracking
  cycleId: string;
  lastSignalTime?: number;

  notes: string;
  updatedAt: string;

  // v7.5.1: OBSERVABILITY LAYER - Why signals didn't fire
  blockReason?: string;
  
  // Score breakdown for transparency
  scoreBreakdown?: {
    stochComponent: number;
    emaComponent: number;
    volatilityComponent: number;
    displacementComponent: number;
    emaAccelerationDelta?: number;
    impulseContinuationBoost?: number;
    totalIgnition: number;
  };
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
  targetPrices?: { tp1: number; tp2: number; sl: number };
  riskReward?: number;
};

/**
 * v17.7.0: ASSET-SPECIFIC NORMALIZATION PROFILES
 * 
 * Different assets have different volatility and momentum characteristics.
 * These profiles normalize signal features per asset WITHOUT changing execution thresholds.
 * 
 * Execution thresholds REMAIN:
 * - SNIPER: 60
 * - CONFIRMED: 75
 */
export type AssetProfile = {
  displacementATRMultiplier: number;    // Normalize displacement per ATR
  emaSlopeNormalization: number;        // Normalize EMA acceleration
  volatilityNormalization: number;      // Normalize volatility expansion
  continuationBiasWeight: number;       // Weight for trend continuation
  impulseWeight: number;                // Weight for impulse expansion
};

// v17.7.0: PROFILE DEFINITIONS
const ASSET_PROFILES: Record<string, AssetProfile> = {
  BTC: {
    displacementATRMultiplier: 0.6,
    emaSlopeNormalization: 0.82,         // v18.0.0: Increased from 0.70 to allow BTC trend participation
    volatilityNormalization: 0.65,
    continuationBiasWeight: 1.15,        // v18.0.0: Reduced from 1.35 to increase expansion responsiveness
    impulseWeight: 1.05,                 // v18.0.0: Increased from 0.92 for earlier trend transitions
  },
  ETH: {
    displacementATRMultiplier: 1.0,
    emaSlopeNormalization: 1.0,
    volatilityNormalization: 1.0,
    continuationBiasWeight: 1.0,
    impulseWeight: 1.08,
  },
  SOL: {
    displacementATRMultiplier: 1.15,
    emaSlopeNormalization: 1.00,         // v18.0.0: Reduced from 1.20 to allow earlier participation
    volatilityNormalization: 1.25,
    continuationBiasWeight: 0.9,
    impulseWeight: 1.45,
  },
};

// v17.7.0: GET ASSET PROFILE
function getAssetProfile(symbol: string): AssetProfile {
  const baseSymbol = symbol.split("/")[0].toUpperCase();
  return ASSET_PROFILES[baseSymbol] || ASSET_PROFILES.ETH; // Default to ETH baseline
}

// v17.7.0: NORMALIZE EMA SLOPE
function normalizeEmaSlope(emaSlope: number | null, symbol: string): number | null {
  if (emaSlope === null) return null;
  const profile = getAssetProfile(symbol);
  return emaSlope / profile.emaSlopeNormalization;
}

// v17.7.0: NORMALIZE VOLATILITY LEVEL
function normalizeVolatilityLevel(volatilityLevel: number | null, symbol: string): number | null {
  if (volatilityLevel === null) return null;
  const profile = getAssetProfile(symbol);
  return volatilityLevel / profile.volatilityNormalization;
}

// v17.7.0: NORMALIZE CONTINUATION BIAS
function applyContinuationBias(continuationScore: number, symbol: string): number {
  const profile = getAssetProfile(symbol);
  return continuationScore * profile.continuationBiasWeight;
}

// v17.7.0: NORMALIZE IMPULSE WEIGHT
function applyImpulseWeight(impulseScore: number, symbol: string): number {
  const profile = getAssetProfile(symbol);
  return impulseScore * profile.impulseWeight;
}

// IGNITION RESULT TYPE FOR INTERNAL CALCS
type IgnitionResult = {
  probability: number;
  reason: string;
  breakdown: {
    stochComponent: number;
    emaComponent: number;
    volatilityComponent: number;
    displacementComponent: number;
    emaAccelerationDelta: number;
    impulseContinuationBoost: number;
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
 * v16.1.0: FINAL ARCHITECTURE - Single Canonical Signal Reducer
 * 
 * Collapse all parallel field derivations into ONE function.
 * No multiple truth systems, no cross-field contradictions.
 * 
 * INPUT: ignition, marketStructure, htfTrend, ltfBias
 * OUTPUT: Single authoritative signal object
 */
export type DerivedSignal = {
  state: SignalState;           // NONE | BUILDING | ACTIVE_SNIPER | ACTIVE_CONFIRMED
  direction: "LONG" | "SHORT" | "NONE";
  confidence: number;            // 0-100, clamped to state band
  type: "TREND" | "REVERSAL" | "NONE";  // NONE when state=BUILDING/NONE
  targets?: {                    // Only if state=SNIPER+
    entry: number;
    takeProfit: number[];
    stopLoss: number;
    expectedMove: number;
    riskReward: number;
  };
};

/**
 * v17.0.0: PURE DETERMINISTIC STATELESS SIGNAL ENGINE
 * 
 * Single canonical signal reducer.
 * State = current market conditions only.
 * No lifecycle persistence, no temporal logic, no hidden invalidation.
 */

/**
 * v16.1.0: UNIFIED SIGNAL REDUCER
 * 
 * Single function that derives EVERYTHING from inputs.
 * No side effects, no separate validation, no hidden logic.
 * 
 * Returns ONE object that is the absolute authority for signal state.
 * No other code computes state/direction/confidence independently.
 */
function deriveSignal(
  ignition: number,
  marketClass: MarketStructureClass,
  htfTrend: "BULLISH" | "BEARISH" | "NEUTRAL" | null,
  ltfBias: "BULLISH" | "BEARISH" | "NEUTRAL",
  direction: "LONG" | "SHORT" | "NEUTRAL",
  price: number,
  volatilityLevel: number | null
): DerivedSignal {
  // Step 1: Derive execution state from ignition ONLY
  const state = deriveExecutionState(ignition);
  
  // Step 2: Determine if this signal is valid for trading
  // Valid = (state is SNIPER/CONFIRMED) AND (direction is LONG/SHORT)
  const isExecutable = 
    (state === "ACTIVE_SNIPER" || state === "ACTIVE_CONFIRMED") &&
    direction !== "NEUTRAL";
  
  // Step 3: If not executable, return NONE signal
  if (!isExecutable) {
    return {
      state: "NONE",
      direction: "NONE",
      confidence: 0,
      type: "NONE",
    };
  }
  
  // Step 4: Validate CONFIRMED signals must be structurally coherent
  if (state === "ACTIVE_CONFIRMED") {
    const structurallyCoherent =
      // Either HTF trend aligns with direction (trend-following)
      ((direction === "LONG" && htfTrend === "BULLISH") ||
       (direction === "SHORT" && htfTrend === "BEARISH")) ||
      // Or explicitly a reversal class that qualifies for CONFIRMED
      (marketClass === "EARLY_REVERSAL" && ignition >= 75);
    
    // If CONFIRMED but not structurally coherent, downgrade to SNIPER
    if (!structurallyCoherent) {
      return {
        state: "ACTIVE_SNIPER",
        direction,
        confidence: deriveReadiness("ACTIVE_SNIPER", ignition),
        type: marketClass === "EARLY_REVERSAL" ? "REVERSAL" : "TREND",
        targets: calculateTradeTargets(price, volatilityLevel ?? 50, direction),
      };
    }
  }
  
  // Step 5: Determine signal type
  const signalType: "TREND" | "REVERSAL" =
    marketClass === "EARLY_REVERSAL" || 
    marketClass === "COUNTER_TREND" ? "REVERSAL" : "TREND";
  
  // Step 6: Calculate final confidence (readiness within state band)
  const confidence = deriveReadiness(state, ignition);
  
  // Step 7: Build signal object (single authority)
  const signal: DerivedSignal = {
    state,
    direction,
    confidence,
    type: signalType,
  };
  
  // Step 8: Add targets only for executable states
  if (state === "ACTIVE_SNIPER" || state === "ACTIVE_CONFIRMED") {
    signal.targets = calculateTradeTargets(price, volatilityLevel ?? 50, direction);
  }
  
  return signal;
}

/**
 * v16.0.0: Unified normalized signal output schema
 * EVERY asset returns complete, deterministic signal object
 * No missing fields, no partial objects, no early returns
 */
/**
 * v16.1.0: Unified Signal Output Schema
 * Uses SINGLE SOURCE OF TRUTH: deriveSignal() output
 * No parallel field derivations allowed
 */
export type NormalizedSignal = {
  symbol: string;
  
  // Market structure context (informational only)
  marketStructure: {
    classification: MarketStructureClass;
    htfTrend: "BULLISH" | "BEARISH" | "NEUTRAL" | null;
    ltfBias: "BULLISH" | "BEARISH" | "NEUTRAL";
  };
  
  // Raw ignition (informational)
  ignition: number;  // 0-100
  
  // SINGLE AUTHORITATIVE SIGNAL (from deriveSignal reducer)
  signal: DerivedSignal;
  
  // Timestamp
  timestamp: number;
};

/**
 * v16.1.0: Normalize signal output using single reducer
 * Guarantees consistent output with no parallel derivations
 */
function normalizeSignalOutput(card: SymbolCardState): NormalizedSignal {
  const ignitionRaw = Math.max(0, Math.min(100, card.ignitionProbability ?? 0));
  
  // SINGLE POINT OF TRUTH: deriveSignal reducer
  const signal = deriveSignal(
    ignitionRaw,
    card.marketClass,
    card.htf4hTrend ?? "NEUTRAL",
    card.ltfBias ?? "NEUTRAL",
    card.direction,
    card.price,
    card.volatilityLevel
  );
  
  return {
    symbol: card.symbol,
    marketStructure: {
      classification: card.marketClass,
      htfTrend: card.htf4hTrend ?? "NEUTRAL",
      ltfBias: card.ltfBias ?? "NEUTRAL",
    },
    ignition: ignitionRaw,
    signal,
    timestamp: Date.now(),
  };
}

/**
 * Generate symbol card states + setups from market snapshot
 * PURE FUNCTION - momentum-based detection
 */
export async function generateSetups(market: Record<string, PriceData>): Promise<{ cards: SymbolCardState[]; setups: Setup[] }> {
  const cards: SymbolCardState[] = [];
  const setups: Setup[] = [];

  for (const [symbol, priceData] of Object.entries(market)) {
    // v16.0.0: NO EARLY RETURNS - all assets go through full pipeline
    // Even if price is 0 or missing, we still generate normalized output
    
    if (priceData.price === 0) {
      console.log(`[SCAN] ${symbol} no price data`);
      // Create minimal card for missing data
      const minimalCard: SymbolCardState = {
        symbol,
        price: 0,
        direction: "NEUTRAL",
        ignitionProbability: 0,
        signalState: "NONE",
        marketClass: "CHOP",
        displayScore: 0,
        setupStatus: "BUILDING",
        mode: "NONE",
      } as SymbolCardState;
      
      cards.push(minimalCard);
      continue;  // Skip setup generation for zero-price assets
    }

    // Generate card state for this symbol
    const card = generateCardState(symbol, priceData);
    cards.push(card);
    
    console.log(`[SCAN] ${symbol} ignition=${card.ignitionProbability} direction=${card.direction} stoch=${card.stochRsi?.toFixed(1)} emaSlope=${card.emaSlope?.toFixed(2)} htf=${card.htf4hTrend}`);

    // v16.0.0: CANONICAL PIPELINE - NO HIDDEN GATING, NO MACRO PENALTIES, NO SCORE CAPS
    // Every asset goes through complete pipeline even if final state is BUILDING/NONE
    
    // Calculate market class (for logging/UI, doesn't gate execution)
    card.marketClass = classifyMarketStructure({
      direction: card.direction,
      htf4hTrend: card.htf4hTrend,
      execution15mState: card.execution15mState,
      ignitionProbability: card.ignitionProbability,
      emaSlope: card.emaSlope,
      volatilityLevel: card.volatilityLevel,
      emaAccelerationDelta: 0,
      displacement: 0,
    });

    console.log(`[MARKET_CLASS] ${symbol}: ${card.marketClass}`);
    
    // Derive execution state ONLY from ignition (no gating logic)
    card.signalState = deriveExecutionState(card.ignitionProbability);
    
    // Derive readiness per execution state bands
    const readiness = deriveReadiness(card.signalState, card.ignitionProbability);
    card.displayScore = readiness;
    card.confidence = readiness;  // v16.2.1 FIX: Set confidence for ALL states (BTC BUILDING needs this)
    card.tradeReadinessScore = readiness;  // v16.2.2 FIX: Set for ALL states, not just SNIPER/CONFIRMED (UI checks this)
    
    console.log(`[EXECUTION_STATE] ${symbol}: ${card.signalState} (ignition=${card.ignitionProbability} readiness=${readiness})`);
    
    // Map signalState to mode/setupStatus for UI compatibility
    switch (card.signalState) {
      case "ACTIVE_CONFIRMED":
        card.mode = "CONFIRMED";
        card.setupStatus = "CONFIRMED";
        break;
      case "ACTIVE_SNIPER":
        card.mode = "SNIPER";
        card.setupStatus = "SNIPER";
        break;
      case "BUILDING":
        card.mode = "NONE";
        card.setupStatus = "BUILDING";
        break;
      case "NONE":
      default:
        card.mode = "NONE";
        card.setupStatus = "BUILDING";
        card.signalState = "NONE";
    }
  }

  // v18.0.0: CROSS-ASSET EXPANSION SYNCHRONIZATION BONUS
  // If 2+ assets have volatilityComponent > 28 AND aligned directions, add +4 bonus to each
  const expansionAssets = cards.filter(c => 
    c.volatilityLevel !== null && 
    c.volatilityLevel > 28 &&
    c.direction !== "NEUTRAL"
  );
  
  const longExpanding = expansionAssets.filter(c => c.direction === "LONG");
  const shortExpanding = expansionAssets.filter(c => c.direction === "SHORT");
  
  let expansionBonus = 0;
  if (longExpanding.length >= 2) {
    expansionBonus = 4;
    console.log(`[EXPANSION_SYNC] LONG: ${longExpanding.map(c => c.symbol).join("/")} expanding together - +4 bonus`);
    longExpanding.forEach(card => {
      card.ignitionProbability = Math.min(100, card.ignitionProbability + expansionBonus);
    });
  }
  
  if (shortExpanding.length >= 2) {
    expansionBonus = 4;
    console.log(`[EXPANSION_SYNC] SHORT: ${shortExpanding.map(c => c.symbol).join("/")} expanding together - +4 bonus`);
    shortExpanding.forEach(card => {
      card.ignitionProbability = Math.min(100, card.ignitionProbability + expansionBonus);
    });
  }

  // v18.0.0: RE-DERIVE EXECUTION STATES AFTER EXPANSION BONUS
  for (const card of cards) {
    if (card.ignitionProbability === 0) continue; // Skip minimal cards
    
    // Check if ignition changed due to expansion bonus
    const newSignalState = deriveExecutionState(card.ignitionProbability);
    const oldSignalState = card.signalState;
    
    if (newSignalState !== oldSignalState) {
      console.log(`[STATE_UPGRADE] ${card.symbol}: ${oldSignalState} → ${newSignalState} (ignition=${card.ignitionProbability} after expansion bonus)`);
      card.signalState = newSignalState;
      
      // Re-derive readiness with new state
      const readiness = deriveReadiness(card.signalState, card.ignitionProbability);
      card.displayScore = readiness;
      card.confidence = readiness;
      card.tradeReadinessScore = readiness;
      
      // Update mode/setupStatus
      switch (card.signalState) {
        case "ACTIVE_CONFIRMED":
          card.mode = "CONFIRMED";
          card.setupStatus = "CONFIRMED";
          break;
        case "ACTIVE_SNIPER":
          card.mode = "SNIPER";
          card.setupStatus = "SNIPER";
          break;
        case "BUILDING":
          card.mode = "NONE";
          card.setupStatus = "BUILDING";
          break;
        case "NONE":
        default:
          card.mode = "NONE";
          card.setupStatus = "BUILDING";
          break;
      }
    }
  }

  // Generate setups after expansion bonus applied
  for (const card of cards) {
    if (card.ignitionProbability === 0) continue; // Skip minimal cards
    
    if (card.signalState === "ACTIVE_CONFIRMED" || card.signalState === "ACTIVE_SNIPER") {
      if (card.direction !== "NEUTRAL") {
        const readiness = deriveReadiness(card.signalState, card.ignitionProbability);
        card.confidence = Math.min(readiness, 99);
        card.lastSignalTime = Date.now();
        card.notes = `${card.signalState} ${card.direction} - ${card.marketClass}`;
        
        // Populate trade targets
        const targets = calculateTradeTargets(card.price, card.volatilityLevel ?? 50, card.direction);
        card.expectedMovePercent = targets.expectedMovePercent;
        card.targetPrices = targets.targetPrices;
        card.riskReward = targets.riskReward;
        
        setups.push({
          symbol: card.symbol,
          mode: card.mode as "SNIPER" | "CONFIRMED",
          direction: card.direction,
          score: readiness,
          reason: `${card.signalState} ${card.direction} - ${card.marketClass}`,
          price: card.price,
          momentum: {
            stochRsiSignal: `Stoch RSI: ${card.stochRsi?.toFixed(1) ?? "—"}`,
            emaStackSignal: card.direction === "LONG" ? "8 EMA accelerating up" : "8 EMA accelerating down",
            volatilitySignal: (card.volatilityLevel ?? 40) > 45 ? "Expansion" : "Forming",
            trend4H: card.htf4hTrend !== "NEUTRAL",
          },
        });
        console.log(`[SETUP_GENERATED] ${card.symbol} ${card.signalState} ${card.direction} | readiness=${readiness} marketClass=${card.marketClass}`);
      }
    } else {
      // v16.0.0: No early return - still track reason for BUILDING/NONE
      let blockReason = "Waiting for signal";
      if (card.direction === "NEUTRAL") {
        blockReason = "No directional bias";
      } else if (card.signalState === "BUILDING") {
        blockReason = `BUILDING - ignition ${card.ignitionProbability}% (need 60% for SNIPER)`;
      } else if (card.signalState === "NONE") {
        blockReason = `NONE - ignition ${card.ignitionProbability}% (need 20% for BUILDING)`;
      }
      card.blockReason = blockReason;
      console.log(`[NO_SETUP] ${card.symbol} ${card.signalState} | ${blockReason}`);
    }
  }

  return { cards, setups };
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
// v15.0.0: calculateMomentumScore DELETED - ignition drives execution state directly

/**
 * v8.0.2: Calculate displacement quality (soft confidence modifier)
 * Measures directional commitment strength of current expansion
 * Returns lightweight modifier (-8 to +8) for ignitionProbability
 * 
 * NOT a gate, NOT a blocker, just a quality confidence adjuster
 */
function calculateDisplacementQuality(
  emaSlope: number | null,
  stochRsi: number | null,
  volatilityLevel: number | null,
  direction: "LONG" | "SHORT" | "NEUTRAL",
  execution15mState: string | null
): { displacementModifier: number; displacementReason: string } {
  let modifier = 0;
  const reasons: string[] = [];

  // POSITIVE DISPLACEMENT: Strong directional commitment
  // EMA slope aligned + volatility expanding + stoch at extremes = committed move
  const emaAligned = 
    (direction === "LONG" && emaSlope !== null && emaSlope > 0.4) ||
    (direction === "SHORT" && emaSlope !== null && emaSlope < -0.4);
  
  const volStrong = volatilityLevel !== null && volatilityLevel > 60;
  const stochExtreme = 
    (direction === "LONG" && stochRsi !== null && stochRsi < 30) ||
    (direction === "SHORT" && stochRsi !== null && stochRsi > 70);
  
  if (emaAligned && volStrong && stochExtreme) {
    modifier = 8;
    reasons.push("Strong directional commitment: aligned EMA + vol expansion + stoch extreme");
  } else if (emaAligned && volStrong) {
    modifier = 6;
    reasons.push("Good directional commitment: aligned EMA + vol expansion");
  } else if (emaAligned && stochExtreme) {
    modifier = 5;
    reasons.push("Decent directional commitment: aligned EMA + stoch extreme");
  } else if (volStrong && execution15mState === "EXPANDING") {
    modifier = 4;
    reasons.push("Expansion with volatility commitment");
  }
  
  // NEGATIVE DISPLACEMENT: Choppy/weak commitment
  // EMA misaligned OR weak vol + high execution chop = weak commitment
  const emaMisaligned = 
    (direction === "LONG" && emaSlope !== null && emaSlope <= 0.1) ||
    (direction === "SHORT" && emaSlope !== null && emaSlope >= -0.1);
  
  const volWeak = volatilityLevel !== null && volatilityLevel < 40;
  const choppy = execution15mState === "CHOP" || execution15mState === "COMPRESSING";
  
  if (emaMisaligned && volWeak && choppy) {
    modifier = -8;
    reasons.push("Weak displacement: EMA misaligned + weak vol + choppy structure");
  } else if (emaMisaligned && volWeak) {
    modifier = -5;
    reasons.push("Weak displacement: EMA misaligned + weak vol");
  } else if (choppy && volWeak) {
    modifier = -4;
    reasons.push("Choppy displacement: CHOP/COMPRESS + weak vol");
  }
  
  return {
    displacementModifier: modifier,
    displacementReason: reasons.length > 0 ? reasons.join(" | ") : "Neutral displacement"
  };
}

/**
 * v18.2.0: Get asset role for HTF bias interpretation
 * Returns: ANCHOR | MACRO_PARTICIPANT | MOMENTUM_AMPLIFIER
 */
function getAssetRole(symbol: string): "ANCHOR" | "MACRO_PARTICIPANT" | "MOMENTUM_AMPLIFIER" {
  if (symbol === "ETH") return "ANCHOR";
  if (symbol === "BTC") return "MACRO_PARTICIPANT";
  if (symbol === "SOL") return "MOMENTUM_AMPLIFIER";
  return "MACRO_PARTICIPANT"; // Default for unknown assets
}

/**
 * v18.2.0: Get human-readable role description
 */
function getRoleDescription(symbol: string): string {
  const role = getAssetRole(symbol);
  if (role === "ANCHOR") return "ANCHOR (momentum-only)";
  if (role === "MACRO_PARTICIPANT") return "MACRO_PARTICIPANT (HTF ±20%)";
  if (role === "MOMENTUM_AMPLIFIER") return "MOMENTUM_AMPLIFIER (HTF ±25%)";
  return role;
}

/**
 * v18.2.0: Apply asset role-specific HTF bias to raw HTF score
 * Returns scalar bias to multiply final ignition score
 */
function applyAssetRoleHTFBias(symbol: string, htfRawScore: number): number {
  const role = getAssetRole(symbol);
  
  if (role === "ANCHOR") {
    // ETH: No HTF influence, returns 0 bias
    return 0;
  } else if (role === "MACRO_PARTICIPANT") {
    // BTC: ±20% bias range (scalar: ±0.20)
    // Formula: clamp(htfScore * 0.05, -0.20, +0.20)
    const bias = htfRawScore * 0.05;
    return Math.max(-0.20, Math.min(0.20, bias));
  } else if (role === "MOMENTUM_AMPLIFIER") {
    // SOL: ±25% bias range (scalar: ±0.25)
    // Formula: clamp(htfScore * 0.06, -0.25, +0.25)
    const bias = htfRawScore * 0.06;
    return Math.max(-0.25, Math.min(0.25, bias));
  }
  
  return 0; // Safe default
}

/**
 * v7.5.2: Calculate ignition probability (probabilistic 5M signal)
 * Returns confidence score 0-100 for imminent short-term execution
 */
function calculateIgnitionProbability(
  stochRsi: number | null,
  emaSlope: number | null,
  volatilityLevel: number | null,
  direction: "LONG" | "SHORT" | "NEUTRAL",
  htf4hTrend: "BULLISH" | "BEARISH" | "NEUTRAL",
  symbol: string = "ETH/USD",
  htf1hAlignment: boolean = true,
  execution15mState: string | null = null
): IgnitionResult {
  // v17.7.0: Apply asset-specific normalization
  const normalizedEmaSlope = normalizeEmaSlope(emaSlope, symbol);
  const normalizedVolatilityLevel = normalizeVolatilityLevel(volatilityLevel, symbol);
  const profile = getAssetProfile(symbol);
  
  let stochComponent = 0;
  let emaComponent = 0;
  let volatilityComponent = 0;
  let volumeComponent = 0;
  let continuationComponent = 0;
  const reasons: string[] = [];

  // v17.8.0: CONTINUOUS WEIGHTED STOCHASTIC COMPONENT (0-30 points)
  // Replaces discrete bucketing with smooth sigmoid-like weighting
  if (stochRsi !== null) {
    if (direction === "LONG") {
      // Oversold = higher score. Map 0-20 → 30 points, 20-50 → 10 points linearly
      if (stochRsi < 20) {
        stochComponent = 30 * (1 - stochRsi / 20); // 20 -> 30, 0 -> 30
        reasons.push(`Stoch deep oversold (${stochRsi.toFixed(1)})`);
      } else if (stochRsi < 50) {
        stochComponent = 10 * (1 - (stochRsi - 20) / 30); // 20 -> 10, 50 -> 0
        reasons.push(`Stoch building (${stochRsi.toFixed(1)})`);
      } else {
        stochComponent = Math.max(0, 5 - (stochRsi - 50) / 10); // Fading above 50
        reasons.push(`Stoch mid-high (${stochRsi.toFixed(1)})`);
      }
    } else if (direction === "SHORT") {
      // Overbought = higher score. Map 80-100 → 30 points, 50-80 → 10 points
      if (stochRsi > 80) {
        stochComponent = 30 * ((stochRsi - 80) / 20); // 80 -> 0, 100 -> 30
        reasons.push(`Stoch deep overbought (${stochRsi.toFixed(1)})`);
      } else if (stochRsi > 50) {
        stochComponent = 10 * ((stochRsi - 50) / 30); // 50 -> 0, 80 -> 10
        reasons.push(`Stoch building down (${stochRsi.toFixed(1)})`);
      } else {
        stochComponent = Math.max(0, 5 - (50 - stochRsi) / 10); // Fading below 50
        reasons.push(`Stoch mid-low (${stochRsi.toFixed(1)})`);
      }
    }
  }

  // v17.8.0: CONTINUOUS WEIGHTED EMA COMPONENT (0-35 points)
  // Replaces all discrete if/else bands with continuous curve
  if (normalizedEmaSlope !== null) {
    const absMagnitude = Math.abs(normalizedEmaSlope);
    const alignedWithDirection = (direction === "LONG" && normalizedEmaSlope > 0) ||
                                  (direction === "SHORT" && normalizedEmaSlope < 0);
    
    if (alignedWithDirection) {
      // v17.9.0: Increased EMA sensitivity for early momentum detection
      // Continuous mapping: 0 → 0, 0.5 → 15, 1.0 → 35 points
      // Changed from 1.3 to 1.15 exponent for faster early ignition
      emaComponent = Math.min(35, Math.pow(absMagnitude, 1.15) * 35);
      emaComponent = applyImpulseWeight(emaComponent, symbol);
      reasons.push(`EMA acceleration: ${emaComponent.toFixed(2)} (norm=${normalizedEmaSlope.toFixed(2)})`);
    } else if (absMagnitude < 0.2 && normalizedVolatilityLevel !== null && normalizedVolatilityLevel > 50) {
      // Early reversal detection: partial credit for improving slope
      emaComponent = 5 + (normalizedVolatilityLevel - 50) * 0.2; // 5-10 range
      emaComponent = applyContinuationBias(emaComponent, symbol);
      reasons.push(`EMA early transition: ${emaComponent.toFixed(2)} (improving slope)`);
    } else {
      reasons.push(`EMA diverges from ${direction} direction (${normalizedEmaSlope.toFixed(2)})`);
    }
  }

  // v17.8.0: CONTINUOUS WEIGHTED VOLATILITY COMPONENT (0-35 points)
  // Replaces discrete > 60, > 50 thresholds with smooth curve
  if (normalizedVolatilityLevel !== null) {
    // Continuous mapping: 20 → 0, 50 → 20, 70 → 35 points
    // Using piecewise continuous function for smoother behavior
    if (normalizedVolatilityLevel < 20) {
      volatilityComponent = 0;
      reasons.push(`Volatility low (${normalizedVolatilityLevel.toFixed(1)})`);
    } else if (normalizedVolatilityLevel < 50) {
      // Linear 20-50 → 0-20
      volatilityComponent = (normalizedVolatilityLevel - 20) * (20 / 30);
      volatilityComponent = applyContinuationBias(volatilityComponent, symbol);
      reasons.push(`Volatility moderate: ${volatilityComponent.toFixed(2)}`);
    } else {
      // Quadratic 50-80 → 20-35 (accelerating curve)
      const expansionFactor = Math.min(1.0, (normalizedVolatilityLevel - 50) / 30);
      volatilityComponent = 20 + Math.pow(expansionFactor, 1.2) * 15;
      volatilityComponent = applyImpulseWeight(volatilityComponent, symbol);
      reasons.push(`Volatility expansion: ${volatilityComponent.toFixed(2)}`);
    }
  }

  // v17.8.0: CONTINUOUS VOLUME IMPULSE COMPONENT (0-8 points)
  // Smooth contribution instead of hard 5-point gate
  if (normalizedVolatilityLevel !== null) {
    if (normalizedVolatilityLevel > 55) {
      // Scale from 0 at vol=55 to 8 at vol=80
      volumeComponent = Math.min(8, (normalizedVolatilityLevel - 55) * (8 / 25));
      volumeComponent = applyImpulseWeight(volumeComponent, symbol);
      reasons.push(`Volume impulse: ${volumeComponent.toFixed(2)}`);
    }
  }

  // v17.8.0: CONTINUATION BIAS WEIGHTING
  // Reward sustained trend direction alignment
  if (normalizedEmaSlope !== null && emaComponent > 5) {
    const continuationMultiplier = profile.continuationBiasWeight;
    continuationComponent = emaComponent * (continuationMultiplier - 1) * 0.2; // Additive, not multiplicative
    continuationComponent = Math.max(0, Math.min(8, continuationComponent));
    if (continuationComponent > 0.5) {
      reasons.push(`Continuation bonus: +${continuationComponent.toFixed(2)}`);
    }
  }

  // v17.8.0: SOFT SATURATION DECAY NEAR THRESHOLDS
  // Prevents sticky CONFIRMED states by gently damping high scores
  let probabilityBase = stochComponent + emaComponent + volatilityComponent + volumeComponent + continuationComponent;
  
  // Apply soft saturation: if score > 70, multiply by 0.96 to reduce tendency to lock at CONFIRMED
  if (probabilityBase > 70) {
    const saturationDamping = 0.96;
    probabilityBase = 70 + (probabilityBase - 70) * saturationDamping;
    reasons.push(`Soft saturation damping (70→${probabilityBase.toFixed(1)})`);
  }

  // v17.9.0: VOLATILITY PERSISTENCE PENALTY (REDUCED)
  // If volatility expansion persists, gradually reduce incremental contribution
  // This is state-free: based only on current volatilityLevel magnitude, not history
  // Updated thresholds to avoid suppressing legitimate breakouts
  let volatilityPersistencePenalty = 0;
  if (normalizedVolatilityLevel !== null && normalizedVolatilityLevel > 75) {
    // High sustained volatility = reduced bonus (less aggressive than v17.8.0)
    volatilityPersistencePenalty = Math.min(4, (normalizedVolatilityLevel - 75) * 0.25);
    volatilityComponent -= volatilityPersistencePenalty;
    reasons.push(`High vol persistence penalty: -${volatilityPersistencePenalty.toFixed(2)}`);
  }

  // v18.4.0: STRUCTURAL HTF CONTEXT (TRUE INDEPENDENCE)
  // Fix: v18.3.0 contaminated HTF with momentum signals (EMA trend, continuation)
  // Now: Pure structural context (regime, compression/expansion, range position)
  // 
  // HTF MUST be independent lens, not "smoothed momentum"
  // Momentum engine is 15M + 5M + Stoch
  // HTF is 4H + regime stability + structural state
  
  let htfRawScore = 0;
  
  if (normalizedVolatilityLevel !== null) {
    // Component 1: COMPRESSION/EXPANSION STATE (±2.0)
    // Not about direction, about structural state
    // Expansion: >50 volatility = market opening up
    // Compression: <40 volatility = market consolidating
    const compressionExpansionState = 
      normalizedVolatilityLevel > 55
        ? Math.min(2.0, (normalizedVolatilityLevel - 55) * 0.4) // High expansion: +2.0 at 70
        : normalizedVolatilityLevel > 40
        ? 0
        : Math.max(-2.0, -(40 - normalizedVolatilityLevel) * 0.4); // Deep compression: -2.0 at 25
    
    // Component 2: RANGE POSITION (±1.5) - v18.5.0 IMPLEMENTATION
    // Where is current price within HTF structural range?
    // This creates geometric grounding for the structural context
    // 
    // Implementation: Use volatility level as proxy for range positioning
    // High volatility (>60) suggests market at/beyond range extremes
    // Low volatility (<40) suggests market in range interior
    // Positioning inference: above/below vol threshold maps to position
    //
    // Proper implementation would need:
    // - 4H rolling high/low (20-50 bars)
    // - Current price normalized: (price - low) / (high - low)
    // - Map 0.0-0.5 → -1.5 to 0 (bottom half)
    // - Map 0.5-1.0 → 0 to +1.5 (top half)
    //
    // For now: Use volatility-based approximation
    // High vol expansion = likely near range extremes (±1.5)
    // Moderate vol = likely mid-range (0)
    let rangePosition = 0;
    if (normalizedVolatilityLevel !== null) {
      if (normalizedVolatilityLevel > 60) {
        // High expansion: market breakout positioning
        // Assume breakout is multidirectional (can be top or bottom)
        // Use direction as hint: LONG = top, SHORT = bottom
        rangePosition = direction === "LONG" ? 1.2 : -1.2;
      } else if (normalizedVolatilityLevel > 50) {
        // Moderate-high expansion
        rangePosition = direction === "LONG" ? 0.6 : -0.6;
      } else if (normalizedVolatilityLevel < 35) {
        // Deep compression: mid-range consolidation uncertainty
        rangePosition = 0;
      } else {
        // Normal range: slight direction bias
        rangePosition = direction === "LONG" ? 0.2 : -0.2;
      }
      // Clamp to -1.5 to +1.5
      rangePosition = Math.max(-1.5, Math.min(1.5, rangePosition));
    }
    
    // Component 3: REGIME STABILITY (±1.0)
    // Not direction, but consistency
    // Is the structural regime being broken?
    // Stable regime: +0.5 to +1.0
    // Breaking regime: -0.5 to -1.0
    // This requires comparing against recent HTF bars
    const regimeStability = htf1hAlignment ? 0.8 : -0.5; // Simplified: uses existing HTF data
    
    // Sum structural components
    htfRawScore = compressionExpansionState + rangePosition + regimeStability;
    
    // Clamp to ±4 range
    htfRawScore = Math.max(-4, Math.min(4, htfRawScore));
    
    reasons.push(`1H struct: comp_exp=${compressionExpansionState.toFixed(2)} range=${rangePosition.toFixed(2)} stab=${regimeStability.toFixed(2)} → ${htfRawScore.toFixed(2)}`);

  } else {
    // Fallback: use regime stability only
    htfRawScore = htf1hAlignment ? 1.0 : -1.0;
    reasons.push("1H regime fallback");
  }
  

  
  // Step 2: Apply asset-role-specific HTF bias (v18.2.0)
  // Now with structural gradient input (v18.4.0)
  // HTF is now independent structural context, not momentum contamination
  const roleBasedHtfBias = applyAssetRoleHTFBias(symbol, htfRawScore);
  const assetRole = getRoleDescription(symbol);
  
  console.log(
    `[HTF_STRUCTURAL_v18.5.0] ${symbol} (${assetRole}): raw=${htfRawScore.toFixed(2)} → scalar=${roleBasedHtfBias.toFixed(3)} ` +
    `(before: ${probabilityBase.toFixed(1)}, multiplier: ${(1 + roleBasedHtfBias).toFixed(3)})`
  );

  // Displacement quality modifier
  const { displacementModifier, displacementReason } = calculateDisplacementQuality(
    emaSlope,
    stochRsi,
    volatilityLevel,
    direction,
    execution15mState
  );

  if (displacementModifier !== 0) {
    reasons.push(`Displacement: ${displacementReason}`);
  }

  // v17.9.0: INCREASE DISPLACEMENT CONTRIBUTION BY 25%
  // Rewards directional commitment, breakout expansion, volatility alignment
  // Keep continuous and floating-point (no discrete bands)
  const adjustedDisplacementModifier = displacementModifier * 1.25;

  // v18.3.0: APPLY ASSET ROLE-BASED HTF BIAS AS MULTIPLICATIVE SCALAR
  // Formula: finalScore = baseScore * (1 + roleBasedHtfBias)
  // Now HTF input is continuous gradient, not binary
  // 
  // Examples:
  // baseScore=54, role=MACRO_PARTICIPANT, HTF gradient=-0.2 (bearish) → 54 * 0.80 = 43.2
  // baseScore=54, role=MACRO_PARTICIPANT, HTF gradient=+0.2 (bullish) → 54 * 1.20 = 64.8
  // baseScore=54, role=ANCHOR, HTF gradient=±0.2 → 54 * 1.00 = 54.0 (HTF ignored)
  
  const htfAdjustedBase = probabilityBase * (1 + roleBasedHtfBias);
  
  // v17.9.0: Displacement contribution (already adjusted)
  // v18.1.0: NO HTF ADDITIVE MODIFIER - removed

  // Final ignition probability with continuous floating-point precision
  // HTF is now structural context only, independent from momentum
  const probability = Math.max(0, Math.min(100, htfAdjustedBase + adjustedDisplacementModifier));

  // v18.4.0: LOGGING UPDATED - Shows structural HTF context
  console.log(
    `[IGNITION_COMPONENTS_v18.5.0] ${symbol} (${assetRole}) ${direction}:` +
    ` ema=${emaComponent.toFixed(2)}` +
    ` vol=${volatilityComponent.toFixed(2)}` +
    ` stoch=${stochComponent.toFixed(2)}` +
    ` impulse=${volumeComponent.toFixed(2)}` +
    ` continuation=${continuationComponent.toFixed(2)}` +
    ` htf_struct=${htfRawScore.toFixed(2)}→${roleBasedHtfBias.toFixed(3)}x` +
    ` disp=${adjustedDisplacementModifier.toFixed(2)}` +
    ` → final=${probability.toFixed(2)}`
  );

  return {
    probability,
    breakdown: {
      stochComponent,
      emaComponent,
      volatilityComponent,
      volumeComponent,
      displacementComponent: adjustedDisplacementModifier,
      emaAccelerationDelta: 0,
      impulseContinuationBoost: 0
    },
    reason: reasons.length > 0 ? reasons.join(" + ") : "No ignition signals detected"
  };
}

/**
 * v7.4.0: SNIPER/CONFIRMED TIMEFRAME RESTRUCTURE
 * 
 * SNIPER: Uses 1H as structural context (no 4H requirement)
 * - 1H alignment provides directional context
 * - 15M provides execution structure (BREAKOUT_READY or EXPANDING)
 * - 5M provides ignition confirmation
}

/**
 * v8.0.4 CRITICAL FIX: Check SNIPER conditions before execution
 * Lightweight pre-check to determine if SNIPER conditions are even plausible
 * Called BEFORE validateActiveSniperExecution for early rejection
 */
/**
 * v8.0.4 CRITICAL FIX: Calculate trade targets for entry/TP/SL
 * Used in CONFIRMED and ACTIVE_SNIPER signal generation
 */
function calculateTradeTargets(
  price: number,
  volatilityLevel: number,
  direction: "LONG" | "SHORT" | "NEUTRAL"
): {
  expectedMovePercent: number;
  targetPrices: { tp1: number; tp2: number; sl: number };
  riskReward: number;
} {
  if (direction === "NEUTRAL" || price <= 0) {
    return {
      expectedMovePercent: 0,
      targetPrices: { tp1: price, tp2: price, sl: price },
      riskReward: 0
    };
  }
  
  // Volatility-based move sizing
  const volatilityFactor = Math.max(0.5, Math.min(2.0, volatilityLevel / 50));
  const expectedMovePercent = volatilityFactor * 1.0;
  const moveAmount = price * (expectedMovePercent / 100);
  
  if (direction === "LONG") {
    return {
      expectedMovePercent,
      targetPrices: {
        tp1: price + moveAmount * 1.0,
        tp2: price + moveAmount * 2.0,
        sl: price - moveAmount * 0.5
      },
      riskReward: 2.0
    };
  } else {
    return {
      expectedMovePercent,
      targetPrices: {
        tp1: price - moveAmount * 1.0,
        tp2: price - moveAmount * 2.0,
        sl: price + moveAmount * 0.5
      },
      riskReward: 2.0
    };
  }
}


/**
 * v8.0.1: Calculate trade readiness score (0-100)
  direction: "LONG" | "SHORT" | "NEUTRAL",
  emaSlope: number | null,
  stochRsi: number | null,
  volatilityLevel: number | null
): string {
  if (direction === "NEUTRAL") {
    return "Awaiting directional impulse";
  }

  // Build state description from components
  const components: string[] = [];
  
  // EMA state
  if (emaSlope !== null) {
    if (Math.abs(emaSlope) > 0.7) {
      components.push("strong trend");
    } else if (Math.abs(emaSlope) > 0.3) {
      components.push("trending");
    } else {
      components.push("flat");
    }
  }
  
  // Stoch state
  if (stochRsi !== null) {
    if (direction === "LONG" && stochRsi < 30) {
      components.push("oversold");
    } else if (direction === "SHORT" && stochRsi > 70) {
      components.push("overbought");
    } else if ((direction === "LONG" && stochRsi > 50) || (direction === "SHORT" && stochRsi < 50)) {
      components.push("momentum");
    }
  }
  
  // Volatility state
  if (volatilityLevel !== null) {
    if (volatilityLevel > 70) {
      components.push("high volatility");
    } else if (volatilityLevel < 30) {
      components.push("low volatility");
    }
  }
  
  // Compose final state string
  const stateStr = components.length > 0 ? components.join(", ") : "neutral conditions";
  return `${direction}: ${stateStr}`;
}

/**
 * v8.4.0 CANONICAL MACRO ALIGNMENT HELPER
 * v15.0.0: isContraMacroStructure DELETED - no macro suppression
 */

function calculateLiveMarketState(
  direction: "LONG" | "SHORT" | "NEUTRAL",
  emaSlope: number | null,
  stochRsi: number | null,
  volatilityLevel: number | null
): string {
  if (direction === "NEUTRAL") {
    return "Awaiting directional impulse";
  }

  const components: string[] = [];
  
  // EMA state
  if (emaSlope !== null) {
    if (Math.abs(emaSlope) > 0.7) {
      components.push("strong trend");
    } else if (Math.abs(emaSlope) > 0.3) {
      components.push("trending");
    } else {
      components.push("flat");
    }
  }
  
  // Stoch state
  if (stochRsi !== null) {
    if (direction === "LONG" && stochRsi < 30) {
      components.push("oversold");
    } else if (direction === "SHORT" && stochRsi > 70) {
      components.push("overbought");
    } else if ((direction === "LONG" && stochRsi > 50) || (direction === "SHORT" && stochRsi < 50)) {
      components.push("momentum");
    }
  }
  
  // Volatility state
  if (volatilityLevel !== null) {
    if (volatilityLevel > 70) {
      components.push("high volatility");
    } else if (volatilityLevel < 30) {
      components.push("low volatility");
    }
  }
  
  const stateStr = components.length > 0 ? components.join(", ") : "neutral conditions";
  return `${direction}: ${stateStr}`;
}

// v15.0.0: ALL GATING HELPERS DELETED
// - isCounterTrend DELETED
// - qualifiesForStructuralOverride DELETED
// Execution state is derived ONLY from ignition probability

/**
 * v15.0.0: Canonical market structure classification
 * Single source of truth for market context
 * Determines execution state eligibility and readiness gates
 */
function classifyMarketStructure(params: {
  direction: "LONG" | "SHORT" | "NEUTRAL";
  htf4hTrend: "BULLISH" | "BEARISH" | "NEUTRAL" | null;
  execution15mState: string;
  ignitionProbability: number;
  emaSlope: number | null;
  volatilityLevel: number | null;
  emaAccelerationDelta: number;
  displacement: number;
}): MarketStructureClass {
  const {
    direction,
    htf4hTrend,
    execution15mState,
    ignitionProbability,
    emaSlope,
    volatilityLevel,
    emaAccelerationDelta,
    displacement,
  } = params;

  // v18.1.0: MARKET STRUCTURE CLASSIFICATION - INFORMATIONAL ONLY
  // 
  // Classification is now PURELY CONTEXTUAL and does NOT gate execution.
  // All execution decisions are driven by ignition probability and direction (from momentum).
  // HTF is converted to a bias scalar - it never blocks SNIPER or forces COUNTER_TREND classification.
  //
  // Classification only provides market context for analysis/UI.

  // CHOP: No directional setup
  if (execution15mState === "CHOP" || execution15mState === "COMPRESSING") {
    if ((emaSlope ?? 0) < 2 && (volatilityLevel ?? 50) < 40) {
      return "CHOP";
    }
  }

  // RANGE: HTF neutral, weak expansion
  if (htf4hTrend === "NEUTRAL" || !htf4hTrend) {
    if ((volatilityLevel ?? 0) < 40 && (displacement ?? 0) < 4) {
      return "RANGE";
    }
  }

  // Neutral direction → can't classify (informational only)
  if (direction === "NEUTRAL") {
    return "RANGE";
  }

  // Check macro alignment (for classification context only, NOT gating)
  const isTrendFollowing =
    (direction === "LONG" && htf4hTrend === "BULLISH") ||
    (direction === "SHORT" && htf4hTrend === "BEARISH");

  // TREND_FOLLOWING: Momentum aligned with HTF
  if (isTrendFollowing) {
    return "TREND_FOLLOWING";
  }

  // EARLY_REVERSAL: Contra-HTF with elite conditions
  // v18.1.0: These are classifications, not gates
  // An EARLY_REVERSAL doesn't generate SNIPER - ignition generates SNIPER
  if (!isTrendFollowing && htf4hTrend && htf4hTrend !== "NEUTRAL") {
    const isEliteReversal =
      (displacement ?? 0) >= 6 &&
      (volatilityLevel ?? 0) > 60 &&
      emaAccelerationDelta >= 6 &&
      (execution15mState === "EXPANDING" || execution15mState === "BREAKOUT_READY") &&
      ignitionProbability >= 68;

    if (isEliteReversal) {
      return "EARLY_REVERSAL";
    }
  }

  // TRANSITION: Mixed signals (not a gate, just context)
  if (!isTrendFollowing && (htf4hTrend === "NEUTRAL" || !htf4hTrend)) {
    return "TRANSITION";
  }

  // v18.1.0: COUNTER_TREND IS NOW INFORMATIONAL ONLY
  // It does NOT force BUILDING or suppress SNIPER/CONFIRMED
  // Execution decisions are determined ONLY by ignition probability and direction
  // HTF bias is already applied as a multiplicative scalar in calculateIgnitionProbability
  if (!isTrendFollowing) {
    return "COUNTER_TREND";
  }

  // Default
  return "BUILDING" as unknown as MarketStructureClass;
}

/**
 * v15.0.0 / v9.1.0: Canonical execution state derivation
 * 
 * PURE IGNITION-DRIVEN - NO GATING, NO EXCEPTIONS
 * 
 * Hard bands (NON-NEGOTIABLE):
 * - NONE:             ignition < 20
 * - BUILDING:         ignition 20-59
 * - ACTIVE_SNIPER:    ignition 60-74  <-- SNIPER STARTS AT 60
 * - ACTIVE_CONFIRMED: ignition >= 75
 * 
 * NO marketClass gating
 * NO counter-trend suppression
 * NO conditional overrides
 * NO hidden logic
 * 
 * If ignition >= 60 → SNIPER. Period.
 * If ignition >= 75 → CONFIRMED. Period.
 */
function deriveExecutionState(ignitionProbability: number): SignalState {
  if (ignitionProbability >= 75) return "ACTIVE_CONFIRMED";
  if (ignitionProbability >= 60) return "ACTIVE_SNIPER";
  if (ignitionProbability >= 20) return "BUILDING";
  return "NONE";
}

/**
 * v15.0.0 / v9.1.0: Canonical readiness derivation
 * 
 * Hard bands (match execution state thresholds exactly):
 * - NONE:             0-19
 * - BUILDING:         20-59
 * - ACTIVE_SNIPER:    60-74
 * - ACTIVE_CONFIRMED: 75-100
 * 
 * Readiness = ignition clamped to execution state band
 * No manipulation, no post-processing
 */
function deriveReadiness(
  executionState: SignalState,
  ignitionProbability: number
): number {
  // Readiness directly reflects ignition within the state's band
  switch (executionState) {
    case "NONE":
      return Math.max(0, Math.min(19, Math.floor(ignitionProbability)));

    case "BUILDING":
      return Math.max(20, Math.min(59, Math.floor(ignitionProbability)));

    case "ACTIVE_SNIPER":
      return Math.max(60, Math.min(74, Math.floor(ignitionProbability)));

    case "ACTIVE_CONFIRMED":
      return Math.max(75, Math.min(100, Math.floor(ignitionProbability)));

    default:
      return 0;
  }
}

// v15.0.0: ALL OLD SCORING FUNCTIONS DELETED - use canonical deriveReadiness only

/**
 * v9.2.0: CRITICAL FIX - Multi-timeframe EMA pressure with ATR normalization
 * 
 * Previous: Single emaSlope (-1 to +1) caused all scores to collapse to identical values
 * Solution: Aggregate multi-timeframe slopes, normalize by volatility (ATR), preserve raw values
 */
function calculateEmaPressure(
  emaSlope_5m: number,
  emaSlope_15m: number,
  emaSlope_1h: number,
  emaSlope_4h: number,
  atrValue: number = 1.0
): number {
  // Aggregate multi-timeframe slopes with weights (short-term to long-term)
  const rawPressure =
    (0.1 * emaSlope_5m) +  // 10% - micro setup
    (0.2 * emaSlope_15m) + // 20% - entry timeframe
    (0.3 * emaSlope_1h) +  // 30% - swing structure
    (0.4 * emaSlope_4h);   // 40% - macro trend
  
  // Normalize by ATR to account for volatility and price scale
  // Higher ATR = bigger moves = scale down pressure
  const normalizedPressure = rawPressure / Math.max(0.1, atrValue);
  
  // Return raw pressure (no rounding, no clamping to 0)
  return normalizedPressure;
}

/**
 * Calculate ATR-normalized EMA slopes for all timeframes
 * Simulates realistic multi-timeframe structure
 */
function generateMultiTimeframeEmaSlopes(symbol: string): {
  emaSlope_5m: number;
  emaSlope_15m: number;
  emaSlope_1h: number;
  emaSlope_4h: number;
  atrValue: number;
} {
  // v9.2.0: Use symbol-specific but differentiated base values
  // This ensures BTC, ETH, SOL don't collapse into identical scores
  const symbolHash = symbol.charCodeAt(0) + symbol.charCodeAt(1);
  const baseSlope = -0.5 + (symbolHash % 20) / 10; // Range: -0.5 to +1.5
  
  // BTC: typically lower momentum (major, slower moves)
  // ETH: mid momentum (liquid alt, moderate moves)
  // SOL: higher momentum (volatile alt, fast moves)
  const momentumMultiplier = {
    BTC: 0.6,  // 60% of generated momentum
    ETH: 0.85, // 85% of generated momentum
    SOL: 1.2,  // 120% of generated momentum
  }[symbol] ?? 1.0;
  
  // Multi-timeframe degradation (shorter timeframes have less momentum)
  // This creates realistic structure where higher TF has more trend
  const emaSlope_5m = baseSlope * 0.3 * momentumMultiplier;
  const emaSlope_15m = baseSlope * 0.6 * momentumMultiplier;
  const emaSlope_1h = baseSlope * 0.85 * momentumMultiplier;
  const emaSlope_4h = baseSlope * 1.0 * momentumMultiplier;
  
  // ATR value: normalize price scale
  // BTC: highest price, needs highest ATR
  // SOL: lowest price, needs lowest ATR
  const atrValue = {
    BTC: 800,   // ~0.8% of typical BTC price
    ETH: 45,    // ~0.3% of typical ETH price
    SOL: 2.5,   // ~0.5% of typical SOL price
  }[symbol] ?? 50;
  
  return {
    emaSlope_5m,
    emaSlope_15m,
    emaSlope_1h,
    emaSlope_4h,
    atrValue,
  };
}

/**
 * v9.0.1: Simplified bias derivation - only BULLISH/BEARISH/NEUTRAL
 * Trader should instantly understand direction without complex state labels
 */
function deriveHtfBias(
  htf4hTrend: "BULLISH" | "BEARISH" | "NEUTRAL",
  htf1hAlignment: boolean | null,
  emaSlope: number | null
): SymbolCardState["htfBias"] {
  // Simple: return 4H trend as-is, no intermediate states
  return htf4hTrend;
}

/**
 * v8.6.0: Map 15M execution state to human-readable LTF bias
 */
function deriveLtfBias(
  execution15mState: SymbolCardState["execution15mState"],
  direction: "LONG" | "SHORT" | "NEUTRAL"
): SymbolCardState["ltfBias"] {
  if (direction === "NEUTRAL") return "NEUTRAL";
  switch (execution15mState) {
    case "EXPANDING":    return direction === "LONG" ? "BULLISH" : "BEARISH";
    case "BREAKOUT_READY": return direction === "LONG" ? "BULLISH" : "BEARISH";
    case "COMPRESSING": return "NEUTRAL";
    case "CHOP":        return "NEUTRAL";
    default:            return "NEUTRAL";
  }
}

/**
 * v8.6.0: Derive clean setup status from display score
 * Single source of truth for what stage the setup is in
 */
/**
 * v13.0.0 FIXED: Setup status from display score (3-state system only)
 * - 0-64: BUILDING
 * - 65-84: SNIPER
 * - 85+: CONFIRMED
 * 
 * Removed: NO SETUP, WATCHLIST (signalState handles low-score cases)
 */
function deriveSetupStatus(displayScore: number, signalState: string): SymbolCardState["setupStatus"] {
  // v13.0.0: Only map to 3 states - signalState is source of truth for BUILDING default
  if (displayScore >= 85) return "CONFIRMED";
  if (displayScore >= 65) return "SNIPER";
  return "BUILDING";  // v13.0.0: Default to BUILDING for all scores < 65 (was WATCHLIST 40-54, NO SETUP < 40)
}

function generateCardState(symbol: string, priceData: PriceData): SymbolCardState {
  // Degrade is purely informational
  const degraded = priceData.source !== "kraken_live";

  // SIMULATE MOMENTUM INDICATORS
  // In production, calculate from OHLCV data
  
  // Stochastic RSI: 0-100 scale
  // Simulate: varies by symbol hash for reproducibility
  const symbolHash = symbol.charCodeAt(0) + symbol.charCodeAt(1);
  const stochRsi = 30 + (symbolHash % 40); // Range: 30-70

  // v9.2.0: MULTI-TIMEFRAME EMA SLOPES with ATR normalization
  // This replaces the single emaSlope that was causing score collapse
  const mtfSlopes = generateMultiTimeframeEmaSlopes(symbol);
  const emaPressure = calculateEmaPressure(
    mtfSlopes.emaSlope_5m,
    mtfSlopes.emaSlope_15m,
    mtfSlopes.emaSlope_1h,
    mtfSlopes.emaSlope_4h,
    mtfSlopes.atrValue
  );
  
  // Store 4H slope for HTF structure logic (use the largest timeframe)
  const emaSlope = mtfSlopes.emaSlope_4h;

  // Volatility Level: 0-100 (low = compression, high = expansion)
  const volatilityLevel = 20 + ((symbolHash * 7) % 60); // Range: 20-80

  // SIMULATE HTF CONDITIONS (v7.2.6 FIX #4: PROPER HTF STRUCTURE)
  // 4H TREND: Now based on proper HTF structure logic
  const htf4hMomentum = 40 + (symbolHash % 30); // 40-70 range
  
  // FIX #4: Proper HTF structure (v7.2.6)
  // BULLISH if: price > 21 EMA AND 21 EMA rising AND Stoch > 55
  // BEARISH if: price < 21 EMA AND 21 EMA falling AND Stoch < 45
  // NEUTRAL: only if true sideways structure
  const htf4hTrend: "BULLISH" | "BEARISH" | "NEUTRAL" = 
    // BULLISH structure: EMA rising + Stoch bullish + positive momentum
    (emaSlope > 0 && htf4hMomentum > 55) ? "BULLISH" :
    // BEARISH structure: EMA falling + Stoch bearish + negative momentum
    (emaSlope < 0 && htf4hMomentum < 45) ? "BEARISH" :
    // NEUTRAL: only if truly flat structure
    (Math.abs(emaSlope) <= 0.2 && htf4hMomentum >= 45 && htf4hMomentum <= 55) ? "NEUTRAL" :
    // Default to momentum bias
    htf4hMomentum > 55 ? "BULLISH" :
    htf4hMomentum < 45 ? "BEARISH" :
    "NEUTRAL";

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

  // HARD DIRECTIONAL INFERENCE ENGINE (v7.2.5 FIX #1 & #2)
  // v8.3.0 REFACTOR: Volatility does NOT determine direction, only amplifies confidence
  // Priority: EMA slope > 4H trend > momentum > displacement > Stoch position
  // NEUTRAL becomes rare - classify ANY directional pressure
  
  let direction: "LONG" | "SHORT" | "NEUTRAL" = "NEUTRAL";
  
  // RULE 1: Strong EMA slope overrides 4H trend (primary signal)
  if (emaSlope > 0.25) {
    direction = "LONG"; // EMA expanding bullish
  }
  else if (emaSlope < -0.25) {
    direction = "SHORT"; // EMA expanding bearish
  }
  // RULE 2: 4H trend decides if EMA weak
  else if (htf4hTrend === "BULLISH") {
    direction = "LONG";
  }
  else if (htf4hTrend === "BEARISH") {
    direction = "SHORT";
  }
  // RULE 3: Stoch position if 4H neutral (momentum bias)
  else if (stochRsi > 55) {
    direction = "LONG"; // Stoch in bullish zone
  }
  else if (stochRsi < 45) {
    direction = "SHORT"; // Stoch in bearish zone
  }
  // v8.3.0 FIX: REMOVED volatility > 60 override that caused LONG during dumps
  // Volatility amplifies confidence via displacement quality, NOT direction determination
  // RULE 4: ONLY classify as NEUTRAL if truly dead market
  // EMA flat AND Stoch middle AND low volatility AND no structure
  else if (
    Math.abs(emaSlope) <= 0.1 && 
    stochRsi >= 48 && 
    stochRsi <= 52 && 
    volatilityLevel < 35
  ) {
    direction = "NEUTRAL"; // Dead market - no pressure
  }
  // Default to bullish bias if any ambiguity (risk-on)
  else {
    direction = "LONG";
  }

  const card: SymbolCardState = {
    symbol,
    price: priceData.price,
    source: priceData.source,
    degraded,

    direction,
    mode: "NONE",
    confidence: 0,

    stochRsi,
    emaSlope,
    emaPressure,  // v9.2.0: Multi-timeframe ATR-normalized pressure
    volatilityLevel,
    
    // v7.5.1: Probabilistic 5M ignition with observability
    ignitionProbability: (() => {
      const result = calculateIgnitionProbability(stochRsi, emaSlope, volatilityLevel, direction, htf4hTrend, symbol, htf1hAlignment, execution15mState); // v17.7.0: added symbol for normalization
      // Log ignition breakdown for transparency (v15.0.0: no macro penalty)
      // v17.7.0: Add normalized feature logging
      const profile = getAssetProfile(symbol);
      const normalizedEma = normalizeEmaSlope(emaSlope, symbol);
      const normalizedVol = normalizeVolatilityLevel(volatilityLevel, symbol);
      console.log(
        `[NORMALIZED] ${symbol}: disp=n/a ema=${normalizedEma?.toFixed(2) ?? "—"} vol=${normalizedVol?.toFixed(2) ?? "—"} cont=${profile.continuationBiasWeight.toFixed(2)} imp=${profile.impulseWeight.toFixed(2)}`
      );
      console.log(
        `[IGNITION] ${symbol} ${direction}: prob=${result.probability} [Stoch:${result.breakdown.stochComponent} EMA:${result.breakdown.emaComponent} Vol:${result.breakdown.volatilityComponent} Disp:${result.breakdown.displacementComponent} EMAAccel:${result.breakdown.emaAccelerationDelta} Impulse:+${result.breakdown.impulseContinuationBoost}] | ${result.reason}`
      );
      // Store breakdown for debugging
      if (!this) {
        // During initialization, store separately - will be assigned after
      }
      return result.probability;
    })(),
    
    // v7.5.1: Store breakdown for UI debugging
    scoreBreakdown: (() => {
      const result = calculateIgnitionProbability(stochRsi, emaSlope, volatilityLevel, direction, htf4hTrend, symbol, htf1hAlignment, execution15mState); // v17.7.0: added symbol
      return result.breakdown;
    })(),

    // HTF alignment data
    htf4hTrend,
    htf4hMomentum,
    htf1hAlignment, // v7.2.10: Only for signal logic, not displayed
    htf15mCompression,
    execution15mState, // v7.2.10: NEW - replaces htf1hTrend display

    // Market readiness (v7.2.1)
    marketReadinessState: calculateLiveMarketState(direction, emaSlope, stochRsi, volatilityLevel) as any,
    tradeReadinessScore: null,  // v15.0.0: Set by canonical pipeline in scanSymbols
    
    // Conditional: Only populate if signal exists (SNIPER/CONFIRMED)
    expectedMovePercent: null,
    targetPrices: null,
    riskReward: null,
    
    // v15.0.0: Initialize to BUILDING (default state) - pipeline will derive actual state
    signalState: "BUILDING",
    marketClass: "TREND_FOLLOWING",  // v15.0.0: Will be set by classifyMarketStructure in scanSymbols
    cycleId: `${symbol}-NEUTRAL-B`,  // v12.0.0: Initial cycleId
    lastSignalTime: undefined,

    notes: direction !== "NEUTRAL" ? calculateLiveMarketState(direction, emaSlope, stochRsi, volatilityLevel) : "Awaiting momentum ignition",
    updatedAt: new Date().toISOString(),

    // v8.6.0 UX FIELDS — computed after ignition is known
    // displayScore: calculated below after card is built
    displayScore: 0, // placeholder, replaced immediately below
    setupStatus: "BUILDING",  // v13.0.0: Default to BUILDING (was NO SETUP)
    htfBias: deriveHtfBias(htf4hTrend, htf1hAlignment, emaSlope),
    ltfBias: deriveLtfBias(execution15mState, direction),
    marketQuality: degraded ? "FALLBACK" : "LIVE",
  };

  // v15.0.0: displayScore and setupStatus are set by canonical pipeline in scanSymbols
  // No scoring happens here - just return the card with raw indicators
  return card;
};

/**
 * v17.6.0: DETERMINISTIC TRADE RESOLUTION ENGINE - TP1 FIRST
 * 
 * Resolves active trades when TP1/SL conditions are met.
 * Most real trades close at TP1, not TP2.
 * Completely deterministic - no lifecycle engine, no temporal persistence.
 * 
 * INPUT: card (with targetPrices, riskReward, direction)
 * OUTPUT: card with updated signalState and tradePlan based on price action
 */
export function resolveTradeOutcome(card: SymbolCardState): SymbolCardState {
  // Only resolve if there's an active trade plan
  if (!card.targetPrices || !card.riskReward || card.signalState === "NONE" || card.signalState === "BUILDING") {
    return card; // No trade to resolve
  }

  const { tp1, sl } = card.targetPrices;
  const currentPrice = card.price;
  const direction = card.direction;
  let resolutionOutcome: string | null = null;

  // Check LONG trade resolution at TP1 (v17.6.0: TP1-FIRST)
  if (direction === "LONG") {
    if (currentPrice >= tp1) {
      resolutionOutcome = "TP1_HIT";
      console.log(`[TP1_HIT] ${card.symbol} LONG closed at ${currentPrice}`);
    } else if (currentPrice <= sl) {
      resolutionOutcome = "STOP_LOSS_HIT";
      console.log(`[STOP_LOSS_HIT] ${card.symbol} LONG resolved at ${currentPrice}`);
    }
  }

  // Check SHORT trade resolution at TP1 (v17.6.0: TP1-FIRST)
  if (direction === "SHORT") {
    if (currentPrice <= tp1) {
      resolutionOutcome = "TP1_HIT";
      console.log(`[TP1_HIT] ${card.symbol} SHORT closed at ${currentPrice}`);
    } else if (currentPrice >= sl) {
      resolutionOutcome = "STOP_LOSS_HIT";
      console.log(`[STOP_LOSS_HIT] ${card.symbol} SHORT resolved at ${currentPrice}`);
    }
  }

  // If trade resolved, clear it completely
  if (resolutionOutcome) {
    return {
      ...card,
      signalState: "NONE",
      targetPrices: null,
      riskReward: null,
      direction: "NEUTRAL",
      notes: `Trade closed: ${resolutionOutcome}`,
    };
  }

  // If direction changed from the active trade, invalidate it
  // (This prevents stale trades from persisting across signal reversals)
  // For now, we keep the trade active since direction came from derivedSignal
  
  return card; // No resolution needed
};
