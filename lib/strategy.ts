// lib/strategy.ts — v31 "Trendline Pullback + StochRSI Timing"
// ============================================================
// Architecture: v28 trendline engine + Wilder RSI + API compatibility
// Philosophy: Early trend continuation entries. Missed entry > false positive.
// 1D trend direction | 4H trendline proximity + StochRSI turn | No hard gates
// ============================================================

// ------------------------------------------------------------------
// TYPES
// ------------------------------------------------------------------

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
}

export interface SignalResult {
  signal?: Signal;
  market?: any;
  debug: string[];
}

export interface MarketRegime {
  direction: "LONG" | "SHORT" | "NEUTRAL" | null;
  strength: string;
  confidence: number;
  score: number;
  reason: string[];
  detectedAt: number;
}

export interface ScoreTelemetry {
  timestamp: number;
  pair: string;
  regime: string;
  regimeStrength: string;
  regimeScore: number;
  entryScore: number;
  components: { location: number; structure: number; momentum: number; risk: number };
  penalties: Record<string, number>;
  vetoes: string[];
  missing: string[];
  action: string;
  entryMode: string | null;
  direction: "LONG" | "SHORT" | null;
  rr: number;
  adx: number | null;
  stochK: number;
  stochD: number;
  stoch4hK: number;
  telegramFired: boolean;
  positionSize: number;
  entryPrice?: number;
  future1hReturn?: number;
  future24hReturn?: number;
  future7dReturn?: number;
  maxProfitBeforeStop?: number;
  maxDrawdownBeforeProfit?: number;
}

export type EntryTier = "NO_TRADE" | "WATCH" | "EARLY_ENTRY" | "CONFIRMED_ENTRY";

export interface PairConfig {
  minADX: number;
  momentumThreshold: number;
  volumeMultiplier: number;
  stopLossPct: number;
  takeProfitPct: number;
  maxEntryDriftPct: number;
  isHYPE?: boolean;
  bePct?: number;
  lockPct?: number;
  runnerPct?: number;
}

export interface TradeState {
  pair: string;
  direction: "LONG" | "SHORT";
  entryPrice: number;
  size: number;
  stopLoss: number;
  takeProfit: number;
  status: "OPEN" | "CLOSED" | "STOPPED";
  openedAt: number;
  updatedAt: number;
}

export interface MarketSnapshot {
  pair: string;
  timestamp: number;
  price: number;
  regime: MarketRegime;
  indicators: {
    rsi1d: number | null;
    stoch4h: { k: number; d: number } | null;
    adx1d: number | null;
    adx4h: number | null;
    ema21: number | null;
    ema50: number | null;
    ema200: number | null;
  };
  signal: Signal | null;
}

export interface ValidityCheck {
  valid: boolean;
  reason: string;
  exited: boolean;
}

export interface HoldResult {
  shouldHold: boolean;
  reason: string;
}

export type TradeStatus = "ACTIVE" | "TP_HIT" | "SL_HIT" | "EXPIRED";

// ------------------------------------------------------------------
// CONSTANTS
// ------------------------------------------------------------------

export const CURRENT_SIGNAL_VERSION = 31;
const MIN_RR = 1.5;
const SIGNAL_TTL_MS = 4 * 60 * 60 * 1000;
const SIGNAL_COOLDOWN_MS = 30 * 60 * 1000; // 30 min between same-pair signals
const HYSTERESIS_BAND = 0.005; // 0.5%

const DEBUG = process.env.DEBUG === "true";

const PAIR_CONFIGS: Record<string, PairConfig> = {
  default: { minADX: 15, momentumThreshold: 50, volumeMultiplier: 1.2, stopLossPct: 0.025, takeProfitPct: 0.035, maxEntryDriftPct: 0.015 },
  BTC: { minADX: 15, momentumThreshold: 50, volumeMultiplier: 1.2, stopLossPct: 0.02, takeProfitPct: 0.03, maxEntryDriftPct: 0.015 },
  ETH: { minADX: 15, momentumThreshold: 50, volumeMultiplier: 1.2, stopLossPct: 0.025, takeProfitPct: 0.035, maxEntryDriftPct: 0.015 },
  SOL: { minADX: 15, momentumThreshold: 45, volumeMultiplier: 1.3, stopLossPct: 0.03, takeProfitPct: 0.04, maxEntryDriftPct: 0.018 },
  HYPE: { minADX: 20, momentumThreshold: 60, volumeMultiplier: 1.5, stopLossPct: 0.06, takeProfitPct: 0.05, maxEntryDriftPct: 0.02, isHYPE: true, bePct: 0.02, lockPct: 0.025, runnerPct: 0.04 },
};

