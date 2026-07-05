// lib/strategy.ts — v29.4 "Phase-Based Detection: Fixed Impulse Scanning"
// ============================================================
// Fixes: detectImpulse now scans last 10 candles (not just last 1)
//        Added detailed debug logging throughout
//        Fixed trend1d undefined reference
//        Lowered thresholds to match actual market conditions

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

// ─── Config (TUNABLE) ────────────────────────────────────────────────────

const IMPULSE_VOLUME_MULT = 1.3;        // 1.3x avg volume
const IMPULSE_BODY_MULT = 1.4;          // 1.4x avg body
const IMPULSE_TR_MULT = 1.2;            // 1.2x avg true range
const IMPULSE_SCAN_DEPTH = 10;          // Scan last N candles

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

// ─── STATE PERSISTENCE (Redis-backed) ────────────────────────────────────

let redisClient: any = null;

export function setRedisClient(client: any): void {
  redisClient = client;
}

async function getPersistedState(pair: string): Promise<{
  stage: "NONE" | "WATCHING" | "ACCUMULATION" | "READY" | "CONFIRMED";
  zone: Zone | null;
  impulseCandle: Candle | null;
  impulseDirection: "LONG" | "SHORT" | null;
  impulseRange: number;
  prevStoch: { k: number; d: number } | null;
  zoneStartIndex: number;
}> {
  if (!redisClient) {
    return {
      stage: "NONE",
      zone: null,
      impulseCandle: null,
      impulseDirection: null,
      impulseRange: 0,
      prevStoch: null,
      zoneStartIndex: 0,
    };
  }
  try {
    const raw = await redisClient.get(`cx_state_${pair}_v29`);
    if (!raw) {
      return {
        stage: "NONE",
        zone: null,
        impulseCandle: null,
        impulseDirection: null,
        impulseRange: 0,
        prevStoch: null,
        zoneStartIndex: 0,
      };
    }
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    return {
      stage: parsed.stage || "NONE",
      zone: parsed.zone || null,
      impulseCandle: parsed.impulseCandle || null,
      impulseDirection: parsed.impulseDirection || null,
      impulseRange: parsed.impulseRange || 0,
      prevStoch: parsed.prevStoch || null,
      zoneStartIndex: parsed.zoneStartIndex || 0,
    };
  } catch {
    return {
      stage: "NONE",
      zone: null,
      impulseCandle: null,
      impulseDirection: null,
      impulseRange: 0,
      prevStoch: null,
      zoneStartIndex: 0,
    };
  }
}

async function persistState(pair: string, state: any): Promise<void> {
  if (!redisClient) return;
  try {
    await redisClient.set(`cx_state_${pair}_v29`, JSON.stringify(state), { ex: 7 * 24 * 60 * 60 });
  } catch (e) {
    console.error(`[STRATEGY] Failed to persist state for ${pair}:`, e);
  }
}

// ─── IMPULSE DETECTION (v29.4 FIX) ───────────────────────────────────
// Scans last N candles for the BEST impulse candidate, not just the last one

