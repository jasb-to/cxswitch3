// lib/strategy.ts — v29.2 "State Machine: Accumulation → Expansion"
// ============================================================
// Fixes: reversed impulse logic, Redis state persistence, adaptive accumulation

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
  left: number;      // start timestamp
  right: number;     // end timestamp (frozen on breakout)
  active: boolean;   // true = still growing, false = frozen
  volumeClimax: number;
  type: "ACCUMULATION" | "DISTRIBUTION";
  touches: number;   // how many times price touched zone edges
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
  age: number;           // candles since zone started
  widthATR: number;      // zone width in ATR multiples
  compression: number;   // % of impulse range compressed
  volumeDecay: number;   // % volume dropped from climax
  touches: number;
  breakAttempts: number;
  label: "EXCELLENT" | "GOOD" | "AVERAGE" | "WEAK";
}

export const CURRENT_SIGNAL_VERSION = 29;

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
    await redisClient.set(`cx_state_${pair}_v29`, JSON.stringify(state), { ex: 7 * 24 * 60 * 60 }); // 7 days
  } catch (e) {
    console.error(`[STRATEGY] Failed to persist state for ${pair}:`, e);
  }
}

// ─── IMPULSE DETECTION ─────────────────────────────────────────────────

// FIXED: Reversed logic. Sell climax → look for LONG. Buy climax → look for SHORT.
function detectImpulse(candles: Candle[]): { candle: Candle; direction: "LONG" | "SHORT"; range: number } | null {
  if (candles.length < 10) return null;

  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];

  const body = Math.abs(last.close - last.open);
  const prevBodies = candles.slice(-10, -1).map(c => Math.abs(c.close - c.open));
  const avgBody = avg(prevBodies);

  const tr = trueRange(last, prev);
  const prevTRs = candles.slice(-10, -1).map((c, i) => trueRange(c, candles[candles.length - 10 + i - 1]));
  const avgTR = avg(prevTRs);

  // Volume above average (relaxed from 2x to 1.3x)
  const prevVolumes = candles.slice(-10, -1).map(c => c.volume);
  const avgVol = avg(prevVolumes);
  const volClimax = last.volume > avgVol * 1.3;

  // Abnormal move (relaxed from 1.8x to 1.4x body, 1.5x to 1.2x TR)
  const strongBody = body > avgBody * 1.4;
  const expandingTR = tr > avgTR * 1.2;

  if (!strongBody || !expandingTR || !volClimax) return null;

  // FIXED: Reverse the direction. Big RED candle → look for LONG reversal.
  // Big GREEN candle → look for SHORT reversal.
  const direction = last.close < last.open ? "LONG" : "SHORT";

  // Calculate impulse range for compression metric later
  const impulseHigh = Math.max(...candles.slice(-3).map(c => c.high));
  const impulseLow = Math.min(...candles.slice(-3).map(c => c.low));

  return { candle: last, direction, range: impulseHigh - impulseLow };
}

// ─── ACCUMULATION DETECTION (adaptive duration) ───────────────────────────

