// lib/strategy.ts — v30.5 "Production complete: all 14 review issues resolved"
// ============================================================
// CHANGELOG v30.5:
//   1. Accumulation window excludes current candle (breakout candle isolated)
//   2. HTF bias requires 55+ daily candles for reliable EMA50
//   3. Stochastic exhaustion is a HARD BLOCK (EXHAUSTION stage)
//   4. Zone hash uses 2-decimal precision + 4h TTL + 50-entry cap
//   5. lastBreakoutTs prevents duplicate signals from same candle
//   6. ADX calculated once and reused
//   7. updateTrail has NaN protection with safe fallback
//   8. Touch scoring weight increased (touches * 15)
//   9. Volume decline relaxed to 0.92
//   10. SignalResult type cleaned (signal: Signal | null, market: any)
//   11. candles15m used for lower-timeframe breakout confirmation
//   12. Added minimum candle validation guards
//   13. Added 15M alignment check for breakout confirmation
//   14. Consumed zone cleanup runs before every signal generation
// ============================================================

import { getPairState, setPairState } from "./state";

export interface Candle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface Signal {
  id: string;
  pair: string;
  direction: "LONG" | "SHORT";
  stage: "WATCHING" | "ACCUMULATION" | "READY" | "CONFIRMED";
  entry: number;
  stop: number;
  target: number;
  trail: number;
  confidence: number;
  rr: number;
  adx: number;
  zoneTop: number;
  zoneBottom: number;
  explanation: string;
  timestamp: number;
  version: number;
}

export interface SignalResult {
  signal: Signal | null;
  market: any;
  debug: string[];
  stage: "NONE" | "WATCHING" | "ACCUMULATION" | "READY" | "CONFIRMED" | "EXPANSION" | "EXHAUSTION";
}

export const CURRENT_SIGNAL_VERSION = 30;

// ─── Config ──────────────────────────────────────────────────────────────

const ACCUM_MIN_CANDLES = 6;
const ACCUM_MAX_CANDLES = 40;
const ACCUM_MAX_WIDTH_ATR = 2.5;
const ACCUM_MIN_TOUCHES = 2;
const ACCUM_VOLUME_DECLINE = 0.92;  // Relaxed from 0.85 → 0.90 → 0.92

const BREAKOUT_MIN_BODY_ATR = 0.25;
const BREAKOUT_CONFIRM_CLOSE = true;

const STOCH_EXTREME_LOW = 15;
const STOCH_EXTREME_HIGH = 85;
const STOCH_CONFIDENCE_PENALTY = 15;

const REQUIRE_HTF_ALIGNMENT = true;
const REQUIRE_15M_ALIGNMENT = true;  // NEW: 15M confirmation for breakouts
const EXIT_COOLDOWN_MS = 30 * 60 * 1000;
const ZONE_CONSUMED_TTL_MS = 4 * 60 * 60 * 1000;
const MAX_CONSUMED_ZONES = 50;

const MIN_CANDLES_1H = 60;   // Minimum for reliable ATR + StochRSI + EMA21
const MIN_CANDLES_4H = 350;  // Minimum for 55+ daily candles + ADX + EMAs

// ─── Helpers ─────────────────────────────────────────────────────────────

function avg(arr: number[]): number {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function ema(values: number[], period: number): number[] {
  if (values.length < period) return values.map(() => values[values.length - 1]);
  const k = 2 / (period + 1);
  const result: number[] = [values[0]];
  for (let i = 1; i < values.length; i++) {
    result.push(values[i] * k + result[i - 1] * (1 - k));
  }
  return result;
}

function atr(candles: Candle[], period: number = 14): number[] {
  if (candles.length < period + 1) return [];
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
  }
  const result: number[] = [];
  for (let i = period - 1; i < trs.length; i++) {
    result.push(avg(trs.slice(i - period + 1, i + 1)));
  }
  return result;
}

function trueRange(c: Candle, p: Candle): number {
  return Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
}

function stochRsi(closes: number[]): { k: number; d: number } {
  if (closes.length < 28) return { k: 50, d: 50 };
  const rsiValues: number[] = [];
  for (let i = 14; i < closes.length; i++) {
    const window = closes.slice(0, i + 1);
    let gains = 0, losses = 0;
    for (let j = 1; j <= 14; j++) {
      const change = window[window.length - 1 - j] - window[window.length - 2 - j];
      if (change > 0) gains += change;
      else losses += Math.abs(change);
    }
    const avgGain = gains / 14;
    const avgLoss = losses / 14;
    rsiValues.push(avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss)));
  }
  if (rsiValues.length < 14) return { k: 50, d: 50 };

  const rawK: number[] = [];
  for (let i = 13; i < rsiValues.length; i++) {
    const w = rsiValues.slice(i - 13, i + 1);
    const lo = Math.min(...w), hi = Math.max(...w);
    rawK.push(hi === lo ? 50 : ((rsiValues[i] - lo) / (hi - lo)) * 100);
  }

  const kValues: number[] = [];
  for (let i = 2; i < rawK.length; i++) {
    kValues.push(avg(rawK.slice(i - 2, i + 1)));
  }

  if (kValues.length < 3) return { k: 50, d: 50 };
  return { k: Math.round(kValues[kValues.length - 1] * 10) / 10, d: Math.round(avg(kValues.slice(-3)) * 10) / 10 };
}

