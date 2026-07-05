// lib/strategy.ts — v30.2 "1H Accumulation + 4H HTF Alignment"
// ============================================================
// PHILOSOPHY: Find tight accumulation on 1H, confirm direction on 4H
// Enter earlier, build position before breakout, ride the full wave

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
  signal?: Signal;
  market?: any;
  debug: string[];
  stage: "NONE" | "WATCHING" | "ACCUMULATION" | "READY" | "CONFIRMED" | "EXPANSION" | "EXHAUSTION";
}

export const CURRENT_SIGNAL_VERSION = 30;

// ─── Config ──────────────────────────────────────────────────────────────

// 1H Accumulation detection
const ACCUM_MIN_CANDLES = 8;        // 8 candles = 8 hours minimum
const ACCUM_MAX_CANDLES = 30;       // 30 candles = 30 hours max
const ACCUM_MAX_WIDTH_ATR = 2.0;    // tight zone
const ACCUM_MIN_TOUCHES = 3;        // 3+ touches for quality
const ACCUM_VOLUME_DECLINE = 0.7;   // declining volume

// Breakout requirements
const BREAKOUT_MIN_BODY_ATR = 0.3;
const BREAKOUT_CONFIRM_CLOSE = true;

// Confidence
const STOCH_EXTREME_LOW = 15;
const STOCH_EXTREME_HIGH = 85;
const STOCH_CONFIDENCE_PENALTY = 15;

const REQUIRE_HTF_ALIGNMENT = true;
const EXIT_COOLDOWN_MS = 30 * 60 * 1000;

// ─── Helpers ─────────────────────────────────────────────────────────────

