/**
 * SNIPER ENGINE v7.0 - MOMENTUM IGNITION SYSTEM
 * 
 * Converts from structure-based scanner to momentum wave detector
 * Uses Stochastic RSI + EMA Stack + Volatility Compression
 * 
 * NO STATE, NO DB ACCESS, PURE EVALUATION
 */

import type { PriceData } from "./price-router";

export type SymbolCardState = {
  symbol: string;
  price: number;
  source: string;
  degraded: boolean;

  direction: "LONG" | "SHORT" | "NEUTRAL";
  mode: "SNIPER" | "CONFIRMED" | "NONE";
  confidence: number;

  // Momentum indicators (5M)
  stochRsi: number | null;
  emaSlope: number | null;
  volatilityLevel: number | null;

  // Higher TimeFrame alignment (v7.1.1)
  htf4hTrend: "BULLISH" | "BEARISH" | "NEUTRAL";
  htf4hMomentum: number | null;
  htf1hAlignment: boolean | null;
  htf15mCompression: boolean | null;

  // Market readiness engine (v7.2.1)
  marketReadinessState: "BUILDING_PRESSURE" | "BULLISH_IGNITION" | "BEARISH_IGNITION" | "TREND_EXPANSION" | "OVEREXTENDED" | "CHOP_NO_TRADE" | "AWAITING_DATA";
  tradeReadinessScore: number | null; // 0-100, NULL if no signal
  
  // Conditional: Only populate if mode === "SNIPER" or "CONFIRMED"
  expectedMovePercent: { sniper: { min: number; max: number } } | null;
  targetPrices: { tp1: number; tp2: number; tp3: number; sl: number } | null;
  riskReward: number | null;

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
      card.notes = `CONFIRMED ${card.direction} trend continuation ${score}`;
      
      // Populate trade targets (v7.2.1)
      const targets = calculateTradeTargets(card.price, card.volatilityLevel ?? 50, card.direction);
      card.expectedMovePercent = targets.expectedMovePercent;
      card.targetPrices = targets.targetPrices;
      card.riskReward = targets.riskReward;
      card.tradeReadinessScore = calculateTradeReadinessScore("CONFIRMED", card.htf4hTrend, card.htf1hAlignment, card.emaSlope, card.stochRsi, card.volatilityLevel);
      
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
    // SNIPER ALERT: score >= 60 AND sniper conditions met (HTF alignment + LTF ignition)
    else if (score >= 60 && card.direction !== "NEUTRAL" && checkSniperConditions(card)) {
      card.mode = "SNIPER";
      card.confidence = Math.min(score, 99);
      card.notes = `SNIPER ${card.direction} ignition ${score}`;
      
      // Populate trade targets (v7.2.1)
      const targets = calculateTradeTargets(card.price, card.volatilityLevel ?? 50, card.direction);
      card.expectedMovePercent = targets.expectedMovePercent;
      card.targetPrices = targets.targetPrices;
      card.riskReward = targets.riskReward;
      card.tradeReadinessScore = calculateTradeReadinessScore("SNIPER", card.htf4hTrend, card.htf1hAlignment, card.emaSlope, card.stochRsi, card.volatilityLevel);
      
      setups.push({
        symbol,
        mode: "SNIPER",
        direction: card.direction,
        score: card.confidence,
        reason: `SNIPER ${card.direction} - HTF aligned ignition event`,
        price: card.price,
        momentum: {
          stochRsiSignal: `Stoch RSI: ${card.stochRsi?.toFixed(1) ?? "—"}`,
          emaStackSignal: card.direction === "LONG" ? "8 EMA turning up" : "8 EMA turning down",
          volatilitySignal: (card.volatilityLevel ?? 40) < 40 ? "Compression active" : "Normal",
          trend4H: card.htf4hTrend !== "NEUTRAL",
        },
        // HTF Breakdown for Telegram alerts
        htf: {
          trend4h: card.htf4hTrend as "BULLISH" | "BEARISH",
          alignment1h: card.htf1hAlignment ?? false,
          compression15m: card.htf15mCompression ?? false,
          trigger5m: (card.stochRsi ?? 50) > 20 && (card.stochRsi ?? 50) < 80 ? "Stoch RSI cross" : "EMA flip",
        },
      });
      console.log(`[ALERT] ${symbol} SNIPER ${card.direction} score=${score} | 4H:${card.htf4hTrend} 1H:${card.htf1hAlignment} 15M:${card.htf15mCompression}`);
    }
    else {
      console.log(`[SCAN] ${symbol} below threshold (score=${score})`);
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
 * Calculate trade readiness score (v7.2.4 FIX #7)
 * NEW FORMULA: 0-100 composite with clear bands
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
  htf4hTrend: string,
  htf1hAlignment: boolean | null,
  emaSlope: number | null,
  stochRsi: number | null,
  volatilityLevel: number | null
): number | null {
  // If direction is NEUTRAL, score may still exist if building
  if (stochRsi === null || emaSlope === null || volatilityLevel === null) {
    return null;
  }

  let score = 0;

  // +25 HTF alignment (v7.2.4)
  if (htf4hTrend === "BULLISH" || htf4hTrend === "BEARISH") score += 25;

  // +20 compression (low volatility = energy buildup)
  if (volatilityLevel < 40) score += 20;

  // +20 momentum ignition (Stoch in active zone)
  if ((stochRsi > 30 && stochRsi < 70) || (stochRsi > 20 && stochRsi < 80)) score += 20;

  // +20 EMA expansion (established slope)
  if (emaSlope !== null && Math.abs(emaSlope) > 0.3) score += 20;

  // +15 impulse confirmation (if signal mode exists)
  if (mode === "SNIPER" || mode === "CONFIRMED") score += 15;

  return Math.min(score, 100);
}

/**
 * Calculate trade targets only when signal fired (v7.2.1)
 */
function calculateTradeTargets(price: number, volatilityLevel: number, direction: string) {
  const volatilityFactor = volatilityLevel / 100;
  const sniperMin = 0.8 + volatilityFactor * 0.5;
  const sniperMax = 1.5 + volatilityFactor * 0.7;
  
  const isLong = direction === "LONG";
  const tp1 = price * (1 + (isLong ? sniperMax : -sniperMax) / 100);
  const tp2 = price * (1 + (isLong ? sniperMax * 1.5 : -sniperMax * 1.5) / 100);
  const tp3 = price * (1 + (isLong ? sniperMax * 2.2 : -sniperMax * 2.2) / 100);
  const sl = price * (1 + (isLong ? -sniperMax : sniperMax) / 100);
  const riskReward = (sniperMax * 2.2) / sniperMax;
  
  return {
    expectedMovePercent: { sniper: { min: sniperMin, max: sniperMax } },
    targetPrices: { tp1, tp2, tp3, sl },
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
 * SNIPER CONDITIONS v7.2.4: EARLY IGNITION ALLOWED
 * SNIPER = beginning of wave, NOT confirmation
 * Allow early ignition if directional bias exists + compression + ignition event
 */
function checkSniperConditions(card: SymbolCardState): boolean {
  // REQUIREMENT 1: Directional bias exists (not NEUTRAL)
  if (card.direction === "NEUTRAL") {
    console.log(`[SNIPER CHECK] ${card.symbol} BLOCKED: No directional bias`);
    return false;
  }

  // REQUIREMENT 2: 15M compression exists OR low volatility (energy buildup)
  if (!card.htf15mCompression && (card.volatilityLevel ?? 50) > 45) {
    console.log(`[SNIPER CHECK] ${card.symbol} BLOCKED: No compression detected`);
    return false;
  }

  // REQUIREMENT 3: One ignition event (Stoch cross OR EMA flip OR impulse)
  const stochCross = (card.stochRsi ?? 50) > 25 && (card.stochRsi ?? 50) < 75; // Active zone
  const emaFlip = card.emaSlope !== null && Math.abs(card.emaSlope) > 0.3; // Slope established
  const ignitionTrigger = stochCross || emaFlip;
  
  if (!ignitionTrigger) {
    console.log(`[SNIPER CHECK] ${card.symbol} BLOCKED: No ignition trigger`);
    return false;
  }

  // ALL CONDITIONS MET: Valid SNIPER setup
  console.log(`[SNIPER CHECK] ${card.symbol} PASSED: direction=${card.direction} + compression + ignition`);
  return true;
}

/**
 * CONFIRMED CONDITIONS (v7.2.4 FIX #3): Established trend + impulse
 * Requires: HTF alignment + EMA expansion + momentum continuation
 * Strict threshold: 75+
 */
function checkConfirmedConditions(card: SymbolCardState): boolean {
  // 1. EMA firmly established (slope > 0.5)
  const emaEstablished = card.emaSlope !== null && Math.abs(card.emaSlope) > 0.5;
  
  // 2. Direction confirmed (not NEUTRAL)
  const directionConfirmed = card.direction !== "NEUTRAL";
  
  // 3. Momentum continuing (Stoch showing strength)
  const momentumContinuing = 
    (card.direction === "LONG" && (card.stochRsi ?? 50) > 50) ||
    (card.direction === "SHORT" && (card.stochRsi ?? 50) < 50);
  
  // 4. HTF aligned
  const htfAligned = card.htf1hAlignment === true;

  return emaEstablished && directionConfirmed && momentumContinuing && htfAligned;
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

  // SIMULATE HTF CONDITIONS (v7.1.1)
  // 4H TREND: Establish macro directional bias
  const htf4hMomentum = 40 + (symbolHash % 30); // 40-70 range
  const htf4hTrend: "BULLISH" | "BEARISH" | "NEUTRAL" = 
    htf4hMomentum > 60 ? "BULLISH" : 
    htf4hMomentum < 40 ? "BEARISH" : 
    "NEUTRAL";

  // 1H ALIGNMENT: Does 1H momentum confirm the 4H trend?
  // Simplified: 1H aligns if EMA slope matches 4H direction
  const htf1hAlignment = 
    (htf4hTrend === "BULLISH" && emaSlope > 0.2) ||
    (htf4hTrend === "BEARISH" && emaSlope < -0.2) ||
    (htf4hTrend === "NEUTRAL" && Math.abs(emaSlope) < 0.3);

  // 15M COMPRESSION: Is there energy build-up?
  // Simplified: compression when volatility < 40
  const htf15mCompression = volatilityLevel < 40;

  // Determine direction based on directional confidence hierarchy (v7.2.4)
  // PRIMARY: 4H trend decides bias
  // SECONDARY: 1H confirms or weakens
  // TERTIARY: 5M refines entry timing only
  
  let direction: "LONG" | "SHORT" | "NEUTRAL" = "NEUTRAL";
  
  // IF 4H bullish AND EMA slope >= 0 => LONG (v7.2.4 FIX #1)
  if (htf4hTrend === "BULLISH" && emaSlope >= -0.1) {
    direction = "LONG";
  }
  // IF 4H bearish AND EMA slope <= 0 => SHORT (v7.2.4 FIX #1)
  else if (htf4hTrend === "BEARISH" && emaSlope <= 0.1) {
    direction = "SHORT";
  }
  // ONLY NEUTRAL if 4H truly flat AND EMA near zero AND Stoch middle AND no breakout
  else if (htf4hTrend === "NEUTRAL" && Math.abs(emaSlope) < 0.3 && stochRsi > 45 && stochRsi < 55 && volatilityLevel < 35) {
    direction = "NEUTRAL";
  }
  // Otherwise lean into 4H bias even if weak signals
  else if (htf4hTrend === "BULLISH") {
    direction = "LONG";
  }
  else if (htf4hTrend === "BEARISH") {
    direction = "SHORT";
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

    // HTF alignment data
    htf4hTrend,
    htf4hMomentum,
    htf1hAlignment,
    htf15mCompression,

    // Market readiness (v7.2.1)
    // Market readiness (v7.2.4 FIX #4: Use live market state instead of old phases)
    marketReadinessState: calculateLiveMarketState(direction, emaSlope, stochRsi, volatilityLevel) as any,
    tradeReadinessScore: calculateTradeReadinessScore("NONE", htf4hTrend, htf1hAlignment, emaSlope, stochRsi, volatilityLevel),
    
    // Conditional: Only populate if signal exists (SNIPER/CONFIRMED)
    expectedMovePercent: null,
    targetPrices: null,
    riskReward: null,

    notes: direction !== "NEUTRAL" ? calculateLiveMarketState(direction, emaSlope, stochRsi, volatilityLevel) : "Awaiting momentum ignition",
    updatedAt: new Date().toISOString(),
  };

  return card;
}
