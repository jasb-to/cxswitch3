// CXSwitch 4H 5/13 EMA diagnostic — dashboard/cron observation only.
// IMPORTANT: This module does not participate in V28 signal generation, gating,
// stops, targets, entries, ADD logic, or execution state.

import type { Candle } from "./strategy";

export type EmaDiagnosticStage =
  | "EARLY_BULLISH_L1" | "EARLY_BULLISH_L2" | "BULLISH_CROSS" | "BULLISH_LOW" | "BULLISH_MEDIUM" | "BULLISH_HIGH"
  | "EARLY_BEARISH_L1" | "EARLY_BEARISH_L2" | "BEARISH_CROSS" | "BEARISH_LOW" | "BEARISH_MEDIUM" | "BEARISH_HIGH"
  | "NEUTRAL";

export interface EmaDiagnostic {
  stage: EmaDiagnosticStage; label: string; direction: "BULLISH" | "BEARISH" | "NEUTRAL";
  ema5: number; ema13: number; ema5Prev: number; ema13Prev: number;
  spread: number; spreadPct: number; spreadAtr: number; spreadPrev: number;
  spreadContracting: boolean; spreadChangePct: number; ema5Slope: number; ema13Slope: number;
  crossNow: boolean; candlesFromCross: number | null; closedCandleTimestamp: number;
}

function ema(values: number[], period: number): number[] {
  if (!values.length) return [];
  const k = 2 / (period + 1), out = [values[0]];
  for (let i = 1; i < values.length; i++) out.push(values[i] * k + out[i - 1] * (1 - k));
  return out;
}

function atr(candles: Candle[], period = 14): number {
  const start = Math.max(1, candles.length - period), ranges: number[] = [];
  for (let i = start; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    ranges.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
  }
  return ranges.length ? ranges.reduce((a, b) => a + b, 0) / ranges.length : 0;
}

export function get4HEmaDiagnostic(candles4h: Candle[]): EmaDiagnostic {
  const closes = candles4h.map(c => c.close);
  if (closes.length < 20) return {
    stage: "NEUTRAL", label: "NEUTRAL", direction: "NEUTRAL", ema5: 0, ema13: 0, ema5Prev: 0, ema13Prev: 0,
    spread: 0, spreadPct: 0, spreadAtr: 0, spreadPrev: 0, spreadContracting: false, spreadChangePct: 0,
    ema5Slope: 0, ema13Slope: 0, crossNow: false, candlesFromCross: null, closedCandleTimestamp: candles4h.at(-1)?.timestamp ?? 0,
  };

  const e5 = ema(closes, 5), e13 = ema(closes, 13), i = e5.length - 1, p = i - 1;
  const ema5 = e5[i], ema13 = e13[i], ema5Prev = e5[p], ema13Prev = e13[p];
  const spread = ema5 - ema13, spreadPrev = ema5Prev - ema13Prev;
  const atrValue = atr(candles4h);
  const spreadAtr = atrValue > 0 ? spread / atrValue : 0;
  const spreadContracting = Math.abs(spread) < Math.abs(spreadPrev);
  const spreadChangePct = Math.abs(spreadPrev) > 0 ? ((Math.abs(spread) - Math.abs(spreadPrev)) / Math.abs(spreadPrev)) * 100 : 0;
  const ema5Slope = ema5 - ema5Prev, ema13Slope = ema13 - ema13Prev;
  const bullishCross = ema5Prev <= ema13Prev && ema5 > ema13, bearishCross = ema5Prev >= ema13Prev && ema5 < ema13;
  const l2Threshold = atrValue > 0 ? Math.max(0.10 * atrValue, Math.abs(ema13) * 0.0005) : Math.abs(ema13) * 0.0005;
  const l1Threshold = atrValue > 0 ? Math.max(0.30 * atrValue, Math.abs(ema13) * 0.0015) : Math.abs(ema13) * 0.0015;

  let stage: EmaDiagnosticStage = "NEUTRAL";
  if (bullishCross) stage = "BULLISH_CROSS";
  else if (bearishCross) stage = "BEARISH_CROSS";
  else if (spread < 0 && spreadContracting && ema5Slope > 0) {
    stage = Math.abs(spread) <= l2Threshold ? "EARLY_BULLISH_L2" : Math.abs(spread) <= l1Threshold ? "EARLY_BULLISH_L1" : "NEUTRAL";
  } else if (spread > 0 && spreadContracting && ema5Slope < 0) {
    stage = Math.abs(spread) <= l2Threshold ? "EARLY_BEARISH_L2" : Math.abs(spread) <= l1Threshold ? "EARLY_BEARISH_L1" : "NEUTRAL";
  } else if (spread > 0) {
    stage = spreadAtr < 0.75 ? "BULLISH_LOW" : spreadAtr < 1.50 ? "BULLISH_MEDIUM" : "BULLISH_HIGH";
  } else if (spread < 0) {
    stage = Math.abs(spreadAtr) < 0.75 ? "BEARISH_LOW" : Math.abs(spreadAtr) < 1.50 ? "BEARISH_MEDIUM" : "BEARISH_HIGH";
  }

  const direction = stage.includes("BULLISH") ? "BULLISH" : stage.includes("BEARISH") ? "BEARISH" : "NEUTRAL";
  const label = stage === "EARLY_BULLISH_L1" ? "EARLY BULLISH — LEVEL 1" : stage === "EARLY_BULLISH_L2" ? "EARLY BULLISH — LEVEL 2" : stage === "BULLISH_CROSS" ? "BULLISH CROSS" : stage === "BULLISH_LOW" ? "BULLISH LOW" : stage === "BULLISH_MEDIUM" ? "BULLISH MEDIUM" : stage === "BULLISH_HIGH" ? "BULLISH HIGH" : stage === "EARLY_BEARISH_L1" ? "EARLY BEARISH — LEVEL 1" : stage === "EARLY_BEARISH_L2" ? "EARLY BEARISH — LEVEL 2" : stage === "BEARISH_CROSS" ? "BEARISH CROSS" : stage === "BEARISH_LOW" ? "BEARISH LOW" : stage === "BEARISH_MEDIUM" ? "BEARISH MEDIUM" : stage === "BEARISH_HIGH" ? "BEARISH HIGH" : "NEUTRAL";

  return {
    stage, label, direction, ema5, ema13, ema5Prev, ema13Prev, spread,
    spreadPct: ema13 !== 0 ? (spread / ema13) * 100 : 0, spreadAtr, spreadPrev,
    spreadContracting, spreadChangePct, ema5Slope, ema13Slope,
    crossNow: bullishCross || bearishCross, candlesFromCross: bullishCross || bearishCross ? 0 : null,
    closedCandleTimestamp: candles4h.at(-1)!.timestamp,
  };
}