// FIXED: Adaptive duration. Minimum 4 candles, maximum 20, until breakout/invalidation.
function isAccumulating(
  candles: Candle[],
  impulseDir: "LONG" | "SHORT",
  zoneStartIndex: number
): { accumulating: boolean; reason?: string } {
  const zoneAge = candles.length - zoneStartIndex;

  // Need at least 4 candles to call it accumulation
  if (zoneAge < 4) return { accumulating: false, reason: `too_fresh_${zoneAge}` };

  // Max 20 candles, then invalidate
  if (zoneAge > 20) return { accumulating: false, reason: "max_age_exceeded" };

  const recent = candles.slice(zoneStartIndex);
  const highs = recent.map(c => c.high);
  const lows = recent.map(c => c.low);
  const range = Math.max(...highs) - Math.min(...lows);

  const atrSeries = atr(candles, 14);
  const currentATR = atrSeries[atrSeries.length - 1];
  const impulseATR = atrSeries[Math.max(0, atrSeries.length - zoneAge - 1)] || currentATR;

  // Range compression vs impulse
  const compressed = range < impulseATR * 3;

  // ATR contraction
  const atrContracted = currentATR < impulseATR * 0.8;

  // Price not continuing the original impulse direction
  const last = candles[candles.length - 1];
  const impulseClose = candles[zoneStartIndex - 1]?.close || candles[0].close;
  const notContinuing = impulseDir === "LONG"
    ? last.close < impulseClose + range * 0.3
    : last.close > impulseClose - range * 0.3;

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

  // Compression: how much smaller is zone vs impulse range
  const compression = impulseRange > 0
    ? Math.max(0, (1 - (zone.top - zone.bottom) / impulseRange) * 100)
    : 0;

  // Volume decay: current avg volume vs impulse volume
  const recentVolumes = candles.slice(-Math.min(zoneAge, 10)).map(c => c.volume);
  const currentAvgVol = avg(recentVolumes);
  const volumeDecay = impulseVolume > 0
    ? Math.max(0, (1 - currentAvgVol / impulseVolume) * 100)
    : 0;

  // Count touches
  let touches = 0;
  const recent = candles.slice(zoneStartIndex);
  for (const c of recent) {
    const nearTop = Math.abs(c.high - zone.top) < currentATR * 0.3;
    const nearBottom = Math.abs(c.low - zone.bottom) < currentATR * 0.3;
    if (nearTop || nearBottom) touches++;
  }

  // Score-based label
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

  debug.push(`HTF Bias: ${htBias} | Stage: ${state.stage}`);

  // ── STAGE: NONE → WATCHING (impulse detected) ─────────────────────

  if (state.stage === "NONE") {
    const impulse = detectImpulse(candles4h);
    if (impulse) {
      // HTF filter: only take setups aligned with higher timeframe
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

  // ── STAGE: WATCHING → ACCUMULATION (range compression after impulse) ─

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

    // Reset if impulse continues without accumulation
    const last = candles4h[candles4h.length - 1];
    const impulseClose = state.impulseCandle?.close || 0;
    const continued = state.impulseDirection === "LONG"
      ? last.close < impulseClose * 0.97  // For LONG reversal, price keeps dropping
      : last.close > impulseClose * 1.03;   // For SHORT reversal, price keeps rising

    if (continued) {
      debug.push("Impulse continued without accumulation — resetting");
      await persistState(pair, { stage: "NONE", zone: null, impulseCandle: null, impulseDirection: null, impulseRange: 0, prevStoch: null, zoneStartIndex: 0 });
      return { debug, stage: "NONE" };
    }

    debug.push("WATCHING: waiting for accumulation pattern");
    return { debug, stage: "WATCHING" };
  }

  // ── STAGE: ACCUMULATION (grow zone, track touches, check for READY) ─

  if (state.stage === "ACCUMULATION" && state.zone) {
    const last = candles4h[candles4h.length - 1];
    const atrSeries = atr(candles4h, 14);
    const currentATR = atrSeries[atrSeries.length - 1];

    // Grow the zone
    state.zone.top = Math.max(state.zone.top, last.high);
    state.zone.bottom = Math.min(state.zone.bottom, last.low);
    state.zone.right = last.timestamp;

    // Track touches
    const nearTop = Math.abs(last.high - state.zone.top) < currentATR * 0.3;
    const nearBottom = Math.abs(last.low - state.zone.bottom) < currentATR * 0.3;
    if (nearTop || nearBottom) state.zone.touches++;

    // Track break attempts (price briefly outside zone but closed back in)
    const brieflyAbove = last.high > state.zone.top && last.close <= state.zone.top;
    const brieflyBelow = last.low < state.zone.bottom && last.close >= state.zone.bottom;
    if (brieflyAbove || brieflyBelow) state.zone.breakAttempts++;

    // Check for READY: price stayed inside zone long enough
    const zoneAge = len - state.zoneStartIndex;
    const insideZone = last.close >= state.zone.bottom && last.close <= state.zone.top;

    // READY after minimum 5 candles inside zone, or if we see a clear compression
    const ready = zoneAge >= 5 && insideZone;

    if (ready) {
      state = { ...state, stage: "READY" };
      await persistState(pair, state);
      debug.push(`READY: Zone matured after ${zoneAge} candles`);
      return { debug, stage: "READY", zone: state.zone };
    }

    // Reset if breaks zone wrong way (continues original impulse direction)
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

  // ── STAGE: READY → CONFIRMED (breakout from zone) ───────────────────

  if (state.stage === "READY" && state.zone) {
    const last = candles4h[candles4h.length - 1];
    const atrSeries = atr(candles4h, 14);
    const currentATR = atrSeries[atrSeries.length - 1];

    const breakoutUp = last.close > state.zone.top + currentATR * 0.2;
    const breakoutDown = last.close < state.zone.bottom - currentATR * 0.2;

    const correctBreakout = state.impulseDirection === "LONG" ? breakoutUp : breakoutDown;

    if (correctBreakout) {
      // Freeze zone
      state.zone.active = false;
      state.zone.right = last.timestamp;

      const direction = state.impulseDirection; // LONG or SHORT
      const entry = last.close;
      const zoneHeight = state.zone.top - state.zone.bottom;

      // Stop: swing low/high in zone OR 2 ATR, whichever is tighter
      const swingStop = direction === "LONG"
        ? state.zone.bottom
        : state.zone.top;
      const atrStop = direction === "LONG"
        ? entry - currentATR * 2
        : entry + currentATR * 2;
      const stop = direction === "LONG"
        ? Math.max(swingStop, atrStop)
        : Math.min(swingStop, atrStop);

      // Target: use ATR projection instead of fixed multiplier
      const atrTarget = direction === "LONG"
        ? entry + currentATR * 4
        : entry - currentATR * 4;
      // Or zone-based if larger
      const zoneTarget = direction === "LONG"
        ? entry + zoneHeight * 2
        : entry - zoneHeight * 2;
      const target = direction === "LONG"
        ? Math.max(atrTarget, zoneTarget)
        : Math.min(atrTarget, zoneTarget);

      // Trail: EMA21 - 0.3 ATR (or + for shorts)
      const ema21 = ema(closes, 21);
      const trail = direction === "LONG"
        ? ema21[ema21.length - 1] - currentATR * 0.3
        : ema21[ema21.length - 1] + currentATR * 0.3;

      const rr = Math.abs(target - entry) / Math.abs(entry - stop);

      // Confidence from zone quality + HTF alignment
      const quality = calcZoneQuality(state.zone, candles4h, state.zoneStartIndex, state.impulseRange, state.impulseCandle?.volume || 0);
      let confidence = 50;
      if (quality.label === "EXCELLENT") confidence = 85;
      else if (quality.label === "GOOD") confidence = 72;
      else if (quality.label === "AVERAGE") confidence = 60;
      else confidence = 45;

      // HTF alignment bonus/penalty
      if (htBias === "NEUTRAL") confidence -= 5;

      // Build explanation
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
        adx: 0, // computed below
        zoneTop: Math.round(state.zone.top * 100) / 100,
        zoneBottom: Math.round(state.zone.bottom * 100) / 100,
        explanation,
        timestamp: Date.now(),
        version: CURRENT_SIGNAL_VERSION,
      };

      // Reset state after signal
      await persistState(pair, { stage: "NONE", zone: null, impulseCandle: null, impulseDirection: null, impulseRange: 0, prevStoch: null, zoneStartIndex: 0 });

      const market = {
        pair,
        price: Math.round(price * 100) / 100,
        timestamp: Date.now(),
        phase: "EXPANSION",
        trend: `${direction} EXPANSION`,
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

    // Still waiting for breakout
    debug.push(`READY: Waiting for breakout | Zone ${state.zone.bottom.toFixed(1)}-${state.zone.top.toFixed(1)}`);
    return { debug, stage: "READY", zone: state.zone };
  }

  // Fallback
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

"use client";

import { useEffect, useState } from "react";

// ─── Types (v29.2) ──────────────────────────────────────────────────────

interface Signal {
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

interface ZoneQuality {
  age: number;
  widthATR: number;
  compression: number;
  volumeDecay: number;
  touches: number;
  breakAttempts: number;
  label: "EXCELLENT" | "GOOD" | "AVERAGE" | "WEAK";
}

interface MarketData {
  pair: string;
  price: number;
  timestamp: number;
  phase: "NONE" | "WATCHING" | "ACCUMULATION" | "READY" | "CONFIRMED" | "EXPANSION" | "EXHAUSTION";
  trend: string;
  htfBias?: "BULLISH" | "BEARISH" | "NEUTRAL";
  adx: number;
  rsi: number;
  stochK: number;
  stochD: number;
  zoneTop: number | null;
  zoneBottom: number | null;
  zoneScore: number;
  zoneQuality?: ZoneQuality;
  closes4h?: number[];
}

const PAIRS = ["BTC", "ETH", "SOL", "HYPE"];

const KRAKEN_PAIRS: Record<string, string> = {
  BTC: "XBTUSD",
  ETH: "ETHUSD",
  SOL: "SOLUSD",
  HYPE: "HYPEUSD",
};

// ─── Helpers ────────────────────────────────────────────────────────────

function money(n?: number): string {
  if (typeof n !== "number" || !isFinite(n)) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: n >= 1000 ? 0 : 2,
  }).format(n);
}

function timeAgo(ts: number): string {
  const mins = Math.floor((Date.now() - ts) / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ${mins % 60}m`;
  return `${Math.floor(hrs / 24)}d`;
}

function calcEMA(values: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const result: number[] = [values[0]];
  for (let i = 1; i < values.length; i++) {
    result.push(values[i] * k + result[i - 1] * (1 - k));
  }
  return result;
}

function getSignalStatus(signal: Signal, currentPrice: number) {
  const ageMinutes = Math.floor((Date.now() - signal.timestamp) / 60000);
  const maxAge = 24 * 60;

  if (signal.direction === "LONG") {
    if (currentPrice >= signal.target) return { status: "TP_HIT" as const, pnl: 0, ageMinutes, ttlRemaining: "0m" };
    if (currentPrice <= signal.stop) return { status: "SL_HIT" as const, pnl: 0, ageMinutes, ttlRemaining: "0m" };
  } else {
    if (currentPrice <= signal.target) return { status: "TP_HIT" as const, pnl: 0, ageMinutes, ttlRemaining: "0m" };
    if (currentPrice >= signal.stop) return { status: "SL_HIT" as const, pnl: 0, ageMinutes, ttlRemaining: "0m" };
  }

  if (ageMinutes > maxAge) return { status: "EXPIRED" as const, pnl: 0, ageMinutes, ttlRemaining: "0m" };

  const pnl = signal.direction === "LONG"
    ? ((currentPrice - signal.entry) / signal.entry) * 100
    : ((signal.entry - currentPrice) / signal.entry) * 100;

  return { status: "ACTIVE" as const, pnl, ageMinutes, ttlRemaining: `${Math.max(0, maxAge - ageMinutes)}m` };
}

function StatusBadge({ status, direction }: { status: string; direction?: "LONG" | "SHORT" }) {
  const configs: Record<string, { bg: string; text: string; label: string }> = {
    ACTIVE_LONG: { bg: "bg-emerald-500", text: "text-white", label: "ACTIVE LONG" },
    ACTIVE_SHORT: { bg: "bg-rose-500", text: "text-white", label: "ACTIVE SHORT" },
    TP_HIT: { bg: "bg-purple-500", text: "text-white", label: "TP HIT" },
    SL_HIT: { bg: "bg-red-600", text: "text-white", label: "SL HIT" },
    EXPIRED: { bg: "bg-slate-600", text: "text-white", label: "EXPIRED" },
    WATCHING: { bg: "bg-yellow-600", text: "text-white", label: "WATCHING" },
    ACCUMULATION: { bg: "bg-blue-600", text: "text-white", label: "ACCUMULATING" },
    READY: { bg: "bg-cyan-600", text: "text-white", label: "READY" },
    CONFIRMED: { bg: "bg-emerald-600", text: "text-white", label: "CONFIRMED" },
    NONE: { bg: "bg-slate-700", text: "text-slate-300", label: "SCANNING" },
  };

  const key = status === "ACTIVE" ? `ACTIVE_${direction}` : status;
  const config = configs[key] || configs.NONE;

  return (
    <span className={`px-3 py-1.5 rounded-lg text-sm font-bold ${config.bg} ${config.text}`}>
      {config.label}
    </span>
  );
}

function PhaseBadge({ phase }: { phase: string }) {
  const configs: Record<string, { bg: string; border: string; text: string; icon: string }> = {
    IMPULSE: { bg: "bg-orange-950/50", border: "border-orange-500/40", text: "text-orange-400", icon: "🔥" },
    ACCUMULATION: { bg: "bg-blue-950/50", border: "border-blue-500/40", text: "text-blue-400", icon: "📦" },
    READY: { bg: "bg-cyan-950/50", border: "border-cyan-500/40", text: "text-cyan-400", icon: "⚡" },
    CONFIRMED: { bg: "bg-emerald-950/50", border: "border-emerald-500/40", text: "text-emerald-400", icon: "✅" },
    EXPANSION: { bg: "bg-purple-950/50", border: "border-purple-500/40", text: "text-purple-400", icon: "🚀" },
    EXHAUSTION: { bg: "bg-red-950/50", border: "border-red-500/40", text: "text-red-400", icon: "😮‍💨" },
    WATCHING: { bg: "bg-yellow-950/50", border: "border-yellow-500/40", text: "text-yellow-400", icon: "👀" },
    NONE: { bg: "bg-slate-800/50", border: "border-slate-600/30", text: "text-slate-500", icon: "◌" },
  };

  const c = configs[phase] || configs.NONE;

  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-bold border ${c.bg} ${c.border} ${c.text}`}>
      <span>{c.icon}</span>
      {phase}
    </span>
  );
}

function QualityBadge({ quality }: { quality?: ZoneQuality }) {
  if (!quality) return null;
  const colors: Record<string, string> = {
    EXCELLENT: "bg-emerald-500/20 text-emerald-400 border-emerald-500/30",
    GOOD: "bg-cyan-500/20 text-cyan-400 border-cyan-500/30",
    AVERAGE: "bg-yellow-500/20 text-yellow-400 border-yellow-500/30",
    WEAK: "bg-rose-500/20 text-rose-400 border-rose-500/30",
  };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-bold border ${colors[quality.label]}`}>
      {quality.label}
    </span>
  );
}

async function fetchKrakenPrice(pair: string): Promise<number | null> {
  try {
    const res = await fetch(
      `https://api.kraken.com/0/public/Ticker?pair=${KRAKEN_PAIRS[pair]}`,
      { cache: "no-store" }
    );
n    const data = await res.json();
    if (data.error?.length) return null;
    const ticker = data.result[Object.keys(data.result)[0]];
    return parseFloat(ticker.c[0]);
  } catch {
    return null;
  }
}