function adx(candles: Candle[]): number {
  if (candles.length < 27) return 0;
  const trs: number[] = [];
  const plusDMs: number[] = [];
  const minusDMs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
    plusDMs.push(c.high - p.high > p.low - c.low ? Math.max(c.high - p.high, 0) : 0);
    minusDMs.push(p.low - c.low > c.high - p.high ? Math.max(p.low - c.low, 0) : 0);
  }
  const atrSmooth = [avg(trs.slice(0, 14))];
  const plusDISmooth = [avg(plusDMs.slice(0, 14))];
  const minusDISmooth = [avg(minusDMs.slice(0, 14))];
  for (let i = 14; i < trs.length; i++) {
    atrSmooth.push((atrSmooth[atrSmooth.length - 1] * 13 + trs[i]) / 14);
    plusDISmooth.push((plusDISmooth[plusDISmooth.length - 1] * 13 + plusDMs[i]) / 14);
    minusDISmooth.push((minusDISmooth[minusDISmooth.length - 1] * 13 + minusDMs[i]) / 14);
  }
  const dxValues: number[] = [];
  for (let i = 0; i < atrSmooth.length; i++) {
    const pDI = (plusDISmooth[i] / atrSmooth[i]) * 100;
    const mDI = (minusDISmooth[i] / atrSmooth[i]) * 100;
    dxValues.push((pDI + mDI === 0) ? 0 : (Math.abs(pDI - mDI) / (pDI + mDI)) * 100);
  }
  const adxSmooth = [avg(dxValues.slice(0, 14))];
  for (let i = 14; i < dxValues.length; i++) {
    adxSmooth.push((adxSmooth[adxSmooth.length - 1] * 13 + dxValues[i]) / 14);
  }
  return Math.round(adxSmooth[adxSmooth.length - 1] * 10) / 10;
}

// ─── Higher Timeframe Bias (4H) ────────────────────────────────────────

function higherTimeframeBias(candles4h: Candle[]): "BULLISH" | "BEARISH" | "NEUTRAL" {
  const daily = aggregateTo1D(candles4h);
  // FIX #2: Require 55+ daily candles for reliable EMA50
  if (daily.length < 55) {
    return "NEUTRAL";
  }
  const closes = daily.map(c => c.close);
  const ema8 = ema(closes, 8);
  const ema21 = ema(closes, 21);
  const ema50 = ema(closes, 50);
  const last8 = ema8[ema8.length - 1];
  const last21 = ema21[ema21.length - 1];
  const last50 = ema50[ema50.length - 1];

  if (last8 > last21 && last21 > last50) return "BULLISH";
  if (last8 < last21 && last21 < last50) return "BEARISH";
  return "NEUTRAL";
}

function aggregateTo1D(candles4h: Candle[]): Candle[] {
  const sorted = [...candles4h].sort((a, b) => a.timestamp - b.timestamp);
  const groups: Map<string, Candle[]> = new Map();
  for (const c of sorted) {
    const d = new Date(c.timestamp);
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(c);
  }
  const daily: Candle[] = [];
  for (const [key, bars] of Array.from(groups.entries()).sort((a, b) => a[0].localeCompare(b[0]))) {
    if (!bars.length) continue;
    daily.push({
      timestamp: bars[0].timestamp,
      open: bars[0].open,
      high: Math.max(...bars.map(b => b.high)),
      low: Math.min(...bars.map(b => b.low)),
      close: bars[bars.length - 1].close,
      volume: bars.reduce((s, b) => s + b.volume, 0),
    });
  }
  return daily.sort((a, b) => a.timestamp - b.timestamp);
}

// ─── STATE PERSISTENCE ───────────────────────────────────────────────────

interface PairState {
  stage: "NONE" | "WATCHING" | "ACCUMULATION" | "READY" | "CONFIRMED";
  zoneTop: number | null;
  zoneBottom: number | null;
  zoneStartIndex: number;
  zoneEndIndex: number;
  lastExitAt: number;
  consumedZones: string[];
  consumedZoneTimes: Record<string, number>;
  lastBreakoutTs: number;
}

function hashZone(top: number, bottom: number): string {
  // FIX #4: 2-decimal precision prevents collision of nearby zones
  return `${top.toFixed(2)}_${bottom.toFixed(2)}`;
}

async function getPersistedState(pair: string): Promise<PairState> {
  const raw = await getPairState(pair);
  return {
    stage: raw.stage || "NONE",
    zoneTop: raw.zoneTop ?? null,
    zoneBottom: raw.zoneBottom ?? null,
    zoneStartIndex: raw.zoneStartIndex || 0,
    zoneEndIndex: raw.zoneEndIndex || 0,
    lastExitAt: raw.lastExitAt || 0,
    consumedZones: Array.isArray(raw.consumedZones) ? raw.consumedZones : [],
    consumedZoneTimes: raw.consumedZoneTimes && typeof raw.consumedZoneTimes === "object" ? raw.consumedZoneTimes : {},
    lastBreakoutTs: raw.lastBreakoutTs || 0,
  };
}

async function persistState(pair: string, state: Partial<PairState>): Promise<void> {
  const existing = await getPersistedState(pair);
  await setPairState(pair, { ...existing, ...state });
}

// ─── Clean expired consumed zones ────────────────────────────────────────

