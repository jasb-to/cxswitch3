// lib/strategy.ts — v29.8 "Production Breakout Engine"
// ============================================================
// FIXES:
// - Uses getPairState/setPairState from @/lib/state (no duplicate Redis)
// - No legacy strings (PHASE1, CLIMAX, etc.)
// - Breakout confirmation: close beyond consolidation
// - Safer stop placement (outside zone + ATR)
// - Prefer newest breakout on tie
// - Extracted buildBreakoutSignal() helper

import { getPairState, setPairState } from "@/lib/state";

export interface Candle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface Zone {
  top: number;
  bottom: number;
  left: number;
  right: number;
  active: boolean;
  volumeClimax: number;
  type: "ACCUMULATION" | "DISTRIBUTION";
  touches: number;
  breakAttempts: number;
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
  zone?: Zone;
  stage: "NONE" | "WATCHING" | "ACCUMULATION" | "READY" | "CONFIRMED" | "EXPANSION" | "EXHAUSTION";
}

export interface ZoneQuality {
  age: number;
  widthATR: number;
  compression: number;
  volumeDecay: number;
  touches: number;
  breakAttempts: number;
  label: "EXCELLENT" | "GOOD" | "AVERAGE" | "WEAK";
}

export const CURRENT_SIGNAL_VERSION = 29;

// ─── Config ──────────────────────────────────────────────────────────────

const DETECTION_MODE: "BREAKOUT" | "ACCUMULATION" = "BREAKOUT";

const BREAKOUT_VOLUME_MULT = 1.2;
const BREAKOUT_RANGE_MULT = 0.7;
const BREAKOUT_BODY_MULT = 0.5;
const BREAKOUT_SCAN_DEPTH = 10;
const BREAKOUT_MIN_SCORE = 2;

const REQUIRE_HTF_ALIGNMENT = true;
const TEST_MODE = false;
const TEST_DIRECTION: "LONG" | "SHORT" = "LONG";

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
    plusDISmooth.push((plusDISmooth[plusDISmooth.length - 1] * plusDMs[i]) / 14);
    minusDISmooth.push((minusDISmooth[minusDISmooth.length - 1] * minusDMs[i]) / 14);
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

// ─── Higher Timeframe Bias ───────────────────────────────────────────────

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

// ─── STATE PERSISTENCE (uses @/lib/state getPairState/setPairState) ─────

async function getPersistedState(pair: string): Promise<{
  stage: "NONE" | "WATCHING" | "ACCUMULATION" | "READY" | "CONFIRMED";
  zone: Zone | null;
  impulseCandle: Candle | null;
  impulseDirection: "LONG" | "SHORT" | null;
  impulseRange: number;
  prevStoch: { k: number; d: number } | null;
  zoneStartIndex: number;
}> {
  const raw = await getPairState(pair);
  return {
    stage: raw.stage || "NONE",
    zone: raw.zone || null,
    impulseCandle: raw.impulseCandle || null,
    impulseDirection: raw.impulseDirection || null,
    impulseRange: raw.impulseRange || 0,
    prevStoch: raw.prevStoch || null,
    zoneStartIndex: raw.zoneStartIndex || 0,
  };
}

async function persistState(pair: string, state: any): Promise<void> {
  await setPairState(pair, state);
}

// ─── DETECTION ENGINE (v29.8) ──────────────────────────────────────────

interface DetectionResult {
  detected: boolean;
  candle: Candle | null;
  direction: "LONG" | "SHORT" | null;
  zone: { top: number; bottom: number } | null;
  quality: ZoneQuality | null;
  index: number;
  score: number;
  reason: string;
}

