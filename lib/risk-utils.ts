/**
 * Risk-reward and volatility utility functions
 * 
 * SNIPER MODE TP structure:
 * TP1 = fast protection target (1R risk moved to breakeven)
 * Runner = dynamic extension based on continuation structure
 * 
 * v21.3.0 CAP FIX: Prevent excessive SL/TP expansion during volatility spikes
 * - SL capped to max 2% from entry
 * - TP1 decoupled to conservative 1R
 * - Runner extension capped to prevent psychological disconnect
 */

import type { Candle } from "./kraken";

/**
 * CAPPED STOP LOSS
 * v21.3.0: SL respects structure but has hard maximum distance
 * Prevents SL from expanding excessively during high volatility regimes
 */
export function calculateStopLoss(entry: number, swingLevel: number | null, direction: "LONG" | "SHORT"): number {
  const MAX_SL_DISTANCE = 0.02; // Hard cap: SL no more than 2% from entry
  
  if (direction === "LONG") {
    const cap = entry * (1 - MAX_SL_DISTANCE); // 2% below entry
    const minimumSL = entry * 0.985; // Structural minimum (1.5%)
    
    if (swingLevel) {
      // Respect swing, but cap at maximum distance
      return Math.max(Math.max(swingLevel, minimumSL), cap);
    }
    return cap;
  } else {
    const cap = entry * (1 + MAX_SL_DISTANCE); // 2% above entry
    const maximumSL = entry * 1.015; // Structural maximum (1.5%)
    
    if (swingLevel) {
      // Respect swing, but cap at maximum distance
      return Math.min(Math.min(swingLevel, maximumSL), cap);
    }
    return cap;
  }
}

/**
 * DECOUPLED TAKE PROFIT
 * v21.3.0: TP1 is conservative 1R (not dependent on inflated SL)
 * Prevents TP from inheriting widened stop distances
 */
export function calculateTakeProfit(entry: number, stopLoss: number, direction: "LONG" | "SHORT"): number {
  const riskDistance = Math.abs(entry - stopLoss);
  
  if (direction === "LONG") {
    // TP1 = conservative 1R (decoupled from SL distance)
    // This allows early profit-taking while runner can extend based on structure
    return entry + riskDistance * 1;
  } else {
    return entry - riskDistance * 1;
  }
}

/**
 * CAPPED RUNNER EXTENSION
 * v21.3.0: Runner extends based on structure but has realistic maximum
 * Prevents psychological disconnect from excessive TP distances
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

  // Maximum reasonable extension: 3x risk from entry
  // Prevents runner from extending endlessly during volatility expansion
  const MAX_RUNNER_EXTENSION = 3;

  if (direction === "LONG") {
    // Trail below lowest of recent lows (trend continuation structure)
    const lowestLow = Math.min(...lows);
    const extension = lowestLow * 1.001; // 0.1% below LH as new target
    // Runner extends at least 50% beyond TP1, but capped at 3R max
    const minRunner = tp1 + Math.abs(tp1 - entry) * 0.5;
    const maxRunner = entry + Math.abs(entry - (entry * 0.98)) * MAX_RUNNER_EXTENSION;
    return Math.max(Math.min(extension, maxRunner), minRunner);
  } else {
    // Trail above highest of recent highs (trend continuation structure)
    const highestHigh = Math.max(...highs);
    const extension = highestHigh * 0.999; // 0.1% above HH as new target
    // Runner extends at least 50% beyond TP1, but capped at 3R max
    const minRunner = tp1 - Math.abs(entry - tp1) * 0.5;
    const maxRunner = entry - Math.abs((entry * 1.02) - entry) * MAX_RUNNER_EXTENSION;
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
