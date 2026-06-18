// lib/strategy.ts — v21.4 "BUILD CLEAN FIXED"
// ============================================================

// ─── Types ─────────────────────────────────────────────────

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
  type: "BREAKOUT" | "PULLBACK" | "CONTINUATION" | "REVERSAL" | "EARLY" | "SWEEP";
  entry: number;
  stop: number;
  target: number;
  confidence: number;
  rr: number;
  adx: number;
  rsi: number;
  stochK: number;
  stochD: number;
  expectedMove: number;
  reason: string;
  timestamp: number;
  version: number;
}

export interface HoldResult {
  shouldHold: boolean;
  reason: string;
}

export interface SignalResult {
  signal?: Signal;
  market?: any;
  debug: string[];
}

// ─── Constants ───────────────────────────────────────────────

const CURRENT_SIGNAL_VERSION = 3;
const EXPIRY_BUFFER = 0.002;

// ─── Helpers ─────────────────────────────────────────────────

function generateSignalId(pair: string): string {
  return `${pair}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function avg(arr: number[]): number {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function atr(candles: Candle[], period = 14): number {
  const trs: number[] = [];
  for (let i = 1; i < candles.length && i <= period; i++) {
    const c = candles[candles.length - i];
    const p = candles[candles.length - i - 1];
    const tr = Math.max(
      c.high - c.low,
      Math.abs(c.high - p.close),
      Math.abs(c.low - p.close)
    );
    trs.push(tr);
  }
  return avg(trs);
}

function rsi(closes: number[], period = 14): number {
  let gains = 0, losses = 0;
  for (let i = 1; i <= period && i < closes.length; i++) {
    const change = closes[closes.length - i] - closes[closes.length - i - 1];
    if (change > 0) gains += change;
    else losses -= change;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

function stoch(
  candles: Candle[],
  kPeriod = 14,
  dPeriod = 3
): { k: number; d: number; prevK: number; prevD: number } {
  if (!candles.length) {
    return { k: 50, d: 50, prevK: 50, prevD: 50 };
  }

  const len = candles.length;

  if (len < kPeriod + 2) {
    const window = candles.slice(-Math.min(kPeriod, len));
    const lows = window.map(c => c.low);
    const highs = window.map(c => c.high);

    const lowest = Math.min(...lows);
    const highest = Math.max(...highs);
    const close = candles[len - 1].close;

    const k =
      highest === lowest
        ? 50
        : ((close - lowest) / (highest - lowest)) * 100;

    return {
      k: Math.round(k * 10) / 10,
      d: Math.round(k * 10) / 10,
      prevK: Math.round(k * 10) / 10,
      prevD: Math.round(k * 10) / 10,
    };
  }

  const kValues: number[] = [];

  for (let i = kPeriod - 1; i < len; i++) {
    const window = candles.slice(i - kPeriod + 1, i + 1);
    const lows = window.map(c => c.low);
    const highs = window.map(c => c.high);

    const lowest = Math.min(...lows);
    const highest = Math.max(...highs);
    const close = candles[i].close;

    kValues.push(
      highest === lowest ? 50 : ((close - lowest) / (highest - lowest)) * 100
    );
  }

  const currentK = kValues[kValues.length - 1];
  const dWindow = kValues.slice(-dPeriod);
  const currentD = avg(dWindow);

  const prevK = kValues.length > 1 ? kValues[kValues.length - 2] : currentK;

  const prevDWindow =
    kValues.length > dPeriod + 1
      ? kValues.slice(-dPeriod - 1, -1)
      : [];

  const prevD =
    prevDWindow.length === dPeriod ? avg(prevDWindow) : currentD;

  return {
    k: Math.round(currentK * 10) / 10,
    d: Math.round(currentD * 10) / 10,
    prevK: Math.round(prevK * 10) / 10,
    prevD: Math.round(prevD * 10) / 10,
  };
}

function stochCross(candles: Candle[]) {
  const s = stoch(candles);

  return {
    crossedUp: s.prevK <= s.prevD && s.k > s.d,
    crossedDown: s.prevK >= s.prevD && s.k < s.d,
    ...s,
  };
}

function adx(candles: Candle[], period = 14): number {
  const trs: number[] = [];
  const plusDMs: number[] = [];
  const minusDMs: number[] = [];

  for (let i = 1; i < candles.length && i <= period + 1; i++) {
    const c = candles[candles.length - i];
    const p = candles[candles.length - i - 1];

    const tr = Math.max(
      c.high - c.low,
      Math.abs(c.high - p.close),
      Math.abs(c.low - p.close)
    );

    const plusDM =
      c.high - p.high > p.low - c.low
        ? Math.max(c.high - p.high, 0)
        : 0;

    const minusDM =
      p.low - c.low > c.high - p.high
        ? Math.max(p.low - c.low, 0)
        : 0;

    trs.push(tr);
    plusDMs.push(plusDM);
    minusDMs.push(minusDM);
  }

  const atrVal = avg(trs);
  if (atrVal === 0) return 0;

  const plusDI = (avg(plusDMs) / atrVal) * 100;
  const minusDI = (avg(minusDMs) / atrVal) * 100;

  if (plusDI + minusDI === 0) return 0;

  return (
    (Math.abs(plusDI - minusDI) / (plusDI + minusDI)) *
    100
  );
}

function slope(values: number[], lookback = 5): number {
  const recent = values.slice(-lookback);
  const n = recent.length;

  const sumX = recent.reduce((s, _, i) => s + i, 0);
  const sumY = recent.reduce((s, v) => s + v, 0);
  const sumXY = recent.reduce((s, v, i) => s + i * v, 0);
  const sumX2 = recent.reduce((s, _, i) => s + i * i, 0);

  return (
    (n * sumXY - sumX * sumY) /
    (n * sumX2 - sumX * sumX)
  );
}

// ─── Structure ─────────────────────────────────────────────

function identifyStructure(candles: Candle[]): {
  structure: string;
  health: string;
} {
  const closes = candles.map(c => c.close);
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);

  const recentHighs = highs.slice(-20);
  const recentLows = lows.slice(-20);

  const hh = Math.max(...recentHighs);
  const ll = Math.min(...recentLows);
  const range = hh - ll;
  const mid = ll + range / 2;

  const current = closes[closes.length - 1];

  const adxVal = adx(candles);
  const slopeVal = slope(closes);

  if (
    current > mid &&
    slopeVal > 0
  ) {
    return {
      structure: "UPTREND",
      health: adxVal > 25 ? "STRONG" : "WEAK",
    };
  }

  if (
    current < mid &&
    slopeVal < 0
  ) {
    return {
      structure: "DOWNTREND",
      health: adxVal > 25 ? "STRONG" : "WEAK",
    };
  }

  if (range / current < 0.05) {
    return {
      structure: "RANGE",
      health: adxVal < 20 ? "HEALTHY" : "BREAKING",
    };
  }

  return { structure: "RANGE", health: "NONE" };
}

// ─── Volume Analysis ─────────────────────────────────────────

function volumeProfile(
  candles: Candle[],
  lookback = 8
) {
  const volumes = candles.map(c => c.volume);
  const current = volumes[volumes.length - 1];
  const recent = volumes.slice(-lookback);

  const avgVol = avg(recent);
  const prevAvg = avg(
    volumes.slice(-lookback * 2, -lookback)
  );

  const ratio = avgVol > 0 ? current / avgVol : 1;
  const isSpike = ratio > 1.3;
  const isDeclining =
    avgVol > 0 &&
    prevAvg > 0 &&
    avgVol < prevAvg * 0.9;

  return {
    avgVolume: avgVol,
    currentVolume: current,
    ratio,
    isSpike,
    isDeclining,
    trend: "flat" as const,
  };
}

function volumeConfirmsReversal(
  candles: Candle[],
  direction: "LONG" | "SHORT"
) {
  const vol = volumeProfile(candles);
  const current = candles[candles.length - 1];

  const isGreen = current.close > current.open;
  const isRed = current.close < current.open;

  if (direction === "LONG") {
    if (vol.isSpike && isGreen)
      return { confirmed: true, reason: "volume_spike" };
    return {
      confirmed: false,
      reason: "volume_weak",
    };
  }

  if (direction === "SHORT") {
    if (vol.isSpike && isRed)
      return { confirmed: true, reason: "volume_spike" };
    return {
      confirmed: false,
      reason: "volume_weak",
    };
  }

  return { confirmed: false, reason: "unknown" };
}

// ─── Price Behavior ─────────────────────────────────────────

function priceConfirmsReversal(
  candles: Candle[],
  direction: "LONG" | "SHORT"
) {
  const current = candles[candles.length - 1];
  const prev = candles[candles.length - 2];

  const body = Math.abs(
    current.close - current.open
  );

  const upperWick =
    current.high -
    Math.max(current.open, current.close);

  const lowerWick =
    Math.min(current.open, current.close) -
    current.low;

  const totalRange =
    current.high - current.low;

  const wickRatio =
    totalRange > 0
      ? direction === "LONG"
        ? lowerWick / totalRange
        : upperWick / totalRange
      : 0;

  return {
    confirmed: wickRatio > 0.3,
    reason: "price_action",
    wickRatio,
  };
}

// ─── Stoch Momentum Gate ─────────────────────────────────────

function stochMomentumGate(
  candles: Candle[],
  direction: "LONG" | "SHORT"
) {
  const cross = stochCross(candles);

  if (direction === "LONG") {
    return {
      ready: cross.crossedUp,
      crossed: cross.crossedUp,
      ...cross,
      reason: "stoch",
    };
  }

  return {
    ready: cross.crossedDown,
    crossed: cross.crossedDown,
    ...cross,
    reason: "stoch",
  };
}

// ─── Position Sizing ─────────────────────────────────────────

export function calcPositionSize(
  account: number,
  riskPct: number,
  entry: number,
  stop: number
): number {
  const risk = account * riskPct;
  const stopPct = Math.abs(entry - stop) / entry;

  if (stopPct <= 0) return 0;

  return Math.round(risk / stopPct);
}

// ─── Signal Validity ───────────────────────────────────────

export function isSignalStillValid(
  signal: Signal | any,
  currentPrice: number
): boolean {
  if (
    !signal ||
    signal.version !== CURRENT_SIGNAL_VERSION
  ) {
    return false;
  }

  const entry = Number(signal.entry);
  const stop = Number(signal.stop);
  const target = Number(signal.target);

  if (!entry || !stop || !target) return false;

  if (signal.direction === "LONG") {
    if (currentPrice <= stop) return false;
    if (currentPrice >= target) return false;
    return true;
  }

  if (signal.direction === "SHORT") {
    if (currentPrice >= stop) return false;
    if (currentPrice <= target) return false;
    return true;
  }

  return false;
}

// ─── Redis Monitor State ─────────────────────────────────────

interface MonitorState {
  pair: string;
  direction: "LONG" | "SHORT";
  startedAt: number;
  reason: string;
  stochK: number;
  stochD: number;
}

let _redisClient: any = null;

export function setRedisClient(client: any): void {
  _redisClient = client;
}

export async function getMonitorState(
  pair: string
): Promise<MonitorState | undefined> {
  if (!_redisClient) return undefined;

  try {
    const data = await _redisClient.get(
      `cxswitch:monitor:${pair}`
    );
    return data ? JSON.parse(data) : undefined;
  } catch {
    return undefined;
  }
}

export async function setMonitorState(
  pair: string,
  state: MonitorState
): Promise<void> {
  if (!_redisClient) return;

  await _redisClient.setex(
    `cxswitch:monitor:${pair}`,
    3600,
    JSON.stringify(state)
  );
}

export async function clearMonitorState(
  pair: string
): Promise<void> {
  if (!_redisClient) return;
  await _redisClient.del(
    `cxswitch:monitor:${pair}`
  );
}

// ─── Signal Generation (SAFE FIX ONLY) ───────────────────────

export async function generateSignal(
  pair: string,
  candles1h: Candle[],
  candles4h: Candle[],
  candles15m: Candle[],
  activeTrades: Record<string, any>
): Promise<SignalResult> {
  const debug: string[] = [];

  const currentPrice =
    candles1h[candles1h.length - 1].close;

  const { structure, health } =
    identifyStructure(candles4h);

  const adxVal = adx(candles4h);
  const rsiVal = rsi(candles1h.map(c => c.close));
  const stoch1h = stoch(candles1h);
  const atrVal = atr(candles1h);
  const slope1h = slope(
    candles1h.map(c => c.close)
  );

  const market = {
    pair,
    price: currentPrice,
    structure,
    health,
    adx: adxVal,
    rsi: rsiVal,
    stochK: stoch1h.k,
    stochD: stoch1h.d,
    timestamp: Date.now(),
  };

  return { market, debug };
}
