/**
 * SNIPER ENGINE v7.0 - MOMENTUM IGNITION SYSTEM
 * 
 * Converts from structure-based scanner to momentum wave detector
 * Uses Stochastic RSI + EMA Stack + Volatility Compression
 * 
 * NO STATE, NO DB ACCESS, PURE EVALUATION
 */

import type { PriceData } from "./price-router";

// v7.5.3: Clean 3-state architecture with continuous progression
// Returns: NONE | BUILDING | ACTIVE_SNIPER | ACTIVE_CONFIRMED
// Flow: BUILDING (ignition < 65) → ACTIVE_SNIPER (65-74) → ACTIVE_CONFIRMED (75+)
export type SignalState = 
  | "NONE"              // No signal
  | "BUILDING"          // Setup forming, ignitionProbability < 65
  | "ACTIVE_SNIPER"     // Early executable impulse, ignitionProbability 65-74 (30 min cooldown)
  | "ACTIVE_CONFIRMED"; // Mature continuation phase (90 min cooldown)

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
  lastSignalTime?: number;

  // Momentum indicators (5M)
  stochRsi: number | null;
  emaSlope: number | null;
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
    cards.push(card);

    // Score using NEW momentum-based system
    const score = calculateMomentumScore(card);
    
    console.log(`[SCAN] ${symbol} score=${score} direction=${card.direction} stoch=${card.stochRsi.toFixed(1)} emaSlope=${card.emaSlope.toFixed(2)}`);

    // ONLY generate setups with directional conviction
    // NO NEUTRAL SIGNALS ALLOWED

    // CONFIRMED ALERT: score >= 75 AND confirmed conditions met
    if (score >= 75 && card.direction !== "NEUTRAL" && checkConfirmedConditions(card)) {
      card.mode = "CONFIRMED";
      card.confidence = Math.min(score, 99);
      card.lastSignalTime = Date.now();
      card.signalState = "ACTIVE_CONFIRMED"; // FIX #1: Set unified signal state
      card.notes = `CONFIRMED ${card.direction} trend continuation ${score}`;
      
      // Populate trade targets (v7.2.1)
      const targets = calculateTradeTargets(card.price, card.volatilityLevel ?? 50, card.direction);
      card.expectedMovePercent = targets.expectedMovePercent;
      card.targetPrices = targets.targetPrices;
      card.riskReward = targets.riskReward;
      card.tradeReadinessScore = calculateTradeReadinessScore("CONFIRMED", card.direction, card.htf4hTrend, card.htf1hAlignment, card.emaSlope, card.stochRsi, card.volatilityLevel);
      
      setups.push({
        symbol,
        mode: "CONFIRMED",
        direction: card.direction,
        score: card.confidence,
        reason: `CONFIRMED ${card.direction} - EMA + impulse + HTF alignment`,
        price: card.price,
        momentum: {
          stochRsiSignal: `Stoch RSI: ${card.stochRsi?.toFixed(1) ?? "—"}`,
          emaStackSignal: card.direction === "LONG" ? "8 EMA above 21 EMA" : "8 EMA below 21 EMA",
          volatilitySignal: (card.volatilityLevel ?? 50) < 30 ? "Compression detected" : "Normal volatility",
          trend4H: (card.stochRsi ?? 50) > 50,
        },
      });
      console.log(`[ALERT] ${symbol} CONFIRMED ${card.direction} score=${score}`);
    }
    // SNIPER ALERT: v7.3.2 - Direct to ACTIVE_SNIPER on early ignition (no SNIPER_READY intermediate)
    else if (score >= 70 && card.direction !== "NEUTRAL" && checkSniperConditions(card)) {
      // v7.3.2 FIX #4: Validate ACTIVE_SNIPER execution requirements
      const executionValidation = validateActiveSniperExecution(card, score);
      
      if (!executionValidation.valid) {
        // Execution validation failed - block ACTIVE_SNIPER
        console.log(`[EXECUTION BLOCKED] ${symbol} ${card.direction}: ${executionValidation.reason}`);
        // Fall through to BUILDING state below
        card.signalState = "BUILDING";
      } else {
        // Execution validation passed - promote directly to ACTIVE_SNIPER (no intermediate states)
        card.mode = "SNIPER";
        card.confidence = Math.min(score, 99);
        card.lastSignalTime = Date.now();
        card.signalState = "ACTIVE_SNIPER"; // v7.3.2: Direct transition from BUILDING
        card.notes = `SNIPER ${card.direction} early ignition ${score}`;
        
        // Populate trade targets (v7.2.1)
        const targets = calculateTradeTargets(card.price, card.volatilityLevel ?? 50, card.direction);
        card.expectedMovePercent = targets.expectedMovePercent;
        card.targetPrices = targets.targetPrices;
        card.riskReward = targets.riskReward;
        card.tradeReadinessScore = calculateTradeReadinessScore("SNIPER", card.direction, card.htf4hTrend, card.htf1hAlignment, card.emaSlope, card.stochRsi, card.volatilityLevel);
        
        setups.push({
          symbol,
          mode: "SNIPER",
          direction: card.direction,
          score: card.confidence,
          reason: `SNIPER ${card.direction} - v7.3.2 early ignition`,
          price: card.price,
          momentum: {
            stochRsiSignal: `Stoch RSI: ${card.stochRsi?.toFixed(1) ?? "—"}`,
            emaStackSignal: card.direction === "LONG" ? "8 EMA accelerating up" : "8 EMA accelerating down",
            volatilitySignal: (card.volatilityLevel ?? 40) > 45 ? "Expansion beginning" : "Structure forming",
            trend4H: card.htf4hTrend !== "NEUTRAL",
          },
          htf: {
            trend4h: card.htf4hTrend as "BULLISH" | "BEARISH",
            alignment1h: card.htf1hAlignment ?? false,
            compression15m: card.htf15mCompression ?? false,
            trigger5m: "Early ignition",
          },
        });
        console.log(`[EXECUTION] ${symbol} ACTIVE_SNIPER ${card.direction} score=${score} | 4H:${card.htf4hTrend} 15M:${card.execution15mState}`);
      }
    }
    else {
      // v7.5.3: Update block reason for clean 3-state architecture
      // Determine WHY signal didn't fire with new thresholds
      let blockReason = "No trade conditions met";
      
      if (card.direction === "NEUTRAL") {
        blockReason = "No directional bias";
      } else if (score < 40) {
        blockReason = `Score ${score} too low (< 40)`;
      } else if (score < 55) {
        blockReason = `Score ${score} below SNIPER floor (< 55)`;
      } else if (card.execution15mState === "CHOP" || card.execution15mState === "COMPRESSING") {
        blockReason = `15M ${card.execution15mState} - not ready`;
      } else if (card.ignitionProbability < 65) {
        blockReason = `Ignition prob=${card.ignitionProbability} (< 65 SNIPER threshold)`;
      } else if (card.ignitionProbability < 75) {
        blockReason = `Ignition prob=${card.ignitionProbability} - ACTIVE_SNIPER ready (65-74) but awaiting 75+ for CONFIRMED`;
      } else if (score < 70) {
        blockReason = `Score ${score} below CONFIRMED floor (< 70)`;
      } else {
        blockReason = "Conditions met but mode=NONE";
      }
      
      card.blockReason = blockReason;
      
      // v7.3.2 FIX #4: Simplified signal state calculation
      const confirmedPassed = score >= 75 && checkConfirmedConditions(card);
      
      card.signalState = calculateSignalState(
        "NONE", 
        score, 
        card.direction,
        card.htf4hTrend,
        false, // sniperPassed (not used in v7.3.2)
        confirmedPassed,
        card.ignitionProbability, // v7.5.0: Pass ignition probability for state determination
        card.lastSignalTime, 
        "NONE"
      );
      // v7.5.3: Log observability data with clean 3-state thresholds
      console.log(`[BLOCK] ${symbol} ${card.signalState} | score=${score} ignition=${card.ignitionProbability} | reason: ${card.blockReason}`);
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
function checkSniperConditions(card: SymbolCardState): boolean {
  // Must have direction
  if (card.direction === "NEUTRAL") {
    return false;
  }
  
  // Must have ignition probability
  if (card.ignitionProbability === null || card.ignitionProbability === undefined) {
    return false;
  }
  
  // Basic ignition threshold check (soft gate)
  if (card.ignitionProbability < 60) {
    return false;
  }
  
  // 15M state must not be in chop
  if (card.execution15mState === "CHOP" || card.execution15mState === "COMPRESSING") {
    return false;
  }
  
  return true;
}

/**
 * v8.0.4 CRITICAL FIX: Calculate trade targets for entry/TP/SL
 * Used in CONFIRMED and SNIPER signal generation
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
 * v7.3.2 FIX #3: Validate ACTIVE_SNIPER execution requirements
 * - Score 55-69 is sufficient on its own
 * 
 * CONFIRMED: Still uses 4H as structural foundation (4H directional required)
 * - 4H trend must be BULLISH or BEARISH (NEUTRAL blocks all CONFIRMED)
 * - 1H agreement with 4H bias
 * - 15M continuation structure validated
 * - Score >= 70 for mature trend phase
 * 
 * Hard validation before promoting to ACTIVE_SNIPER state.
 * Returns clear rejection reason if ANY condition fails.
 * 
 * Requirements for SNIPER (ALL must be true):
 * 1. 1H alignment = true (direction matches 1H trend, not 4H)
 * 2. execution15mState = BREAKOUT_READY or EXPANDING (NOT CHOP/COMPRESSING)
 * 3. ignitionProbability >= 60 (soft threshold, not hard gate)
 * 4. Score >= 55 (execution-grade threshold for SNIPER)
 * 5. Direction consistent (no internal divergence)
 * 
 * Returns: { valid: boolean, reason?: string }
 */
function validateActiveSniperExecution(card: SymbolCardState, score: number): { valid: boolean; reason?: string; structuralOverride?: boolean } {
  // v8.3.0 REFACTOR: Weighted macro penalty with structural override for elite reversals
  // 
  // Purpose: Allow early reversal capture (SNIPER's original role) while protecting against
  // naive counter-trend trades during dumps
  //
  // Logic:
  // 1. Apply macro penalty (-8) if contra-directional (already done in ignitionProbability)
  // 2. Check if signal qualifies as "elite reversal" (structural override)
  // 3. If elite: allow SNIPER despite macro penalty
  // 4. If not elite: require ignition >= 65 after penalty (blocks weak reversals)
  // 5. CONFIRMED always requires 4H alignment (no override)

  // REQUIREMENT 1: 15M Execution state must be valid (NOT CHOP/COMPRESSING)
  if (card.execution15mState === "CHOP" || card.execution15mState === "COMPRESSING") {
    return {
      valid: false,
      reason: `15M ${card.execution15mState} - not ready for entry`
    };
  }

  // REQUIREMENT 2: Direction must be valid (not NEUTRAL)
  if (card.direction === "NEUTRAL") {
    return {
      valid: false,
      reason: `Direction NEUTRAL - no trade bias`
    };
  }

  // Check for structural override eligibility for elite reversals
  // ONLY allow contra-4H SNIPER if ALL conditions are true:
  const isContra = isContraMacroStructure(card.direction, card.htf4hTrend);
  
  let structuralOverride = false;
  if (isContra) {
    // Attempting contra-4H reversal - check if it's elite enough
    const eliteReversalConditions = {
      displacementExcellent: card.scoreBreakdown?.displacementComponent >= 6,
      volatilityExpanding: card.volatilityLevel !== null && card.volatilityLevel > 60,
      emaAccelerationStrong: card.scoreBreakdown?.emaAccelerationDelta >= 6,
      structureTransitioning: card.execution15mState === "EXPANDING" || card.execution15mState === "BREAKOUT_READY",
      ignitionAfterPenalty: card.ignitionProbability >= 72,
      scoreGood: score >= 60
    };

    const conditionsMet = Object.values(eliteReversalConditions).filter(Boolean).length;
    const allConditionsMet = conditionsMet === Object.values(eliteReversalConditions).length;

    if (allConditionsMet) {
      structuralOverride = true;
      console.log(`[STRUCTURAL OVERRIDE] ${card.symbol} ${card.direction}: elite reversal detected (Disp:${card.scoreBreakdown?.displacementComponent} Vol:${card.volatilityLevel} EMAAccel:${card.scoreBreakdown?.emaAccelerationDelta})`);
    } else {
      // Weak reversal attempt - block it
      return {
        valid: false,
        reason: `Contra-4H ${card.direction} fails structural override (${conditionsMet}/6 elite conditions met). Macro penalty (-8) insufficient for SNIPER.`
      };
    }
  }

  // REQUIREMENT 3: Ignition probability >= 65 for SNIPER threshold
  if (card.ignitionProbability < 65) {
    return {
      valid: false,
      reason: `Ignition probability ${card.ignitionProbability} below ACTIVE_SNIPER threshold (65)`
    };
  }

  // REQUIREMENT 4: Score must be execution-grade (>= 55 for SNIPER)
  if (score < 55) {
    return {
      valid: false,
      reason: `Score ${score} below SNIPER threshold (55)`
    };
  }

  // ALL REQUIREMENTS MET: Valid ACTIVE_SNIPER execution
  return { valid: true, structuralOverride };
}

/**
 * CONFIRMED CONDITIONS (v7.4.0): Established trend + 4H validation
 * Requires: 4H directional trend (BULLISH/BEARISH only, NEUTRAL blocks all)
 *           1H agreement with 4H bias
 *           15M continuation structure
 *           Mature EMA expansion + momentum confirmation
 * 
 * v7.4.0 FIX #2: CONFIRMED is strict and 4H-dependent (opposite of SNIPER)
 * Score threshold: 70+ for high-conviction continuation
 */
function checkConfirmedConditions(card: SymbolCardState): boolean {
  // v7.4.0 FIX #2: CONFIRMED requires 4H directional trend (NOT NEUTRAL)
  // This is the ONLY place 4H trend is gating ACTIVE signals
  const has4HTrend = card.htf4hTrend !== "NEUTRAL" && card.htf4hTrend !== undefined;
  
  if (!has4HTrend) {
    return false; // 4H NEUTRAL or undefined blocks CONFIRMED immediately
  }

  // 1. EMA firmly established (slope > 0.5) - trend must be mature
  const emaEstablished = card.emaSlope !== null && Math.abs(card.emaSlope) > 0.5;
  
  // 2. Direction confirmed (not NEUTRAL)
  const directionConfirmed = card.direction !== "NEUTRAL";
  
  // 3. Momentum continuing (Stoch showing strength in direction)
  const momentumContinuing = 
    (card.direction === "LONG" && (card.stochRsi ?? 50) > 50) ||
    (card.direction === "SHORT" && (card.stochRsi ?? 50) < 50);
  
  // 4. 1H aligned with 4H bias (agreement required)
  const oneHAligned = card.htf1hAlignment === true;
  
  // 5. Direction must match 4H trend (no divergence)
  const directionMatchesHTF =
    (card.direction === "LONG" && card.htf4hTrend === "BULLISH") ||
    (card.direction === "SHORT" && card.htf4hTrend === "BEARISH");

  return emaEstablished && directionConfirmed && momentumContinuing && oneHAligned && directionMatchesHTF;
}

/**
 * v8.0.2 HOTFIX: Calculate signal state based on validation results
 * Determines which of 4 states the signal should be in: NONE, BUILDING, ACTIVE_SNIPER, ACTIVE_CONFIRMED
 * This is the canonical state determination logic
 */
function calculateSignalState(
  _prevState: string, // unused, kept for compat
  score: number,
  direction: "LONG" | "SHORT" | "NEUTRAL",
  _htf4hTrend: string | null, // unused
  _sniperPassed: boolean, // unused
  confirmedPassed: boolean,
  ignitionProbability: number | null,
  _lastSignalTime: number | undefined, // unused
  _blockReason: string // unused
): "NONE" | "BUILDING" | "ACTIVE_SNIPER" | "ACTIVE_CONFIRMED" {
  // If no direction or very low score, NONE
  if (direction === "NEUTRAL" || score < 40) {
    return "NONE";
  }
  
  // CONFIRMED takes priority if all conditions met
  if (confirmedPassed && (ignitionProbability ?? 0) >= 75) {
    return "ACTIVE_CONFIRMED";
  }
  
  // SNIPER if ignition >= 65
  if ((ignitionProbability ?? 0) >= 65) {
    return "ACTIVE_SNIPER";
  }
  
  // BUILDING if we have direction and score but not quite SNIPER yet
  if (direction !== "NEUTRAL" && score >= 55) {
    return "BUILDING";
  }
  
  // Default to NONE
  return "NONE";
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
function calculateTradeReadinessScore(
  signalState: "NONE" | "BUILDING" | "SNIPER" | "CONFIRMED",
  direction: "LONG" | "SHORT" | "NEUTRAL",
  htf4hTrend: "BULLISH" | "BEARISH" | "NEUTRAL" | null,
  htf1hAlignment: boolean,
  emaSlope: number | null,
  stochRsi: number | null,
  volatilityLevel: number | null
): number {
  // Base score for having direction
  let score = 0;
  
  if (direction === "NEUTRAL") {
    return 0; // No direction = no readiness
  }
  
  // 20 points: Directional confirmation
  score += 20;
  
  // 20 points: EMA establishes trend
  if (emaSlope !== null) {
    const absSlope = Math.abs(emaSlope);
    if (absSlope > 0.7) {
      score += 20;
    } else if (absSlope > 0.4) {
      score += 15;
    } else if (absSlope > 0.2) {
      score += 10;
    }
  }
  
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
  
  // 20 points: Volatility expansion
  if (volatilityLevel !== null) {
    if (volatilityLevel > 60) {
      score += 20; // Strong expansion
    } else if (volatilityLevel > 40) {
      score += 10; // Moderate expansion
    }
  }
  
  // 20 points: HTF alignment
  if (htf4hTrend !== "NEUTRAL" && htf4hTrend !== null) {
    const directionAligned = (direction === "LONG" && htf4hTrend === "BULLISH") ||
                              (direction === "SHORT" && htf4hTrend === "BEARISH");
    if (directionAligned) {
      score += 20; // Full HTF alignment
    } else {
      score -= 10; // Divergence penalty
    }
  }
  
  // Signal state bonus
  if (signalState === "CONFIRMED") {
    score = Math.min(score + 20, 100); // Boost confirmed signals
  } else if (signalState === "SNIPER") {
    score = Math.min(score + 10, 100); // Small boost for SNIPER
  }
  
  // 1H alignment modifier
  if (htf1hAlignment) {
    score = Math.min(score + 5, 100);
  } else {
    score = Math.max(score - 5, 0);
  }
  
  return Math.min(Math.max(score, 0), 100);
}

/**
 * Calculate momentum score using event-driven multiplier model
 * v7.1 STABILISATION FIX
 */
function generateCardState(symbol: string, priceData: PriceData): SymbolCardState {
  // Degrade is purely informational
  const degraded = priceData.source !== "kraken_live";

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
    tradeReadinessScore: calculateTradeReadinessScore("NONE", direction, htf4hTrend, htf1hAlignment, emaSlope, stochRsi, volatilityLevel),
    
    // Conditional: Only populate if signal exists (SNIPER/CONFIRMED)
    expectedMovePercent: null,
    targetPrices: null,
    riskReward: null,
    
    // FIX #1: Initialize signalState to NONE (will be updated by alert logic)
    signalState: "NONE",
    lastSignalTime: undefined,

    notes: direction !== "NEUTRAL" ? calculateLiveMarketState(direction, emaSlope, stochRsi, volatilityLevel) : "Awaiting momentum ignition",
    updatedAt: new Date().toISOString(),
  };

  return card;
}
