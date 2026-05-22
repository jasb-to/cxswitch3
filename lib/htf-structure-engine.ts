/**
 * REAL 4H STRUCTURE DETECTION ENGINE (v22.0)
 * 
 * Replaces synthetic hash-based 4H trend with actual OHLC structure analysis
 * 
 * INPUT: 4H OHLC candles (minimum 20 candles for structure detection)
 * OUTPUT: HTFTrend with macro bias based on real market structure
 * 
 * Structure Detection:
 * - BULLISH: HH/HL pattern + positive EMA slope + displacement upward
 * - BEARISH: LH/LL pattern + negative EMA slope + displacement downward
 * - NEUTRAL: mixed structure or flat EMA slope
 */

import type { Candle } from "./kraken";

export type HTFTrend = "BULLISH" | "BEARISH" | "NEUTRAL";

export interface HTFStructureAnalysis {
  trend: HTFTrend;
  structure: "HH" | "HL" | "LH" | "LL" | "MIXED" | "UNKNOWN";
  emaSlope: number;
  spreadAcceleration: number;
  displacement: number;
  swingHigh: number;
  swingLow: number;
  confidence: number;
  lastCandle: Candle | null;
}

/**
 * Calculate 4H trend from real OHLC structure
 * 
 * v22.0 CRITICAL: This is the macro context layer
 * - NOT used to hard-override 1H direction
 * - ONLY used as macro alignment filter
 * - Recomputed fresh every cycle
 * 
 * v22.1 FIX: Fallback to momentum-only bias when insufficient candles
 * When 4H candles are missing/insufficient, use EMA slope to maintain directional responsiveness
 */
export function analyze4HStructure(candles: Candle[], fallbackEMASlope?: number): HTFStructureAnalysis {
  // Need minimum lookback for structure analysis
  if (!candles || candles.length < 20) {
    // v22.1 FALLBACK: If no structure data, derive bias from EMA slope alone
    // This prevents BTC from getting stuck at NEUTRAL when 4H candles fail to fetch
    const fallbackTrend: HTFTrend = fallbackEMASlope !== undefined 
      ? (fallbackEMASlope > 0.3 ? "BULLISH" : fallbackEMASlope < -0.3 ? "BEARISH" : "NEUTRAL")
      : "NEUTRAL";
    
    console.log(`[4H_FALLBACK] Insufficient candles (${candles?.length ?? 0} < 20), using fallback bias: ${fallbackTrend} (EMA slope: ${fallbackEMASlope?.toFixed(3)})`);
    
    return {
      trend: fallbackTrend,
      structure: "UNKNOWN",
      emaSlope: fallbackEMASlope ?? 0,
      displacement: 0,
      swingHigh: 0,
      swingLow: 0,
      confidence: fallbackEMASlope !== undefined ? 40 : 0, // Lower confidence for fallback
      lastCandle: null,
    };
  }

  const lastCandle = candles[candles.length - 1];
  
  // FIX: Calculate directional structure from EMA cross (primary) + acceleration (secondary)
  // STOP averaging conflicting regimes - that corrupts the signal
  
  const ema8 = calculateEMA(candles, 8);
  const ema21 = calculateEMA(candles, 21);
  
  // PRIMARY: Directional bias from EMA cross
  // This is the STRUCTURAL direction, not historical momentum
  const directionalBias = (ema8 - ema21) / ema21 * 100;
  
  // SECONDARY: Spread acceleration (is the cross accelerating or decelerating?)
  // This measures REAL directional expansion, not lagging drift
  const currentSpread = ema8 - ema21;
  const prevEma8 = candles.length >= 2 ? calculateEMA(candles.slice(0, -1), 8) : ema8;
  const prevEma21 = candles.length >= 2 ? calculateEMA(candles.slice(0, -1), 21) : ema21;
  const previousSpread = prevEma8 - prevEma21;
  const spreadAcceleration = currentSpread - previousSpread;
  
  // CRITICAL: emaSlope is now DIRECTIONAL, not averaged
  // Positive = EMA8 above EMA21 (bullish structure)
  // Negative = EMA8 below EMA21 (bearish structure)
  // This is NO LONGER averaged with historical drift
  const emaSlope = directionalBias;
  
  // Mandatory observability: FULL directional structure
  console.log(`[EMA_STRUCTURE] ${lastCandle?.symbol || 'UNKNOWN'}:`, {
    ema8: ema8.toFixed(2),
    ema21: ema21.toFixed(2),
    spread: currentSpread.toFixed(0),
    spreadPrev: previousSpread.toFixed(0),
    acceleration: spreadAcceleration.toFixed(0),
    directionalBias: directionalBias.toFixed(3),
    emaSlope: emaSlope.toFixed(3),
    structure: ema8 < ema21 ? "BEARISH_STRUCTURE" : ema8 > ema21 ? "BULLISH_STRUCTURE" : "NEUTRAL",
    accelerating: spreadAcceleration > 0 ? "YES" : "NO",
    timestamp: new Date().toISOString()
  });
  
  // Detect swing highs and lows (structure)
  const { swingHigh, swingLow, structure } = detectSwingStructure(candles);
  
  // Calculate displacement (trend strength)
  const displacement = calculateDisplacement(candles);
  
  // Determine trend from directional structure
  const trend = determineTrend(structure, emaSlope, spreadAcceleration, displacement, lastCandle);
  
  // Calculate confidence score (0-100)
  const confidence = calculateConfidence(structure, emaSlope, displacement);

  return {
    trend,
    structure,
    emaSlope,
    spreadAcceleration,
    displacement,
    swingHigh,
    swingLow,
    confidence,
    lastCandle,
  };
}