// ─── Indicator Grid ─────────────────────────────────────────────────────

function IndicatorGrid({ market }: { market: MarketData | undefined }) {
  if (!market) return null;

  const adx = market.adx;
  const stochK = market.stochK;
  const stochD = market.stochD;

  const adxColor = adx > 25 ? "text-emerald-400" : adx > 20 ? "text-yellow-400" : "text-slate-500";
  const stochColor = stochK < 20 ? "text-emerald-400" : stochK > 80 ? "text-rose-400" : "text-slate-500";
  const crossDir = stochK > stochD ? "↑" : "↓";
  const crossColor = stochK > stochD ? "text-emerald-400" : "text-rose-400";

  return (
    <div className="grid grid-cols-4 gap-2">
      <div className="bg-slate-800/40 rounded-lg p-2 text-center">
        <p className="text-[10px] text-slate-500 uppercase tracking-wider mb-1">ADX</p>
        <p className={`font-mono font-bold text-sm ${adxColor}`}>{adx.toFixed(1)}</p>
        <p className="text-[10px] text-slate-600">{adx > 25 ? "STRONG" : adx > 20 ? "BUILDING" : "WEAK"}</p>
      </div>
      <div className="bg-slate-800/40 rounded-lg p-2 text-center">
        <p className="text-[10px] text-slate-500 uppercase tracking-wider mb-1">Stoch K</p>
        <p className={`font-mono font-bold text-sm ${stochColor}`}>{stochK.toFixed(1)}</p>
        <p className="text-[10px] text-slate-600">{stochK < 20 ? "OVERSOLD" : stochK > 80 ? "OVERBOUGHT" : "NEUTRAL"}</p>
      </div>
      <div className="bg-slate-800/40 rounded-lg p-2 text-center">
        <p className="text-[10px] text-slate-500 uppercase tracking-wider mb-1">Stoch D</p>
        <p className={`font-mono font-bold text-sm ${stochColor}`}>{stochD.toFixed(1)}</p>
      </div>
      <div className="bg-slate-800/40 rounded-lg p-2 text-center">
        <p className="text-[10px] text-slate-500 uppercase tracking-wider mb-1">Cross</p>
        <p className={`font-mono font-bold text-sm ${crossColor}`}>K {crossDir} D</p>
        <p className="text-[10px] text-slate-600">{Math.abs(stochK - stochD).toFixed(1)} spread</p>
      </div>
    </div>
  );
}