function detectPattern(candles: Candle[], debug: string[]): DetectionResult {
  if (candles.length < 25) {
    return { detected: false, candle: null, direction: null, zone: null, quality: null, index: -1, score: 0, reason: "insufficient_candles" };
  }

  const last = candles.length - 1;
  const scanStart = Math.max(1, last - BREAKOUT_SCAN_DEPTH + 1);

  const lookbackStart = Math.max(0, last - BREAKOUT_SCAN_DEPTH - 15);
  const lookbackCandles = candles.slice(lookbackStart, scanStart);

  const prevBodies = lookbackCandles.map(c => Math.abs(c.close - c.open));
  const avgBody = avg(prevBodies);

  const prevTRs = lookbackCandles.slice(1).map((c, i) => trueRange(c, lookbackCandles[i]));
  const avgTR = avg(prevTRs);

  const prevVolumes = lookbackCandles.map(c => c.volume);
  const avgVol = avg(prevVolumes);

  debug.push(`DETECT mode=${DETECTION_MODE} avgBody=${avgBody.toFixed(2)} avgTR=${avgTR.toFixed(2)} avgVol=${avgVol.toFixed(2)}`);

  let bestResult: DetectionResult | null = null;

  for (let i = scanStart; i <= last; i++) {
    const c = candles[i];
    const p = candles[i - 1];

    const body = Math.abs(c.close - c.open);
    const tr = trueRange(c, p);

    const volRatio = avgVol > 0 ? c.volume / avgVol : 0;
    const bodyRatio = avgBody > 0 ? body / avgBody : 0;
    const trRatio = avgTR > 0 ? tr / avgTR : 0;

    const isBullish = c.close > c.open;
    const direction = isBullish ? "LONG" : "SHORT";

    const volScore = volRatio >= BREAKOUT_VOLUME_MULT ? 1 : 0;
    const rangeScore = trRatio >= BREAKOUT_RANGE_MULT ? 1 : 0;
    const momentumScore = bodyRatio >= BREAKOUT_BODY_MULT ? 1 : 0;
    const score = volScore + rangeScore + momentumScore;

    debug.push(
      `CHECK[${i}] vol=${volRatio.toFixed(2)}x(${volScore}) tr=${trRatio.toFixed(2)}x(${rangeScore}) ` +
      `body=${bodyRatio.toFixed(2)}x(${momentumScore}) score=${score}/3 dir=${direction} close=${c.close.toFixed(2)}`
    );

    if (score >= BREAKOUT_MIN_SCORE) {
      const zoneStart = Math.max(0, i - 8);
      const zoneCandles = candles.slice(zoneStart, i);
      const prevHigh = Math.max(...zoneCandles.map(c => c.high));
      const prevLow = Math.min(...zoneCandles.map(c => c.low));

      const confirmed = direction === "LONG" ? c.close > prevHigh : c.close < prevLow;

      debug.push(`CHECK[${i}] zone=${prevLow.toFixed(2)}-${prevHigh.toFixed(2)} confirmed=${confirmed}`);

      if (!confirmed) continue;

      const top = Math.max(prevHigh, c.high);
      const bottom = Math.min(prevLow, c.low);

      const atrSeries = atr(candles, 14);
      const currentATR = atrSeries[atrSeries.length - 1] || 1;
      const zoneHeight = top - bottom;
      const widthATR = currentATR > 0 ? zoneHeight / currentATR : 0;

      let label: ZoneQuality["label"] = "WEAK";
      if (widthATR < 1.5) label = "EXCELLENT";
      else if (widthATR < 2.5) label = "GOOD";
      else if (widthATR < 4) label = "AVERAGE";

      const quality: ZoneQuality = {
        age: zoneCandles.length,
        widthATR,
        compression: Math.max(0, 100 - widthATR * 25),
        volumeDecay: 0,
        touches: 1,
        breakAttempts: 0,
        label,
      };

      const result: DetectionResult = {
        detected: true,
        candle: c,
        direction,
        zone: { top, bottom },
        quality,
        index: i,
        score,
        reason: "breakout_confirmed",
      };

      if (
        !bestResult ||
        score > bestResult.score ||
        (score === bestResult.score && i > bestResult.index)
      ) {
        bestResult = result;
      }
    }
  }

  if (bestResult) {
    debug.push(`SELECTED[${bestResult.index}] score=${bestResult.score} dir=${bestResult.direction} zone=${bestResult.zone?.bottom.toFixed(2)}-${bestResult.zone?.top.toFixed(2)}`);
    return bestResult;
  }

  debug.push(`NO_DETECT: max score < ${BREAKOUT_MIN_SCORE} in last ${BREAKOUT_SCAN_DEPTH} candles`);
  return { detected: false, candle: null, direction: null, zone: null, quality: null, index: -1, score: 0, reason: "no_breakout_detected" };
}

// ─── Signal Builder ─────────────────────────────────────────────────────