/**
 * Calculate EMA for given period
 * Uses smoothing factor: multiplier = 2 / (period + 1)
 */
function calculateEMA(candles: Candle[], period: number): number {
  if (candles.length < period) return candles[candles.length - 1]?.close ?? 0;
  
  // Start with SMA for first period
  let sum = 0;
  for (let i = 0; i < period; i++) {
    sum += candles[i].close;
  }
  let ema = sum / period;
  
  // Apply EMA formula
  const multiplier = 2 / (period + 1);
  for (let i = period; i < candles.length; i++) {
    ema = (candles[i].close - ema) * multiplier + ema;
  }
  
  return ema;
}

/**
 * Detect recent swing highs and lows (HH/HL/LH/LL pattern)
 * 
 * HH (Higher High): Most recent high > previous high (BULLISH structure)
 * HL (Higher Low): Most recent low > previous low (BULLISH structure)
 * LH (Lower High): Most recent high < previous high (BEARISH structure)
 * LL (Lower Low): Most recent low < previous low (BEARISH structure)
 */
function detectSwingStructure(candles: Candle[]): {
  swingHigh: number;
  swingLow: number;
  structure: "HH" | "HL" | "LH" | "LL" | "MIXED";
} {
  if (candles.length < 4) {
    return { swingHigh: 0, swingLow: 0, structure: "MIXED" };
  }
  
  // Get last 3 significant candles for swing detection
  const recent = candles.slice(-3);
  
  // Identify highs and lows in the sample
  // Current swing high/low vs previous swing high/low
  const prev2 = candles[candles.length - 3];
  const prev1 = candles[candles.length - 2];
  const curr = candles[candles.length - 1];
  
  // Previous swing high/low (avg of last 2)
  const prevSwingHigh = Math.max(prev2.high, prev1.high);
  const prevSwingLow = Math.min(prev2.low, prev1.low);
  
  // Current swing high/low
  const currSwingHigh = curr.high;
  const currSwingLow = curr.low;
  
  // Determine structure pattern
  let structure: "HH" | "HL" | "LH" | "LL" | "MIXED" = "MIXED";
  
  const higherHigh = currSwingHigh > prevSwingHigh;
  const higherLow = currSwingLow > prevSwingLow;
  const lowerHigh = currSwingHigh < prevSwingHigh;
  const lowerLow = currSwingLow < prevSwingLow;
  
  if (higherHigh && higherLow) {
    structure = "HH"; // Bullish structure
  } else if (higherHigh && !higherLow) {
    structure = "HL"; // Mixed, but leaning bullish
  } else if (lowerHigh && lowerLow) {
    structure = "LL"; // Bearish structure
  } else if (lowerHigh && !lowerLow) {
    structure = "LH"; // Mixed, but leaning bearish
  }
  
  return {
    swingHigh: currSwingHigh,
    swingLow: currSwingLow,
    structure,
  };
}

/**
 * Calculate displacement (trend strength/momentum)
 * 
 * Measures how strongly price is moving away from mean
 * Positive = upward displacement (bullish)
 * Negative = downward displacement (bearish)
 * Near 0 = ranging/neutral
 */