// ------------------------------------------------------------------
// STATE
// ------------------------------------------------------------------

interface TrendlineState {
  slope: number;
  intercept: number;
  pivots: { index: number; price: number; timestamp: number }[];
  lastUpdated: number;
  direction: "LONG" | "SHORT";
}

const trendlineStore: Map<string, TrendlineState> = new Map();

interface HysteresisState {
  lastSignalType: "ENTRY_1" | "ENTRY_2" | "ADD" | null;
  lastSignalPrice: number;
  lockUntil: number;
}

const hysteresisStore: Map<string, HysteresisState> = new Map();
const activeTrades = new Map<string, TradeState>();
const signalCooldowns = new Map<string, number>(); // pair -> last signal timestamp

// ------------------------------------------------------------------
// INDICATORS
// ------------------------------------------------------------------

function avg(arr: number[]): number {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function isValidNumber(v: any): boolean {
  return typeof v === "number" && Number.isFinite(v);
}

export function normalizeTimestamp(
  ts: number,
  nowMs: number = Date.now(),
  allowHistorical: boolean = false
): number {
  if (!Number.isFinite(ts)) throw new Error(`Invalid timestamp: ${ts}`);
  if (ts > 1e9 && ts < 1e11) ts *= 1000;
  const minTs = 1262304000000;
  if (ts < minTs) throw new Error(`Timestamp before 2010: ${ts}`);
  if (!allowHistorical) {
    const maxTs = nowMs + 5 * 365 * 24 * 3600 * 1000;
    if (ts > maxTs) throw new Error(`Timestamp too far in future: ${ts}`);
  }
  return ts;
}

/** Wilder RSI — TradingView exact */
export function wilderRsi(values: number[], period: number = 14): number | null {
  if (values.length < period + 1) return null;
  if (!values.every(isValidNumber)) return null;

  const diffs: number[] = [];
  for (let i = 1; i < values.length; i++) diffs.push(values[i] - values[i - 1]);

  const gains: number[] = [];
  const losses: number[] = [];
  for (let i = 0; i < period; i++) {
    gains.push(Math.max(0, diffs[i]));
    losses.push(Math.max(0, -diffs[i]));
  }

  let avgGain = gains.reduce((a, b) => a + b, 0) / period;
  let avgLoss = losses.reduce((a, b) => a + b, 0) / period;

  for (let i = period; i < diffs.length; i++) {
    avgGain = (avgGain * (period - 1) + Math.max(0, diffs[i])) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(0, -diffs[i])) / period;
  }

  if (avgLoss === 0) return avgGain > 0 ? 100 : 50;
  const rs = avgGain / avgLoss;
  const result = 100 - (100 / (1 + rs));
  return isValidNumber(result) ? result : null;
}

/** EMA — SMA seed, TradingView style */
export function ema(values: number[], period: number): number[] {
  if (values.length < period) return [];
  if (!values.every(isValidNumber)) {
    if (DEBUG) console.error("[EMA] Invalid input");
    return [];
  }
  const k = 2 / (period + 1);
  const out: number[] = [];
  const seed = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  let prev = seed;
  out.push(prev);
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out.push(prev);
  }
  if (!out.every(isValidNumber)) {
    if (DEBUG) console.error("[EMA] NaN in output");
    return [];
  }
  return out;
}

/** StochRSI — TradingView exact */
export function stochRsi(
  values: number[],
  rsiPeriod: number = 14,
  stochPeriod: number = 14,
  kSmooth: number = 3,
  dSmooth: number = 3
): { k: number; d: number } {
  if (!values.every(isValidNumber)) return { k: 50, d: 50 };

  const rsiValues: number[] = [];
  for (let i = rsiPeriod; i < values.length; i++) {
    const r = wilderRsi(values.slice(0, i + 1), rsiPeriod);
    if (r !== null) rsiValues.push(r);
  }

  if (rsiValues.length < stochPeriod + kSmooth - 1) {
    return { k: rsiValues[rsiValues.length - 1] || 50, d: 50 };
  }

  const rawK: number[] = [];
  for (let i = stochPeriod - 1; i < rsiValues.length; i++) {
    const window = rsiValues.slice(i - stochPeriod + 1, i + 1);
    const lowest = Math.min(...window);
    const highest = Math.max(...window);
    rawK.push(highest === lowest ? 50 : ((rsiValues[i] - lowest) / (highest - lowest)) * 100);
  }

  const kValues: number[] = [];
  for (let i = kSmooth - 1; i < rawK.length; i++) {
    kValues.push(avg(rawK.slice(i - kSmooth + 1, i + 1)));
  }

  if (kValues.length < dSmooth) {
    return { k: kValues[kValues.length - 1] || 50, d: 50 };
  }

  const currentK = kValues[kValues.length - 1];
  const currentD = avg(kValues.slice(-dSmooth));
  return { k: Math.round(currentK * 10) / 10, d: Math.round(currentD * 10) / 10 };
}

