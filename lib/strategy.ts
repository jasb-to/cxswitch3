// lib/strategy.ts — v28 "Trendline Break: StochRSI Timing + Position Build"
// ============================================================
// Architecture: stateful trendline, hysteresis bands, TV-exact StochRSI
// EXIT: Stoch extreme opposite (matches chart)
// ALERTS: ENTRY_1 and ADD only (ENTRY_2 is internal, no alert)
//
// v28-UI-FIX + MOMENTUM:
// - getMarketSnapshot returns full UI-compatible market data for ALL pairs
// - Phase detection for UI (NONE/WATCHING/ACCUMULATION/READY/CONFIRMED/EXHAUSTION)
// - Zone calculation (top/bottom/quality/score) for ALL pairs
// - closes4h[] included for UI trend calculation
// - htfBias included for UI 1D trend display
// - Signal enriched with UI fields (stage, zoneTop, zoneBottom, trail, explanation)
// - HYPE-specific parameters (wider bands, larger targets)
// - MOMENTUM ENTRY MODE: early trend change detection via EMA cross + volume
// ============================================================

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
  type: "ACCUMULATE" | "BREAKOUT" | "EXIT";
  scale: "ENTRY_1" | "ENTRY_2" | "ADD" | null;
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
  // UI-enriched fields
  stage?: "WATCHING" | "ACCUMULATION" | "READY" | "CONFIRMED";
  zoneTop?: number;
  zoneBottom?: number;
  trail?: number;
  explanation?: string;
  // v28 exit tracking
  exited?: boolean;
  exitReason?: string;
  exitPrice?: number;
  exitTimestamp?: number;
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