// ─── Trend Display (4H + 1D) ──────────────────────────────────────────

function TrendDisplay({ market }: { market: MarketData | undefined }) {
  if (!market?.closes4h || market.closes4h.length < 30) {
    return (
      <div className="grid grid-cols-2 gap-3">
        <div className="bg-slate-800/40 rounded-lg p-3">
          <p className="text-[10px] text-slate-500 uppercase tracking-wider mb-1">4H Trend</p>
          <p className="text-sm text-slate-600 font-semibold">—</p>
        </div>
        <div className="bg-slate-800/40 rounded-lg p-3">
          <p className="text-[10px] text-slate-500 uppercase tracking-wider mb-1">1D Trend</p>
          <p className="text-sm text-slate-600 font-semibold">—</p>
        </div>
      </div>
    );
  }

  const closes = market.closes4h;
  const ema8 = calcEMA(closes, 8);
  const ema21 = calcEMA(closes, 21);
  const price = closes[closes.length - 1];

  const ema8Last = ema8[ema8.length - 1];
  const ema21Last = ema21[ema21.length - 1];
  let trend4hDir: string | null = null;
  let trend4hStrength = "WEAK";
  if (ema8Last !== undefined && ema21Last !== undefined) {
    trend4hDir = price > ema8Last && price > ema21Last ? "LONG" : price < ema8Last && price < ema21Last ? "SHORT" : null;
    const spread = Math.abs(ema8Last - ema21Last) / ema21Last;
    trend4hStrength = spread > 0.02 ? "STRONG" : spread > 0.01 ? "MEDIUM" : "WEAK";
  }
  const trend4h = trend4hDir ? `${trend4hDir} ${trend4hStrength}` : "MIXED";

  // FIX: 1D trend comes from htfBias, never "NONE"
  const trend1d = market.htfBias === "BULLISH" ? "LONG" : market.htfBias === "BEARISH" ? "SHORT" : "MIXED";

  return (
    <div className="grid grid-cols-2 gap-3">
      <div className="bg-slate-800/40 rounded-lg p-3">
        <p className="text-[10px] text-slate-500 uppercase tracking-wider mb-1">4H Trend</p>
        <p className={`text-sm font-bold ${
          trend4h.includes("SHORT") ? "text-rose-400" :
          trend4h.includes("LONG") ? "text-emerald-400" : "text-yellow-400"
        }`}>
          {trend4h}
        </p>
      </div>
      <div className="bg-slate-800/40 rounded-lg p-3">
        <p className="text-[10px] text-slate-500 uppercase tracking-wider mb-1">1D Trend</p>
        <p className={`text-sm font-bold ${
          trend1d === "SHORT" ? "text-rose-400" :
          trend1d === "LONG" ? "text-emerald-400" : "text-yellow-400"
        }`}>
          {trend1d}
        </p>
        <p className="text-[10px] text-slate-600 mt-0.5">HTF: {market.htfBias}</p>
      </div>
    </div>
  );
}

