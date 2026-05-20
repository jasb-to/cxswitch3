/**
 * Risk-reward and volatility utility functions
 * 
 * SNIPER MODE TP structure:
 * TP1 = fast protection target (1R risk moved to breakeven)
 * Runner = dynamic extension based on continuation structure
 * 
 * v21.3.2: Tighter SL cap (1.5%), decoupled TP (1R), capped runner extension
 */

import type { Candle } from "./kraken";

/**
 * CAPPED STOP LOSS (v21.3.2)
 * Hard cap: 1.5% max from entry - keeps early entries tight
 * Still respects swing levels but won't allow excessive widening
 */
export function calculateStopLoss(entry: number, swingLevel: number | null, direction: "LONG" | "SHORT"): number {
  const MAX_SL_DISTANCE = 0.015; // Hard cap: 1.5% from entry (tight for early entries)
  
  if (direction === "LONG") {
    const cap = entry * (1 - MAX_SL_DISTANCE); // 1.5% below entry
    const minimumSL = entry * 0.985; // Structural minimum (1.5%)
    
    if (swingLevel) {
      // Respect swing, but cap at maximum distance
      return Math.max(Math.max(swingLevel, minimumSL), cap);
    }
    return cap;
  } else {
    const cap = entry * (1 + MAX_SL_DISTANCE); // 1.5% above entry
    const maximumSL = entry * 1.015; // Structural maximum (1.5%)
    
    if (swingLevel) {
      // Respect swing, but cap at maximum distance
      return Math.min(Math.min(swingLevel, maximumSL), cap);
    }
    return cap;
  }
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