async function cleanConsumedZones(state: PairState, debug: string[]): Promise<PairState> {
  const now = Date.now();
  const freshZones: string[] = [];
  const freshTimes: Record<string, number> = {};

  for (const zh of state.consumedZones) {
    const consumedAt = state.consumedZoneTimes[zh] || 0;
    if (now - consumedAt < ZONE_CONSUMED_TTL_MS) {
      freshZones.push(zh);
      freshTimes[zh] = consumedAt;
    } else {
      debug.push(`ZONE EXPIRED: ${zh} consumed ${Math.round((now - consumedAt) / 60000)}m ago, clearing`);
    }
  }

  // FIX #5: Hard cap at MAX_CONSUMED_ZONES most recent
  if (freshZones.length > MAX_CONSUMED_ZONES) {
    const sorted = freshZones
      .map(z => ({ zone: z, time: freshTimes[z] || 0 }))
      .sort((a, b) => b.time - a.time)
      .slice(0, MAX_CONSUMED_ZONES);
    const trimmedZones = sorted.map(s => s.zone);
    const trimmedTimes: Record<string, number> = {};
    for (const s of sorted) trimmedTimes[s.zone] = s.time;
    debug.push(`TRIMMED consumedZones from ${freshZones.length} to ${MAX_CONSUMED_ZONES}`);
    return { ...state, consumedZones: trimmedZones, consumedZoneTimes: trimmedTimes };
  }

  return { ...state, consumedZones: freshZones, consumedZoneTimes: freshTimes };
}

// ─── ACCUMULATION DETECTION (1H) — current candle excluded ─────────────

interface AccumulationZone {
  top: number;
  bottom: number;
  startIndex: number;
  endIndex: number;
  touches: number;
  avgVolume: number;
  widthATR: number;
}

function detectAccumulation(pair: string, candles1h: Candle[], debug: string[]): AccumulationZone | null {
  // FIX #1/#2/#3: Accumulation ends at previous candle; current candle is for breakout only
  const last = candles1h.length - 2;
  if (last < ACCUM_MIN_CANDLES + 14) {
    debug.push(`ACCUM: insufficient 1H candles (${candles1h.length} need >= ${ACCUM_MIN_CANDLES + 14 + 1})`);
    return null;
  }

  const atrSeries = atr(candles1h, 14);
  const currentATR = atrSeries[atrSeries.length - 1] || 1;

  debug.push(`ACCUM SCAN: last=${last} ATR=${currentATR.toFixed(4)} minCandles=${ACCUM_MIN_CANDLES} maxCandles=${ACCUM_MAX_CANDLES} maxWidthATR=${getAccumMaxWidthATR(pair)}`);

  let bestZone: AccumulationZone | null = null;
  let bestScore = -1;

  for (let windowSize = ACCUM_MIN_CANDLES; windowSize <= Math.min(ACCUM_MAX_CANDLES, last); windowSize++) {
    const start = last - windowSize + 1;
    const zoneCandles = candles1h.slice(start, last + 1);

    const highs = zoneCandles.map(c => c.high);
    const lows = zoneCandles.map(c => c.low);
    const top = Math.max(...highs);
    const bottom = Math.min(...lows);
    const width = top - bottom;
    const widthATR = currentATR > 0 ? width / currentATR : 999;

    if (windowSize <= 12 || windowSize % 5 === 0) {
      debug.push(`ACCUM[${windowSize}]: top=${top.toFixed(2)} bottom=${bottom.toFixed(2)} width=${width.toFixed(4)} widthATR=${widthATR.toFixed(2)}`);
    }

    if (widthATR > getAccumMaxWidthATR(pair)) {
      if (windowSize <= 10) debug.push(`ACCUM[${windowSize}]: REJECTED widthATR=${widthATR.toFixed(2)} > ${getAccumMaxWidthATR(pair)}`);
      continue;
    }

    let touches = 0;
    for (const c of zoneCandles) {
      const touchTop = width > 0 && Math.abs(c.high - top) / width < 0.20;
      const touchBottom = width > 0 && Math.abs(c.low - bottom) / width < 0.20;
      if (touchTop || touchBottom) touches++;
    }

    if (touches < ACCUM_MIN_TOUCHES) {
      debug.push(`ACCUM[${windowSize}]: REJECTED touches=${touches} < ${ACCUM_MIN_TOUCHES}`);
      continue;
    }

    const firstHalf = zoneCandles.slice(0, Math.floor(zoneCandles.length / 2));
    const secondHalf = zoneCandles.slice(Math.floor(zoneCandles.length / 2));
    const volFirst = avg(firstHalf.map(c => c.volume));
    const volSecond = avg(secondHalf.map(c => c.volume));
    const volRatio = volFirst > 0 ? volSecond / volFirst : 1;

    // FIX #12: Relaxed volume decline (0.92)
    if (volRatio > ACCUM_VOLUME_DECLINE) {
      debug.push(`ACCUM[${windowSize}]: REJECTED volRatio=${volRatio.toFixed(2)} > ${ACCUM_VOLUME_DECLINE}`);
      continue;
    }

    // FIX #11: Stronger touch weighting (touches * 15 instead of * 5)
    const score = (100 - widthATR * 20) + touches * 15;
    debug.push(`ACCUM[${windowSize}]: CANDIDATE top=${top.toFixed(2)} bottom=${bottom.toFixed(2)} width=${width.toFixed(4)} (${widthATR.toFixed(2)}x ATR) touches=${touches} volRatio=${volRatio.toFixed(2)} score=${score.toFixed(1)}`);

    if (score > bestScore) {
      bestScore = score;
      bestZone = {
        top,
        bottom,
        startIndex: start,
        endIndex: last,
        touches,
        avgVolume: avg(zoneCandles.map(c => c.volume)),
        widthATR,
      };
    }
  }

  if (bestZone) {
    debug.push(`ACCUM SELECTED: [${bestZone.startIndex}-${bestZone.endIndex}] top=${bestZone.top.toFixed(2)} bottom=${bestZone.bottom.toFixed(2)} width=${(bestZone.top - bestZone.bottom).toFixed(4)} (${bestZone.widthATR.toFixed(2)}x ATR) touches=${bestZone.touches}`);
    return bestZone;
  }

  debug.push("ACCUM: no tight accumulation zone found on 1H");
  return null;
}