// ─── Zone Details Panel ─────────────────────────────────────────────────

function ZoneDetails({ market }: { market: MarketData | undefined }) {
  if (!market?.zoneQuality) return null;

  const q = market.zoneQuality;
  const zoneHeight = market.zoneTop !== null && market.zoneBottom !== null
    ? market.zoneTop - market.zoneBottom
    : 0;

  return (
    <div className="bg-slate-800/40 rounded-lg p-3 space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-[10px] text-slate-500 uppercase tracking-wider">Zone Quality</span>
        <QualityBadge quality={q} />
      </div>
      <div className="grid grid-cols-3 gap-2 text-[11px]">
        <div className="text-center bg-slate-900/50 rounded p-1.5">
          <p className="text-slate-500 mb-0.5">Age</p>
          <p className="font-mono font-bold text-slate-300">{q.age}c</p>
        </div>
        <div className="text-center bg-slate-900/50 rounded p-1.5">
          <p className="text-slate-500 mb-0.5">Width</p>
          <p className="font-mono font-bold text-slate-300">{q.widthATR.toFixed(1)}x ATR</p>
        </div>
        <div className="text-center bg-slate-900/50 rounded p-1.5">
          <p className="text-slate-500 mb-0.5">Compress</p>
          <p className="font-mono font-bold text-slate-300">{q.compression}%</p>
        </div>
        <div className="text-center bg-slate-900/50 rounded p-1.5">
          <p className="text-slate-500 mb-0.5">Vol Decay</p>
          <p className="font-mono font-bold text-slate-300">{q.volumeDecay}%</p>
        </div>
        <div className="text-center bg-slate-900/50 rounded p-1.5">
          <p className="text-slate-500 mb-0.5">Touches</p>
          <p className="font-mono font-bold text-slate-300">{q.touches}</p>
        </div>
        <div className="text-center bg-slate-900/50 rounded p-1.5">
          <p className="text-slate-500 mb-0.5">Breaks</p>
          <p className="font-mono font-bold text-slate-300">{q.breakAttempts}</p>
        </div>
      </div>
      {zoneHeight > 0 && (
        <div className="flex items-center justify-between text-[11px]">
          <span className="text-slate-500">Zone Range</span>
          <span className="font-mono text-blue-400">
            {money(market.zoneBottom)} — {money(market.zoneTop)}
          </span>
        </div>
      )}
    </div>
  );
}