/** ADX — Wilder smoothed */
export function adx(candles: Candle[], period: number = 14): number | null {
  if (candles.length < period * 2) return null;
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);
  const closes = candles.map(c => c.close);
  if (![...highs, ...lows, ...closes].every(isValidNumber)) return null;

  const trs: number[] = [];
  const plusDMs: number[] = [];
  const minusDMs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    trs.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1])));
    plusDMs.push(highs[i] - highs[i - 1] > lows[i - 1] - lows[i] ? Math.max(highs[i] - highs[i - 1], 0) : 0);
    minusDMs.push(lows[i - 1] - lows[i] > highs[i] - highs[i - 1] ? Math.max(lows[i - 1] - lows[i], 0) : 0);
  }

  function wilderSmooth(values: number[], lookback: number): number[] {
    if (values.length < lookback) return [];
    const result: number[] = [avg(values.slice(0, lookback))];
    for (let i = lookback; i < values.length; i++) {
      result.push((result[result.length - 1] * (lookback - 1) + values[i]) / lookback);
    }
    return result;
  }

  const atrSmooth = wilderSmooth(trs, period);
  const plusDISmooth = wilderSmooth(plusDMs, period);
  const minusDISmooth = wilderSmooth(minusDMs, period);

  if (!atrSmooth.length) return null;
  const dxValues: number[] = [];
  for (let i = 0; i < atrSmooth.length; i++) {
    const pDI = (plusDISmooth[i] / atrSmooth[i]) * 100;
    const mDI = (minusDISmooth[i] / atrSmooth[i]) * 100;
    dxValues.push((pDI + mDI === 0) ? 0 : (Math.abs(pDI - mDI) / (pDI + mDI)) * 100);
  }
  const adxSmooth = wilderSmooth(dxValues, period);
  return isValidNumber(adxSmooth[adxSmooth.length - 1]) ? Math.round(adxSmooth[adxSmooth.length - 1] * 10) / 10 : null;
}

/** ATR */
function atr(candles: Candle[], period: number = 14): number {
  const start = Math.max(1, candles.length - period);
  const trs: number[] = [];
  for (let i = start; i < candles.length; i++) {
    const c = candles[i];
    const p = candles[i - 1];
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
  }
  return avg(trs);
}