function calculateDisplacement(candles: Candle[]): number {
  if (candles.length < 10) return 0;
  
  // Calculate 20-candle SMA
  const sma20 = calculateSMA(candles.slice(-20));
  
  // Current price vs SMA
  const currentPrice = candles[candles.length - 1].close;
  const displacement = ((currentPrice - sma20) / sma20) * 100; // % displacement
  
  return displacement;
}

/**
 * Calculate simple moving average
 */
function calculateSMA(candles: Candle[]): number {
  if (candles.length === 0) return 0;
  const sum = candles.reduce((acc, c) => acc + c.close, 0);
  return sum / candles.length;
}

/**
 * Determine final trend from composite signals
 * 
 * BULLISH: HH/HL structure + positive EMA slope + positive displacement
 * BEARISH: LH/LL structure + negative EMA slope + negative displacement
 * NEUTRAL: mixed or conflicting signals
 */
function determineTrend(
  structure: "HH" | "HL" | "LH" | "LL" | "MIXED",
  emaSlope: number,
  spreadAcceleration: number,
  displacement: number,
  lastCandle: Candle | null
): HTFTrend {
  // HARD RULE: If ema8 < ema21 AND spread acceleration worsening
  // LONG cannot be generated unless reclaim structure explicitly exists
  const bearishStructure = emaSlope < -0.1;  // EMA8 below EMA21
  const acceleratingBearish = spreadAcceleration < -50; // Gap worsening
  
  if (bearishStructure && acceleratingBearish) {
    // BEARISH structure + worsening spread = SHORT bias (no LONG exception)
    return "BEARISH";
  }
  
  // Structure bullish signals
  const structureBullish = structure === "HH" || structure === "HL";
  const structureBearish = structure === "LH" || structure === "LL";
  
  // EMA bullish/bearish signals (now DIRECTIONAL, not averaged)
  const emaBullish = emaSlope > 0.1;  // EMA8 above EMA21
  const emaBearish = emaSlope < -0.1; // EMA8 below EMA21
  
  // Displacement bullish/bearish signals
  const displacementBullish = displacement > 0.5;
  const displacementBearish = displacement < -0.5;
  
  // BULLISH: Need 2+ bullish signals
  const bullishScore = (structureBullish ? 1 : 0) + (emaBullish ? 1 : 0) + (displacementBullish ? 1 : 0);
  
  // BEARISH: Need 2+ bearish signals
  const bearishScore = (structureBearish ? 1 : 0) + (emaBearish ? 1 : 0) + (displacementBearish ? 1 : 0);
  
  if (bullishScore >= 2) {
    return "BULLISH";
  } else if (bearishScore >= 2) {
    return "BEARISH";
  } else {
    return "NEUTRAL";
  }
}

/**
 * Calculate confidence in trend identification (0-100)
 * 
 * High confidence when signals align
 * Low confidence when signals conflict
 */
function calculateConfidence(
  structure: "HH" | "HL" | "LH" | "LL" | "MIXED",
  emaSlope: number,
  displacement: number
): number {
  let confidence = 50; // Base
  
  // Boost for clear structure
  if (structure === "HH" || structure === "LL") {
    confidence += 20;
  } else if (structure === "HL" || structure === "LH") {
    confidence += 10;
  } else if (structure === "MIXED") {
    confidence -= 10;
  }
  
  // Boost for strong EMA slope
  const emaMagnitude = Math.abs(emaSlope);
  if (emaMagnitude > 1) {
    confidence += 15;
  } else if (emaMagnitude > 0.5) {
    confidence += 10;
  }
  
  // Boost for strong displacement
  const displacementMagnitude = Math.abs(displacement);
  if (displacementMagnitude > 2) {
    confidence += 15;
  } else if (displacementMagnitude > 1) {
    confidence += 10;
  }
  
  // Penalize flat conditions
  if (Math.abs(emaSlope) < 0.1 && Math.abs(displacement) < 0.5) {
    confidence -= 15;
  }
  
  return Math.max(0, Math.min(100, confidence));
}

/**
 * INTEGRATION POINT: Called from generateCardState to populate real htf4hTrend
 * 
 * Instead of: htf4hTrend = (hash based) ? "BULLISH" : ...
 * Now use: htf4hTrend = analyze4HStructure(candles4h).trend
 */