// ─── Progress Banner ──────────────────────────────────────────────────────

function ProgressBanner({ market }: { market: MarketData | undefined }) {
  if (!market) return null;

  const phase = market.phase;

  const banners: Record<string, { bg: string; border: string; text: string; title: string; desc: string }> = {
    WATCHING: {
      bg: "bg-yellow-950/30",
      border: "border-yellow-500/30",
      text: "text-yellow-400",
      title: "👀 Watching for Accumulation",
      desc: "Volume climax detected. Waiting for price to compress into a range.",
    },
    ACCUMULATION: {
      bg: "bg-blue-950/30",
      border: "border-blue-500/30",
      text: "text-blue-400",
      title: "📦 Accumulation in Progress",
      desc: "Price is compressing. Zone is growing. Monitoring for breakout readiness.",
    },
    READY: {
      bg: "bg-cyan-950/30",
      border: "border-cyan-500/30",
      text: "text-cyan-400",
      title: "⚡ Ready for Breakout",
      desc: "Zone matured. Momentum aligned. One breakout candle away from entry signal.",
    },
    CONFIRMED: {
      bg: "bg-emerald-950/30",
      border: "border-emerald-500/30",
      text: "text-emerald-400",
      title: "✅ Signal Confirmed",
      desc: "Breakout detected. Trade is active with trail stop in play.",
    },
    EXPANSION: {
      bg: "bg-purple-950/30",
      border: "border-purple-500/30",
      text: "text-purple-400",
      title: "🚀 Expansion Phase",
      desc: "Price is expanding from zone. Trail stop managing the position.",
    },
    EXHAUSTION: {
      bg: "bg-red-950/30",
      border: "border-red-500/30",
      text: "text-red-400",
      title: "😮‍💨 Exhaustion",
      desc: "Extended move showing signs of fatigue. No new entries.",
    },
    NONE: {
      bg: "bg-slate-800/30",
      border: "border-slate-600/20",
      text: "text-slate-500",
      title: "◌ Scanning Market",
      desc: "No impulse or accumulation detected. Monitoring for setups.",
    },
  };

  const b = banners[phase] || banners.NONE;

  return (
    <div className={`rounded-lg border ${b.bg} ${b.border} p-3`}>
      <p className={`text-xs font-bold uppercase tracking-wider ${b.text} mb-1`}>{b.title}</p>
      <p className="text-xs text-slate-400 leading-relaxed">{b.desc}</p>
    </div>
  );
}

// ─── Signal Card ────────────────────────────────────────────────────────