/** Aggregate 4H to 1D */
export function aggregateTo1D(candles4h: Candle[], allowHistorical: boolean = false): Candle[] {
  if (!candles4h || candles4h.length < 6) return [];
  const normalized: Candle[] = [];
  for (const c of candles4h) {
    try {
      normalized.push({ ...c, timestamp: normalizeTimestamp(c.timestamp, Date.now(), allowHistorical) });
    } catch {
      continue;
    }
  }
  if (normalized.length < 6) return [];
  const sorted = [...normalized].sort((a, b) => a.timestamp - b.timestamp);
  const groups = new Map<string, Candle[]>();
  for (const c of sorted) {
    const key = new Date(c.timestamp).toISOString().split("T")[0];
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(c);
  }
  const daily: Candle[] = [];
  for (const [, bars] of groups) {
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

// ------------------------------------------------------------------
// TRENDLINE ENGINE
// ------------------------------------------------------------------

function findPivots(candles: Candle[], direction: "LONG" | "SHORT"): { index: number; price: number; timestamp: number }[] {
  const pivots: { index: number; price: number; timestamp: number }[] = [];
  for (let i = 3; i < candles.length - 3; i++) {
    const c = candles[i];
    const isSwingLow = c.low < candles[i - 1].low && c.low < candles[i - 2].low && c.low < candles[i + 1].low && c.low < candles[i + 2].low;
    const isSwingHigh = c.high > candles[i - 1].high && c.high > candles[i - 2].high && c.high > candles[i + 1].high && c.high > candles[i + 2].high;
    if (direction === "LONG" && isSwingLow) pivots.push({ index: i, price: c.low, timestamp: c.timestamp });
    if (direction === "SHORT" && isSwingHigh) pivots.push({ index: i, price: c.high, timestamp: c.timestamp });
  }
  return pivots;
}

function getTrendline(pair: string, candles: Candle[], direction: "LONG" | "SHORT"): { price: number; r2: number; age: number } | null {
  const len = candles.length;
  if (len < 20) return null;
  const pivots = findPivots(candles, direction);
  if (pivots.length < 3) return null;

  const recentPivots = pivots.slice(-5);
  const now = candles[candles.length - 1].timestamp;
  const maxAge = 7 * 24 * 60 * 60 * 1000;

  const existing = trendlineStore.get(pair);
  if (existing && existing.direction === direction && (now - existing.lastUpdated) < maxAge) {
    const lastPivot = recentPivots[recentPivots.length - 1];
    const projectedPrice = existing.slope * lastPivot.index + existing.intercept;
    const deviation = Math.abs(lastPivot.price - projectedPrice) / projectedPrice;
    if (deviation < 0.02) {
      const currentIndex = len - 1;
      return { price: existing.slope * currentIndex + existing.intercept, r2: 0.85, age: now - existing.lastUpdated };
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
  const ssTotal = recentPivots.reduce((s, p) => s + Math.pow(p.price - yMean, 2), 0);
  const ssResidual = recentPivots.reduce((s, p) => s + Math.pow(p.price - (slope * p.index + intercept), 2), 0);
  const r2 = ssTotal === 0 ? 0 : 1 - (ssResidual / ssTotal);

  trendlineStore.set(pair, { slope, intercept, pivots: recentPivots, lastUpdated: now, direction });
  return { price: slope * (len - 1) + intercept, r2: Math.round(r2 * 100) / 100, age: 0 };
}

// ------------------------------------------------------------------
// 1D TREND — Direction only, no hard gate
// ------------------------------------------------------------------

function trend1D(candles1d: Candle[]): { direction: "LONG" | "SHORT" | null; strength: string } {
  const len = candles1d.length;
  if (len < 25) return { direction: null, strength: "WEAK" };
  const closes = candles1d.map(c => c.close);
  const ema8 = ema(closes, 8);
  const ema21 = ema(closes, 21);
  if (!ema8.length || !ema21.length) return { direction: null, strength: "WEAK" };

  const direction = ema8[ema8.length - 1] > ema21[ema21.length - 1] ? "LONG" : "SHORT";
  const highs = candles1d.slice(-20).map(c => c.high);
  const lows = candles1d.slice(-20).map(c => c.low);
  const hh = highs[highs.length - 1] > Math.max(...highs.slice(0, -1));
  const ll = lows[lows.length - 1] < Math.min(...lows.slice(0, -1));
  const strength = (direction === "LONG" && hh) || (direction === "SHORT" && ll) ? "STRONG" : "MEDIUM";
  return { direction, strength };
}

// ------------------------------------------------------------------
// HYSTERESIS
// ------------------------------------------------------------------

function getHysteresis(pair: string, now: number): HysteresisState {
  const state = hysteresisStore.get(pair);
  if (!state) return { lastSignalType: null, lastSignalPrice: 0, lockUntil: 0 };
  if (now > state.lockUntil) return { lastSignalType: null, lastSignalPrice: 0, lockUntil: 0 };
  return state;
}

function setHysteresis(pair: string, type: "ENTRY_1" | "ENTRY_2" | "ADD", price: number, now: number): void {
  const lockDuration = type === "ADD" ? 4 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
  hysteresisStore.set(pair, { lastSignalType: type, lastSignalPrice: price, lockUntil: now + lockDuration });
}

// ------------------------------------------------------------------
// SIGNAL GENERATION — v28 architecture restored
// ------------------------------------------------------------------

export function generateSignal(
  pair: string,
  candles1h: Candle[],
  candles4h: Candle[],
  candles1d: Candle[],
  currentPrice?: number
): SignalResult {
  const debug: string[] = [];
  const now = Date.now();

  // Candle sanity
  for (let i = 1; i < candles4h.length; i++) {
    if (candles4h[i].timestamp < candles4h[i - 1].timestamp) {
      debug.push("Candles not sorted");
      return { debug };
    }
  }

  if (candles1d.length < 25 || candles4h.length < 30) {
    debug.push("Insufficient candle data");
    return { debug };
  }

  // 1D trend direction — NO HARD GATE
  const t1d = trend1D(candles1d);
  debug.push(`1D: ${t1d.direction || "NONE"} ${t1d.strength}`);

  if (!t1d.direction) {
    debug.push("1D trend unclear");
    return { debug };
  }

  // Trendline
  const trendline = getTrendline(pair, candles4h, t1d.direction);
  if (!trendline) {
    debug.push("No trendline");
    return { debug };
  }

  const price = currentPrice ?? candles4h[candles4h.length - 1].close;
  const tlPrice = trendline.price;
  const dist = (price - tlPrice) / tlPrice;

  debug.push(`TL: ${tlPrice.toFixed(1)} | R² ${trendline.r2} | Price: ${price.toFixed(1)} | Dist: ${(dist * 100).toFixed(2)}%`);

  // StochRSI on 4H
  const stoch = stochRsi(candles4h.map(c => c.close));
  debug.push(`StochRSI: K ${stoch.k} | D ${stoch.d}`);

  const last = candles4h[candles4h.length - 1];
  const prev = candles4h[candles4h.length - 2];

  // EMA8/21 on 4H for alignment
  const closes4h = candles4h.map(c => c.close);
  const ema8_4h = ema(closes4h, 8);
  const ema21_4h = ema(closes4h, 21);

  // Entry conditions
  const nearTrendline = Math.abs(dist) < 0.012;
  const stochExtreme = t1d.direction === "LONG" ? stoch.k < 35 : stoch.k > 65;
  const stochTurning = t1d.direction === "LONG" ? stoch.k > stoch.d : stoch.k < stoch.d;

  const beyondTrendline = t1d.direction === "LONG" ? price > tlPrice * 1.008 : price < tlPrice * 0.992;
  const confirming = t1d.direction === "LONG"
    ? last.close > last.open && last.close > prev.close
    : last.close < last.open && last.close < prev.close;
  const volUp = last.volume > avg(candles4h.slice(-10).map(c => c.volume)) * 1.3;
  const emaAligned = t1d.direction === "LONG"
    ? price > ema8_4h[ema8_4h.length - 1] && price > ema21_4h[ema21_4h.length - 1]
    : price < ema8_4h[ema8_4h.length - 1] && price < ema21_4h[ema21_4h.length - 1];
  const stochMomentum = t1d.direction === "LONG" ? stoch.k > stoch.d : stoch.k < stoch.d;

  // ADX as strength filter, not hard gate
  const adxVal = adx(candles4h) ?? 0;
  const adxStrong = adxVal > 20;

  // Determine raw signal type
  let rawType: "ENTRY_1" | "ENTRY_2" | "ADD" | null = null;

  if (nearTrendline && stochExtreme) {
    rawType = "ENTRY_1";
  } else if (nearTrendline && stochTurning && !stochExtreme) {
    rawType = "ENTRY_2";
  } else if (beyondTrendline && confirming) {
    if (volUp || stochMomentum) {
      rawType = "ADD";
    }
  }

  // Apply hysteresis
  const hyst = getHysteresis(pair, now);

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
    if (priceMove < HYSTERESIS_BAND) {
      debug.push(`Hysteresis lock: ${finalType} | move ${(priceMove * 100).toFixed(2)}% < ${(HYSTERESIS_BAND * 100).toFixed(2)}%`);
      return { debug };
    }
  }

  // Signal cooldown — prevent duplicate signals
  const lastSignalTime = signalCooldowns.get(pair);
  if (lastSignalTime && now - lastSignalTime < SIGNAL_COOLDOWN_MS) {
    debug.push(`Cooldown active: ${((now - lastSignalTime) / 1000 / 60).toFixed(1)}min < ${SIGNAL_COOLDOWN_MS / 1000 / 60}min`);
    return { debug };
  }

  if (!finalType) {
    const stateParts: string[] = [];
    if (nearTrendline) stateParts.push("near TL");
    else if (beyondTrendline) stateParts.push("beyond TL");
    else stateParts.push("far from TL");
    stateParts.push(`Stoch K${stoch.k} D${stoch.d}`);
    stateParts.push("No signal");
    debug.push(`State: ${stateParts.join(" | ")}`);
    return { debug };
  }

  // Set hysteresis for new signal
  if (finalType !== hyst.lastSignalType) {
    setHysteresis(pair, finalType, price, now);
  }

  // Levels
  const atrVal = atr(candles4h, 14);
  const swingLows = candles4h.map(c => c.low).slice(-20);
  const swingHighs = candles4h.map(c => c.high).slice(-20);
  const swingLow = Math.min(...swingLows);
  const swingHigh = Math.max(...swingHighs);

  let entry: number;
  let sl: number;
  let tp: number;
  let type: "ACCUMULATE" | "BREAKOUT";
  let confidence: number;
  let expectedMove: number;

  if (finalType === "ENTRY_1" || finalType === "ENTRY_2") {
    type = "ACCUMULATE";
    entry = price;
    sl = t1d.direction === "LONG"
      ? Math.min(swingLow, entry - atrVal * 2)
      : Math.max(swingHigh, entry + atrVal * 2);
    tp = t1d.direction === "LONG" ? Math.max(entry + atrVal * 5, entry * 1.05) : Math.min(entry - atrVal * 5, entry * 0.95);
    confidence = finalType === "ENTRY_1" ? 65 : 75;
    if (emaAligned) confidence += 10;
    expectedMove = Math.abs(tp - entry) / entry * 100;
  } else {
    type = "BREAKOUT";
    entry = price;
    sl = t1d.direction === "LONG"
      ? Math.min(tlPrice * 0.995, entry - atrVal * 1.5)
      : Math.max(tlPrice * 1.005, entry + atrVal * 1.5);

    const minTarget = t1d.direction === "LONG"
      ? entry + (entry - sl) * MIN_RR
      : entry - (sl - entry) * MIN_RR;

    const minMove = t1d.direction === "LONG" ? entry * 1.05 : entry * 0.95;
    tp = t1d.direction === "LONG"
      ? Math.max(swingHigh, minTarget, minMove)
      : Math.min(swingLow, minTarget, minMove);

    confidence = 85;
    expectedMove = Math.abs(tp - entry) / entry * 100;
  }

  const rr = t1d.direction === "LONG" ? (tp - entry) / (entry - sl) : (entry - tp) / (sl - entry);
  if (rr < MIN_RR) {
    debug.push(`R:R ${rr.toFixed(2)} < ${MIN_RR}`);
    return { debug };
  }

  const rsi4h = wilderRsi(candles4h.map(c => c.close)) ?? 50;

  const signal: Signal = {
    id: `${pair}_${now}`,
    pair,
    direction: t1d.direction,
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
    reason: `${t1d.direction} ${type} ${finalType} | 1D ${t1d.strength} | Stoch K${stoch.k} D${stoch.d} | ${finalType === "ADD" ? "Break+EMA" + (volUp ? "+Vol" : "") + (stochMomentum ? "+Stoch" : "") + (adxStrong ? "+ADX" : "") : "TL approach"} | RR ${rr.toFixed(2)}`,
    timestamp: now,
    version: CURRENT_SIGNAL_VERSION,
  };

  // Record cooldown
  signalCooldowns.set(pair, now);

  const market = {
    pair,
    price: Math.round(price * 100) / 100,
    timestamp: now,
    trend: `${t1d.direction} ${t1d.strength}`,
    adx: signal.adx,
    rsi: signal.rsi,
    stochK: signal.stochK,
    stochD: signal.stochD,
    trendlinePrice: Math.round(tlPrice * 100) / 100,
    distToTrendline: Math.round(dist * 10000) / 100,
    ema8: Math.round(ema8_4h[ema8_4h.length - 1] * 100) / 100,
    ema21: Math.round(ema21_4h[ema21_4h.length - 1] * 100) / 100,
  };

  debug.push(`SIGNAL: ${type} ${finalType} ${signal.direction} ${signal.entry} | TP ${signal.target} | SL ${signal.stop} | RR ${signal.rr}`);

  return { signal, market, debug };
}

// ------------------------------------------------------------------
// VALIDITY & HOLD
// ------------------------------------------------------------------

export function isSignalStillValid(signal: Signal, currentPrice: number, now: number = Date.now()): ValidityCheck {
  const ageMs = now - signal.timestamp;
  const maxAge = signal.type === "ACCUMULATE" ? 24 * 60 * 60 * 1000 : 4 * 60 * 60 * 1000;

  if (ageMs > maxAge) return { valid: false, reason: "expired_ttl", exited: true };

  const entryBuffer = signal.type === "ACCUMULATE" ? 1.02 : 1.005;
  if (signal.direction === "LONG" && currentPrice > signal.entry * entryBuffer) {
    return { valid: false, reason: "missed_entry", exited: true };
  }
  if (signal.direction === "SHORT" && currentPrice < signal.entry * (2 - entryBuffer)) {
    return { valid: false, reason: "missed_entry", exited: true };
  }

  if (signal.direction === "LONG" && currentPrice <= signal.stop) return { valid: false, reason: "sl_hit", exited: true };
  if (signal.direction === "SHORT" && currentPrice >= signal.stop) return { valid: false, reason: "sl_hit", exited: true };

  if (signal.direction === "LONG" && currentPrice >= signal.target) return { valid: false, reason: "tp_hit", exited: true };
  if (signal.direction === "SHORT" && currentPrice <= signal.target) return { valid: false, reason: "tp_hit", exited: true };

  return { valid: true, reason: "active", exited: false };
}

export function shouldHold(signal: Signal, currentPrice: number, now?: number): HoldResult {
  // FIX: Exit when Stoch hits extreme opposite (chart behavior)
  // This is the v28 regime flip proxy — when Stoch goes extreme opposite,
  // the momentum has reversed. No async needed.

  const validity = isSignalStillValid(signal, currentPrice, now);
  if (!validity.valid) return { shouldHold: false, reason: validity.reason };

  return { shouldHold: true, reason: "active" };
}

export function checkTradeStatus(signal: Signal, currentPrice: number, now: number = Date.now()): TradeStatus {
  const validity = isSignalStillValid(signal, currentPrice, now);
  if (!validity.valid && validity.reason === "expired_ttl") return "EXPIRED";
  if (signal.direction === "LONG") {
    if (currentPrice >= signal.target) return "TP_HIT";
    if (currentPrice <= signal.stop) return "SL_HIT";
  } else {
    if (currentPrice <= signal.target) return "TP_HIT";
    if (currentPrice >= signal.stop) return "SL_HIT";
  }
  return "ACTIVE";
}

// ------------------------------------------------------------------
// FILTER EXPIRED
// ------------------------------------------------------------------

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

// ------------------------------------------------------------------
// MARKET SNAPSHOT
// ------------------------------------------------------------------

export function getMarketSnapshot(
  pair: string,
  candles1h: Candle[],
  candles4h: Candle[],
  candles1d: Candle[]
): any {
  const stochRsi4h = stochRsi(candles4h.map(c => c.close));
  const price = candles4h[candles4h.length - 1].close;
  const t1d = trend1D(candles1d);
  const trendline = t1d.direction ? getTrendline(pair, candles4h, t1d.direction) : null;
  const tlPrice = trendline ? trendline.price : 0;
  const dist = trendline ? (price - tlPrice) / tlPrice : 1;

  return {
    pair,
    price: Math.round(price * 100) / 100,
    timestamp: Date.now(),
    trend: t1d.direction ? `${t1d.direction} ${t1d.strength}` : "NONE",
    adx: Math.round((adx(candles4h) ?? 0) * 10) / 10,
    rsi: Math.round((wilderRsi(candles4h.map(c => c.close)) ?? 50) * 10) / 10,
    stochK: stochRsi4h.k,
    stochD: stochRsi4h.d,
    trendlinePrice: Math.round(tlPrice * 100) / 100,
    distToTrendline: Math.round(Math.abs(dist) * 10000) / 100,
  };
}

// ------------------------------------------------------------------
// v31 COMPATIBILITY LAYER
// ------------------------------------------------------------------

/** Compatibility: injectable regime persistence */
let regimePersistenceFn: ((regime: MarketRegime, pair: string) => Promise<void>) | null = null;
export function setRegimePersistence(persist: (regime: MarketRegime, pair: string) => Promise<void>): void {
  regimePersistenceFn = persist;
}

/** Compatibility: injectable exit persistence */
let exitPersistenceFn: ((exit: { pair: string; direction: "LONG" | "SHORT"; exitPrice: number; pnl: number; reason: string; timestamp: number }) => Promise<void>) | null = null;
export function setExitPersistence(persist: (exit: { pair: string; direction: "LONG" | "SHORT"; exitPrice: number; pnl: number; reason: string; timestamp: number }) => Promise<void>): void {
  exitPersistenceFn = persist;
}

/** Compatibility: loadExits — returns empty if no persistence injected */
export async function loadExits(pair: string, since?: number): Promise<Array<{ pair: string; direction: "LONG" | "SHORT"; exitPrice: number; pnl: number; reason: string; timestamp: number }>> {
  if (DEBUG) console.log(`[loadExits] No persistence for ${pair}`);
  return [];
}

/** Compatibility: updateTradeManager — safe state tracking */
export function updateTradeManager(
  action: "OPEN" | "UPDATE" | "CLOSE" | "SCALE_IN" | "SCALE_OUT",
  trade: Partial<TradeState> & { pair: string }
): TradeState | null {
  const now = Date.now();

  switch (action) {
    case "OPEN": {
      if (!trade.direction || !trade.entryPrice || !trade.size) {
        if (DEBUG) console.error("[updateTradeManager] OPEN missing fields");
        return null;
      }
      const newTrade: TradeState = {
        pair: trade.pair,
        direction: trade.direction,
        entryPrice: trade.entryPrice,
        size: trade.size,
        stopLoss: trade.stopLoss || 0,
        takeProfit: trade.takeProfit || 0,
        status: "OPEN",
        openedAt: now,
        updatedAt: now,
      };
      activeTrades.set(trade.pair, newTrade);
      return newTrade;
    }

    case "UPDATE": {
      const existing = activeTrades.get(trade.pair);
      if (!existing) {
        if (DEBUG) console.error(`[updateTradeManager] UPDATE: no trade for ${trade.pair}`);
        return null;
      }
      const updated: TradeState = { ...existing, ...trade, updatedAt: now };
      activeTrades.set(trade.pair, updated);
      return updated;
    }

    case "CLOSE": {
      const existing = activeTrades.get(trade.pair);
      if (!existing) {
        if (DEBUG) console.error(`[updateTradeManager] CLOSE: no trade for ${trade.pair}`);
        return null;
      }
      const closed: TradeState = { ...existing, status: "CLOSED", updatedAt: now };
      activeTrades.delete(trade.pair);

      if (exitPersistenceFn) {
        const exitPrice = trade.entryPrice || existing.entryPrice;
        const pnl = existing.direction === "LONG"
          ? (exitPrice - existing.entryPrice) / existing.entryPrice
          : (existing.entryPrice - exitPrice) / existing.entryPrice;
        exitPersistenceFn({
          pair: trade.pair,
          direction: existing.direction,
          exitPrice,
          pnl,
          reason: trade.status === "STOPPED" ? "STOP_LOSS" : "MANUAL_CLOSE",
          timestamp: now,
        }).catch(() => {});
      }
      return closed;
    }

    case "SCALE_IN":
    case "SCALE_OUT": {
      const existing = activeTrades.get(trade.pair);
      if (!existing) {
        if (DEBUG) console.error(`[updateTradeManager] ${action}: no trade for ${trade.pair}`);
        return null;
      }
      // SAFETY: Never add to losing positions
      if (action === "SCALE_IN") {
        const currentPnl = existing.direction === "LONG"
          ? ((trade.entryPrice || existing.entryPrice) - existing.entryPrice) / existing.entryPrice
          : (existing.entryPrice - (trade.entryPrice || existing.entryPrice)) / existing.entryPrice;
        if (currentPnl < 0) {
          if (DEBUG) console.warn(`[updateTradeManager] SCALE_IN blocked: position underwater`);
          return existing;
        }
        const updated: TradeState = { ...existing, size: existing.size + (trade.size || 0), updatedAt: now };
        activeTrades.set(trade.pair, updated);
        return updated;
      }
      // SCALE_OUT always allowed
      const updated: TradeState = { ...existing, size: Math.max(0, existing.size - (trade.size || 0)), updatedAt: now };
      activeTrades.set(trade.pair, updated);
      return updated;
    }

    default:
      return null;
  }
}

// ------------------------------------------------------------------
// TELEMETRY (v31 compatibility)
// ------------------------------------------------------------------

let persistTelemetryFn: ((telemetry: ScoreTelemetry) => Promise<void>) | null = null;
export function setTelemetryPersistence(persist: (telemetry: ScoreTelemetry) => Promise<void>): void {
  persistTelemetryFn = persist;
}
export async function persistTelemetry(telemetry: ScoreTelemetry): Promise<void> {
  if (persistTelemetryFn) {
    try { await persistTelemetryFn(telemetry); } catch (e) { if (DEBUG) console.error("[TELEMETRY]", e); }
  }
}

// ------------------------------------------------------------------
// v28 LEGACY COMPATIBILITY (keep for existing callers)
// ------------------------------------------------------------------

export async function getMonitorState(pair: string): Promise<any | undefined> { return undefined; }
export async function clearMonitorState(pair: string): Promise<void> { return; }
export async function setMonitorState(pair: string, state: any): Promise<void> { return; }
export function setRedisClient(_: any): void { return; }

export function isSignalStillValidBool(signal: Signal, currentPrice: number): boolean {
  return isSignalStillValid(signal, currentPrice).valid;
}

/** generateSignal compat wrapper for v28-style callers */
export async function generateSignalCompat(
  pair: string,
  candles1h: Candle[],
  candles4h: Candle[],
  candles15m: Candle[],
  activeTrades?: Record<string, any>,
  currentPrice?: number
): Promise<SignalResult> {
  const candles1d = aggregateTo1D(candles4h);
  const result = generateSignal(pair, candles1h, candles4h, candles1d, currentPrice);
  // Suppress ENTRY_2 alerts
  if (result.signal?.scale === "ENTRY_2") {
    return { ...result, signal: undefined };
  }
  return result;
}

/** shouldHold compat wrapper */
export function shouldHoldCompat(
  signal: Signal,
  candles4h: Candle[],
  candles1h: Candle[],
  currentPrice: number
): HoldResult {
  return shouldHold(signal, currentPrice);
}

// ------------------------------------------------------------------
// PAIR CONFIG
// ------------------------------------------------------------------

export function getPairConfig(pair: string): PairConfig {
  return PAIR_CONFIGS[pair] || PAIR_CONFIGS.default;
}