// ─── BREAKOUT DETECTION (current candle only) ────────────────────────────

interface BreakoutResult {
  detected: boolean;
  direction: "LONG" | "SHORT" | null;
  candle: Candle | null;
  reason: string;
}

function checkBreakout(
  candles1h: Candle[],
  zone: AccumulationZone,
  debug: string[]
): BreakoutResult {
  const current = candles1h[candles1h.length - 1];

  debug.push(`BREAKOUT CHECK: close=${current.close.toFixed(2)} open=${current.open.toFixed(2)} zone=${zone.bottom.toFixed(2)}-${zone.top.toFixed(2)}`);

  let beyondZone = false;
  let direction: "LONG" | "SHORT" | null = null;

  if (BREAKOUT_CONFIRM_CLOSE) {
    if (current.close > zone.top) {
      beyondZone = true;
      direction = "LONG";
    } else if (current.close < zone.bottom) {
      beyondZone = true;
      direction = "SHORT";
    }
  } else {
    if (current.high > zone.top) {
      beyondZone = true;
      direction = "LONG";
    } else if (current.low < zone.bottom) {
      beyondZone = true;
      direction = "SHORT";
    }
  }

  if (!beyondZone) {
    debug.push(`BREAKOUT: no breakout — close=${current.close.toFixed(2)} inside zone ${zone.bottom.toFixed(2)}-${zone.top.toFixed(2)}`);
    return { detected: false, direction: null, candle: null, reason: "no_breakout" };
  }

  const atrSeries = atr(candles1h, 14);
  const currentATR = atrSeries[atrSeries.length - 1] || 1;
  const body = Math.abs(current.close - current.open);
  const bodyATR = currentATR > 0 ? body / currentATR : 0;

  debug.push(`BREAKOUT: beyond zone dir=${direction} body=${body.toFixed(2)} (${bodyATR.toFixed(2)}x ATR)`);

  if (bodyATR < BREAKOUT_MIN_BODY_ATR) {
    debug.push(`BREAKOUT: body too small (${bodyATR.toFixed(2)} < ${BREAKOUT_MIN_BODY_ATR})`);
    return { detected: false, direction: null, candle: null, reason: "body_too_small" };
  }

  debug.push(`BREAKOUT: ${direction} confirmed close=${current.close.toFixed(2)} beyond zone`);
  return { detected: true, direction, candle: current, reason: `breakout_${direction?.toLowerCase()}` };
}

// ─── 15M CONFIRMATION (lower timeframe alignment) ────────────────────────

function check15MAlignment(
  candles15m: Candle[],
  direction: "LONG" | "SHORT",
  debug: string[]
): { aligned: boolean; reason: string } {
  if (!candles15m || candles15m.length < 1) {
    debug.push("15M: no data available, skipping confirmation");
    return { aligned: true, reason: "no_15m_data" };
  }

  const last15m = candles15m[candles15m.length - 1];
  const isBullish = last15m.close > last15m.open;
  const isBearish = last15m.close < last15m.open;

  if (direction === "LONG" && isBullish) {
    debug.push(`15M: aligned bullish (close=${last15m.close.toFixed(2)} > open=${last15m.open.toFixed(2)})`);
    return { aligned: true, reason: "15m_aligned" };
  }
  if (direction === "SHORT" && isBearish) {
    debug.push(`15M: aligned bearish (close=${last15m.close.toFixed(2)} < open=${last15m.open.toFixed(2)})`);
    return { aligned: true, reason: "15m_aligned" };
  }

  debug.push(`15M: MISALIGNED — direction=${direction} but 15M candle is ${isBullish ? "bullish" : isBearish ? "bearish" : "neutral"}`);
  return { aligned: false, reason: `15m_misaligned_${direction.toLowerCase()}` };
}

// ─── Signal Builder ─────────────────────────────────────────────────────

