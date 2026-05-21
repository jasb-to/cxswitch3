/**
 * Risk-reward and volatility utility functions
 * 
 * v26.0 CRITICAL FIXES:
 * - STRUCTURE SL: Set at support/resistance levels (2.5% max, wider)
 * - SNIPER SL: Set at recent swing low/high (1.5% max, tighter)
 * - SL Inflation cap: Reject any SL exceeding 1.8% for SNIPER entries
 * - STRICT SEPARATION: Never mix SNIPER SL with STRUCTURE SL sources
 * 
 * SNIPER MODE TP structure:
 * TP1 = fast protection target (1R risk moved to breakeven)
 * Runner = dynamic extension based on continuation structure
 * 
 * v21.3.2: Tighter SL cap (1.5%), decoupled TP (1R), capped runner extension
 */

import type { Candle } from "./kraken";

/**
 * v26.0 SNIPER STOP LOSS - STRICT RULES
 * MUST derive ONLY from:
 * - Last impulse swing high/low (NOT recalculated)
 * - Execution candle structure
 * Hard cap: 1.5% from entry (prevents inflation)
 * Inflation cap: Reject anything beyond 1.8%
 */
export function calculateSniperStopLoss(
  entry: number,
  recentSwingLevel: number | null,
  direction: "LONG" | "SHORT"
): number {
  const MAX_SNIPER_SL = 0.015; // Hard cap: 1.5% (tight for early entries)
  const INFLATION_CAP = 0.018; // Reject anything beyond 1.8%
  
  if (direction === "LONG") {
    const cap = entry * (1 - MAX_SNIPER_SL); // 1.5% below entry
    
    if (recentSwingLevel && recentSwingLevel > 0) {
      // Use swing low but enforce caps
      const swingBasedSL = Math.max(recentSwingLevel, cap);
      const inflationThreshold = entry * (1 - INFLATION_CAP); // 1.8% rejection level
      
      // If SL would exceed inflation cap, use hard cap instead
      if (swingBasedSL >= inflationThreshold) {
        return cap; // Reject inflated SL, use hard cap
      }
      return swingBasedSL;
    }
    return cap;
  } else {
    const cap = entry * (1 + MAX_SNIPER_SL); // 1.5% above entry
    
    if (recentSwingLevel && recentSwingLevel > 0) {
      // Use swing high but enforce caps
      const swingBasedSL = Math.min(recentSwingLevel, cap);
      const inflationThreshold = entry * (1 + INFLATION_CAP); // 1.8% rejection level
      
      // If SL would exceed inflation cap, use hard cap instead
      if (swingBasedSL <= inflationThreshold) {
        return cap; // Reject inflated SL, use hard cap
      }
      return swingBasedSL;
    }
    return cap;
  }
}

/**
 * v26.0 STRUCTURE STOP LOSS - STRICT RULES
 * ONLY used when:
 * - SNIPER SL invalidated (momentum decay)
 * - Or trading structure-confirmed holds
 * Wider cap: 2.5% from entry (respects structures)
 */
export function calculateStructureStopLoss(
  entry: number,
  supportLevel: number | null,
  resistanceLevel: number | null,
  direction: "LONG" | "SHORT"
): number {
  const MAX_STRUCTURE_SL = 0.025; // 2.5% max for structure SL (wider than SNIPER)
  
  if (direction === "LONG") {
    // For LONG: SL below support or 2.5% below entry, whichever is tighter
    const defaultSL = entry * (1 - MAX_STRUCTURE_SL);
    
    if (supportLevel && supportLevel > 0) {
      // Use support level but don't go wider than 2.5%
      return Math.max(supportLevel, defaultSL);
    }
    return defaultSL;
  } else {
    // For SHORT: SL above resistance or 2.5% above entry, whichever is tighter
    const defaultSL = entry * (1 + MAX_STRUCTURE_SL);
    
    if (resistanceLevel && resistanceLevel > 0) {
      // Use resistance level but don't go wider than 2.5%
      return Math.min(resistanceLevel, defaultSL);
    }
    return defaultSL;
  }
}

/**
 * v26.0 VALIDATE SL SEPARATION NOT VIOLATED
 * Enforce: SNIPER SL comes ONLY from swing levels
 *          STRUCTURE SL comes ONLY from support/resistance
 * Check: SNIPER SL must be tighter than STRUCTURE SL
 */
export function validateSLSeparation(
  sniperSL: number,
  structureSL: number,
  direction: "LONG" | "SHORT"
): { valid: boolean; reason?: string } {
  // SNIPER SL must be tighter (closer to entry) than STRUCTURE SL
  if (direction === "LONG") {
    if (sniperSL <= structureSL) {
      return { valid: true }; // Correct: SNIPER is tighter
    }
    return { valid: false, reason: "SNIPER SL wider than STRUCTURE SL (violation)" };
  } else {
    if (sniperSL >= structureSL) {
      return { valid: true }; // Correct: SNIPER is tighter
    }
    return { valid: false, reason: "SNIPER SL wider than STRUCTURE SL (violation)" };
  }
}

