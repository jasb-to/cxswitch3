/**
 * Risk-reward and volatility utility functions
 * 
 * SNIPER MODE TP structure:
 * TP1 = fast protection target (1R risk moved to breakeven)
 * Runner = dynamic extension based on continuation structure
 */

import type { Candle } from "./kraken";

export function calculateStopLoss(entry: number, swingLevel: number | null, direction: "LONG" | "SHORT"): number {
  if (direction === "LONG") {
    const cap = entry * 0.985;
    return swingLevel ? Math.max(swingLevel, cap) : cap;
  } else {
    const cap = entry * 1.015;
    return swingLevel ? Math.min(swingLevel, cap) : cap;
  }
}

export function calculateTakeProfit(entry: number, stopLoss: number, direction: "LONG" | "SHORT"): number {
  const riskDistance = Math.abs(entry - stopLoss);
  if (direction === "LONG") {
    // TP = 2R for initial target (allows breakeven stop after TP1, runner extends from there)
    return entry + riskDistance * 2;
  } else {
    return entry - riskDistance * 2;
  }
}

/**
 * Calculate dynamic runner extension for CONFIRMED continuation
 * Runner extends based on structure hold — trail below HLs (long) or above LHs (short)
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

  if (direction === "LONG") {
    // Trail below lowest of recent lows (trend continuation structure)
    const lowestLow = Math.min(...lows);
    const extension = lowestLow * 1.001; // 0.1% below LH as new target
    // Runner extends at least 50% beyond TP1
    const minRunner = tp1 + Math.abs(tp1 - entry) * 0.5;
    return Math.max(extension, minRunner);
  } else {
    // Trail above highest of recent highs (trend continuation structure)
    const highestHigh = Math.max(...highs);
    const extension = highestHigh * 0.999; // 0.1% above HH as new target
    // Runner extends at least 50% beyond TP1
    const minRunner = tp1 - Math.abs(entry - tp1) * 0.5;
    return Math.min(extension, minRunner);
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
