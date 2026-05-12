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

  direction: "LONG" | "SHORT" | "NEUTRAL";
  mode: "SNIPER" | "CONFIRMED" | "NONE";
  confidence: number;
  
  // FIX #1: Unified signal state (v7.2.6), extended for v7.2.8, standardized for v7.2.9
  signalState: SignalState;
  marketClass: MarketStructureClass;  // v15.0.0: Market structure classification (replaces setupClassification)
  cycleId: string;  // v12.0.0: LEAN cycle fingerprint (for Telegram dedupe ONLY, no re-alerts)
  lastSignalTime?: number;

  // Momentum indicators (5M)
  stochRsi: number | null;
  emaSlope: number | null;
  emaPressure: number;  // v9.2.0: Multi-timeframe ATR-normalized pressure (replacement for emaSlope in scoring)
  volatilityLevel: number | null;
  
  // v7.5.0: Probabilistic 5M ignition (replaces binary trigger)
  // Score 0-100 representing likelihood of imminent execution
  ignitionProbability: number;

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
  
  // Conditional: Only populate if mode === "SNIPER" or "CONFIRMED"
  expectedMovePercent: { sniper: { min: number; max: number } } | null;
  targetPrices: { tp1: number; tp2: number; sl: number } | null;
  riskReward: number | null;

  // Trend memory (v7.2.5)
  lastBullishCycle?: number;
  lastBearishCycle?: number;
  trendMemory?: "BULLISH" | "BEARISH";

  notes: string;
  updatedAt: string;

  // v8.6.0 UX FIELDS: Human-readable display layer
  // Derived from engine internals — never raw jargon on primary UI
  displayScore: number;           // Blended setup score (structure 60% + ignition 40%), always 0-100
  setupStatus: "BUILDING" | "SNIPER" | "CONFIRMED";  // v13.0.0: Removed WATCHLIST and NO SETUP (signalState handles it)
  htfBias: "BULLISH" | "BEARISH" | "NEUTRAL";
  ltfBias: "BULLISH" | "BEARISH" | "NEUTRAL";
  marketQuality: "LIVE" | "FALLBACK"; // Whether price is from Kraken live or degraded source

  // v7.5.1: OBSERVABILITY LAYER - Why signals didn't fire
  // Single string explaining block reason for non-alert states
  blockReason?: string;
  
  // Score breakdown for transparency
  scoreBreakdown?: {
    stochComponent: number;
    emaComponent: number;
    volatilityComponent: number;
    displacementComponent: number; // v8.0.2: directional commitment quality modifier
    emaAccelerationDelta?: number; // v8.1.0: reversal acceleration transition detection
    impulseContinuationBoost?: number; // v8.1.0: expansion continuation confidence assist
    macroPenalty?: number; // v8.3.0: penalty for contra-directional signals (-8)
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
  // HTF Alignment breakdown (v7.1.1)
  htf: {
    trend4h: "BULLISH" | "BEARISH";
    alignment1h: boolean;
    compression15m: boolean;
    trigger5m: string;
  };
};

/**
 * Generate symbol card states + setups from market snapshot
 * PURE FUNCTION - momentum-based detection
 */
