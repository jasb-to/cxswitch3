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
 * Calculate trade readiness score (v7.2.5 FIX #5)
 * Readiness MUST follow direction
 * 
 * IF direction bullish AND momentum exists: minimum 45-55
 * IF compression + ignition: 60-75
 * IF HTF aligned + continuation: 75-90
 * NEVER allow: NEUTRAL + 40% readiness (contradictory UX)
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

  // If direction exists (LONG or SHORT), minimum 45-55 baseline
  let score = 45;

  // +10 compression (low volatility = energy buildup)
  if (volatilityLevel < 40) score += 10;

  // +15 momentum in direction (Stoch aligned with direction)
  if (direction === "LONG" && stochRsi > 50) score += 15;
  if (direction === "SHORT" && stochRsi < 50) score += 15;

  // +15 EMA expansion (established slope)
  if (emaSlope !== null && Math.abs(emaSlope) > 0.4) score += 15;

  // +10 HTF alignment
  if (htf4hTrend !== "NEUTRAL") score += 10;

  // +10 impulse confirmation (if signal mode exists)
  if (mode === "SNIPER" || mode === "CONFIRMED") score += 10;

  return Math.min(score, 100);
}

/**
 * Calculate trade targets only when signal fired (v7.2.5: FIX TP3 removal)
 */