function buildBreakoutSignal(
  pair: string,
  detection: DetectionResult,
  candles4h: Candle[],
  htBias: "BULLISH" | "BEARISH" | "NEUTRAL",
  debug: string[]
): { signal: Signal; market: any } | null {
  if (!detection.candle || !detection.direction || !detection.zone) return null;

  const direction = detection.direction;
  const entry = detection.candle.close;
  const zone = detection.zone;
  const zoneHeight = zone.top - zone.bottom;

  const closes = candles4h.map(c => c.close);
  const atrSeries = atr(candles4h, 14);
  const currentATR = atrSeries[atrSeries.length - 1] || zoneHeight * 0.5;

  const swingStop = direction === "LONG" ? zone.bottom : zone.top;
  const atrStop = direction === "LONG"
    ? entry - currentATR * 1.5
    : entry + currentATR * 1.5;

  const stop = direction === "LONG"
    ? Math.min(swingStop, atrStop)
    : Math.max(swingStop, atrStop);

  const atrTarget = direction === "LONG" ? entry + currentATR * 3 : entry - currentATR * 3;
  const zoneTarget = direction === "LONG" ? entry + zoneHeight * 1.5 : entry - zoneHeight * 1.5;
  const target = direction === "LONG" ? Math.max(atrTarget, zoneTarget) : Math.min(atrTarget, zoneTarget);

  const ema21 = ema(closes, 21);
  const trail = direction === "LONG"
    ? ema21[ema21.length - 1] - currentATR * 0.5
    : ema21[ema21.length - 1] + currentATR * 0.5;

  const rr = Math.abs(target - entry) / Math.abs(entry - stop);

  let confidence = 50;
  if (detection.quality) {
    if (detection.quality.label === "EXCELLENT") confidence = 85;
    else if (detection.quality.label === "GOOD") confidence = 72;
    else if (detection.quality.label === "AVERAGE") confidence = 60;
    else confidence = 45;
  }
  if (htBias === "NEUTRAL") confidence -= 5;
  const adxValue = adx(candles4h);
  if (adxValue > 25) confidence += 5;
  if (adxValue > 35) confidence += 5;
  confidence = Math.min(95, Math.max(30, confidence));

  const explanation = `${direction} BREAKOUT: ${detection.quality?.label || "UNKNOWN"} quality zone (${zone.bottom.toFixed(0)}-${zone.top.toFixed(0)}) broken with momentum. HTF=${htBias}, ADX=${adxValue.toFixed(1)}, Score=${detection.score}/3`;

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
    adx: adxValue,
    zoneTop: Math.round(zone.top * 100) / 100,
    zoneBottom: Math.round(zone.bottom * 100) / 100,
    explanation,
    timestamp: Date.now(),
    version: CURRENT_SIGNAL_VERSION,
  };

  const trend1d = htBias === "BULLISH" ? "LONG" : htBias === "BEARISH" ? "SHORT" : "MIXED";
  const stoch = stochRsi(closes);

  const market = {
    pair,
    price: Math.round(entry * 100) / 100,
    timestamp: Date.now(),
    phase: "EXPANSION",
    trend: trend1d,
    htfBias: htBias,
    adx: adxValue,
    rsi: 0,
    stochK: stoch.k,
    stochD: stoch.d,
    zoneTop: signal.zoneTop,
    zoneBottom: signal.zoneBottom,
    zoneScore: detection.quality ? (detection.quality.label === "EXCELLENT" ? 90 : detection.quality.label === "GOOD" ? 70 : detection.quality.label === "AVERAGE" ? 50 : 30) : 0,
    zoneQuality: detection.quality,
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
  const price = currentPrice ?? candles4h[candles4h.length - 1].close;

  let state = await getPersistedState(pair);
  const closes = candles4h.map(c => c.close);
  const stoch = stochRsi(closes);
  const htBias = higherTimeframeBias(candles4h);
  const trend1d = htBias === "BULLISH" ? "LONG" : htBias === "BEARISH" ? "SHORT" : "MIXED";

  debug.push(`HTF Bias: ${htBias} | Stage: ${state.stage} | Mode: ${DETECTION_MODE}`);

  if (TEST_MODE) {
    debug.push("TEST MODE: Forcing signal generation");
    const atrSeries = atr(candles4h, 14);
    const currentATR = atrSeries[atrSeries.length - 1] || price * 0.02;
    const direction = TEST_DIRECTION;
    const entry = price;
    const stop = direction === "LONG" ? entry - currentATR * 2 : entry + currentATR * 2;
    const target = direction === "LONG" ? entry + currentATR * 4 : entry - currentATR * 4;
    const trail = direction === "LONG" ? entry - currentATR : entry + currentATR;
    const rr = Math.abs(target - entry) / Math.abs(entry - stop);

    const signal: Signal = {
      id: `${pair}_${Date.now()}`,
      pair,
      direction,
      stage: "CONFIRMED",
      entry: Math.round(entry * 100) / 100,
      stop: Math.round(stop * 100) / 100,
      target: Math.round(target * 100) / 100,
      trail: Math.round(trail * 100) / 100,
      confidence: 50,
      rr: Math.round(rr * 100) / 100,
      adx: adx(candles4h),
      zoneTop: Math.round((entry + currentATR) * 100) / 100,
      zoneBottom: Math.round((entry - currentATR) * 100) / 100,
      explanation: `TEST MODE: Forced ${direction} signal for debugging`,
      timestamp: Date.now(),
      version: CURRENT_SIGNAL_VERSION,
    };

    const market = {
      pair, price: Math.round(price * 100) / 100, timestamp: Date.now(),
      phase: "EXPANSION", trend: trend1d, htfBias: htBias,
      adx: signal.adx, rsi: 0, stochK: stoch.k, stochD: stoch.d,
      zoneTop: signal.zoneTop, zoneBottom: signal.zoneBottom,
      zoneScore: 50, zoneQuality: null,
      closes4h: candles4h.slice(-50).map(c => c.close),
    };

    debug.push(`TEST_SIGNAL: ${direction} entry=${signal.entry} stop=${signal.stop} target=${signal.target}`);
    return { signal, market, debug, stage: "EXPANSION" };
  }

  if (state.stage === "NONE") {
    const detection = detectPattern(candles4h, debug);

    if (!detection.detected || !detection.candle || !detection.direction || !detection.zone) {
      debug.push("No breakout detected — scanning");
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

    if (REQUIRE_HTF_ALIGNMENT) {
      const aligned =
        (detection.direction === "LONG" && (htBias === "BULLISH" || htBias === "NEUTRAL")) ||
        (detection.direction === "SHORT" && (htBias === "BEARISH" || htBias === "NEUTRAL"));

      if (!aligned) {
        debug.push(`BLOCKED: ${detection.direction} breakout but HTF is ${htBias}`);
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

    const built = buildBreakoutSignal(pair, detection, candles4h, htBias, debug);
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

    await persistState(pair, { stage: "NONE", zone: null, impulseCandle: null, impulseDirection: null, impulseRange: 0, prevStoch: null, zoneStartIndex: 0 });

    return { signal: built.signal, market: built.market, debug, stage: "EXPANSION" };
  }

  if (state.stage !== "NONE") {
    debug.push(`Legacy state ${state.stage} — resetting`);
    await persistState(pair, { stage: "NONE", zone: null, impulseCandle: null, impulseDirection: null, impulseRange: 0, prevStoch: null, zoneStartIndex: 0 });

    const detection = detectPattern(candles4h, debug);
    if (detection.detected && detection.candle && detection.direction && detection.zone) {
      const aligned =
        (detection.direction === "LONG" && (htBias === "BULLISH" || htBias === "NEUTRAL")) ||
        (detection.direction === "SHORT" && (htBias === "BEARISH" || htBias === "NEUTRAL"));

      if (aligned) {
        const built = buildBreakoutSignal(pair, detection, candles4h, htBias, debug);
        if (built) {
          await persistState(pair, { stage: "NONE", zone: null, impulseCandle: null, impulseDirection: null, impulseRange: 0, prevStoch: null, zoneStartIndex: 0 });
          return { signal: built.signal, market: built.market, debug, stage: "EXPANSION" };
        }
      }
    }
  }

  debug.push("No signal — scanning");
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

// ─── Trail Stop Update ─────────────────────────────────────────────────

export function updateTrail(
  signal: Signal,
  candles4h: Candle[],
  currentPrice: number
): { trail: number; shouldExit: boolean; reason: string } {
  const closes = candles4h.map(c => c.close);
  const ema21 = ema(closes, 21);
  const atrSeries = atr(candles4h, 14);
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
    zoneTop: state.zone ? Math.round(state.zone.top * 100) / 100 : null,
    zoneBottom: state.zone ? Math.round(state.zone.bottom * 100) / 100 : null,
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

export function shouldHold(
  pair: string,
  signal: Signal,
  candles4h: Candle[],
  currentPrice: number
): HoldResult {
  const trailUpdate = updateTrail(signal, candles4h, currentPrice);

  if (trailUpdate.shouldExit) {
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

export function shouldHoldCompat(
  pair: string,
  signal: Signal,
  candles4h: Candle[],
  candles1h: Candle[],
  currentPrice: number
): HoldResult {
  return shouldHold(pair, signal, candles4h, currentPrice);
}