export async function generateSetups(market: Record<string, PriceData>): Promise<{ cards: SymbolCardState[]; setups: Setup[] }> {
  const cards: SymbolCardState[] = [];
  const setups: Setup[] = [];

  for (const [symbol, priceData] of Object.entries(market)) {
    if (priceData.price === 0) {
      console.log(`[SCAN] ${symbol} no data`);
      continue;
    }

    // Generate card state for this symbol
    const card = generateCardState(symbol, priceData);
    console.log(`[DEBUG_CARD_INITIAL] ${symbol}: signalState=${card.signalState}, direction=${card.direction}`);
    
    // v8.7.0: Assign setup classification (macro-aware)
    if (isCounterTrend(card.direction, card.htf4hTrend)) {
      card.setupClassification = "COUNTER_TREND";
    } else if (card.direction !== "NEUTRAL" && card.htf4hTrend && card.htf4hTrend !== "NEUTRAL") {
      card.setupClassification = "TREND_FOLLOWING";
    } else {
      card.setupClassification = "TREND_FOLLOWING"; // Default
    }
    
    cards.push(card);

    // Score using NEW momentum-based system
    const structureScore = calculateMomentumScore(card);
    
    // v8.5.0 REFINEMENT: Blend structure score with ignition probability
    // This eliminates psychological confusion (high score + low ignition = confusing)
    // Display score now represents "actual readiness to trade"
    // v8.7.0: Pass macro-aware parameters for counter-trend cap logic
    const score = calculateExecutionReadinessScore(
      structureScore,
      card.ignitionProbability,
      card.direction,
      card.htf4hTrend,
      undefined, // displacement - not calculated yet
      card.volatilityLevel,
      undefined, // emaAccelerationDelta - not passed in here
      card.execution15mState
    );
    
    console.log(`[SCAN] ${symbol} ignition=${card.ignitionProbability} direction=${card.direction} stoch=${card.stochRsi?.toFixed(1)} emaSlope=${card.emaSlope?.toFixed(2)} htf=${card.htf4hTrend}`);

    // v15.0.0: CANONICAL PIPELINE - NO HIDDEN GATING, NO MACRO PENALTIES, NO SCORE CAPS
    // Single deterministic path: ignition → executionState → readiness
    
    // Calculate market class first (for logging/UI only, doesn't gate execution)
    card.marketClass = classifyMarketStructure({
      direction: card.direction,
      htf4hTrend: card.htf4hTrend,
      execution15mState: card.execution15mState,
      ignitionProbability: card.ignitionProbability,
      emaSlope: card.emaSlope,
      volatilityLevel: card.volatilityLevel,
      emaAccelerationDelta: 0, // TODO: calculate real EMA acceleration
      displacement: 0, // TODO: calculate real displacement
    });

    console.log(`[MARKET_CLASS] ${symbol}: ${card.marketClass}`);
    
    // v15.0.0: Derive execution state ONLY from ignition probability (no gating logic)
    card.signalState = deriveExecutionState(card.ignitionProbability);
    
    // v15.0.0: Derive readiness per execution state bands
    const readiness = deriveReadiness(card.signalState, card.ignitionProbability);
    card.displayScore = readiness;
    
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
    
    // v15.0.0: Generate setups ONLY for executable states
    // ACTIVE_CONFIRMED and ACTIVE_SNIPER only
    if (card.signalState === "ACTIVE_CONFIRMED" || card.signalState === "ACTIVE_SNIPER") {
      if (card.direction !== "NEUTRAL") {
        card.confidence = Math.min(readiness, 99);
        card.lastSignalTime = Date.now();
        card.notes = `${card.signalState} ${card.direction} - ${card.marketClass}`;
        
        // Populate trade targets
        const targets = calculateTradeTargets(card.price, card.volatilityLevel ?? 50, card.direction);
        card.expectedMovePercent = targets.expectedMovePercent;
        card.targetPrices = targets.targetPrices;
        card.riskReward = targets.riskReward;
        card.tradeReadinessScore = readiness;
        
        setups.push({
          symbol,
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
        console.log(`[SETUP_GENERATED] ${symbol} ${card.signalState} ${card.direction} | readiness=${readiness} marketClass=${card.marketClass}`);
      }
    } else {
      // No executable setup - explain why
      let blockReason = "No executable setup";
      if (card.direction === "NEUTRAL") {
        blockReason = "No directional bias";
      } else if (card.signalState === "BUILDING") {
        blockReason = `BUILDING - ignition ${card.ignitionProbability}% (need 60% for SNIPER)`;
      } else if (card.signalState === "NONE") {
        blockReason = `NONE - ignition ${card.ignitionProbability}% (need 20% for BUILDING)`;
      }
      card.blockReason = blockReason;
      console.log(`[NO_SETUP] ${symbol} ${card.signalState} | ${blockReason}`);
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
function calculateMomentumScore(card: SymbolCardState): number {
  // BASE SCORE - foundation for all signals
  let score = 30;

  // EVENT MULTIPLIERS (not additive)
  let multiplier = 1.0;

  // EVENT 1: Stoch RSI cross detected
  // Range: 0-100, active zone: 20-80
  const stochRsiActive = card.stochRsi > 20 && card.stochRsi < 80;
  if (stochRsiActive) {
    multiplier *= 1.25; // Stoch RSI event multiplier
  }

  // EVENT 2: EMA 8/21 flip detected
  // Strong slope indicates alignment
  const emaFlipped = Math.abs(card.emaSlope) > 0.5;
  if (emaFlipped) {
    multiplier *= 1.35; // EMA flip multiplier (highest impact)
  }

  // EVENT 3: Volatility compression present
  // BB squeeze or ATR contraction
  const volatilityCompression = card.volatilityLevel < 30;
  if (volatilityCompression) {
    multiplier *= 1.20; // Compression multiplier
  }

  // EVENT 4: Impulse candle (direction conviction)
  if (card.direction !== "NEUTRAL") {
    multiplier *= 1.30; // Impulse multiplier
  }

  // EVENT 5: 4H trend alignment
  // Trend bias from higher timeframe
  const trend4HAligned = card.stochRsi > 50; // Simplified: would use actual 4H data
  if (trend4HAligned) {
    multiplier *= 1.40; // HTF trend multiplier (critical for CONFIRMED)
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
 * v7.5.2: Calculate ignition probability (probabilistic 5M signal)
 * Returns confidence score 0-100 for imminent short-term execution
 */
function calculateIgnitionProbability(
  stochRsi: number | null,
  emaSlope: number | null,
  volatilityLevel: number | null,
  direction: "LONG" | "SHORT" | "NEUTRAL",
  htf4hTrend: "BULLISH" | "BEARISH" | "NEUTRAL",
  htf1hAlignment: boolean = true, // v7.5.2: 1H alignment as probabilistic modifier (default true)
  execution15mState: string | null = null // v8.0.2: for displacement quality
): IgnitionResult {
  let stochComponent = 0;
  let emaComponent = 0;
  let volatilityComponent = 0;
  let volumeComponent = 0;
  const reasons: string[] = [];

  // COMPONENT 1: Stochastic momentum pressure (0-30 points)
  if (stochRsi !== null) {
    if (direction === "LONG") {
      if (stochRsi < 20) {
        stochComponent = 30;
        reasons.push("Stoch deep oversold");
      } else if (stochRsi < 35) {
        stochComponent = 20;
        reasons.push("Stoch near oversold");
      } else if (stochRsi < 50) {
        stochComponent = 10;
        reasons.push("Stoch building");
      } else if (stochRsi < 70) {
        stochComponent = 5;
        reasons.push("Stoch mid-range");
      } else {
        reasons.push("Stoch overbought, fading");
      }
    } else if (direction === "SHORT") {
      if (stochRsi > 80) {
        stochComponent = 30;
        reasons.push("Stoch deep overbought");
      } else if (stochRsi > 65) {
        stochComponent = 20;
        reasons.push("Stoch near overbought");
      } else if (stochRsi > 50) {
        stochComponent = 10;
        reasons.push("Stoch building");
      } else if (stochRsi > 30) {
        stochComponent = 5;
        reasons.push("Stoch mid-range");
      } else {
        reasons.push("Stoch oversold, fading");
      }
    }
  }

  // COMPONENT 2: EMA acceleration (0-35 points) v7.5.4: increased from 30 to capture early trend ignition
  // v8.1.0 ENHANCEMENT: Early acceleration detection for transitions
  let emaAccelerationDelta = 0;
  if (emaSlope !== null) {
    const absMagnitude = Math.abs(emaSlope);
    if (direction === "LONG" && emaSlope > 0) {
      if (absMagnitude > 0.8) {
        emaComponent = 35;
        reasons.push("EMA strong acceleration up");
      } else if (absMagnitude > 0.5) {
        emaComponent = 25;
        reasons.push("EMA good acceleration up");
      } else if (absMagnitude > 0.3) {
        emaComponent = 17;
        reasons.push("EMA moderate acceleration up");
      } else if (absMagnitude > 0.15) {
        emaComponent = 10;
        reasons.push("EMA slight acceleration up");
      } else if (absMagnitude > 0.05) {
        emaComponent = 4;
        reasons.push("EMA subtle acceleration up");
      } else {
        reasons.push("EMA flat, no acceleration");
      }
    } else if (direction === "SHORT" && emaSlope < 0) {
      if (absMagnitude > 0.8) {
        emaComponent = 35;
        reasons.push("EMA strong acceleration down");
      } else if (absMagnitude > 0.5) {
        emaComponent = 25;
        reasons.push("EMA good acceleration down");
      } else if (absMagnitude > 0.3) {
        emaComponent = 17;
        reasons.push("EMA moderate acceleration down");
      } else if (absMagnitude > 0.15) {
        emaComponent = 10;
        reasons.push("EMA slight acceleration down");
      } else if (absMagnitude > 0.05) {
        emaComponent = 4;
        reasons.push("EMA subtle acceleration down");
      } else {
        reasons.push("EMA flat, no acceleration");
      }
    } else {
      // v8.1.0 FIX: Early acceleration detection for REVERSALS
      // If slope is improving toward direction (even if still opposing), award partial credit
      const absMagnitude = Math.abs(emaSlope);
      const isImproving = (direction === "LONG" && emaSlope > -0.2 && emaSlope < 0) ||
                          (direction === "SHORT" && emaSlope < 0.2 && emaSlope > 0);
      
      if (isImproving && absMagnitude < 0.15 && volatilityLevel !== null && volatilityLevel > 50) {
        // Early acceleration transition: slope improving toward direction + expanding vol
        emaAccelerationDelta = 8;
        emaComponent = 8;
        reasons.push(`EMA early accel transition (${emaSlope.toFixed(2)})`);
      } else if (isImproving && volatilityLevel !== null && volatilityLevel > 60) {
        // Very early reversal but strong vol support
        emaAccelerationDelta = 6;
        emaComponent = 6;
        reasons.push(`EMA reversal forming (${emaSlope.toFixed(2)}) + strong vol`);
      } else {
        reasons.push(`EMA slope diverges from ${direction} direction`);
      }
    }
  }

  // COMPONENT 3: Micro volatility expansion (0-35 points) v7.5.4: increased from 25 to capture impulse expansion
  if (volatilityLevel !== null) {
    if (volatilityLevel > 60) {
      volatilityComponent = 35;
      reasons.push("Volatility high expansion");
    } else if (volatilityLevel > 50) {
      volatilityComponent = 25;
      reasons.push("Volatility good expansion");
    } else if (volatilityLevel > 40) {
      volatilityComponent = 15;
      reasons.push("Volatility moderate expansion");
    } else if (volatilityLevel > 30) {
      volatilityComponent = 8;
      reasons.push("Volatility slight expansion");
    } else {
      reasons.push("Volatility compressing, not expanding");
    }
  }

  // COMPONENT 4: Volume impulse (0-15 points)
  if (volatilityLevel !== null && volatilityLevel > 55) {
    volumeComponent = 5;
    reasons.push("Volume impulse-like");
  }

  // v8.0.0: Apply 1H alignment modifier - fine-tuned for early impulse capture
  // Aligned: +6 (boosts early confidence, but not overweighting)
  // Divergent: -4 (penalizes counter-structure asymmetrically, but still allows marginal setups)
  // Rationale: Reduces over-suppression of first-wave momentum while SNIPER stays disciplined
  let probabilityBase = stochComponent + emaComponent + volatilityComponent + volumeComponent;
  let htfModifier = 0;
  
  if (htf1hAlignment) {
    htfModifier = 6;
    reasons.push("1H aligned");
  } else {
    htfModifier = -4;
    reasons.push("1H divergent (-4)");
  }
  
  // v8.0.2: Apply displacement quality modifier (soft confidence adjuster)
  // Measures directional commitment strength, -8 to +8
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
  
  // v8.1.0 ENHANCEMENT: Impulse continuation boost
  // Problem: ETH repeatedly stalls at 62-64 despite good displacement + expanding vol
  // Solution: Award micro boost (+3 max) when expansion has strong quality indicators
  // This is NOT a new gate - just a confidence assist for genuine impulse continuation
  let impulseContinuationBoost = 0;
  if (displacementModifier >= 4 && volatilityLevel !== null && volatilityLevel > 55 && 
      (execution15mState === "EXPANDING" || execution15mState === "BREAKOUT_READY")) {
    // Displacement strong + volatility expanding + structure transitioning = genuine impulse
    impulseContinuationBoost = 3;
    reasons.push("Impulse continuation quality (+3)");
  }
  
  
  // v8.4.0 CRITICAL: Apply macro penalty for contra-directional signals
  // This MUST happen before final probability calculation
  const macroPenalty = calculateMacroPenalty(direction, htf4hTrend);
  if (macroPenalty !== 0) {
    reasons.push(`MACRO PENALTY: ${direction} vs 4H ${htf4hTrend} (${macroPenalty})`);
  }
  
  const probability = Math.min(Math.max(probabilityBase + htfModifier + displacementModifier + impulseContinuationBoost + macroPenalty, 0), 100); // Clamp 0-100
  
  return {
    probability,
    breakdown: { 
      stochComponent, 
      emaComponent, 
      volatilityComponent, 
      volumeComponent, 
      displacementComponent: displacementModifier,
      emaAccelerationDelta,  // v8.1.0: Track reversal acceleration for observability
      impulseContinuationBoost,  // v8.1.0: Track continuation boost for observability
      macroPenalty  // v8.4.0: Now correctly calculated and tracked
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
 * Single source of truth for directional vs macro structure checks
 * Eliminates duplicate/mismatched directional logic throughout codebase
 */
function isContraMacroStructure(direction: "LONG" | "SHORT" | "NEUTRAL", htf4hTrend: "BULLISH" | "BEARISH" | "NEUTRAL"): boolean {
  if (direction === "NEUTRAL" || htf4hTrend === "NEUTRAL") {
    return false;
  }
  
  return (direction === "LONG" && htf4hTrend === "BEARISH") ||
         (direction === "SHORT" && htf4hTrend === "BULLISH");
}

/**
 * v8.4.0 CALCULATE MACRO PENALTY
 * Returns penalty amount (-8 for contra, 0 for aligned)
 * This is the canonical macro penalty calculation
 */
function calculateMacroPenalty(direction: "LONG" | "SHORT" | "NEUTRAL", htf4hTrend: "BULLISH" | "BEARISH" | "NEUTRAL"): number {
  if (isContraMacroStructure(direction, htf4hTrend)) {
    return -8; // Penalty for trading against macro structure
  }
  return 0; // No penalty for aligned or neutral
}


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

/**
 * v8.0.2 HOTFIX: Calculate trade readiness score (0-100)
 * Composite score for UI progress bar and signal entry timing
 * FIX #4 (v7.2.4): Uses live market state instead of old phases
 */
/**
 * v9.2.0: FIXED Trade Readiness Score
 * 
 * Old formula: Simple sum of components (caused equal scores for different assets)
 * New formula: Weighted blend with emaPressure replacing binary EMA check
 * 
 * Result: BTC (~35-45%), ETH (~45-60%), SOL (~65-80%)
 */
/**
 * v8.7.0: Canonical helper to detect counter-trend setups
 * Returns true when direction opposes 4H HTF macro trend
 */
function isCounterTrend(
  direction: "LONG" | "SHORT" | "NEUTRAL",
  htf4hTrend: "BULLISH" | "BEARISH" | "NEUTRAL" | null
): boolean {
  if (direction === "NEUTRAL" || !htf4hTrend || htf4hTrend === "NEUTRAL") {
    return false;
  }
  return (direction === "LONG" && htf4hTrend === "BEARISH") ||
         (direction === "SHORT" && htf4hTrend === "BULLISH");
}

/**
 * v8.7.0: Check if counter-trend setup qualifies for structural override
 * ONLY allow higher scores IF ALL conditions met:
 * - displacement >= 6 (strong move away from macro)
 * - volatility > 60 (expansion confirming move)
 * - emaAccelerationDelta >= 6 (momentum building)
 * - 15M state = EXPANDING or BREAKOUT_READY
 * - ignitionProbability >= 72 AFTER penalties
 */
function qualifiesForStructuralOverride(
  displacement: number | null,
  volatilityLevel: number | null,
  emaAccelerationDelta: number | null,
  execution15mState: string,
  ignitionProbability: number
): boolean {
  return (
    (displacement ?? 0) >= 6 &&
    (volatilityLevel ?? 0) > 60 &&
    (emaAccelerationDelta ?? 0) >= 6 &&
    (execution15mState === "EXPANDING" || execution15mState === "BREAKOUT_READY") &&
    ignitionProbability >= 72
  );
}

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

  // Neutral direction → can't classify
  if (direction === "NEUTRAL") {
    return "RANGE";
  }

  // Check macro alignment
  const isTrendFollowing =
    (direction === "LONG" && htf4hTrend === "BULLISH") ||
    (direction === "SHORT" && htf4hTrend === "BEARISH");

  // TREND_FOLLOWING
  if (isTrendFollowing) {
    return "TREND_FOLLOWING";
  }

  // EARLY_REVERSAL: Contra-HTF with elite conditions
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

  // TRANSITION: Mixed signals
  if (!isTrendFollowing && (htf4hTrend === "NEUTRAL" || !htf4hTrend)) {
    return "TRANSITION";
  }

  // COUNTER_TREND: Contra-HTF without elite conditions
  if (!isTrendFollowing) {
    return "COUNTER_TREND";
  }

  // Default
  return "BUILDING" as unknown as MarketStructureClass;
}

/**
 * v15.0.0: Canonical execution state derivation
 * Single source of truth for execution readiness
 * Purely from market structure class and ignition probability
 * No secondary validators, no override functions, no macro gates
 */
function deriveExecutionState(
  marketClass: MarketStructureClass,
  ignitionProbability: number
): SignalState {
  switch (marketClass) {
    case "TREND_FOLLOWING":
      if (ignitionProbability >= 75) return "ACTIVE_CONFIRMED";
      if (ignitionProbability >= 65) return "ACTIVE_SNIPER";
      return "BUILDING";

    case "EARLY_REVERSAL":
      if (ignitionProbability >= 82) return "ACTIVE_SNIPER"; // EARLY_REVERSAL max is ACTIVE_SNIPER (never CONFIRMED)
      if (ignitionProbability >= 68) return "ACTIVE_SNIPER";
      return "BUILDING";

    case "COUNTER_TREND":
      // Counter-trend without elite conditions: max BUILDING
      return "BUILDING";

    case "TRANSITION":
      // Incomplete reversal: max BUILDING
      return "BUILDING";

    case "RANGE":
      // Rotational: max BUILDING
      return "BUILDING";

    case "CHOP":
      // No setup: NONE
      return "NONE";

    default:
      return "BUILDING";
  }
}

/**
 * v15.0.0: Canonical readiness derivation
 * Enforced hard bands per execution state
 * Mismatch warnings emitted if readiness contradicts executionState
 */
function deriveReadiness(
  executionState: SignalState,
  ignitionProbability: number
): number {
  let readiness: number;

  switch (executionState) {
    case "NONE":
      readiness = Math.max(0, Math.min(20, Math.floor(ignitionProbability / 5)));
      break;

    case "BUILDING":
      readiness = Math.max(20, Math.min(64, Math.floor(ignitionProbability * 0.8)));
      break;

    case "ACTIVE_SNIPER":
      readiness = Math.max(65, Math.min(74, Math.floor(ignitionProbability * 0.9)));
      break;

    case "ACTIVE_CONFIRMED":
      readiness = Math.max(75, Math.min(100, Math.floor(ignitionProbability * 0.95)));
      break;

    default:
      readiness = 0;
  }

  return Math.round(readiness);
}

function calculateTradeReadinessScore(
  signalState: SignalState,
  direction: "LONG" | "SHORT" | "NEUTRAL",
  htf4hTrend: "BULLISH" | "BEARISH" | "NEUTRAL" | null,
  htf1hAlignment: boolean,
  emaPressure: number,  // v9.2.0: NEW - raw ATR-normalized pressure (no clamping)
  stochRsi: number | null,
  volatilityLevel: number | null,
  execution15mState?: string,  // v8.7.0: For structural override checks
  ignitionProbability?: number, // v8.7.0: For structural override checks
  emaAccelerationDelta?: number,  // v8.7.0: For structural override checks
  displacement?: number  // v8.7.0: For structural override checks
): number {
  // Base score for having direction
  let score = 0;
  
  if (direction === "NEUTRAL") {
    return 0; // No direction = no readiness
  }
  
  // v8.7.0: Check macro structure
  const counterTrend = isCounterTrend(direction, htf4hTrend);
  const structuralOverride = counterTrend && qualifiesForStructuralOverride(
    displacement ?? null,
    volatilityLevel,
    emaAccelerationDelta ?? null,
    execution15mState ?? "CHOP",
    ignitionProbability ?? 0
  );
  
  // 40 points: Directional confirmation + setup state
  if (signalState === "CONFIRMED") {
    score += 40;
  } else if (signalState === "SNIPER") {
    score += 35;
  } else if (signalState === "BUILDING") {
    score += 20;
  } else {
    score += 10; // BUILDING bonus (v13.0.0: was WATCHLIST, now BUILDING covers low-score range)
  }
  
  // 25 points: EMA pressure (multi-timeframe aggregated)
  // v9.2.0: This is where we see the differences between BTC/ETH/SOL
  // emaPressure is raw, not clamped, not rounded - captures true momentum difference
  const emaPressureContribution = Math.max(0, Math.min(25, 12.5 + emaPressure * 10));
  score += emaPressureContribution;
  
  // 20 points: Stoch momentum
  if (stochRsi !== null) {
    if (direction === "LONG" && stochRsi < 30) {
      score += 20; // Oversold on LONG = high readiness
    } else if (direction === "SHORT" && stochRsi > 70) {
      score += 20; // Overbought on SHORT = high readiness
    } else if ((direction === "LONG" && stochRsi > 50) || (direction === "SHORT" && stochRsi < 50)) {
      score += 10; // Momentum in direction
    }
  }
  
  // 15 points: Volatility expansion
  if (volatilityLevel !== null) {
    if (volatilityLevel > 60) {
      score += 15; // Strong expansion
    } else if (volatilityLevel > 40) {
      score += 8; // Moderate expansion
    }
  }
  
  // 15 points: HTF alignment bonus (v8.7.0: reduced for counter-trend without override)
  if (htf4hTrend !== "NEUTRAL" && htf4hTrend !== null) {
    const directionAligned = (direction === "LONG" && htf4hTrend === "BULLISH") ||
                              (direction === "SHORT" && htf4hTrend === "BEARISH");
    if (directionAligned) {
      score += 15; // Full HTF alignment (trend-following bonus)
    } else if (counterTrend && structuralOverride) {
      score += 10; // Partial credit for structural override (reversal unlocked)
      console.log(`[STRUCTURAL_REVERSAL] Counter-trend setup qualifies for override`);
    }
    // No bonus for counter-trend without override
  }
  
  // 5 points: 1H alignment bonus (micro)
  if (htf1hAlignment) {
    score += 5;
  }
  
  // v8.7.0: Apply macro-aware readiness cap for counter-trend setups
  const rawScore = Math.max(0, Math.min(100, score));
  
  if (counterTrend && !structuralOverride) {
    const cappedScore = Math.min(rawScore, 45); // Counter-trend cap: 45% readiness max
    if (cappedScore < rawScore) {
      console.log(`[MACRO_CAP] Counter-trend readiness capped at 45% (was ${rawScore.toFixed(1)}%)`);
    }
    return cappedScore;
  }
  
  return rawScore;
}

/**
 * v8.5.0 REFINEMENT: Calculate display score that reflects execution readiness
 * Blends structural quality with ignition probability to avoid psychological confusion
 * 
 * Problem: High structure score + low ignition = confusing (looks ready but isn't)
 * Solution: Weight ignition into final score so display matches user expectations
 * 
 * v8.9.0 SIMPLIFIED FORMULA: displayScore = (structureScore * 0.8) + (ignitionProbability * 0.2)
 * - 80% structural quality (this is what matters for BTC/ETH)
 * - 20% execution probability (informational, not suppressant)
 * 
 * Rationale: BTC/ETH move slower, structure > ignition. Solves BTC/ETH under-triggering.
 */
/**
 * v9.0.1: FINAL SIMPLIFICATION - displayScore = structureScore only
 * Ignition is internal/debug only, never influences execution decisions
 * v8.7.0: Add macro-aware cap - counter-trend execution capped at 55
 */
function calculateExecutionReadinessScore(
  structureScore: number,
  ignitionProbability: number,
  direction?: "LONG" | "SHORT" | "NEUTRAL",
  htf4hTrend?: "BULLISH" | "BEARISH" | "NEUTRAL" | null,
  displacement?: number | null,
  volatilityLevel?: number | null,
  emaAccelerationDelta?: number | null,
  execution15mState?: string
): number {
  let score = structureScore;
  
  // v8.7.0: Apply macro-aware execution cap for counter-trend setups
  if (direction && htf4hTrend && isCounterTrend(direction, htf4hTrend)) {
    const structuralOverride = qualifiesForStructuralOverride(
      displacement ?? null,
      volatilityLevel,
      emaAccelerationDelta ?? null,
      execution15mState ?? "CHOP",
      ignitionProbability
    );
    
    if (!structuralOverride) {
      const cappedScore = Math.min(score, 55); // Counter-trend execution cap: 55
      if (cappedScore < score) {
        console.log(`[MACRO_CAP] Counter-trend execution capped at 55 (was ${score})`);
      }
      score = cappedScore;
    }
  }
  
  return score;
}

/**
 * Calculate momentum score using event-driven multiplier model
 * v7.1 STABILISATION FIX
 */
/**
 * v8.6.0: Per-symbol SNIPER ignition thresholds
 * BTC/ETH naturally move slower than alts - lower threshold required
 */
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
      const result = calculateIgnitionProbability(stochRsi, emaSlope, volatilityLevel, direction, htf4hTrend, htf1hAlignment, execution15mState); // v8.4.0: added htf4hTrend for macro penalty
      // Log ignition breakdown for transparency
      console.log(
        `[IGNITION] ${symbol} ${direction}: prob=${result.probability} [Stoch:${result.breakdown.stochComponent} EMA:${result.breakdown.emaComponent} Vol:${result.breakdown.volatilityComponent} Disp:${result.breakdown.displacementComponent} EMAAccel:${result.breakdown.emaAccelerationDelta} Impulse:+${result.breakdown.impulseContinuationBoost} Macro:${result.breakdown.macroPenalty}] | ${result.reason}`
      );
      // Store breakdown for debugging
      if (!this) {
        // During initialization, store separately - will be assigned after
      }
      return result.probability;
    })(),
    
    // v7.5.1: Store breakdown for UI debugging
    scoreBreakdown: (() => {
      const result = calculateIgnitionProbability(stochRsi, emaSlope, volatilityLevel, direction, htf4hTrend, htf1hAlignment, execution15mState); // v8.4.0: added htf4hTrend
      return result.breakdown;
    })(),

    // HTF alignment data
    htf4hTrend,
    htf4hMomentum,
    htf1hAlignment, // v7.2.10: Only for signal logic, not displayed
    htf15mCompression,
    execution15mState, // v7.2.10: NEW - replaces htf1hTrend display

    // Market readiness (v7.2.1)
    // Market readiness (v7.2.4 FIX #4: Use live market state instead of old phases)
    marketReadinessState: calculateLiveMarketState(direction, emaSlope, stochRsi, volatilityLevel) as any,
    tradeReadinessScore: calculateTradeReadinessScore("NONE", direction, htf4hTrend, htf1hAlignment, emaPressure, stochRsi, volatilityLevel),
    
    // Conditional: Only populate if signal exists (SNIPER/CONFIRMED)
    expectedMovePercent: null,
    targetPrices: null,
    riskReward: null,
    
    // FIX #1: v11.0.0 - Initialize to BUILDING (default state)
    signalState: "BUILDING",
    setupClassification: "TREND_FOLLOWING",  // v8.7.0: Will be updated in scanSymbols loop
    cycleId: `${symbol}-NEUTRAL-B`,  // v12.0.0: Initial cycleId (will be updated in promotion logic)
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

  // v8.6.0: Compute displayScore now that ignition is available
  // Never returns 0 unless engine truly has no data
  const _structureScore = calculateMomentumScore(card);
  card.displayScore = calculateExecutionReadinessScore(_structureScore, card.ignitionProbability);
  // v13.0.0 FIX: setupStatus MUST match signalState (no separate derivation)
  // setupStatus is UI field that mirrors signalState - they represent the same 3-state system
  card.setupStatus = card.signalState as SymbolCardState["setupStatus"];

  return card;
}