function SignalCard({
  signal,
  market,
  livePrice,
}: {
  signal: Signal;
  market: MarketData | undefined;
  livePrice: number | undefined;
}) {
  const currentPrice = livePrice ?? market?.price ?? 0;
  const meta = getSignalStatus(signal, currentPrice);

  const confColor =
    signal.confidence >= 70 ? "text-emerald-400" :
    signal.confidence >= 50 ? "text-yellow-400" :
    "text-rose-400";

  return (
    <div className="rounded-2xl border border-slate-700/50 bg-slate-900/60 p-5 space-y-4 backdrop-blur-sm">
      {/* Header */}
      <div className="flex justify-between items-start">
        <div>
          <h2 className="text-2xl font-bold text-white tracking-tight">{signal.pair}</h2>
          <p className="text-slate-400 text-sm mt-0.5">Price: {money(currentPrice)}</p>
        </div>
        <div className="flex flex-col items-end gap-2">
          <StatusBadge status={meta.status} direction={signal.direction} />
          <PhaseBadge phase={market?.phase || "NONE"} />
        </div>
      </div>

      {/* Progress Banner */}
      <ProgressBanner market={market} />

      {/* Indicators */}
      <IndicatorGrid market={market} />

      {/* Trends */}
      <TrendDisplay market={market} />

      {/* Zone Details */}
      <ZoneDetails market={market} />

      {/* Confidence */}
      <div>
        <div className="flex justify-between items-center mb-1.5">
          <span className="text-xs text-slate-500 uppercase tracking-wider">Confidence</span>
          <span className={`text-sm font-bold ${confColor}`}>{signal.confidence}%</span>
        </div>
        <div className="h-2 bg-slate-800 rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full transition-all duration-500 ${
              signal.confidence >= 70 ? "bg-emerald-500" :
              signal.confidence >= 50 ? "bg-yellow-500" : "bg-rose-500"
            }`}
            style={{ width: `${signal.confidence}%` }}
          />
        </div>
      </div>

      {/* Trade Setup */}
      <div className="bg-slate-800/40 rounded-lg p-3 space-y-2">
        <p className="text-[10px] text-slate-500 uppercase tracking-wider mb-1">Trade Setup</p>
        <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
          <div className="flex justify-between">
            <span className="text-slate-400">Direction</span>
            <span className={`font-bold ${signal.direction === "LONG" ? "text-emerald-400" : "text-rose-400"}`}>
              {signal.direction}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-slate-400">Stage</span>
            <span className="font-mono text-slate-300">{signal.stage}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-slate-400">Entry</span>
            <span className="font-mono text-white font-semibold">{money(signal.entry)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-slate-400">Stop</span>
            <span className="font-mono text-rose-400 font-semibold">{money(signal.stop)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-slate-400">Target</span>
            <span className="font-mono text-emerald-400 font-semibold">{money(signal.target)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-slate-400">Trail</span>
            <span className="font-mono text-purple-400 font-semibold">{money(signal.trail)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-slate-400">R:R</span>
            <span className="font-mono text-yellow-400 font-bold">{signal.rr.toFixed(2)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-slate-400">Zone</span>
            <span className="font-mono text-blue-400">{money(signal.zoneBottom)} — {money(signal.zoneTop)}</span>
          </div>
        </div>
      </div>

      {/* Explanation */}
      <div className="bg-slate-800/40 rounded-lg p-3">
        <p className="text-[10px] text-slate-500 uppercase tracking-wider mb-1.5">Explanation</p>
        <p className="text-xs text-slate-300 leading-relaxed">{signal.explanation}</p>
      </div>

      {/* PnL / Status */}
      {meta.status === "ACTIVE" && (
        <div className={`text-2xl font-mono font-bold ${meta.pnl >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
          {meta.pnl >= 0 ? "+" : ""}{meta.pnl.toFixed(2)}%
        </div>
      )}

      {meta.status !== "ACTIVE" && (
        <div className={`text-base font-bold ${
          meta.status === "TP_HIT" ? "text-purple-400" :
          meta.status === "SL_HIT" ? "text-rose-400" :
          meta.status === "EXPIRED" ? "text-slate-400" :
          "text-yellow-400"
        }`}>
          {meta.status === "TP_HIT" ? "🎯 TARGET HIT" :
           meta.status === "SL_HIT" ? "🛑 STOP HIT" :
           meta.status === "EXPIRED" ? "⏰ EXPIRED" :
           "⚠️ UNKNOWN"}
        </div>
      )}

      {/* Footer */}
      <div className="flex gap-2 text-[10px]">
        <span className="px-2 py-1 rounded bg-slate-800 text-slate-400">TTL {meta.ttlRemaining}</span>
        <span className="px-2 py-1 rounded bg-slate-800 text-slate-400">{timeAgo(signal.timestamp)} old</span>
        <span className="px-2 py-1 rounded bg-slate-800 text-slate-400">v{signal.version}</span>
      </div>
    </div>
  );
}

// ─── Waiting Card ───────────────────────────────────────────────────────