function calculateTradeTargets(price: number, volatilityLevel: number, direction: string) {
  const volatilityFactor = volatilityLevel / 100;
  const sniperMin = 0.8 + volatilityFactor * 0.5;
  const sniperMax = 1.5 + volatilityFactor * 0.7;
  
  const isLong = direction === "LONG";
  const tp1 = price * (1 + (isLong ? sniperMax : -sniperMax) / 100);
  const tp2 = price * (1 + (isLong ? sniperMax * 1.5 : -sniperMax * 1.5) / 100);
  const sl = price * (1 + (isLong ? -sniperMax : sniperMax) / 100);
  const riskReward = (sniperMax * 1.5) / sniperMax;
  
  return {
    expectedMovePercent: { sniper: { min: sniperMin, max: sniperMax } },
    targetPrices: { tp1, tp2, sl },
    riskReward,
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
 * v7.5.3: Clean 3-state signal progression
 * Returns: NONE | BUILDING | ACTIVE_SNIPER | ACTIVE_CONFIRMED
 * Seamless threshold progression with no dead zones or overlaps
 */
function calculateSignalState(
  mode: "SNIPER" | "CONFIRMED" | "NONE",
  score: number,
  direction: string,
  htf4hTrend: string,
  sniperPassed: boolean,
  confirmedPassed: boolean,
  ignitionProbability: number,
  lastSignalTime: number | undefined,
  lastMode: "SNIPER" | "CONFIRMED" | "NONE"
): SignalState {
  // v7.5.3: ACTIVE_CONFIRMED: Highest priority (mature continuation phase)
  // ignitionProbability >= 75 (exact boundary where SNIPER ends)
  if (confirmedPassed && score >= 70) {
    if (lastMode === "CONFIRMED" && !isCooldownElapsed(lastSignalTime, "CONFIRMED")) {
      return "ACTIVE_CONFIRMED"; // Still in active window
    }
    return "ACTIVE_CONFIRMED"; // New CONFIRMED setup ready
  }
  
  // v7.5.3: ACTIVE_SNIPER: Early executable impulse expansion
  // ignitionProbability 65-74 (clean band, no SNIPER_READY intermediate)
  if (sniperPassed && score >= 55 && !confirmedPassed && ignitionProbability >= 65) {
    if (lastMode === "SNIPER" && !isCooldownElapsed(lastSignalTime, "SNIPER")) {
      return "ACTIVE_SNIPER"; // Still in active window
    }
    return "ACTIVE_SNIPER"; // Early impulse expansion captured
  }
  
  // BUILDING: Setup forming but not ready for execution
  // ignitionProbability < 65 (all non-alert momentum states)
  if (direction !== "NEUTRAL" && score >= 40) {
    return "BUILDING";
  }
  
  // No signal
  return "NONE";
}

/**
 * v7.3.1: STRICT ACTIVE_SNIPER EXECUTION VALIDATION
 * v7.3.2: Loosen 5M ignition for earlier ACTIVE_SNIPER (early momentum capture)
 * Allow ANY ignition condition, not just confirmed breakout
 * 
 * Earlier ignition means:
 * - EMA acceleration (not full reversal)
 * - Stochastic momentum (not hard crossover)
 * - Volatility expansion beginning
 * - Directional impulse detected
 */
function checkSniperConditions(card: SymbolCardState, checkMode: "strict" | "early" = "strict"): boolean {
  // REQUIREMENT 1: Directional bias exists (not NEUTRAL)
  if (card.direction === "NEUTRAL") {
    console.log(`[SNIPER CHECK] ${card.symbol} BLOCKED: No directional bias`);
    return false;
  }

  // v7.3.2: LOOSEN IGNITION (early momentum capture)
  // ANY of these conditions trigger ACTIVE_SNIPER now:
  // 1. EMA has momentum (slope > 0.15, was > 0.2)
  // 2. Stochastic active zone (not extreme)
  // 3. Volatility expanding (vol > 45)
  
  const emaAccelerating = (card.emaSlope ?? 0) > 0.15; // Loosen from 0.2
  const stochActive = (card.stochRsi ?? 50) > 30 && (card.stochRsi ?? 50) < 70; // Loosen from 25-75
  const volatilityExpanding = (card.volatilityLevel ?? 50) > 45; // Breakout mode
  
  const hasEarlyIgnition = emaAccelerating || stochActive || volatilityExpanding;
  
  if (!hasEarlyIgnition) {
    console.log(`[SNIPER CHECK] ${card.symbol} BLOCKED: No early ignition`);
    return false;
  }

  // v7.3.2: Keep HTF structure strict
  // Still require compression OR expansion (not none)
  const compressionExists = card.htf15mCompression === true;
  const emaExpanding = Math.abs(card.emaSlope ?? 0) > 0.4;
  const volatilityBreakout = (card.volatilityLevel ?? 50) > 50;
  const energyBuilding = (card.volatilityLevel ?? 50) <= 45;
  
  const compressionOrExpansion = compressionExists || emaExpanding || volatilityBreakout || energyBuilding;
  
  if (!compressionOrExpansion) {
    console.log(`[SNIPER CHECK] ${card.symbol} BLOCKED: No compression/expansion detected`);
    return false;
  }

  // ALL CONDITIONS MET: Valid SNIPER setup (early ignition)
  console.log(`[SNIPER CHECK] ${card.symbol} PASSED (${checkMode}): direction=${card.direction} + early ignition + execution structure`);
  return true;
}

/**
 * v7.5.0: PROBABILISTIC 5M IGNITION SCORING
 * 
 * Replace binary "5M trigger" gate with continuous probability (0-100)
 * No longer permission gate, now "pressure meter for execution timing"
 * 
 * Returns: { probability: 0-100, breakdown: component scores, reason: why }
 */
interface IgnitionResult {
  probability: number;
  breakdown: {
    stochComponent: number;
    emaComponent: number;
    volatilityComponent: number;
    volumeComponent: number;
  };
  reason: string;
}

function calculateIgnitionProbability(
  stochRsi: number | null,
  emaSlope: number | null,
  volatilityLevel: number | null,
  direction: "LONG" | "SHORT" | "NEUTRAL",
  htf1hAlignment: boolean = true // v7.5.2: 1H alignment as probabilistic modifier (default true)
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

  // COMPONENT 2: EMA acceleration (0-30 points)
  if (emaSlope !== null) {
    const absMagnitude = Math.abs(emaSlope);
    if (direction === "LONG" && emaSlope > 0) {
      if (absMagnitude > 0.8) {
        emaComponent = 30;
        reasons.push("EMA strong acceleration up");
      } else if (absMagnitude > 0.5) {
        emaComponent = 22;
        reasons.push("EMA good acceleration up");
      } else if (absMagnitude > 0.3) {
        emaComponent = 15;
        reasons.push("EMA moderate acceleration up");
      } else if (absMagnitude > 0.15) {
        emaComponent = 8;
        reasons.push("EMA slight acceleration up");
      } else if (absMagnitude > 0.05) {
        emaComponent = 3;
        reasons.push("EMA subtle acceleration up");
      } else {
        reasons.push("EMA flat, no acceleration");
      }
    } else if (direction === "SHORT" && emaSlope < 0) {
      if (absMagnitude > 0.8) {
        emaComponent = 30;
        reasons.push("EMA strong acceleration down");
      } else if (absMagnitude > 0.5) {
        emaComponent = 22;
        reasons.push("EMA good acceleration down");
      } else if (absMagnitude > 0.3) {
        emaComponent = 15;
        reasons.push("EMA moderate acceleration down");
      } else if (absMagnitude > 0.15) {
        emaComponent = 8;
        reasons.push("EMA slight acceleration down");
      } else if (absMagnitude > 0.05) {
        emaComponent = 3;
        reasons.push("EMA subtle acceleration down");
      } else {
        reasons.push("EMA flat, no acceleration");
      }
    } else {
      reasons.push(`EMA slope diverges from ${direction} direction`);
    }
  }

  // COMPONENT 3: Micro volatility expansion (0-25 points)
  if (volatilityLevel !== null) {
    if (volatilityLevel > 60) {
      volatilityComponent = 25;
      reasons.push("Volatility high expansion");
    } else if (volatilityLevel > 50) {
      volatilityComponent = 18;
      reasons.push("Volatility good expansion");
    } else if (volatilityLevel > 40) {
      volatilityComponent = 10;
      reasons.push("Volatility moderate expansion");
    } else if (volatilityLevel > 30) {
      volatilityComponent = 5;
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

  // v7.5.2: Apply 1H alignment modifier (probabilistic, not hard gate)
  // Aligned: +10 (boosts early entry confidence)
  // Divergent: -10 (penalizes counter-structure but doesn't block)
  let probabilityBase = stochComponent + emaComponent + volatilityComponent + volumeComponent;
  let htfModifier = 0;
  
  if (htf1hAlignment) {
    htfModifier = 10;
    reasons.push("1H aligned");
  } else {
    htfModifier = -10;
    reasons.push("1H divergent (-10)");
  }
  
  const probability = Math.min(Math.max(probabilityBase + htfModifier, 0), 100); // Clamp 0-100
  
  return {
    probability,
    breakdown: { stochComponent, emaComponent, volatilityComponent, volumeComponent },
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
function validateActiveSniperExecution(card: SymbolCardState, score: number): { valid: boolean; reason?: string } {
  // v7.4.0: SNIPER removed 4H requirement, use 1H alignment only
  // v7.5.2: REMOVED hard 1H alignment gate (now probabilistic modifier in ignitionProbability)
  // 1H divergence will reduce probability but NOT block execution
  // Allows early impulse capture during first wave before 1H fully aligns

  // REQUIREMENT 2: 15M Execution state must be valid (NOT CHOP/COMPRESSING)
  if (card.execution15mState === "CHOP" || card.execution15mState === "COMPRESSING") {
    return {
      valid: false,
      reason: `15M ${card.execution15mState} - not ready for entry`
    };
  }

  // REQUIREMENT 3: v7.5.3 ignitionProbability >= 65 (ACTIVE_SNIPER threshold)
  // Removed: hard binary trigger gate (Stoch cross, EMA flip)
  if (card.ignitionProbability < 65) {
    return {
      valid: false,
      reason: `Ignition probability ${card.ignitionProbability} below ACTIVE_SNIPER threshold (65)`
    };
  }

  // REQUIREMENT 4: Score must be execution-grade (>= 55 for SNIPER, lower threshold than v7.3.3)
  if (score < 55) {
    return {
      valid: false,
      reason: `Score ${score} below SNIPER threshold (55)`
    };
  }

  // REQUIREMENT 5: Direction must be valid (not NEUTRAL)
  if (card.direction === "NEUTRAL") {
    return {
      valid: false,
      reason: `Direction NEUTRAL - no trade bias`
    };
  }

  // ALL REQUIREMENTS MET: Valid ACTIVE_SNIPER execution (v7.4.0: 1H based, no 4H dependency)
  return { valid: true };
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
  // Priority: EMA slope > 4H trend > momentum > volatility > Stoch position
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
  // RULE 4: Volatility expansion (breakout bias)
  else if (volatilityLevel > 60) {
    direction = "LONG"; // Expanding - usually bullish
  }
  // RULE 5: ONLY classify as NEUTRAL if truly dead market
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
      const result = calculateIgnitionProbability(stochRsi, emaSlope, volatilityLevel, direction, htf1hAlignment); // v7.5.2: pass 1H alignment
      // Log ignition breakdown for transparency
      console.log(
        `[IGNITION] ${symbol} ${direction}: prob=${result.probability} [Stoch:${result.breakdown.stochComponent} EMA:${result.breakdown.emaComponent} Vol:${result.breakdown.volatilityComponent}] | ${result.reason}`
      );
      // Store breakdown for debugging
      if (!this) {
        // During initialization, store separately - will be assigned after
      }
      return result.probability;
    })(),
    
    // v7.5.1: Store breakdown for UI debugging
    scoreBreakdown: (() => {
      const result = calculateIgnitionProbability(stochRsi, emaSlope, volatilityLevel, direction, htf1hAlignment); // v7.5.2: pass 1H alignment
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