function buildSignal(
  pair: string,
  direction: "LONG" | "SHORT",
  zone: AccumulationZone,
  candles1h: Candle[],
  candles4h: Candle[],
  htBias: "BULLISH" | "BEARISH" | "NEUTRAL",
  stochK: number,
  adx4h: number,
  debug: string[]
): { signal: Signal; market: any } | null {
  const entry = candles1h[candles1h.length - 1].close;
  const zoneHeight = zone.top - zone.bottom;

  const closes1h = candles1h.map(c => c.close);
  const atr1h = atr(candles1h, 14);
  const currentATR = atr1h[atr1h.length - 1] || zoneHeight * 0.5;

  const swingStop = direction === "LONG" ? zone.bottom : zone.top;
  const atrStop = direction === "LONG"
    ? entry - currentATR * 1.5
    : entry + currentATR * 1.5;

  const stop = direction === "LONG"
    ? Math.min(swingStop, atrStop)
    : Math.max(swingStop, atrStop);

  const risk = Math.abs(entry - stop);
  const target = direction === "LONG" ? entry + risk * 2.5 : entry - risk * 2.5;

  const ema21 = ema(closes1h, 21);
  const trail = direction === "LONG"
    ? ema21[ema21.length - 1] - currentATR * 0.5
    : ema21[ema21.length - 1] + currentATR * 0.5;

  const rr = risk > 0 ? Math.abs(target - entry) / risk : 0;

  let confidence = 50;

  if (zone.widthATR < 1.5) confidence += 20;
  else if (zone.widthATR < 2.0) confidence += 10;

  if (zone.touches >= 5) confidence += 10;
  else if (zone.touches >= 3) confidence += 5;

  if (adx4h > 30) confidence += 10;
  else if (adx4h > 20) confidence += 5;

  if (direction === "SHORT" && stochK < STOCH_EXTREME_LOW) {
    confidence -= STOCH_CONFIDENCE_PENALTY;
    debug.push(`CONFIDENCE: Stoch K=${stochK} oversold, -${STOCH_CONFIDENCE_PENALTY}% for SHORT`);
  }
  if (direction === "LONG" && stochK > STOCH_EXTREME_HIGH) {
    confidence -= STOCH_CONFIDENCE_PENALTY;
    debug.push(`CONFIDENCE: Stoch K=${stochK} overbought, -${STOCH_CONFIDENCE_PENALTY}% for LONG`);
  }

  confidence = Math.min(95, Math.max(25, confidence));

  const explanation = `${direction} BREAKOUT (1H): Accumulation zone ${zone.bottom.toFixed(0)}-${zone.top.toFixed(0)} (${zone.widthATR.toFixed(1)}x ATR, ${zone.touches} touches) broken. HTF=${htBias}, ADX(4H)=${adx4h.toFixed(1)}, StochK=${stochK}`;

  const signal: Signal = {
    id: `${pair}_${Date.now()}`,
    pair,
    direction,
    stage: "CONFIRMED",
    entry: Math.round(entry * 100) / 100,
    stop: Math.round(stop * 100) / 100,
    target: Math.round(target * 100) / 100,
    trail: Math.round(trail * 100) / 100,
    confidence,
    rr: Math.round(rr * 100) / 100,
    adx: adx4h,
    zoneTop: Math.round(zone.top * 100) / 100,
    zoneBottom: Math.round(zone.bottom * 100) / 100,
    explanation,
    timestamp: Date.now(),
    version: CURRENT_SIGNAL_VERSION,
  };

  const trend1d = htBias === "BULLISH" ? "LONG" : htBias === "BEARISH" ? "SHORT" : "MIXED";
  const stoch = stochRsi(closes1h);

  const market = {
    pair,
    price: Math.round(entry * 100) / 100,
    timestamp: Date.now(),
    phase: "EXPANSION",
    trend: trend1d,
    htfBias: htBias,
    adx: adx4h,
    rsi: 0,
    stochK: stoch.k,
    stochD: stoch.d,
    zoneTop: signal.zoneTop,
    zoneBottom: signal.zoneBottom,
    zoneScore: confidence,
    zoneQuality: {
      age: zone.endIndex - zone.startIndex,
      widthATR: zone.widthATR,
      compression: Math.max(0, 100 - zone.widthATR * 30),
      volumeDecay: 0,
      touches: zone.touches,
      breakAttempts: 0,
      label: zone.widthATR < 1.5 ? "EXCELLENT" : zone.widthATR < 2.0 ? "GOOD" : "AVERAGE",
    },
    closes4h: candles4h.slice(-50).map(c => c.close),
  };

  debug.push(`SIGNAL: ${direction} CONFIRMED entry=${signal.entry} stop=${signal.stop} target=${signal.target} trail=${signal.trail} RR=${signal.rr} conf=${confidence}%`);

  return { signal, market };
}

// ─── MAIN GENERATOR ────────────────────────────────────────────────────