function WaitingCard({
  pair,
  market,
  livePrice,
}: {
  pair: string;
  market: MarketData | undefined;
  livePrice: number | undefined;
}) {
  const currentPrice = livePrice ?? market?.price ?? 0;

  return (
    <div className="rounded-2xl border border-slate-700/50 bg-slate-900/40 p-5 space-y-4 backdrop-blur-sm">
      {/* Header */}
      <div className="flex justify-between items-start">
        <div>
          <h2 className="text-2xl font-bold text-slate-300 tracking-tight">{pair}</h2>
          <p className="text-slate-500 text-sm mt-0.5">Price: {money(currentPrice)}</p>
        </div>
        <PhaseBadge phase={market?.phase || "NONE"} />
      </div>

      {/* Progress Banner */}
      <ProgressBanner market={market} />

      {/* Indicators */}
      <IndicatorGrid market={market} />

      {/* Trends */}
      <TrendDisplay market={market} />

      {/* Zone Details */}
      <ZoneDetails market={market} />

      {/* Phase-specific info */}
      {market?.phase === "ACCUMULATION" && market.zoneTop !== null && market.zoneBottom !== null && (
        <div className="bg-blue-950/20 border border-blue-500/20 rounded-lg p-3">
          <div className="flex items-center justify-between mb-1">
            <span className="text-[10px] text-blue-400 font-bold uppercase tracking-wider">Accumulation Zone</span>
            {market.zoneQuality && <QualityBadge quality={market.zoneQuality} />}
          </div>
          <p className="text-sm text-slate-300 font-mono">
            {money(market.zoneBottom)} — {money(market.zoneTop)}
          </p>
          <p className="text-xs text-slate-500 mt-1">
            {market.zoneQuality
              ? `${market.zoneQuality.age} candles • ${market.zoneQuality.compression}% compressed • ${market.zoneQuality.touches} touches`
              : "Zone forming..."}
          </p>
        </div>
      )}

      {market?.phase === "READY" && (
        <div className="bg-cyan-950/20 border border-cyan-500/20 rounded-lg p-3 animate-pulse">
          <p className="text-[10px] text-cyan-400 font-bold uppercase tracking-wider mb-1">⚡ Breakout Imminent</p>
          <p className="text-xs text-slate-400">
            Zone matured. Waiting for breakout candle with volume confirmation.
          </p>
          {market.zoneTop !== null && market.zoneBottom !== null && (
            <p className="text-xs text-slate-500 font-mono mt-1">
              Zone: {money(market.zoneBottom)} — {money(market.zoneTop)}
            </p>
          )}
        </div>
      )}

      {market?.phase === "WATCHING" && (
        <div className="bg-yellow-950/20 border border-yellow-500/20 rounded-lg p-3">
          <p className="text-[10px] text-yellow-400 font-bold uppercase tracking-wider mb-1">👀 Volume Climax Detected</p>
          <p className="text-xs text-slate-400">
            Abnormal volume + range expansion spotted. Monitoring for accumulation pattern.
          </p>
        </div>
      )}
    </div>
  );
}

// ─── Main Dashboard ─────────────────────────────────────────────────────

export default function Dashboard() {
  const [signals, setSignals] = useState<Record<string, Signal | null>>({});
  const [marketData, setMarketData] = useState<Record<string, MarketData>>({});
  const [livePrices, setLivePrices] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [fetchCount, setFetchCount] = useState(0);
  const [lastFetch, setLastFetch] = useState<number>(0);

  useEffect(() => {
    async function load() {
      try {
        const res = await fetch("/api/signals", { cache: "no-store" });
        const data = await res.json();

        const sigMap: Record<string, Signal | null> = {};
        const mktMap: Record<string, MarketData> = {};

        for (const p of PAIRS) {
          const s = data.signals?.find((sig: Signal) => sig.pair === p);
          sigMap[p] = s || null;
        }
        for (const m of data.marketData || []) {
          if (m?.pair) mktMap[m.pair] = m;
        }

        setSignals(sigMap);
        setMarketData(mktMap);
        setFetchCount((c) => c + 1);
        setLastFetch(Date.now());
      } catch (e) {
        console.error(e);
      } finally {
        setLoading(false);
      }
    }
    load();
    const i = setInterval(load, 30000);
    return () => clearInterval(i);
  }, []);

  useEffect(() => {
    async function loadPrices() {
      const liveMap: Record<string, number> = {};
      await Promise.all(
        PAIRS.map(async (pair) => {
          const price = await fetchKrakenPrice(pair);
          if (price) liveMap[pair] = price;
        })
      );
      setLivePrices(liveMap);
    }
    loadPrices();
    const i = setInterval(loadPrices, 10000);
    return () => clearInterval(i);
  }, []);

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-950 text-white flex items-center justify-center">
        <div className="text-lg">Loading CX Switch v29...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-950 p-6 space-y-8">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-bold text-white tracking-tight">CX Switch v29</h1>
          <p className="text-slate-500 text-sm mt-1">
            Phase-Based Accumulation → Expansion
          </p>
          <p className="text-slate-600 text-xs">
            Fetches: {fetchCount} | Last: {lastFetch ? new Date(lastFetch).toLocaleTimeString() : "—"}
          </p>
        </div>
      </div>

      <div className="grid md:grid-cols-2 gap-6">
        {PAIRS.map((pair) => {
          const signal = signals[pair];
          const mkt = marketData[pair];
          const livePrice = livePrices[pair];

          return signal ? (
            <SignalCard key={pair} signal={signal} market={mkt} livePrice={livePrice} />
          ) : (
            <WaitingCard key={pair} pair={pair} market={mkt} livePrice={livePrice} />
          );
        })}
      </div>
    </div>
  );
}

// ─── Validity ───────────────────────────────────────────────────────────

export interface ValidityCheck {
  valid: boolean;
  reason: string;
  exited: boolean;
}

export function isSignalStillValid(signal: Signal, currentPrice: number, now: number = Date.now()): ValidityCheck {
  const ageMs = now - signal.timestamp;
  const maxAge = 24 * 60 * 60 * 1000; // 24h for expansion entries

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