export interface MarketData {
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

export interface SignalResult {
  signal?: Signal;
  market?: MarketData;
  debug: string[];
}

export const CURRENT_SIGNAL_VERSION = 28;
const MIN_RR = 1.5;

// ============================================================
// MOMENTUM MODE FLAG
// Set to true to enable early momentum entry (EMA cross + volume)
// Set to false for original v28 pullback behavior
// ============================================================
export const MOMENTUM_MODE = true;

// ============================================================
// PAIR-SPECIFIC PARAMETERS
// ============================================================

interface PairConfig {
  nearTrendlineATR: number;
  targetATR: number;
  stopATR: number;
  hysteresisBand: number;
  hysteresisLockHours: number;
  minADX: number;
  momentumBandATR: number;    // ATR multiplier for momentum entry band
  momentumTargetATR: number;  // Target multiplier for momentum mode
}

const PAIR_CONFIGS: Record<string, PairConfig> = {
  default: { nearTrendlineATR: 0.5, targetATR: 5, stopATR: 2, hysteresisBand: 0.005, hysteresisLockHours: 24, minADX: 20, momentumBandATR: 1.5, momentumTargetATR: 6 },
  BTC:     { nearTrendlineATR: 0.5, targetATR: 5, stopATR: 2, hysteresisBand: 0.005, hysteresisLockHours: 24, minADX: 20, momentumBandATR: 1.0, momentumTargetATR: 5 },
  ETH:     { nearTrendlineATR: 0.5, targetATR: 5, stopATR: 2, hysteresisBand: 0.005, hysteresisLockHours: 24, minADX: 20, momentumBandATR: 1.0, momentumTargetATR: 5 },
  SOL:     { nearTrendlineATR: 0.7, targetATR: 6, stopATR: 1.8, hysteresisBand: 0.008, hysteresisLockHours: 18, minADX: 18, momentumBandATR: 1.5, momentumTargetATR: 7 },
  HYPE:    { nearTrendlineATR: 1.2, targetATR: 8, stopATR: 1.5, hysteresisBand: 0.012, hysteresisLockHours: 12, minADX: 15, momentumBandATR: 2.0, momentumTargetATR: 10 },
};

function getPairConfig(pair: string): PairConfig {
  return PAIR_CONFIGS[pair] || PAIR_CONFIGS.default;
}

// ============================================================
// STATEFUL TRENDLINE STORE
// ============================================================

interface TrendlineState {
  slope: number;
  intercept: number;
  pivots: { index: number; price: number; timestamp: number }[];
  lastUpdated: number;
  direction: "LONG" | "SHORT";
}

const trendlineStore: Map<string, TrendlineState> = new Map();

function avg(arr: number[]): number {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

// --- RSI (TradingView exact) ---
function rsi(closes: number[], period: number = 14): number {
  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period && i < closes.length; i++) {
    const change = closes[closes.length - i] - closes[closes.length - i - 1];
    if (change > 0) gains += change;
    else losses += Math.abs(change);
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  return 100 - (100 / (1 + avgGain / avgLoss));
}

// --- RSI SERIES ---
function rsiSeries(closes: number[], period: number = 14): number[] {
  const series: number[] = [];
  for (let i = period; i < closes.length; i++) {
    const window = closes.slice(i - period + 1, i + 1);
    series.push(rsi(window, period));
  }
  return series;
}

// --- STOCHRSI (TradingView exact) ---
function stochRsi(
  closes: number[],
  rsiPeriod: number = 14,
  stochPeriod: number = 14,
  kSmooth: number = 3,
  dSmooth: number = 3
): { k: number; d: number } {
  const rsiValues = rsiSeries(closes, rsiPeriod);

  if (rsiValues.length < stochPeriod + kSmooth - 1) return { k: 50, d: 50 };

  const rawK: number[] = [];
  for (let i = stochPeriod - 1; i < rsiValues.length; i++) {
    const window = rsiValues.slice(i - stochPeriod + 1, i + 1);
    const lowest = Math.min(...window);
    const highest = Math.max(...window);
    if (highest === lowest) {
      rawK.push(50);
    } else {
      rawK.push(((rsiValues[i] - lowest) / (highest - lowest)) * 100);
    }
  }

  const kValues: number[] = [];
  for (let i = kSmooth - 1; i < rawK.length; i++) {
    kValues.push(avg(rawK.slice(i - kSmooth + 1, i + 1)));
  }

  if (kValues.length < dSmooth) return { k: 50, d: 50 };

  const currentK = kValues[kValues.length - 1];
  const currentD = avg(kValues.slice(-dSmooth));

  return { k: Math.round(currentK * 10) / 10, d: Math.round(currentD * 10) / 10 };
}

// --- WILDER SMOOTHING ---
function wilderSmooth(values: number[], period: number): number[] {
  const result: number[] = [avg(values.slice(0, period))];
  for (let i = period; i < values.length; i++) {
    result.push((result[result.length - 1] * (period - 1) + values[i]) / period);
  }
  return result;
}

// --- ADX (Wilder-smoothed) ---
function adx(candles: Candle[], period: number = 14): number {
  if (candles.length < period + 1) return 0;

  const trs: number[] = [];
  const plusDMs: number[] = [];
  const minusDMs: number[] = [];

  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const p = candles[i - 1];
    trs.push(
      Math.max(
        c.high - c.low,
        Math.abs(c.high - p.close),
        Math.abs(c.low - p.close)
      )
    );
    plusDMs.push(
      c.high - p.high > p.low - c.low ? Math.max(c.high - p.high, 0) : 0
    );
    minusDMs.push(
      p.low - c.low > c.high - p.high ? Math.max(p.low - c.low, 0) : 0
    );
  }

  const atrSmooth = wilderSmooth(trs, period);
  const plusDISmooth = wilderSmooth(plusDMs, period);
  const minusDISmooth = wilderSmooth(minusDMs, period);

  const dxValues: number[] = [];
  for (let i = 0; i < atrSmooth.length; i++) {
    const pDI = (plusDISmooth[i] / atrSmooth[i]) * 100;
    const mDI = (minusDISmooth[i] / atrSmooth[i]) * 100;
    const dx =
      pDI + mDI === 0 ? 0 : (Math.abs(pDI - mDI) / (pDI + mDI)) * 100;
    dxValues.push(dx);
  }

  const adxSmooth = wilderSmooth(dxValues, period);
  return Math.round(adxSmooth[adxSmooth.length - 1] * 10) / 10;
}

// --- AGGREGATE 4H TO 1D ---
function aggregateTo1D(candles4h: Candle[]): Candle[] {
  const sorted = [...candles4h].sort((a, b) => a.timestamp - b.timestamp);
  const groups: Map<string, Candle[]> = new Map();

  for (const c of sorted) {
    const date = new Date(c.timestamp);
    const key = `${date.getUTCFullYear()}-${date.getUTCMonth()}-${date.getUTCDate()}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(c);
  }

  const daily: Candle[] = [];
  for (const [, bars] of groups) {
    if (bars.length === 0) continue;
    daily.push({
      timestamp: bars[0].timestamp,
      open: bars[0].open,
      high: Math.max(...bars.map((b) => b.high)),
      low: Math.min(...bars.map((b) => b.low)),
      close: bars[bars.length - 1].close,
      volume: bars.reduce((sum, b) => sum + b.volume, 0),
    });
  }

  return daily.sort((a, b) => a.timestamp - b.timestamp);
}

// --- FIND PIVOTS ---
function findPivots(
  candles: Candle[],
  direction: "LONG" | "SHORT"
): { index: number; price: number; timestamp: number }[] {
  const pivots: { index: number; price: number; timestamp: number }[] = [];

  for (let i = 3; i < candles.length - 3; i++) {
    const c = candles[i];
    const isSwingLow =
      c.low < candles[i - 1].low &&
      c.low < candles[i - 2].low &&
      c.low < candles[i + 1].low &&
      c.low < candles[i + 2].low;
    const isSwingHigh =
      c.high > candles[i - 1].high &&
      c.high > candles[i - 2].high &&
      c.high > candles[i + 1].high &&
      c.high > candles[i + 2].high;

    if (direction === "LONG" && isSwingLow) {
      pivots.push({ index: i, price: c.low, timestamp: c.timestamp });
    }
    if (direction === "SHORT" && isSwingHigh) {
      pivots.push({ index: i, price: c.high, timestamp: c.timestamp });
    }
  }

  return pivots;
}

// --- STATEFUL TRENDLINE ---
function getTrendline(
  pair: string,
  candles: Candle[],
  direction: "LONG" | "SHORT"
): { price: number; r2: number; age: number } | null {
  const len = candles.length;
  if (len < 20) return null;

  const pivots = findPivots(candles, direction);
  if (pivots.length < 3) return null;

  const recentPivots = pivots.slice(-5);
  const now = candles[candles.length - 1].timestamp;

  const existing = trendlineStore.get(pair);
  const maxAge = 7 * 24 * 60 * 60 * 1000;

  if (
    existing &&
    existing.direction === direction &&
    now - existing.lastUpdated < maxAge
  ) {
    const lastPivot = recentPivots[recentPivots.length - 1];
    const projectedPrice =
      existing.slope * lastPivot.index + existing.intercept;
    const deviation =
      Math.abs(lastPivot.price - projectedPrice) / projectedPrice;

    if (deviation < 0.02) {
      const currentIndex = len - 1;
      const price = existing.slope * currentIndex + existing.intercept;
      return { price, r2: 0.85, age: now - existing.lastUpdated };
    }
  }

  const n = recentPivots.length;
  const sumX = recentPivots.reduce((s, p) => s + p.index, 0);
  const sumY = recentPivots.reduce((s, p) => s + p.price, 0);
  const sumXY = recentPivots.reduce((s, p) => s + p.index * p.price, 0);
  const sumX2 = recentPivots.reduce((s, p) => s + p.index * p.index, 0);

  const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
  const intercept = (sumY - slope * sumX) / n;

  const yMean = sumY / n;
  const ssTotal = recentPivots.reduce(
    (s, p) => s + Math.pow(p.price - yMean, 2),
    0
  );
  const ssResidual = recentPivots.reduce(
    (s, p) => s + Math.pow(p.price - (slope * p.index + intercept), 2),
    0
  );
  const r2 = ssTotal === 0 ? 0 : 1 - ssResidual / ssTotal;

  trendlineStore.set(pair, {
    slope,
    intercept,
    pivots: recentPivots,
    lastUpdated: now,
    direction,
  });

  const currentIndex = len - 1;
  const price = slope * currentIndex + intercept;

  return { price, r2: Math.round(r2 * 100) / 100, age: 0 };
}

// --- 1D TREND ---
function trend1D(candles1d: Candle[]): {
  direction: "LONG" | "SHORT" | null;
  strength: string;
  ema21Slope: number;
} {
  const len = candles1d.length;
  if (len < 25) return { direction: null, strength: "WEAK", ema21Slope: 0 };

  const closes = candles1d.map((c) => c.close);
  const ema8 = ema(closes, 8);
  const ema21 = ema(closes, 21);

  const direction =
    ema8[ema8.length - 1] > ema21[ema21.length - 1] ? "LONG" : "SHORT";

  const ema21Slope =
    ema21.length >= 3
      ? (ema21[ema21.length - 1] - ema21[ema21.length - 3]) / 2
      : 0;

  const highs = candles1d.slice(-20).map((c) => c.high);
  const lows = candles1d.slice(-20).map((c) => c.low);
  const hh = highs[highs.length - 1] > Math.max(...highs.slice(0, -1));
  const ll = lows[lows.length - 1] < Math.min(...lows.slice(0, -1));

  const strength =
    (direction === "LONG" && hh) || (direction === "SHORT" && ll)
      ? "STRONG"
      : "MEDIUM";

  return { direction, strength, ema21Slope };
}

function ema(closes: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const ema: number[] = [closes[0]];
  for (let i = 1; i < closes.length; i++) {
    ema.push(closes[i] * k + ema[i - 1] * (1 - k));
  }
  return ema;
}

// --- ATR ---
function atr(candles: Candle[], period: number = 14): number {
  const start = Math.max(1, candles.length - period);
  const trs: number[] = [];
  for (let i = start; i < candles.length; i++) {
    const c = candles[i];
    const p = candles[i - 1];
    trs.push(
      Math.max(
        c.high - c.low,
        Math.abs(c.high - p.close),
        Math.abs(c.low - p.close)
      )
    );
  }
  return avg(trs);
}

// --- HYSTERESIS STATE ---
interface HysteresisState {
  lastSignalType: "ENTRY_1" | "ENTRY_2" | "ADD" | null;
  lastSignalPrice: number;
  lockUntil: number;
}

const hysteresisStore: Map<string, HysteresisState> = new Map();

function getHysteresis(pair: string, now: number): HysteresisState {
  const state = hysteresisStore.get(pair);
  if (!state) return { lastSignalType: null, lastSignalPrice: 0, lockUntil: 0 };
  if (now > state.lockUntil)
    return { lastSignalType: null, lastSignalPrice: 0, lockUntil: 0 };
  return state;
}

function setHysteresis(
  pair: string,
  type: "ENTRY_1" | "ENTRY_2" | "ADD",
  price: number,
  now: number,
  config: PairConfig
): void {
  const lockDuration =
    type === "ADD"
      ? 4 * 60 * 60 * 1000
      : config.hysteresisLockHours * 60 * 60 * 1000;
  hysteresisStore.set(pair, {
    lastSignalType: type,
    lastSignalPrice: price,
    lockUntil: now + lockDuration,
  });
}

// ============================================================
// MOMENTUM DETECTION
// ============================================================

interface MomentumResult {
  hasMomentum: boolean;
  direction: "LONG" | "SHORT" | null;
  strength: number; // 0-100
  reasons: string[];
}

function detectMomentum(
  candles4h: Candle[],
  candles1d: Candle[],
  currentPrice: number,
  config: PairConfig
): MomentumResult {
  const reasons: string[] = [];
  const closes4h = candles4h.map((c) => c.close);
  const volumes4h = candles4h.map((c) => c.volume);

  // 4H EMA cross detection
  const ema8_4h = ema(closes4h, 8);
  const ema21_4h = ema(closes4h, 21);
  const ema8Prev = ema8_4h[ema8_4h.length - 2];
  const ema21Prev = ema21_4h[ema21_4h.length - 2];
  const ema8Now = ema8_4h[ema8_4h.length - 1];
  const ema21Now = ema21_4h[ema21_4h.length - 1];

  const wasBearish = ema8Prev <= ema21Prev;
  const isBullish = ema8Now > ema21Now;
  const wasBullish = ema8Prev >= ema21Prev;
  const isBearish = ema8Now < ema21Now;

  const emaCrossUp = wasBearish && isBullish;
  const emaCrossDown = wasBullish && isBearish;

  // Volume surge
  const avgVol = avg(volumes4h.slice(-10));
  const lastVol = volumes4h[volumes4h.length - 1];
  const volSurge = lastVol > avgVol * 1.5;

  // StochRSI alignment
  const stoch = stochRsi(closes4h);
  const stochAlignedLong = stoch.k > stoch.d && stoch.k < 70; // crossing up, not yet overbought
  const stochAlignedShort = stoch.k < stoch.d && stoch.k > 30; // crossing down, not yet oversold

  // ADX confirmation
  const adxVal = adx(candles4h);
  const adxBuilding = adxVal > config.minADX;

  // Price velocity (ROC)
  const roc = ((closes4h[closes4h.length - 1] - closes4h[closes4h.length - 4]) / closes4h[closes4h.length - 4]) * 100;
  const strongVelocity = Math.abs(roc) > 2;

  let direction: "LONG" | "SHORT" | null = null;
  let strength = 0;

  if (emaCrossUp) {
    direction = "LONG";
    reasons.push("ema8_cross_above_21");
    strength += 30;
  } else if (emaCrossDown) {
    direction = "SHORT";
    reasons.push("ema8_cross_below_21");
    strength += 30;
  }

  // Also detect momentum WITHOUT cross (price accelerating away from EMAs)
  if (!direction) {
    const priceAboveBoth = currentPrice > ema8Now && currentPrice > ema21Now;
    const priceBelowBoth = currentPrice < ema8Now && currentPrice < ema21Now;
    const emaSpread = Math.abs(ema8Now - ema21Now) / ema21Now;
    const emaSpreadWide = emaSpread > 0.005; // 0.5% spread

    if (priceAboveBoth && emaSpreadWide && stochAlignedLong) {
      direction = "LONG";
      reasons.push("price_above_emas");
      strength += 20;
    } else if (priceBelowBoth && emaSpreadWide && stochAlignedShort) {
      direction = "SHORT";
      reasons.push("price_below_emas");
      strength += 20;
    }
  }

  if (volSurge) {
    reasons.push("volume_surge");
    strength += 20;
  }
  if (adxBuilding) {
    reasons.push("adx_building");
    strength += 15;
  }
  if (strongVelocity) {
    reasons.push("strong_velocity");
    strength += 15;
  }
  if (direction === "LONG" && stochAlignedLong) {
    reasons.push("stoch_aligned");
    strength += 10;
  } else if (direction === "SHORT" && stochAlignedShort) {
    reasons.push("stoch_aligned");
    strength += 10;
  }

  strength = Math.min(100, strength);

  return { hasMomentum: strength >= 50 && direction !== null, direction, strength, reasons };
}

// ============================================================
// ZONE CALCULATION
// ============================================================

function calculateZone(
  candles4h: Candle[],
  trendlinePrice: number,
  atrVal: number,
  direction: "LONG" | "SHORT" | null
): {
  zoneTop: number | null;
  zoneBottom: number | null;
  zoneScore: number;
  zoneQuality?: ZoneQuality;
} {
  if (!direction || candles4h.length < 30) {
    return { zoneTop: null, zoneBottom: null, zoneScore: 0 };
  }

  const recent = candles4h.slice(-20);
  const highs = recent.map((c) => c.high);
  const lows = recent.map((c) => c.low);
  const volumes = recent.map((c) => c.volume);

  const rangeHigh = Math.max(...highs);
  const rangeLow = Math.min(...lows);
  const rangeWidth = rangeHigh - rangeLow;

  const zoneTop = Math.min(trendlinePrice + atrVal * 1.5, rangeHigh);
  const zoneBottom = Math.max(trendlinePrice - atrVal * 1.5, rangeLow);

  const widthATR = rangeWidth / atrVal;
  const compression = Math.max(0, Math.min(100, (1 - widthATR / 4) * 100));
  const avgVol = avg(volumes);
  const recentVol = avg(volumes.slice(-5));
  const volumeDecay =
    avgVol > 0 ? Math.max(0, (1 - recentVol / avgVol) * 100) : 0;

  let touches = 0;
  let breakAttempts = 0;
  for (const c of recent) {
    const nearTop = Math.abs(c.high - zoneTop) < atrVal * 0.3;
    const nearBottom = Math.abs(c.low - zoneBottom) < atrVal * 0.3;
    if (nearTop || nearBottom) touches++;
    if (c.high > zoneTop || c.low < zoneBottom) breakAttempts++;
  }

  let score = 50;
  score += Math.min(compression, 30);
  score += Math.min(touches * 3, 15);
  score -= breakAttempts * 2;
  score += volumeDecay * 0.2;
  score = Math.round(Math.min(100, Math.max(0, score)));

  let label: ZoneQuality["label"] = "AVERAGE";
  if (score >= 80 && touches >= 3 && compression > 40) label = "EXCELLENT";
  else if (score >= 65 && touches >= 2 && compression > 25) label = "GOOD";
  else if (score < 40 || breakAttempts > 5) label = "WEAK";

  const quality: ZoneQuality = {
    age: recent.length,
    widthATR: Math.round(widthATR * 10) / 10,
    compression: Math.round(compression * 10) / 10,
    volumeDecay: Math.round(volumeDecay * 10) / 10,
    touches,
    breakAttempts,
    label,
  };

  return {
    zoneTop: Math.round(zoneTop * 100) / 100,
    zoneBottom: Math.round(zoneBottom * 100) / 100,
    zoneScore: score,
    zoneQuality: quality,
  };
}

// ============================================================
// PHASE DETECTION
// ============================================================

function detectPhase(
  direction: "LONG" | "SHORT" | null,
  adxVal: number,
  stochK: number,
  stochD: number,
  distToTrendline: number,
  nearTrendline: boolean,
  stochExtreme: boolean,
  stochTurning: boolean,
  config: PairConfig,
  hasSignal: boolean,
  momentumResult?: MomentumResult
): MarketData["phase"] {
  if (!direction || adxVal < 15) return "NONE";

  // Exhaustion
  const stochExhausted = direction === "LONG" ? stochK > 85 : stochK < 15;
  if (stochExhausted && adxVal > 30) return "EXHAUSTION";

  if (hasSignal) return "CONFIRMED";

  // Momentum phase
  if (MOMENTUM_MODE && momentumResult?.hasMomentum) {
    return momentumResult.strength >= 70 ? "READY" : "ACCUMULATION";
  }

  // Pullback phase
  if (nearTrendline) {
    if (stochExtreme) return "READY";
    if (stochTurning) return "ACCUMULATION";
    return "WATCHING";
  }

  if (Math.abs(distToTrendline) < 0.03) return "WATCHING";

  return "NONE";
}

// ============================================================
// SIGNAL ENRICHMENT FOR UI
// ============================================================

function enrichSignalForUI(
  signal: Signal,
  candles4h: Candle[],
  trendlinePrice: number,
  atrVal: number
): Signal {
  const enriched = { ...signal };

  if (signal.scale === "ENTRY_1" || signal.scale === "ENTRY_2") {
    enriched.stage = "CONFIRMED";
  } else if (signal.scale === "ADD") {
    enriched.stage = "CONFIRMED";
  } else {
    enriched.stage = "WATCHING";
  }

  const zone = calculateZone(candles4h, trendlinePrice, atrVal, signal.direction);
  enriched.zoneTop = zone.zoneTop ?? undefined;
  enriched.zoneBottom = zone.zoneBottom ?? undefined;

  enriched.trail =
    signal.direction === "LONG"
      ? Math.round((signal.entry - atrVal) * 100) / 100
      : Math.round((signal.entry + atrVal) * 100) / 100;

  enriched.explanation = signal.reason;

  return enriched;
}

// ============================================================
// MAIN SIGNAL GENERATOR
// ============================================================

export function generateSignal(
  pair: string,
  candles1h: Candle[],
  candles4h: Candle[],
  candles15m: Candle[],
  currentPrice?: number
): SignalResult {
  const debug: string[] = [];
  const config = getPairConfig(pair);

  for (let i = 1; i < candles4h.length; i++) {
    if (candles4h[i].timestamp < candles4h[i - 1].timestamp) {
      debug.push("Candles not sorted");
      return { debug };
    }
  }

  const candles1d = aggregateTo1D(candles4h);

  if (candles1d.length < 25 || candles4h.length < 30) {
    debug.push("Insufficient candle data");
    return { debug };
  }

  const t1d = trend1D(candles1d);
  debug.push(
    `1D: ${t1d.direction || "NONE"} ${t1d.strength} slope=${t1d.ema21Slope.toFixed(2)}`
  );

  const price = currentPrice ?? candles4h[candles4h.length - 1].close;
  const atrVal = atr(candles4h, 14);
  const stoch = stochRsi(candles4h.map((c) => c.close));
  const adxVal = adx(candles4h);
  const closes4h = candles4h.map((c) => c.close);
  const ema8_4h = ema(closes4h, 8);
  const ema21_4h = ema(closes4h, 21);

  // --- MOMENTUM MODE: Early trend change detection ---
  let momentumResult: MomentumResult | undefined;
  if (MOMENTUM_MODE) {
    momentumResult = detectMomentum(candles4h, candles1d, price, config);
    if (momentumResult.hasMomentum) {
      debug.push(
        `MOMENTUM: ${momentumResult.direction} strength=${momentumResult.strength} | ${momentumResult.reasons.join(", ")}`
      );
    }
  }

  // Determine trend direction: use 1D trend OR momentum direction
  let trendDirection: "LONG" | "SHORT" | null = t1d.direction;

  // If momentum disagrees with 1D trend, follow momentum for early entry
  if (MOMENTUM_MODE && momentumResult?.hasMomentum && momentumResult.direction !== t1d.direction) {
    debug.push(`Momentum disagrees with 1D trend (${t1d.direction} vs ${momentumResult.direction}), following momentum`);
    trendDirection = momentumResult.direction;
  }

  if (!trendDirection) {
    debug.push("1D trend unclear");
    return { debug };
  }

  const trendline = getTrendline(pair, candles4h, trendDirection);
  const tlPrice = trendline ? trendline.price : price;
  const dist = trendline ? (price - tlPrice) / tlPrice : 0;

  if (trendline) {
    debug.push(
      `TL: ${tlPrice.toFixed(1)} | R² ${trendline.r2} | Price: ${price.toFixed(1)} | Dist: ${(dist * 100).toFixed(2)}% | ATR: ${atrVal.toFixed(1)}`
    );
  }

  debug.push(`StochRSI: K ${stoch.k} | D ${stoch.d}`);
  debug.push(`ADX: ${adxVal.toFixed(1)}`);

  const last = candles4h[candles4h.length - 1];
  const prev = candles4h[candles4h.length - 2];

  const now = Date.now();
  const hyst = getHysteresis(pair, now);

  // --- ENTRY CONDITIONS ---
  let rawType: "ENTRY_1" | "ENTRY_2" | "ADD" | null = null;

  // MOMENTUM ENTRY: EMA cross + volume + stoch alignment
  if (MOMENTUM_MODE && momentumResult?.hasMomentum && momentumResult.direction === trendDirection) {
    const volUp = last.volume > avg(candles4h.slice(-10).map((c) => c.volume)) * 1.3;
    const confirming =
      trendDirection === "LONG"
        ? last.close > last.open && last.close > prev.close
        : last.close < last.open && last.close < prev.close;

    if (confirming || volUp || momentumResult.strength >= 70) {
      rawType = "ENTRY_1";
      debug.push(`MOMENTUM ENTRY triggered: strength=${momentumResult.strength}`);
    }
  }

  // PULLBACK ENTRY: Original v28 logic (only if no momentum entry)
  if (!rawType) {
    const nearTrendline = trendline && Math.abs(dist * tlPrice) < atrVal * config.nearTrendlineATR;
    const stochExtreme = trendDirection === "LONG" ? stoch.k < 20 : stoch.k > 80;
    const stochTurning = trendDirection === "LONG" ? stoch.k > stoch.d : stoch.k < stoch.d;

    const beyondTrendline =
      trendDirection === "LONG"
        ? price > tlPrice * 1.008
        : price < tlPrice * 0.992;
    const confirming =
      trendDirection === "LONG"
        ? last.close > last.open && last.close > prev.close
        : last.close < last.open && last.close < prev.close;
    const volUp =
      last.volume > avg(candles4h.slice(-10).map((c) => c.volume)) * 1.3;
    const emaAligned =
      trendDirection === "LONG"
        ? price > ema8_4h[ema8_4h.length - 1] &&
          price > ema21_4h[ema21_4h.length - 1]
        : price < ema8_4h[ema8_4h.length - 1] &&
          price < ema21_4h[ema21_4h.length - 1];
    const stochMomentum =
      trendDirection === "LONG" ? stoch.k > stoch.d : stoch.k < stoch.d;
    const adxStrong = adxVal > config.minADX;

    if (nearTrendline && stochExtreme) {
      rawType = "ENTRY_1";
    } else if (nearTrendline && stochTurning && !stochExtreme) {
      rawType = "ENTRY_2";
    } else if (beyondTrendline && confirming && emaAligned) {
      if (volUp || stochMomentum || adxStrong) {
        rawType = "ADD";
      }
    }
  }

  // Hysteresis
  let finalType: "ENTRY_1" | "ENTRY_2" | "ADD" | null = null;

  if (hyst.lastSignalType === "ADD") {
    finalType = "ADD";
  } else if (hyst.lastSignalType === "ENTRY_2") {
    if (rawType === "ADD") finalType = "ADD";
    else finalType = "ENTRY_2";
  } else if (hyst.lastSignalType === "ENTRY_1") {
    if (rawType === "ADD") finalType = "ADD";
    else if (rawType === "ENTRY_2") finalType = "ENTRY_2";
    else finalType = "ENTRY_1";
  } else {
    finalType = rawType;
  }

  // Price hysteresis
  if (hyst.lastSignalType && finalType === hyst.lastSignalType) {
    const priceMove = Math.abs(price - hyst.lastSignalPrice) / hyst.lastSignalPrice;
    if (priceMove < config.hysteresisBand) {
      debug.push(
        `Hysteresis lock: ${finalType} | move ${(priceMove * 100).toFixed(2)}% < ${(config.hysteresisBand * 100).toFixed(2)}%`
      );

      const phase = detectPhase(
        trendDirection,
        adxVal,
        stoch.k,
        stoch.d,
        dist,
        false,
        false,
        false,
        config,
        false,
        momentumResult
      );
      const zone = calculateZone(candles4h, tlPrice, atrVal, trendDirection);
      const market: MarketData = {
        pair,
        price: Math.round(price * 100) / 100,
        timestamp: now,
        phase,
        trend: `${trendDirection} ${t1d.strength}`,
        htfBias:
          trendDirection === "LONG"
            ? "BULLISH"
            : trendDirection === "SHORT"
              ? "BEARISH"
              : "NEUTRAL",
        adx: Math.round(adxVal * 10) / 10,
        rsi: Math.round(rsi(candles4h.map((c) => c.close)) * 10) / 10,
        stochK: stoch.k,
        stochD: stoch.d,
        zoneTop: zone.zoneTop,
        zoneBottom: zone.zoneBottom,
        zoneScore: zone.zoneScore,
        zoneQuality: zone.zoneQuality,
        closes4h: closes4h.slice(-50),
      };
      return { market, debug };
    }
  }

  if (!finalType) {
    const stateParts: string[] = [];
    if (MOMENTUM_MODE && momentumResult?.hasMomentum) {
      stateParts.push(`momentum ${momentumResult.direction} strength=${momentumResult.strength}`);
    }
    stateParts.push(`Stoch K${stoch.k} D${stoch.d}`);
    stateParts.push("No signal");
    debug.push(`State: ${stateParts.join(" | ")}`);

    const phase = detectPhase(
      trendDirection,
      adxVal,
      stoch.k,
      stoch.d,
      dist,
      false,
      false,
      false,
      config,
      false,
      momentumResult
    );
    const zone = calculateZone(candles4h, tlPrice, atrVal, trendDirection);
    const market: MarketData = {
      pair,
      price: Math.round(price * 100) / 100,
      timestamp: now,
      phase,
      trend: `${trendDirection} ${t1d.strength}`,
      htfBias:
        trendDirection === "LONG"
          ? "BULLISH"
          : trendDirection === "SHORT"
            ? "BEARISH"
            : "NEUTRAL",
      adx: Math.round(adxVal * 10) / 10,
      rsi: Math.round(rsi(candles4h.map((c) => c.close)) * 10) / 10,
      stochK: stoch.k,
      stochD: stoch.d,
      zoneTop: zone.zoneTop,
      zoneBottom: zone.zoneBottom,
      zoneScore: zone.zoneScore,
      zoneQuality: zone.zoneQuality,
      closes4h: closes4h.slice(-50),
    };
    return { market, debug };
  }

  if (finalType !== hyst.lastSignalType) {
    setHysteresis(pair, finalType, price, now, config);
  }

  // --- LEVELS ---
  const swingLows = candles4h.map((c) => c.low).slice(-20);
  const swingHighs = candles4h.map((c) => c.high).slice(-20);
  const swingLow = Math.min(...swingLows);
  const swingHigh = Math.max(...swingHighs);

  let entry: number;
  let sl: number;
  let tp: number;
  let type: "ACCUMULATE" | "BREAKOUT";
  let confidence: number;
  let expectedMove: number;

  // Momentum mode uses wider bands and bigger targets
  const isMomentumEntry = MOMENTUM_MODE && momentumResult?.hasMomentum && finalType === "ENTRY_1";
  const targetMult = isMomentumEntry ? config.momentumTargetATR : config.targetATR;

  if (finalType === "ENTRY_1" || finalType === "ENTRY_2") {
    type = "ACCUMULATE";
    entry = price;
    sl =
      trendDirection === "LONG"
        ? Math.min(swingLow, entry - atrVal * config.stopATR)
        : Math.max(swingHigh, entry + atrVal * config.stopATR);
    tp =
      trendDirection === "LONG"
        ? entry + atrVal * targetMult
        : entry - atrVal * targetMult;
    confidence = finalType === "ENTRY_1" ? (isMomentumEntry ? 65 : 50) : 60;
    expectedMove = (Math.abs(tp - entry) / entry) * 100;
  } else {
    type = "BREAKOUT";
    entry = price;
    sl =
      trendDirection === "LONG"
        ? Math.min(tlPrice * 0.995, entry - atrVal * config.stopATR)
        : Math.max(tlPrice * 1.005, entry + atrVal * config.stopATR);

    const minTarget =
      trendDirection === "LONG"
        ? entry + (entry - sl) * MIN_RR
        : entry - (sl - entry) * MIN_RR;

    tp =
      trendDirection === "LONG"
        ? Math.max(swingHigh, minTarget)
        : Math.min(swingLow, minTarget);

    confidence = 85;
    expectedMove = (Math.abs(tp - entry) / entry) * 100;
  }

  const rr =
    trendDirection === "LONG"
      ? (tp - entry) / (entry - sl)
      : (entry - tp) / (sl - entry);
  if (rr < MIN_RR) {
    debug.push(`R:R ${rr.toFixed(2)} < ${MIN_RR}`);

    const phase = detectPhase(
      trendDirection,
      adxVal,
      stoch.k,
      stoch.d,
      dist,
      false,
      false,
      false,
      config,
      false,
      momentumResult
    );
    const zone = calculateZone(candles4h, tlPrice, atrVal, trendDirection);
    const market: MarketData = {
      pair,
      price: Math.round(price * 100) / 100,
      timestamp: now,
      phase,
      trend: `${trendDirection} ${t1d.strength}`,
      htfBias:
        trendDirection === "LONG"
          ? "BULLISH"
          : trendDirection === "SHORT"
            ? "BEARISH"
            : "NEUTRAL",
      adx: Math.round(adxVal * 10) / 10,
      rsi: Math.round(rsi(candles4h.map((c) => c.close)) * 10) / 10,
      stochK: stoch.k,
      stochD: stoch.d,
      zoneTop: zone.zoneTop,
      zoneBottom: zone.zoneBottom,
      zoneScore: zone.zoneScore,
      zoneQuality: zone.zoneQuality,
      closes4h: closes4h.slice(-50),
    };
    return { market, debug };
  }

  const rsi4h = rsi(candles4h.map((c) => c.close));

  const entryReason = isMomentumEntry
    ? `${trendDirection} MOMENTUM ${finalType} | 1D ${t1d.strength} | Stoch K${stoch.k} D${stoch.d} | ${momentumResult!.reasons.join(", ")} | RR ${rr.toFixed(2)}`
    : `${trendDirection} ${type} ${finalType} | 1D ${t1d.strength} | Stoch K${stoch.k} D${stoch.d} | TL approach | RR ${rr.toFixed(2)}`;

  let signal: Signal = {
    id: `${pair}_${Date.now()}`,
    pair,
    direction: trendDirection,
    type,
    scale: finalType,
    entry: Math.round(entry * 100) / 100,
    stop: Math.round(sl * 100) / 100,
    target: Math.round(tp * 100) / 100,
    confidence,
    rr: Math.round(rr * 100) / 100,
    adx: Math.round(adxVal * 10) / 10,
    rsi: Math.round(rsi4h * 10) / 10,
    stochK: stoch.k,
    stochD: stoch.d,
    expectedMove: Math.round(expectedMove * 10) / 10,
    reason: entryReason,
    timestamp: now,
    version: CURRENT_SIGNAL_VERSION,
  };

  signal = enrichSignalForUI(signal, candles4h, tlPrice, atrVal);

  const phase = detectPhase(
    trendDirection,
    adxVal,
    stoch.k,
    stoch.d,
    dist,
    false,
    false,
    false,
    config,
    true,
    momentumResult
  );
  const zone = calculateZone(candles4h, tlPrice, atrVal, trendDirection);

  const market: MarketData = {
    pair,
    price: Math.round(price * 100) / 100,
    timestamp: now,
    phase,
    trend: `${trendDirection} ${t1d.strength}`,
    htfBias:
      trendDirection === "LONG"
        ? "BULLISH"
        : trendDirection === "SHORT"
          ? "BEARISH"
          : "NEUTRAL",
    adx: signal.adx,
    rsi: signal.rsi,
    stochK: signal.stochK,
    stochD: signal.stochD,
    zoneTop: zone.zoneTop,
    zoneBottom: zone.zoneBottom,
    zoneScore: zone.zoneScore,
    zoneQuality: zone.zoneQuality,
    closes4h: closes4h.slice(-50),
  };

  debug.push(
    `SIGNAL: ${type} ${finalType} ${signal.direction} ${signal.entry} | TP ${signal.target} | SL ${signal.stop} | RR ${signal.rr}`
  );

  return { signal, market, debug };
}

// ============================================================
// MARKET SNAPSHOT — FULL UI DATA FOR ALL PAIRS
// ============================================================

export function getMarketSnapshot(
  pair: string,
  candles1h: Candle[],
  candles4h: Candle[],
  candles15m: Candle[]
): MarketData {
  const candles1d = aggregateTo1D(candles4h);
  const t1d = trend1D(candles1d);
  const stochRsi4h = stochRsi(candles4h.map((c) => c.close));
  const price = candles4h[candles4h.length - 1].close;
  const config = getPairConfig(pair);

  const trendline = t1d.direction
    ? getTrendline(pair, candles4h, t1d.direction)
    : null;
  const tlPrice = trendline ? trendline.price : price;
  const dist = trendline ? (price - tlPrice) / tlPrice : 0;
  const atrVal = atr(candles4h, 14);
  const adxVal = adx(candles4h);

  const closes4h = candles4h.map((c) => c.close);
  const ema8_4h = ema(closes4h, 8);
  const ema21_4h = ema(closes4h, 21);

  const nearTrendline =
    trendline && Math.abs(dist * tlPrice) < atrVal * config.nearTrendlineATR;
  const stochExtreme =
    t1d.direction === "LONG"
      ? stochRsi4h.k < 20
      : t1d.direction === "SHORT"
        ? stochRsi4h.k > 80
        : false;
  const stochTurning =
    t1d.direction === "LONG"
      ? stochRsi4h.k > stochRsi4h.d
      : t1d.direction === "SHORT"
        ? stochRsi4h.k < stochRsi4h.d
        : false;

  // Check momentum for phase
  let momentumResult: MomentumResult | undefined;
  if (MOMENTUM_MODE) {
    momentumResult = detectMomentum(candles4h, candles1d, price, config);
  }

  const phase = detectPhase(
    t1d.direction,
    adxVal,
    stochRsi4h.k,
    stochRsi4h.d,
    dist,
    !!nearTrendline,
    stochExtreme,
    stochTurning,
    config,
    false,
    momentumResult
  );

  const zone = calculateZone(candles4h, tlPrice, atrVal, t1d.direction);

  return {
    pair,
    price: Math.round(price * 100) / 100,
    timestamp: Date.now(),
    phase,
    trend: t1d.direction ? `${t1d.direction} ${t1d.strength}` : "NONE",
    htfBias:
      t1d.direction === "LONG"
        ? "BULLISH"
        : t1d.direction === "SHORT"
          ? "BEARISH"
          : "NEUTRAL",
    adx: Math.round(adxVal * 10) / 10,
    rsi: Math.round(rsi(candles4h.map((c) => c.close)) * 10) / 10,
    stochK: stochRsi4h.k,
    stochD: stochRsi4h.d,
    zoneTop: zone.zoneTop,
    zoneBottom: zone.zoneBottom,
    zoneScore: zone.zoneScore,
    zoneQuality: zone.zoneQuality,
    closes4h: closes4h.slice(-50),
  };
}

// ============================================================
// VALIDITY
// ============================================================

export interface ValidityCheck {
  valid: boolean;
  reason: string;
  exited: boolean;
}

export function isSignalStillValid(
  signal: Signal,
  currentPrice: number,
  now: number = Date.now()
): ValidityCheck {
  const ageMs = now - signal.timestamp;

  const maxAge =
    signal.type === "ACCUMULATE"
      ? 24 * 60 * 60 * 1000
      : 4 * 60 * 60 * 1000;

  if (ageMs > maxAge) {
    return { valid: false, reason: "expired_ttl", exited: true };
  }

  const entryBuffer = signal.type === "ACCUMULATE" ? 1.02 : 1.005;
  if (
    signal.direction === "LONG" &&
    currentPrice > signal.entry * entryBuffer
  ) {
    return { valid: false, reason: "missed_entry", exited: true };
  }
  if (
    signal.direction === "SHORT" &&
    currentPrice < signal.entry * (2 - entryBuffer)
  ) {
    return { valid: false, reason: "missed_entry", exited: true };
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

// --- shouldHold ---
// Exit on Stoch extreme opposite (matches chart)
export interface HoldResult {
  shouldHold: boolean;
  reason: string;
}

export function shouldHold(
  signal: Signal,
  candles4h: Candle[],
  currentPrice: number,
  now?: number
): HoldResult {
  const candles1d = aggregateTo1D(candles4h);
  const t1d = trend1D(candles1d);
  const trendReversed =
    (signal.direction === "LONG" && t1d.direction === "SHORT") ||
    (signal.direction === "SHORT" && t1d.direction === "LONG");

  if (trendReversed) {
    const inProfit =
      signal.direction === "LONG"
        ? currentPrice > signal.entry
        : currentPrice < signal.entry;
    if (!inProfit) {
      return { shouldHold: false, reason: "trend_reversed_unprofitable" };
    }
  }

  // Exit when Stoch hits extreme opposite (chart behavior)
  const closes4h = candles4h.map((c) => c.close);
  const stoch = stochRsi(closes4h);

  const stochExtremeOpposite =
    signal.direction === "LONG"
      ? stoch.k < 20
      : stoch.k > 80;

  if (stochExtremeOpposite) {
    return { shouldHold: false, reason: "stoch_extreme_opposite_exit" };
  }

  const validity = isSignalStillValid(signal, currentPrice, now);
  return { shouldHold: validity.valid, reason: validity.reason };
}

// --- filterExpiredSignals ---
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

// --- checkTradeStatus ---
export type TradeStatus = "ACTIVE" | "TP_HIT" | "SL_HIT" | "EXPIRED";

export function checkTradeStatus(
  signal: Signal,
  currentPrice: number,
  now: number = Date.now()
): TradeStatus {
  const validity = isSignalStillValid(signal, currentPrice, now);

  if (!validity.valid && validity.reason === "expired_ttl") {
    return "EXPIRED";
  }

  if (signal.direction === "LONG") {
    if (currentPrice >= signal.target) return "TP_HIT";
    if (currentPrice <= signal.stop) return "SL_HIT";
  } else {
    if (currentPrice <= signal.target) return "TP_HIT";
    if (currentPrice >= signal.stop) return "SL_HIT";
  }

  return "ACTIVE";
}

// ============================================================
// v28 COMPATIBILITY LAYER
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

export function setRedisClient(_: any): void {
  return;
}

// Only alert on ENTRY_1 and ADD. ENTRY_2 is internal (no alert).
export async function generateSignalCompat(
  pair: string,
  candles1h: Candle[],
  candles4h: Candle[],
  candles15m: Candle[],
  activeTrades?: Record<string, any>,
  currentPrice?: number
): Promise<SignalResult> {
  const result = generateSignal(
    pair,
    candles1h,
    candles4h,
    candles15m,
    currentPrice
  );

  if (result.signal?.scale === "ENTRY_2") {
    return { ...result, signal: undefined };
  }

  return result;
}

export function isSignalStillValidBool(
  signal: Signal,
  currentPrice: number
): boolean {
  return isSignalStillValid(signal, currentPrice).valid;
}

export function shouldHoldCompat(
  signal: Signal,
  candles4h: Candle[],
  candles1h: Candle[],
  currentPrice: number
): HoldResult {
  return shouldHold(signal, candles4h, currentPrice);
}

// ============================================================
// STUB EXPORTS for any code that imports Trade Manager stuff
// These are no-ops to prevent build errors
// ============================================================

export const FEATURES = {
  TRADE_MANAGER_ENABLED: false,
  PROFIT_LOCK_ENABLED: false,
  TRAIL_STOP_ENABLED: false,
  BREAK_EVEN_ENABLED: false,
  EXHAUSTION_FILTER_ENABLED: true,
};

export type TradeState = "OPEN" | "BREAK_EVEN" | "LOCKED" | "RUNNER" | "EXITED";

export interface TradeManagerState {
  tradeState: TradeState;
  highestPrice: number;
  lowestPrice: number;
  lockedStop: number;
  entryPrice: number;
  direction: "LONG" | "SHORT";
  initialStop: number;
}

export function updateTradeManagerState(
  _signal: Signal,
  _currentPrice: number,
  _candles4h: Candle[]
): { state: TradeManagerState; shouldExit: boolean; exitReason?: string } {
  return {
    state: {
      tradeState: "OPEN",
      highestPrice: 0,
      lowestPrice: 0,
      lockedStop: 0,
      entryPrice: 0,
      direction: "LONG",
      initialStop: 0,
    },
    shouldExit: false,
  };
}

export function removeTradeManagerState(_signalId: string): void {
  return;
}

export function setTradeManagerPersistence(
  _getFn: (signalId: string) => Promise<TradeManagerState | null>,
  _setFn: (signalId: string, state: TradeManagerState) => Promise<void>,
  _delFn: (signalId: string) => Promise<void>
): void {
  return;
}

export function clearAllTradeManagerState(): void {
  return;
}