export async function generateSignal(
  pair: string,
  candles1h: Candle[],
  candles4h: Candle[],
  candles15m: Candle[],
  currentPrice?: number
): Promise<SignalResult> {
  const debug: string[] = [];
  const price = currentPrice ?? candles1h[candles1h.length - 1]?.close ?? 0;

  // ── GUARD: Minimum candle requirements ─────────────────────
  if (!candles1h || candles1h.length < MIN_CANDLES_1H) {
    debug.push(`GUARD: insufficient 1H candles (${candles1h?.length || 0} < ${MIN_CANDLES_1H})`);
    return {
      signal: null,
      market: { pair, price, timestamp: Date.now(), phase: "NONE", error: "insufficient_1h_data" },
      debug,
      stage: "NONE",
    };
  }
  if (!candles4h || candles4h.length < MIN_CANDLES_4H) {
    debug.push(`GUARD: insufficient 4H candles (${candles4h?.length || 0} < ${MIN_CANDLES_4H})`);
    return {
      signal: null,
      market: { pair, price, timestamp: Date.now(), phase: "NONE", error: "insufficient_4h_data" },
      debug,
      stage: "NONE",
    };
  }

  let state = await getPersistedState(pair);
  const closes1h = candles1h.map(c => c.close);
  const stoch = stochRsi(closes1h);
  const htBias = higherTimeframeBias(candles4h);
  // FIX #9: ADX calculated once and reused
  const adx4h = adx(candles4h);
  const trend1d = htBias === "BULLISH" ? "LONG" : htBias === "BEARISH" ? "SHORT" : "MIXED";

  debug.push(`HTF(4H): ${htBias} | Stage: ${state.stage} | StochK(1H)=${stoch.k} | ADX(4H)=${adx4h}`);

  // ── COOLDOWN CHECK ──────────────────────────────────────────
  if (state.lastExitAt > 0) {
    const timeSinceExit = Date.now() - state.lastExitAt;
    if (timeSinceExit < EXIT_COOLDOWN_MS) {
      debug.push(`COOLDOWN: ${Math.round(timeSinceExit / 1000)}s since exit, need ${Math.round(EXIT_COOLDOWN_MS / 1000)}s`);
      return {
        signal: null,
        market: {
          pair, price, timestamp: Date.now(),
          phase: "NONE", trend: trend1d,
          htfBias: htBias, adx: adx4h, rsi: 0,
          stochK: stoch.k, stochD: stoch.d,
          zoneTop: null, zoneBottom: null, zoneScore: 0,
        },
        debug,
        stage: "NONE",
      };
    }
  }

  // ── CLEAN EXPIRED CONSUMED ZONES ────────────────────────────
  state = await cleanConsumedZones(state, debug);

  // ── STEP 1: DETECT ACCUMULATION ON 1H (excludes current candle) ──
  const zone = detectAccumulation(pair, candles1h, debug);

  if (!zone) {
    return {
      signal: null,
      market: {
        pair, price, timestamp: Date.now(),
        phase: "NONE", trend: trend1d,
        htfBias: htBias, adx: adx4h, rsi: 0,
        stochK: stoch.k, stochD: stoch.d,
        zoneTop: null, zoneBottom: null, zoneScore: 0,
      },
      debug,
      stage: "NONE",
    };
  }

  // ── STEP 2: CHECK IF ZONE ALREADY CONSUMED ──────────────────
  const zoneHash = hashZone(zone.top, zone.bottom);
  if (state.consumedZones.includes(zoneHash)) {
    debug.push(`ZONE CONSUMED: ${zoneHash} already traded (within ${ZONE_CONSUMED_TTL_MS / 3600000}h window)`);
    return {
      signal: null,
      market: {
        pair, price, timestamp: Date.now(),
        phase: "NONE", trend: trend1d,
        htfBias: htBias, adx: adx4h, rsi: 0,
        stochK: stoch.k, stochD: stoch.d,
        zoneTop: zone.top, zoneBottom: zone.bottom, zoneScore: 0,
      },
      debug,
      stage: "NONE",
    };
  }

  // ── STEP 3: CHECK FOR BREAKOUT ON CURRENT 1H CANDLE ───────
  const breakout = checkBreakout(candles1h, zone, debug);

  if (!breakout.detected || !breakout.direction) {
    debug.push(`WATCHING: 1H accumulation detected, waiting for breakout`);

    await persistState(pair, {
      stage: "WATCHING",
      zoneTop: zone.top,
      zoneBottom: zone.bottom,
      zoneStartIndex: zone.startIndex,
      zoneEndIndex: zone.endIndex,
    });

    return {
      signal: null,
      market: {
        pair, price, timestamp: Date.now(),
        phase: "WATCHING", trend: trend1d,
        htfBias: htBias, adx: adx4h, rsi: 0,
        stochK: stoch.k, stochD: stoch.d,
        zoneTop: zone.top, zoneBottom: zone.bottom,
        zoneScore: 40,
        zoneQuality: {
          age: zone.endIndex - zone.startIndex,
          widthATR: zone.widthATR,
          compression: Math.max(0, 100 - zone.widthATR * 30),
          touches: zone.touches,
          label: zone.widthATR < 1.5 ? "EXCELLENT" : zone.widthATR < 2.0 ? "GOOD" : "AVERAGE",
        },
      },
      debug,
      stage: "WATCHING",
    };
  }

  // ── STEP 4: HTF ALIGNMENT (4H) ─────────────────────────────
  if (REQUIRE_HTF_ALIGNMENT) {
    const aligned =
      (breakout.direction === "LONG" && (htBias === "BULLISH" || htBias === "NEUTRAL")) ||
      (breakout.direction === "SHORT" && (htBias === "BEARISH" || htBias === "NEUTRAL"));

    if (!aligned) {
      debug.push(`BLOCKED: ${breakout.direction} breakout but HTF(4H) is ${htBias}`);
      return {
        signal: null,
        market: {
          pair, price, timestamp: Date.now(),
          phase: "NONE", trend: trend1d,
          htfBias: htBias, adx: adx4h, rsi: 0,
          stochK: stoch.k, stochD: stoch.d,
          zoneTop: zone.top, zoneBottom: zone.bottom, zoneScore: 0,
        },
        debug,
        stage: "NONE",
      };
    }
  }

  // ── STEP 5: 15M LOWER TIMEFRAME CONFIRMATION ───────────────
  // FIX #14: candles15m now used for breakout confirmation
  if (REQUIRE_15M_ALIGNMENT && candles15m && candles15m.length > 0) {
    const alignment = check15MAlignment(candles15m, breakout.direction, debug);
    if (!alignment.aligned) {
      debug.push(`BLOCKED: ${breakout.direction} breakout rejected by 15M misalignment`);
      return {
        signal: null,
        market: {
          pair, price, timestamp: Date.now(),
          phase: "NONE", trend: trend1d,
          htfBias: htBias, adx: adx4h, rsi: 0,
          stochK: stoch.k, stochD: stoch.d,
          zoneTop: zone.top, zoneBottom: zone.bottom, zoneScore: 0,
        },
        debug,
        stage: "NONE",
      };
    }
  }

  // ── STEP 6: STOCHASTIC EXHAUSTION HARD BLOCK ────────────────
  // FIX #7: Exhaustion now returns EXHAUSTION stage, no signal generated
  if (breakout.direction === "SHORT" && stoch.k < STOCH_EXTREME_LOW) {
    debug.push(`EXHAUSTION: Stoch K=${stoch.k} < ${STOCH_EXTREME_LOW}, blocking SHORT`);
    return {
      signal: null,
      market: {
        pair, price, timestamp: Date.now(),
        phase: "EXHAUSTION", trend: trend1d,
        htfBias: htBias, adx: adx4h, rsi: 0,
        stochK: stoch.k, stochD: stoch.d,
        zoneTop: zone.top, zoneBottom: zone.bottom, zoneScore: 0,
      },
      debug,
      stage: "EXHAUSTION",
    };
  }
  if (breakout.direction === "LONG" && stoch.k > STOCH_EXTREME_HIGH) {
    debug.push(`EXHAUSTION: Stoch K=${stoch.k} > ${STOCH_EXTREME_HIGH}, blocking LONG`);
    return {
      signal: null,
      market: {
        pair, price, timestamp: Date.now(),
        phase: "EXHAUSTION", trend: trend1d,
        htfBias: htBias, adx: adx4h, rsi: 0,
        stochK: stoch.k, stochD: stoch.d,
        zoneTop: zone.top, zoneBottom: zone.bottom, zoneScore: 0,
      },
      debug,
      stage: "EXHAUSTION",
    };
  }

  // ── STEP 7: BUILD SIGNAL ──────────────────────────────────
  const built = buildSignal(pair, breakout.direction, zone, candles1h, candles4h, htBias, stoch.k, adx4h, debug);

  if (!built) {
    debug.push("Signal build failed");
    return {
      signal: null,
      market: {
        pair, price, timestamp: Date.now(),
        phase: "NONE", trend: trend1d,
        htfBias: htBias, adx: adx4h, rsi: 0,
        stochK: stoch.k, stochD: stoch.d,
        zoneTop: null, zoneBottom: null, zoneScore: 0,
      },
      debug,
      stage: "NONE",
    };
  }

  // ── STEP 8: DUPLICATE BREAKOUT PREVENTION ──────────────────
  // FIX #6: lastBreakoutTs now prevents duplicate signals from same candle
  if (breakout.candle && state.lastBreakoutTs === breakout.candle.timestamp) {
    debug.push(`DUPLICATE BREAKOUT: same candle timestamp ${breakout.candle.timestamp}, skipping`);
    return {
      signal: null,
      market: {
        pair, price, timestamp: Date.now(),
        phase: "NONE", trend: trend1d,
        htfBias: htBias, adx: adx4h, rsi: 0,
        stochK: stoch.k, stochD: stoch.d,
        zoneTop: zone.top, zoneBottom: zone.bottom, zoneScore: 0,
      },
      debug,
      stage: "NONE",
    };
  }

  // ── STEP 9: PERSIST CONSUMED ZONE ──────────────────────────
  await persistState(pair, {
    stage: "NONE",
    zoneTop: null,
    zoneBottom: null,
    zoneStartIndex: 0,
    zoneEndIndex: 0,
    consumedZones: [...state.consumedZones, zoneHash],
    consumedZoneTimes: { ...state.consumedZoneTimes, [zoneHash]: Date.now() },
    lastBreakoutTs: breakout.candle!.timestamp,
  });

  return { signal: built.signal, market: built.market, debug, stage: "EXPANSION" };
}