function avg(arr: number[]): number {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function ema(values: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const result: number[] = [values[0]];
  for (let i = 1; i < values.length; i++) {
    result.push(values[i] * k + result[i - 1] * (1 - k));
  }
  return result;
}

function atr(candles: Candle[], period: number = 14): number[] {
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
  if (daily.length < 30) return "NEUTRAL";
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
  lastBreakoutTs: number;
}

function hashZone(top: number, bottom: number): string {
  return `${Math.round(top)}_${Math.round(bottom)}`;
}

async function getPersistedState(pair: string): Promise<PairState> {
  const raw = await getPairState(pair);
  return {
    stage: raw.stage || "NONE",
    zoneTop: raw.zoneTop || null,
    zoneBottom: raw.zoneBottom || null,
    zoneStartIndex: raw.zoneStartIndex || 0,
    zoneEndIndex: raw.zoneEndIndex || 0,
    lastExitAt: raw.lastExitAt || 0,
    consumedZones: raw.consumedZones || [],
    lastBreakoutTs: raw.lastBreakoutTs || 0,
  };
}

async function persistState(pair: string, state: Partial<PairState>): Promise<void> {
  const existing = await getPersistedState(pair);
  await setPairState(pair, { ...existing, ...state });
}

// ─── ACCUMULATION DETECTION (1H candles) ────────────────────────────────

interface AccumulationZone {
  top: number;
  bottom: number;
  startIndex: number;
  endIndex: number;
  touches: number;
  avgVolume: number;
  widthATR: number;
}

function detectAccumulation(candles1h: Candle[], debug: string[]): AccumulationZone | null {
  if (candles1h.length < ACCUM_MIN_CANDLES + 14) {
    debug.push(`ACCUM: insufficient 1H candles (${candles1h.length})`);
    return null;
  }

  const atrSeries = atr(candles1h, 14);
  const currentATR = atrSeries[atrSeries.length - 1] || 1;
  const last = candles1h.length - 1;

  for (let windowSize = ACCUM_MIN_CANDLES; windowSize <= Math.min(ACCUM_MAX_CANDLES, last); windowSize++) {
    const start = last - windowSize;
    const zoneCandles = candles1h.slice(start, last);

    const highs = zoneCandles.map(c => c.high);
    const lows = zoneCandles.map(c => c.low);
    const top = Math.max(...highs);
    const bottom = Math.min(...lows);
    const width = top - bottom;
    const widthATR = currentATR > 0 ? width / currentATR : 999;

    if (widthATR > ACCUM_MAX_WIDTH_ATR) continue;

    let touches = 0;
    for (const c of zoneCandles) {
      const touchTop = Math.abs(c.high - top) / width < 0.15;
      const touchBottom = Math.abs(c.low - bottom) / width < 0.15;
      if (touchTop || touchBottom) touches++;
    }
    if (touches < ACCUM_MIN_TOUCHES) continue;

    const firstHalf = zoneCandles.slice(0, Math.floor(zoneCandles.length / 2));
    const secondHalf = zoneCandles.slice(Math.floor(zoneCandles.length / 2));
    const volFirst = avg(firstHalf.map(c => c.volume));
    const volSecond = avg(secondHalf.map(c => c.volume));
    const volRatio = volFirst > 0 ? volSecond / volFirst : 1;

    if (volRatio > ACCUM_VOLUME_DECLINE) {
      debug.push(`ACCUM: volume not declining (${volRatio.toFixed(2)} > ${ACCUM_VOLUME_DECLINE})`);
      continue;
    }

    debug.push(`ACCUM FOUND (1H): [${start}-${last - 1}] top=${top.toFixed(2)} bottom=${bottom.toFixed(2)} width=${width.toFixed(2)} (${widthATR.toFixed(2)}x ATR) touches=${touches} volRatio=${volRatio.toFixed(2)}`);

    return {
      top,
      bottom,
      startIndex: start,
      endIndex: last - 1,
      touches,
      avgVolume: avg(zoneCandles.map(c => c.volume)),
      widthATR,
    };
  }

  debug.push("ACCUM: no tight accumulation zone found on 1H");
  return null;
}

// ─── BREAKOUT DETECTION (1H current candle) ──────────────────────────────

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
  const last = candles1h.length - 1;
  const c = candles1h[last];

  debug.push(`BREAKOUT CHECK: close=${c.close.toFixed(2)} open=${c.open.toFixed(2)} zone=${zone.bottom.toFixed(2)}-${zone.top.toFixed(2)}`);

  const isBullish = c.close > c.open;
  let beyondZone = false;
  let direction: "LONG" | "SHORT" | null = null;

  if (BREAKOUT_CONFIRM_CLOSE) {
    if (c.close > zone.top) {
      beyondZone = true;
      direction = "LONG";
    } else if (c.close < zone.bottom) {
      beyondZone = true;
      direction = "SHORT";
    }
  } else {
    if (c.high > zone.top) {
      beyondZone = true;
      direction = "LONG";
    } else if (c.low < zone.bottom) {
      beyondZone = true;
      direction = "SHORT";
    }
  }

  if (!beyondZone) {
    debug.push(`BREAKOUT: no breakout — close=${c.close.toFixed(2)} inside zone`);
    return { detected: false, direction: null, candle: null, reason: "no_breakout" };
  }

  const atrSeries = atr(candles1h, 14);
  const currentATR = atrSeries[atrSeries.length - 1] || 1;
  const body = Math.abs(c.close - c.open);
  const bodyATR = currentATR > 0 ? body / currentATR : 0;

  debug.push(`BREAKOUT: beyond zone dir=${direction} body=${body.toFixed(2)} (${bodyATR.toFixed(2)}x ATR)`);

  if (bodyATR < BREAKOUT_MIN_BODY_ATR) {
    debug.push(`BREAKOUT: body too small (${bodyATR.toFixed(2)} < ${BREAKOUT_MIN_BODY_ATR})`);
    return { detected: false, direction: null, candle: null, reason: "body_too_small" };
  }

  debug.push(`BREAKOUT: ${direction} confirmed close=${c.close.toFixed(2)} beyond zone`);
  return { detected: true, direction, candle: c, reason: `breakout_${direction?.toLowerCase()}` };
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
  debug: string[]
): { signal: Signal; market: any } | null {
  const entry = candles1h[candles1h.length - 1].close;
  const zoneHeight = zone.top - zone.bottom;

  const closes1h = candles1h.map(c => c.close);
  const atr1h = atr(candles1h, 14);
  const currentATR = atr1h[atr1h.length - 1] || zoneHeight * 0.5;

  // Stop: outside zone + 1H ATR buffer
  const swingStop = direction === "LONG" ? zone.bottom : zone.top;
  const atrStop = direction === "LONG"
    ? entry - currentATR * 1.5
    : entry + currentATR * 1.5;

  const stop = direction === "LONG"
    ? Math.min(swingStop, atrStop)
    : Math.max(swingStop, atrStop);

  const risk = Math.abs(entry - stop);
  const target = direction === "LONG" ? entry + risk * 2.5 : entry - risk * 2.5;

  // Trail: EMA21(1H) ± ATR
  const ema21 = ema(closes1h, 21);
  const trail = direction === "LONG"
    ? ema21[ema21.length - 1] - currentATR * 0.5
    : ema21[ema21.length - 1] + currentATR * 0.5;

  const rr = risk > 0 ? Math.abs(target - entry) / risk : 0;

  // Confidence
  let confidence = 50;

  if (zone.widthATR < 1.5) confidence += 20;
  else if (zone.widthATR < 2.0) confidence += 10;

  if (zone.touches >= 5) confidence += 10;
  else if (zone.touches >= 3) confidence += 5;

  // 4H ADX for trend strength
  const adx4h = adx(candles4h);
  if (adx4h > 30) confidence += 10;
  else if (adx4h > 20) confidence += 5;

  // Stoch adjustment (confidence, not veto)
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
  const price = currentPrice ?? candles1h[candles1h.length - 1].close;

  const state = await getPersistedState(pair);
  const closes1h = candles1h.map(c => c.close);
  const stoch = stochRsi(closes1h);
  const htBias = higherTimeframeBias(candles4h);
  const trend1d = htBias === "BULLISH" ? "LONG" : htBias === "BEARISH" ? "SHORT" : "MIXED";

  debug.push(`HTF(4H): ${htBias} | Stage: ${state.stage} | StochK(1H)=${stoch.k} | ADX(4H)=${adx(candles4h)}`);

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
          htfBias: htBias, adx: adx(candles4h), rsi: 0,
          stochK: stoch.k, stochD: stoch.d,
          zoneTop: null, zoneBottom: null, zoneScore: 0,
        },
        debug,
        stage: "NONE",
      };
    }
  }

  // ── STEP 1: DETECT ACCUMULATION ON 1H ──────────────────────
  const zone = detectAccumulation(candles1h, debug);

  if (!zone) {
    return {
      signal: null,
      market: {
        pair, price, timestamp: Date.now(),
        phase: "NONE", trend: trend1d,
        htfBias: htBias, adx: adx(candles4h), rsi: 0,
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
    debug.push(`ZONE CONSUMED: ${zoneHash} already traded`);
    return {
      signal: null,
      market: {
        pair, price, timestamp: Date.now(),
        phase: "NONE", trend: trend1d,
        htfBias: htBias, adx: adx(candles4h), rsi: 0,
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
        htfBias: htBias, adx: adx(candles4h), rsi: 0,
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
          htfBias: htBias, adx: adx(candles4h), rsi: 0,
          stochK: stoch.k, stochD: stoch.d,
          zoneTop: zone.top, zoneBottom: zone.bottom, zoneScore: 0,
        },
        debug,
        stage: "NONE",
      };
    }
  }

  // ── STEP 5: BUILD SIGNAL ──────────────────────────────────
  const built = buildSignal(pair, breakout.direction, zone, candles1h, candles4h, htBias, stoch.k, debug);

  if (!built) {
    debug.push("Signal build failed");
    return {
      signal: null,
      market: {
        pair, price, timestamp: Date.now(),
        phase: "NONE", trend: trend1d,
        htfBias: htBias, adx: adx(candles4h), rsi: 0,
        stochK: stoch.k, stochD: stoch.d,
        zoneTop: null, zoneBottom: null, zoneScore: 0,
      },
      debug,
      stage: "NONE",
    };
  }

  await persistState(pair, {
    stage: "NONE",
    zoneTop: null,
    zoneBottom: null,
    zoneStartIndex: 0,
    zoneEndIndex: 0,
    consumedZones: [...state.consumedZones, zoneHash],
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
  const currentATR = atrSeries[atrSeries.length - 1];

  const newTrail = signal.direction === "LONG"
    ? Math.max(signal.trail, ema21[ema21.length - 1] - currentATR * 0.3)
    : Math.min(signal.trail, ema21[ema21.length - 1] + currentATR * 0.3);

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