/**
 * v25.0 SNIPER SL INVALIDATION
 * SNIPER SL can be invalidated if momentum drops below threshold
 * Returns true if SL should be invalidated and reverted to STRUCTURE SL
 * Momentum-based invalidation prevents whipsaw in choppy markets
 */
export function shouldInvalidateSniperSL(
  stochRsi: number | null,
  emaSlope: number | null,
  direction: "LONG" | "SHORT"
): boolean {
  if (stochRsi === null || emaSlope === null) {
    return false; // Not enough data
  }
  
  if (direction === "LONG") {
    // For LONG: Invalidate if stoch falls below 40 AND EMA becomes flat/bearish
    if (stochRsi < 40 && emaSlope < 0.1) {
      return true; // Momentum failed - revert to wider STRUCTURE SL
    }
  } else {
    // For SHORT: Invalidate if stoch rises above 60 AND EMA becomes flat/bullish
    if (stochRsi > 60 && emaSlope > -0.1) {
      return true; // Momentum failed - revert to wider STRUCTURE SL
    }
  }
  
  return false;
}

/**
 * CAPPED STOP LOSS (v21.3.2) - DEPRECATED, use calculateSniperStopLoss or calculateStructureStopLoss
 */
export function calculateStopLoss(entry: number, swingLevel: number | null, direction: "LONG" | "SHORT"): number {
  return calculateSniperStopLoss(entry, swingLevel, direction);
}


/**
 * DECOUPLED TAKE PROFIT (v21.3.2)
 * Conservative 1R to allow early profit-taking
 * Prevents TP from inheriting inflated SL distances
 */
export function calculateTakeProfit(entry: number, stopLoss: number, direction: "LONG" | "SHORT"): number {
  const riskDistance = Math.abs(entry - stopLoss);
  if (direction === "LONG") {
    return entry + riskDistance * 1; // 1R only (was 2R)
  } else {
    return entry - riskDistance * 1; // 1R only (was 2R)
  }
}

/**
 * CAPPED RUNNER EXTENSION (v21.3.2)
 * Maximum 3x risk from entry - realistic intraday targets
 * Still respects structure but prevents excessive stretch
 */
export function calculateRunnerExtension(
  entry: number,
  tp1: number,
  candles: Candle[],
  direction: "LONG" | "SHORT"
): number {
  if (candles.length < 3) return tp1; // Not enough data

  const recent = candles.slice(-5);
  const highs = recent.map((c) => c.high);
  const lows = recent.map((c) => c.low);
  
  const MAX_RUNNER_EXTENSION = 3; // Max 3x risk from entry

  if (direction === "LONG") {
    // Trail below lowest of recent lows (trend continuation structure)
    const lowestLow = Math.min(...lows);
    const extension = lowestLow * 1.001; // 0.1% below LH as new target
    // Runner extends at least 50% beyond TP1, but capped at 3R max
    const minRunner = tp1 + Math.abs(tp1 - entry) * 0.5;
    const maxRunner = entry + Math.abs(entry - (entry * 0.985)) * MAX_RUNNER_EXTENSION;
    return Math.max(Math.min(extension, maxRunner), minRunner);
  } else {
    // Trail above highest of recent highs (trend continuation structure)
    const highestHigh = Math.max(...highs);
    const extension = highestHigh * 0.999; // 0.1% above HH as new target
    // Runner extends at least 50% beyond TP1, but capped at 3R max
    const minRunner = tp1 - Math.abs(entry - tp1) * 0.5;
    const maxRunner = entry - Math.abs((entry * 1.015) - entry) * MAX_RUNNER_EXTENSION;
    return Math.min(Math.max(extension, maxRunner), minRunner);
  }
}

export function calculateRiskReward(entry: number, tp: number, sl: number, direction: "LONG" | "SHORT"): number {
  const riskDistance = Math.abs(entry - sl);
  if (riskDistance === 0) return 0;
  const rewardDistance = Math.abs(tp - entry);
  return rewardDistance / riskDistance;
}

export function calculateVolatility(candles: Candle[]): number {
  if (candles.length < 2) return 0;
  const recent = candles.slice(-5);
  const ranges = recent.map((c) => c.high - c.low);
  const avgRange = ranges.reduce((a, b) => a + b) / ranges.length;
  const avgLow = recent.reduce((a, c) => a + c.low, 0) / recent.length;
  return avgLow > 0 ? avgRange / avgLow : 0;
}