// ─── Trail Stop Update ─────────────────────────────────────────────────

export function updateTrail(
  signal: Signal,
  candles1h: Candle[],
  currentPrice: number
): { trail: number; shouldExit: boolean; reason: string } {
  const closes = candles1h.map(c => c.close);
  const ema21 = ema(closes, 21);
  const atrSeries = atr(candles1h, 14);
  // FIX #8: Safe fallback for undefined ATR
  const currentATR = atrSeries[atrSeries.length - 1];
  const safeATR = currentATR && currentATR > 0 ? currentATR : Math.abs(currentPrice - signal.entry) * 0.1;

  const newTrail = signal.direction === "LONG"
    ? Math.max(signal.trail, ema21[ema21.length - 1] - safeATR * 0.3)
    : Math.min(signal.trail, ema21[ema21.length - 1] + safeATR * 0.3);

  const hit = signal.direction === "LONG" ? currentPrice < newTrail : currentPrice > newTrail;

  return {
    trail: Math.round(newTrail * 100) / 100,
    shouldExit: hit,
    reason: hit ? `Trail hit at ${newTrail.toFixed(1)}` : "Holding",
  };
}

// ─── Market Snapshot ────────────────────────────────────────────────────

export async function getMarketSnapshot(
  pair: string,
  candles1h: Candle[] | undefined,
  candles4h: Candle[],
  candles15m: Candle[] | undefined
): Promise<any> {
  const state = await getPersistedState(pair);
  const price = candles4h[candles4h.length - 1].close;
  const closes = candles4h.map(c => c.close);
  const stoch = stochRsi(closes);
  const htBias = higherTimeframeBias(candles4h);

  const adxValue = adx(candles4h);
  const trend1d = htBias === "BULLISH" ? "LONG" : htBias === "BEARISH" ? "SHORT" : "MIXED";

  return {
    pair,
    price: Math.round(price * 100) / 100,
    timestamp: Date.now(),
    phase: state.stage === "NONE" ? "NONE" : state.stage,
    trend: trend1d,
    htfBias: htBias,
    adx: adxValue,
    rsi: 0,
    stochK: stoch.k,
    stochD: stoch.d,
    zoneTop: state.zoneTop ? Math.round(state.zoneTop * 100) / 100 : null,
    zoneBottom: state.zoneBottom ? Math.round(state.zoneBottom * 100) / 100 : null,
    zoneScore: 0,
    zoneQuality: null,
    closes4h: candles4h.slice(-50).map(c => c.close),
  };
}