function detectImpulse(
  candles: Candle[],
  debug: string[]
): { candle: Candle; direction: "LONG" | "SHORT"; range: number; index: number } | null {
  if (candles.length < IMPULSE_SCAN_DEPTH + 5) {
    debug.push(`IMPULSE: insufficient candles (${candles.length})`);
    return null;
  }

  const last = candles.length - 1;
  const scanStart = Math.max(1, last - IMPULSE_SCAN_DEPTH + 1);

  // Pre-calculate averages from the full lookback window
  const lookbackStart = Math.max(0, last - IMPULSE_SCAN_DEPTH - 10);
  const lookbackCandles = candles.slice(lookbackStart, scanStart);

  const prevBodies = lookbackCandles.map(c => Math.abs(c.close - c.open));
  const avgBody = avg(prevBodies);

  const prevTRs = lookbackCandles.slice(1).map((c, i) => trueRange(c, lookbackCandles[i]));
  const avgTR = avg(prevTRs);

  const prevVolumes = lookbackCandles.map(c => c.volume);
  const avgVol = avg(prevVolumes);

  debug.push(`IMPULSE_AVG body=${avgBody.toFixed(2)} tr=${avgTR.toFixed(2)} vol=${avgVol.toFixed(2)}`);

  let bestCandidate: {
    candle: Candle;
    direction: "LONG" | "SHORT";
    range: number;
    index: number;
    score: number;
  } | null = null;

  // Scan last N candles for the best impulse
  for (let i = scanStart; i <= last; i++) {
    const c = candles[i];
    const p = candles[i - 1];

    const body = Math.abs(c.close - c.open);
    const tr = trueRange(c, p);

    const volRatio = avgVol > 0 ? c.volume / avgVol : 0;
    const bodyRatio = avgBody > 0 ? body / avgBody : 0;
    const trRatio = avgTR > 0 ? tr / avgTR : 0;

    const volClimax = volRatio >= IMPULSE_VOLUME_MULT;
    const strongBody = bodyRatio >= IMPULSE_BODY_MULT;
    const expandingTR = trRatio >= IMPULSE_TR_MULT;

    // Direction: reversal logic — big RED candle suggests LONG reversal setup
    const direction = c.close < c.open ? "LONG" : "SHORT";

    // Composite score (0-3)
    const score = (volClimax ? 1 : 0) + (strongBody ? 1 : 0) + (expandingTR ? 1 : 0);

    debug.push(
      `IMPULSE[${i}] vol=${volRatio.toFixed(2)}x body=${bodyRatio.toFixed(2)}x tr=${trRatio.toFixed(2)}x ` +
      `score=${score}/3 dir=${direction} close=${c.close.toFixed(2)} open=${c.open.toFixed(2)}`
    );

    // Need at least 2 of 3 conditions
    if (score >= 2) {
      const impulseHigh = Math.max(...candles.slice(Math.max(0, i - 2), i + 1).map(c => c.high));
      const impulseLow = Math.min(...candles.slice(Math.max(0, i - 2), i + 1).map(c => c.low));

      if (!bestCandidate || score > bestCandidate.score) {
        bestCandidate = {
          candle: c,
          direction,
          range: impulseHigh - impulseLow,
          index: i,
          score,
        };
      }
    }
  }

  if (bestCandidate) {
    debug.push(
      `IMPULSE_SELECTED[${bestCandidate.index}] score=${bestCandidate.score}/3 ` +
      `dir=${bestCandidate.direction} range=${bestCandidate.range.toFixed(2)}`
    );
    return {
      candle: bestCandidate.candle,
      direction: bestCandidate.direction,
      range: bestCandidate.range,
      index: bestCandidate.index,
    };
  }

  debug.push(`IMPULSE: no candidate met score>=2 (vol>=${IMPULSE_VOLUME_MULT}x body>=${IMPULSE_BODY_MULT}x tr>=${IMPULSE_TR_MULT}x)`);
  return null;
}

// ─── ACCUMULATION DETECTION (adaptive duration) ───────────────────────────

function isAccumulating(
  candles: Candle[],
  impulseDir: "LONG" | "SHORT",
  zoneStartIndex: number
): { accumulating: boolean; reason?: string } {
  const zoneAge = candles.length - zoneStartIndex;

  if (zoneAge < 4) return { accumulating: false, reason: `too_fresh_${zoneAge}` };
  if (zoneAge > 20) return { accumulating: false, reason: "max_age_exceeded" };

  const recent = candles.slice(zoneStartIndex);
  const highs = recent.map(c => c.high);
  const lows = recent.map(c => c.low);
  const range = Math.max(...highs) - Math.min(...lows);

  const atrSeries = atr(candles, 14);
  const currentATR = atrSeries[atrSeries.length - 1];
  const impulseATR = atrSeries[Math.max(0, atrSeries.length - zoneAge - 1)] || currentATR;

  const compressed = range < impulseATR * 3;
  const atrContracted = currentATR < impulseATR * 0.8;

  if (!compressed) return { accumulating: false, reason: "not_compressed" };
  if (!atrContracted) return { accumulating: false, reason: "atr_not_contracted" };

  return { accumulating: true };
}

// ─── ZONE QUALITY METRIC ─────────────────────────────────────────────────

