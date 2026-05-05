/**
 * Risk-reward and volatility utility functions
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
    return entry + riskDistance * 2;
  } else {
    return entry - riskDistance * 2;
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