// ─── Validity ───────────────────────────────────────────────────────────

export interface ValidityCheck {
  valid: boolean;
  reason: string;
  exited: boolean;
}

export function isSignalStillValid(signal: Signal, currentPrice: number, now: number = Date.now()): ValidityCheck {
  const ageMs = now - signal.timestamp;
  const maxAge = 24 * 60 * 60 * 1000;

  if (ageMs > maxAge) {
    return { valid: false, reason: "expired_ttl", exited: true };
  }

  if (signal.direction === "LONG" && currentPrice <= signal.stop) {
    return { valid: false, reason: "sl_hit", exited: true };
  }
  if (signal.direction === "SHORT" && currentPrice >= signal.stop) {
    return { valid: false, reason: "sl_hit", exited: true };
  }

  if (signal.direction === "LONG" && currentPrice >= signal.target) {
    return { valid: false, reason: "tp_hit", exited: true };
  }
  if (signal.direction === "SHORT" && currentPrice <= signal.target) {
    return { valid: false, reason: "tp_hit", exited: true };
  }

  return { valid: true, reason: "active", exited: false };
}

// ─── shouldHold ────────────────────────────────────────────────────────

export interface HoldResult {
  shouldHold: boolean;
  reason: string;
}

export async function shouldHold(
  pair: string,
  signal: Signal,
  candles1h: Candle[],
  currentPrice: number
): Promise<HoldResult> {
  const trailUpdate = updateTrail(signal, candles1h, currentPrice);

  if (trailUpdate.shouldExit) {
    await persistState(pair, { lastExitAt: Date.now() });
    return { shouldHold: false, reason: `trail_stop — Price ${currentPrice.toFixed(1)} hit trail at ${trailUpdate.trail}` };
  }

  return { shouldHold: true, reason: `trailing at ${trailUpdate.trail}` };
}

// ─── filterExpiredSignals ───────────────────────────────────────────────

export function filterExpiredSignals(
  signals: Signal[],
  currentPrices: Record<string, number>,
  now?: number
): { active: Signal[]; exited: { signal: Signal; reason: string }[] } {
  const active: Signal[] = [];
  const exited: { signal: Signal; reason: string }[] = [];

  for (const signal of signals) {
    const price = currentPrices[signal.pair];
    if (price === undefined) {
      active.push(signal);
      continue;
    }
    const check = isSignalStillValid(signal, price, now);
    if (check.valid) active.push(signal);
    else exited.push({ signal, reason: check.reason });
  }

  return { active, exited };
}

// ─── checkTradeStatus ───────────────────────────────────────────────────

export type TradeStatus = "ACTIVE" | "TP_HIT" | "SL_HIT" | "EXHAUSTION" | "EXPIRED";

export function checkTradeStatus(signal: Signal, currentPrice: number, now: number = Date.now()): TradeStatus {
  const validity = isSignalStillValid(signal, currentPrice, now);

  if (!validity.valid && validity.reason === "expired_ttl") return "EXPIRED";
  if (!validity.valid && validity.reason === "sl_hit") return "SL_HIT";
  if (!validity.valid && validity.reason === "tp_hit") return "TP_HIT";

  return "ACTIVE";
}

// ============================================================
// COMPATIBILITY EXPORTS
// ============================================================

export async function getMonitorState(pair: string): Promise<any | undefined> {
  return undefined;
}

export async function clearMonitorState(pair: string): Promise<void> {
  return;
}

export async function setMonitorState(pair: string, state: any): Promise<void> {
  return;
}

export async function generateSignalCompat(
  pair: string,
  candles1h: Candle[],
  candles4h: Candle[],
  candles15m: Candle[],
  activeTrades?: Record<string, any>,
  currentPrice?: number
): Promise<SignalResult> {
  return generateSignal(pair, candles1h, candles4h, candles15m, currentPrice);
}

export function isSignalStillValidBool(signal: Signal, currentPrice: number): boolean {
  return isSignalStillValid(signal, currentPrice).valid;
}

export async function shouldHoldCompat(
  pair: string,
  signal: Signal,
  candles4h: Candle[],
  candles1h: Candle[],
  currentPrice: number
): Promise<HoldResult> {
  return shouldHold(pair, signal, candles1h, currentPrice);
}