function calcZoneQuality(
  zone: Zone,
  candles: Candle[],
  zoneStartIndex: number,
  impulseRange: number,
  impulseVolume: number
): ZoneQuality {
  const zoneAge = candles.length - zoneStartIndex;
  const atrSeries = atr(candles, 14);
  const currentATR = atrSeries[atrSeries.length - 1] || 1;
  const widthATR = (zone.top - zone.bottom) / currentATR;

  const compression = impulseRange > 0
    ? Math.max(0, (1 - (zone.top - zone.bottom) / impulseRange) * 100)
    : 0;

  const recentVolumes = candles.slice(-Math.min(zoneAge, 10)).map(c => c.volume);
  const currentAvgVol = avg(recentVolumes);
  const volumeDecay = impulseVolume > 0
    ? Math.max(0, (1 - currentAvgVol / impulseVolume) * 100)
    : 0;

  let touches = 0;
  const recent = candles.slice(zoneStartIndex);
  for (const c of recent) {
    const nearTop = Math.abs(c.high - zone.top) < currentATR * 0.3;
    const nearBottom = Math.abs(c.low - zone.bottom) < currentATR * 0.3;
    if (nearTop || nearBottom) touches++;
  }

  let score = 0;
  if (zoneAge >= 6) score += 15;
  if (zoneAge >= 10) score += 10;
  if (widthATR < 2) score += 20;
  if (widthATR < 1.5) score += 10;
  if (compression > 60) score += 15;
  if (volumeDecay > 40) score += 15;
  if (touches >= 3) score += 10;
  if (zone.breakAttempts >= 1) score += 5;

  let label: ZoneQuality["label"] = "WEAK";
  if (score >= 75) label = "EXCELLENT";
  else if (score >= 55) label = "GOOD";
  else if (score >= 35) label = "AVERAGE";

  return {
    age: zoneAge,
    widthATR,
    compression: Math.round(compression),
    volumeDecay: Math.round(volumeDecay),
    touches,
    breakAttempts: zone.breakAttempts,
    label,
  };
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
  const len = candles4h.length;

  let state = await getPersistedState(pair);
  const closes = candles4h.map(c => c.close);
  const stoch = stochRsi(closes);
  const htBias = higherTimeframeBias(candles4h);

  // Calculate trend1d for use in signal generation
  const trend1d = htBias === "BULLISH" ? "LONG" : htBias === "BEARISH" ? "SHORT" : "MIXED";

  debug.push(`HTF Bias: ${htBias} | Stage: ${state.stage}`);

  // ── STAGE: NONE → WATCHING ──────────────────────────────────────

  if (state.stage === "NONE") {
    const impulse = detectImpulse(candles4h, debug);
    if (impulse) {
      const aligned =
        (htBias === "BULLISH" && impulse.direction === "LONG") ||
        (htBias === "BEARISH" && impulse.direction === "SHORT") ||
        htBias === "NEUTRAL";

      if (!aligned) {
        debug.push(`WATCHING BLOCKED: ${impulse.direction} impulse but HTF is ${htBias}`);
        return { debug, stage: "NONE" };
      }

      state = {
        ...state,
        stage: "WATCHING",
        impulseCandle: impulse.candle,
        impulseDirection: impulse.direction,
        impulseRange: impulse.range,
        zoneStartIndex: len,
      };
      await persistState(pair, state);
      debug.push(`WATCHING: ${impulse.direction} impulse (reversal setup) at ${impulse.candle.close.toFixed(1)} | HTF: ${htBias}`);
      return { debug, stage: "WATCHING" };
    }
    debug.push("No impulse — scanning");
    return { debug, stage: "NONE" };
  }

  // ── STAGE: WATCHING → ACCUMULATION ──────────────────────────────

  if (state.stage === "WATCHING" && state.impulseDirection) {
    const accumulation = isAccumulating(candles4h, state.impulseDirection, state.zoneStartIndex);

    if (accumulation.accumulating) {
      const recent = candles4h.slice(state.zoneStartIndex);
      const top = Math.max(...recent.map(c => c.high));
      const bottom = Math.min(...recent.map(c => c.low));

      const zone: Zone = {
        top,
        bottom,
        left: recent[0].timestamp,
        right: recent[recent.length - 1].timestamp,
        active: true,
        volumeClimax: state.impulseCandle?.volume || 0,
        type: state.impulseDirection === "LONG" ? "ACCUMULATION" : "DISTRIBUTION",
        touches: 0,
        breakAttempts: 0,
      };

      state = { ...state, stage: "ACCUMULATION", zone };
      await persistState(pair, state);
      debug.push(`ACCUMULATION: Zone ${bottom.toFixed(1)}-${top.toFixed(1)} forming after ${state.impulseDirection} impulse | Age: ${len - state.zoneStartIndex}`);
      return { debug, stage: "ACCUMULATION", zone };
    }

    const last = candles4h[candles4h.length - 1];
    const impulseClose = state.impulseCandle?.close || 0;
    const continued = state.impulseDirection === "LONG"
      ? last.close < impulseClose * 0.97
      : last.close > impulseClose * 1.03;

    if (continued) {
      debug.push("Impulse continued without accumulation — resetting");
      await persistState(pair, { stage: "NONE", zone: null, impulseCandle: null, impulseDirection: null, impulseRange: 0, prevStoch: null, zoneStartIndex: 0 });
      return { debug, stage: "NONE" };
    }

    debug.push("WATCHING: waiting for accumulation pattern");
    return { debug, stage: "WATCHING" };
  }

  // ── STAGE: ACCUMULATION (grow zone) ─────────────────────────────

  if (state.stage === "ACCUMULATION" && state.zone) {
    const last = candles4h[candles4h.length - 1];
    const atrSeries = atr(candles4h, 14);
    const currentATR = atrSeries[atrSeries.length - 1];

    state.zone.top = Math.max(state.zone.top, last.high);
    state.zone.bottom = Math.min(state.zone.bottom, last.low);
    state.zone.right = last.timestamp;

    const nearTop = Math.abs(last.high - state.zone.top) < currentATR * 0.3;
    const nearBottom = Math.abs(last.low - state.zone.bottom) < currentATR * 0.3;
    if (nearTop || nearBottom) state.zone.touches++;

    const brieflyAbove = last.high > state.zone.top && last.close <= state.zone.top;
    const brieflyBelow = last.low < state.zone.bottom && last.close >= state.zone.bottom;
    if (brieflyAbove || brieflyBelow) state.zone.breakAttempts++;

    const zoneAge = len - state.zoneStartIndex;
    const insideZone = last.close >= state.zone.bottom && last.close <= state.zone.top;
    const ready = zoneAge >= 5 && insideZone;

    if (ready) {
      state = { ...state, stage: "READY" };
      await persistState(pair, state);
      debug.push(`READY: Zone matured after ${zoneAge} candles`);
      return { debug, stage: "READY", zone: state.zone };
    }

    const brokeWrongWay = state.impulseDirection === "LONG"
      ? last.close < state.zone.bottom - currentATR * 0.5
      : last.close > state.zone.top + currentATR * 0.5;

    if (brokeWrongWay) {
      debug.push("Broke zone wrong way — resetting");
      await persistState(pair, { stage: "NONE", zone: null, impulseCandle: null, impulseDirection: null, impulseRange: 0, prevStoch: null, zoneStartIndex: 0 });
      return { debug, stage: "NONE" };
    }

    await persistState(pair, state);
    debug.push(`ACCUMULATION: Zone growing ${state.zone.bottom.toFixed(1)}-${state.zone.top.toFixed(1)} | Age: ${zoneAge} | Touches: ${state.zone.touches}`);
    return { debug, stage: "ACCUMULATION", zone: state.zone };
  }

  // ── STAGE: READY → CONFIRMED (breakout) ─────────────────────────

  if (state.stage === "READY" && state.zone) {
    const last = candles4h[candles4h.length - 1];
    const atrSeries = atr(candles4h, 14);
    const currentATR = atrSeries[atrSeries.length - 1];

    const breakoutUp = last.close > state.zone.top + currentATR * 0.2;
    const breakoutDown = last.close < state.zone.bottom - currentATR * 0.2;

    const correctBreakout = state.impulseDirection === "LONG" ? breakoutUp : breakoutDown;

    if (correctBreakout) {
      state.zone.active = false;
      state.zone.right = last.timestamp;

      const direction = state.impulseDirection;
      const entry = last.close;
      const zoneHeight = state.zone.top - state.zone.bottom;

      const swingStop = direction === "LONG" ? state.zone.bottom : state.zone.top;
      const atrStop = direction === "LONG" ? entry - currentATR * 2 : entry + currentATR * 2;
      const stop = direction === "LONG" ? Math.max(swingStop, atrStop) : Math.min(swingStop, atrStop);

      const atrTarget = direction === "LONG" ? entry + currentATR * 4 : entry - currentATR * 4;
      const zoneTarget = direction === "LONG" ? entry + zoneHeight * 2 : entry - zoneHeight * 2;
      const target = direction === "LONG" ? Math.max(atrTarget, zoneTarget) : Math.min(atrTarget, zoneTarget);

      const ema21 = ema(closes, 21);
      const trail = direction === "LONG"
        ? ema21[ema21.length - 1] - currentATR * 0.3
        : ema21[ema21.length - 1] + currentATR * 0.3;

      const rr = Math.abs(target - entry) / Math.abs(entry - stop);

      const quality = calcZoneQuality(state.zone, candles4h, state.zoneStartIndex, state.impulseRange, state.impulseCandle?.volume || 0);
      let confidence = 50;
      if (quality.label === "EXCELLENT") confidence = 85;
      else if (quality.label === "GOOD") confidence = 72;
      else if (quality.label === "AVERAGE") confidence = 60;
      else confidence = 45;

      if (htBias === "NEUTRAL") confidence -= 5;

      const explanation = `BUY because: A ${state.impulseDirection === "LONG" ? "high-volume selloff" : "high-volume buying climax"} was followed by ${quality.age} candles of range compression, ATR contracted, price formed a ${quality.label.toLowerCase()} ${state.zone.type.toLowerCase()} zone (${state.zone.bottom.toFixed(0)}-${state.zone.top.toFixed(0)}), and price broke out with momentum. Zone quality: ${quality.label} | Compression: ${quality.compression}% | Volume decay: ${quality.volumeDecay}% | Touches: ${quality.touches}.`;

      const signal: Signal = {
        id: `${pair}_${Date.now()}`,
        pair,
        direction,
        stage: "CONFIRMED",
        entry: Math.round(entry * 100) / 100,
        stop: Math.round(stop * 100) / 100,
        target: Math.round(target * 100) / 100,
        trail: Math.round(trail * 100) / 100,
        confidence: Math.min(95, Math.max(30, confidence)),
        rr: Math.round(rr * 100) / 100,
        adx: adx(candles4h),
        zoneTop: Math.round(state.zone.top * 100) / 100,
        zoneBottom: Math.round(state.zone.bottom * 100) / 100,
        explanation,
        timestamp: Date.now(),
        version: CURRENT_SIGNAL_VERSION,
      };

      await persistState(pair, { stage: "NONE", zone: null, impulseCandle: null, impulseDirection: null, impulseRange: 0, prevStoch: null, zoneStartIndex: 0 });

      const market = {
        pair,
        price: Math.round(price * 100) / 100,
        timestamp: Date.now(),
        phase: "EXPANSION",
        trend: trend1d,
        htfBias: htBias,
        adx: signal.adx,
        rsi: 0,
        stochK: stoch.k,
        stochD: stoch.d,
        zoneTop: signal.zoneTop,
        zoneBottom: signal.zoneBottom,
        zoneScore: quality.label === "EXCELLENT" ? 90 : quality.label === "GOOD" ? 70 : quality.label === "AVERAGE" ? 50 : 30,
        zoneQuality: quality,
        closes4h: candles4h.slice(-50).map(c => c.close),
      };

      debug.push(`SIGNAL: ${direction} CONFIRMED entry=${signal.entry} stop=${signal.stop} target=${signal.target} trail=${signal.trail} RR=${signal.rr} Quality=${quality.label}`);

      return { signal, market, debug, phase: "EXPANSION", zone: state.zone };
    }

    debug.push(`READY: Waiting for breakout | Zone ${state.zone.bottom.toFixed(1)}-${state.zone.top.toFixed(1)}`);
    return { debug, stage: "READY", zone: state.zone };
  }

  debug.push(`Unknown stage: ${state.stage} — resetting`);
  await persistState(pair, { stage: "NONE", zone: null, impulseCandle: null, impulseDirection: null, impulseRange: 0, prevStoch: null, zoneStartIndex: 0 });
  return { debug, stage: "NONE" };
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

  let zoneQuality: ZoneQuality | null = null;
  if (state.zone && state.zoneStartIndex > 0) {
    zoneQuality = calcZoneQuality(state.zone, candles4h, state.zoneStartIndex, state.impulseRange, state.impulseCandle?.volume || 0);
  }

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
    zoneScore: zoneQuality
      ? (zoneQuality.label === "EXCELLENT" ? 90 : zoneQuality.label === "GOOD" ? 70 : zoneQuality.label === "AVERAGE" ? 50 : 30)
      : 0,
    zoneQuality,
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

// ─── shouldHold (uses trail, not stoch) ────────────────────────────────

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
// COMPATIBILITY EXPORTS (unchanged)
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
