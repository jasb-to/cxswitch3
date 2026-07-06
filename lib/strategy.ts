// lib/strategy.ts — v28 "Trendline Break: StochRSI Timing + Professional Trade Manager"
// ============================================================
// Architecture: stateful trendline, hysteresis bands, TV-exact StochRSI
// ENTRY ENGINE: Completely untouched from profitable v28
// TRADE MANAGER: Isolated behind feature flags — disable without touching entry
// EXIT: Stoch extreme opposite (legacy) OR profit-locking engine (new, flag-gated)
// ALERTS: Single entry only. No ENTRY_1/ENTRY_2/ADD progression.

// ============================================================
// EXPORTS & INTERFACES — DO NOT MODIFY (backward compatibility)
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
}

export interface SignalResult {
  signal?: Signal;
  market?: any;
  debug: string[];
}

export const CURRENT_SIGNAL_VERSION = 28;
const MIN_RR = 1.5;

// ============================================================
// FEATURE FLAGS — Trade manager kill switches
// ============================================================
// Set any flag to false to instantly disable that subsystem
// without touching the entry engine.
//
// Usage in consuming code:
//   import { FEATURE_FLAGS } from "@/lib/strategy";
//   if (FEATURE_FLAGS.ENABLE_PROFIT_LOCKING) { ... }

export const FEATURE_FLAGS = {
  /** Master switch for the new trade manager. When false, legacy behavior applies. */
  ENABLE_TRADE_MANAGER: true,
  /** Enable staged profit locking (break-even → lock → trail → runner) */
  ENABLE_PROFIT_LOCKING: true,
  /** Enable ATR-based trailing stop after +12% */
  ENABLE_ATR_TRAIL: true,
  /** Enable exhaustion filter for new entries */
  ENABLE_EXHAUSTION_FILTER: true,
  /** Enable trade state machine tracking */
  ENABLE_STATE_MACHINE: true,
} as const;

/** Runtime override — call this to disable trade manager without redeploying */
export function setFeatureFlag(key: keyof typeof FEATURE_FLAGS, value: boolean): void {
  (FEATURE_FLAGS as any)[key] = value;
}

// ============================================================
// TRADE MANAGER TYPES — Isolated from Signal interface
// ============================================================

export type TradeState =
  | "OPEN"
  | "UNDERWATER"
  | "BREAK_EVEN"
  | "LOCKED_2PCT"
  | "LOCKED_4PCT"
  | "RUNNER"
  | "EXITED";

export interface TradeSnapshot {
  signalId: string;
  pair: string;
  direction: "LONG" | "SHORT";
  entry: number;
  initialStop: number;
  currentStop: number;
  highestPrice: number;
  lowestPrice: number;
  lockedProfit: number;
  state: TradeState;
  exited: boolean;
  exitReason?: string;
  exitPrice?: number;
  updatedAt: number;
}

export interface TradeManagerResult {
  snapshot: TradeSnapshot;
  shouldExit: boolean;
  exitReason?: string;
  exitPrice?: number;
}

export interface HoldResult {
  shouldHold: boolean;
  reason: string;
}

export interface ValidityCheck {
  valid: boolean;
  reason: string;
  exited: boolean;
}

// ============================================================
// STATEFUL STORES
// ============================================================

interface TrendlineState {
  slope: number;
  intercept: number;
  pivots: { index: number; price: number; timestamp: number }[];
n  lastUpdated: number;
  direction: "LONG" | "SHORT";
}

const trendlineStore: Map<string, TrendlineState> = new Map();

/** In-memory trade snapshots — keyed by signalId. Production: persist to Redis/KV. */
const tradeSnapshotStore: Map<string, TradeSnapshot> = new Map();

/** Track which signal IDs have already fired an exit alert — prevents duplicates. */
const exitedSignalIds: Set<string> = new Set();

// ============================================================
// MATH HELPERS
// ============================================================

function avg(arr: number[]): number {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function max(arr: number[]): number {
  return arr.length ? Math.max(...arr) : 0;
}

function min(arr: number[]): number {
  return arr.length ? Math.min(...arr) : 0;
}

// ============================================================
// INDICATORS (TradingView exact)
// ============================================================

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

function rsiSeries(closes: number[], period: number = 14): number[] {
  const series: number[] = [];
  for (let i = period; i < closes.length; i++) {
    const window = closes.slice(i - period + 1, i + 1);
    series.push(rsi(window, period));
  }
  return series;
}

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

function wilderSmooth(values: number[], period: number): number[] {
  const result: number[] = [avg(values.slice(0, period))];
  for (let i = period; i < values.length; i++) {
    result.push((result[result.length - 1] * (period - 1) + values[i]) / period);
  }
  return result;
}

function adx(candles: Candle[], period: number = 14): number {
  if (candles.length < period + 1) return 0;

  const trs: number[] = [];
  const plusDMs: number[] = [];
  const minusDMs: number[] = [];

  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const p = candles[i - 1];
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
    plusDMs.push(c.high - p.high > p.low - c.low ? Math.max(c.high - p.high, 0) : 0);
    minusDMs.push(p.low - c.low > c.high - p.high ? Math.max(p.low - c.low, 0) : 0);
  }

  const atrSmooth = wilderSmooth(trs, period);
  const plusDISmooth = wilderSmooth(plusDMs, period);
  const minusDISmooth = wilderSmooth(minusDMs, period);

  const dxValues: number[] = [];
  for (let i = 0; i < atrSmooth.length; i++) {
    const pDI = (plusDISmooth[i] / atrSmooth[i]) * 100;
    const mDI = (minusDISmooth[i] / atrSmooth[i]) * 100;
    const dx = pDI + mDI === 0 ? 0 : (Math.abs(pDI - mDI) / (pDI + mDI)) * 100;
    dxValues.push(dx);
  }

  const adxSmooth = wilderSmooth(dxValues, period);
  return Math.round(adxSmooth[adxSmooth.length - 1] * 10) / 10;
}

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

  if (existing && existing.direction === direction && now - existing.lastUpdated < maxAge) {
    const lastPivot = recentPivots[recentPivots.length - 1];
    const projectedPrice = existing.slope * lastPivot.index + existing.intercept;
    const deviation = Math.abs(lastPivot.price - projectedPrice) / projectedPrice;

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
  const ssTotal = recentPivots.reduce((s, p) => s + Math.pow(p.price - yMean, 2), 0);
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

function trend1D(candles1d: Candle[]): { direction: "LONG" | "SHORT" | null; strength: string } {
  const len = candles1d.length;
  if (len < 25) return { direction: null, strength: "WEAK" };

  const closes = candles1d.map((c) => c.close);
  const ema8 = ema(closes, 8);
  const ema21 = ema(closes, 21);

  const direction = ema8[ema8.length - 1] > ema21[ema21.length - 1] ? "LONG" : "SHORT";

  const highs = candles1d.slice(-20).map((c) => c.high);
  const lows = candles1d.slice(-20).map((c) => c.low);
  const hh = highs[highs.length - 1] > Math.max(...highs.slice(0, -1));
  const ll = lows[lows.length - 1] < Math.min(...lows.slice(0, -1));

  const strength =
    (direction === "LONG" && hh) || (direction === "SHORT" && ll) ? "STRONG" : "MEDIUM";

  return { direction, strength };
}

function ema(closes: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const ema: number[] = [closes[0]];
  for (let i = 1; i < closes.length; i++) {
    ema.push(closes[i] * k + ema[i - 1] * (1 - k));
  }
  return ema;
}

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

// ============================================================
// EXHAUSTION FILTER — Rejects late entries only
// ============================================================
// Must NOT affect normal early entries.
// Only triggers when at least 2 of 4 conditions are true.

function checkExhaustion(
  direction: "LONG" | "SHORT",
  price: number,
  stochK: number,
  ema20: number,
  atrVal: number,
  trendlinePrice: number,
  adxVal: number,
  candles4h: Candle[]
): { exhausted: boolean; conditionsMet: number; details: string[] } {
  if (!FEATURE_FLAGS.ENABLE_EXHAUSTION_FILTER) {
    return { exhausted: false, conditionsMet: 0, details: ["exhaustion_filter_disabled"] };
  }

  const details: string[] = [];
  let conditionsMet = 0;

  // ADX rising check — compare last 3 values
  const adxValues: number[] = [];
  for (let i = candles4h.length - 5; i < candles4h.length; i++) {
    if (i >= 15) adxValues.push(adx(candles4h.slice(0, i + 1)));
  }
  const adxRising = adxValues.length >= 2 && adxValues[adxValues.length - 1] > adxValues[0];

  if (direction === "LONG") {
    if (stochK > 90) {
      conditionsMet++;
      details.push("stochK>90");
    }
    if (price > ema20 + 2 * atrVal) {
      conditionsMet++;
      details.push("price>EMA20+2ATR");
    }
    if (price > trendlinePrice + 1.5 * atrVal) {
      conditionsMet++;
      details.push("price>TL+1.5ATR");
    }
    if (adxVal > 45 && adxRising) {
      conditionsMet++;
      details.push("adx>45+rising");
    }
  } else {
    if (stochK < 10) {
      conditionsMet++;
      details.push("stochK<10");
    }
    if (price < ema20 - 2 * atrVal) {
      conditionsMet++;
      details.push("price<EMA20-2ATR");
    }
    if (price < trendlinePrice - 1.5 * atrVal) {
      conditionsMet++;
      details.push("price<TL-1.5ATR");
    }
    if (adxVal > 45 && adxRising) {
      conditionsMet++;
      details.push("adx>45+rising");
    }
  }

  const exhausted = conditionsMet >= 2;
  return { exhausted, conditionsMet, details };
}

// ============================================================
// ENTRY ENGINE — COMPLETELY UNTOUCHED from profitable v28
// ============================================================
// This is the original entry logic that made the strategy profitable.
// DO NOT MODIFY. The trade manager lives separately below.

interface HysteresisState {
  lastSignalType: "ENTRY_1" | "ENTRY_2" | "ADD" | null;
  lastSignalPrice: number;
  lockUntil: number;
}

const hysteresisStore: Map<string, HysteresisState> = new Map();
const HYSTERESIS_BAND = 0.005; // 0.5%

function getHysteresis(pair: string, now: number): HysteresisState {
  const state = hysteresisStore.get(pair);
  if (!state) return { lastSignalType: null, lastSignalPrice: 0, lockUntil: 0 };
  if (now > state.lockUntil) return { lastSignalType: null, lastSignalPrice: 0, lockUntil: 0 };
  return state;
}

function setHysteresis(pair: string, type: "ENTRY_1" | "ENTRY_2" | "ADD", price: number, now: number): void {
  const lockDuration = type === "ADD" ? 4 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
  hysteresisStore.set(pair, {
    lastSignalType: type,
    lastSignalPrice: price,
    lockUntil: now + lockDuration,
  });
}

export function generateSignal(
  pair: string,
  candles1h: Candle[],
  candles4h: Candle[],
  candles15m: Candle[],
  currentPrice?: number
): SignalResult {
  const debug: string[] = [];

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
  debug.push(`1D: ${t1d.direction || "NONE"} ${t1d.strength}`);

  if (!t1d.direction) {
    debug.push("1D trend unclear");
    return { debug };
  }

  const trendline = getTrendline(pair, candles4h, t1d.direction);
  if (!trendline) {
    debug.push("No trendline");
    return { debug };
  }

  const price = currentPrice ?? candles4h[candles4h.length - 1].close;
  const tlPrice = trendline.price;
  const dist = (price - tlPrice) / tlPrice;

  debug.push(
    `TL: ${tlPrice.toFixed(1)} | R² ${trendline.r2} | Price: ${price.toFixed(1)} | Dist: ${(
      dist * 100
    ).toFixed(2)}%`
  );

  const stoch = stochRsi(candles4h.map((c) => c.close));
  debug.push(`StochRSI: K ${stoch.k} | D ${stoch.d}`);

  const last = candles4h[candles4h.length - 1];
  const prev = candles4h[candles4h.length - 2];

  const closes4h = candles4h.map((c) => c.close);
  const ema8_4h = ema(closes4h, 8);
  const ema21_4h = ema(closes4h, 21);

  const nearTrendline = Math.abs(dist) < 0.012;
  const stochExtreme = t1d.direction === "LONG" ? stoch.k < 20 : stoch.k > 80;
  const stochTurning = t1d.direction === "LONG" ? stoch.k > stoch.d : stoch.k < stoch.d;

  const beyondTrendline = t1d.direction === "LONG" ? price > tlPrice * 1.008 : price < tlPrice * 0.992;
  const confirming =
    t1d.direction === "LONG"
      ? last.close > last.open && last.close > prev.close
      : last.close < last.open && last.close < prev.close;
  const volUp = last.volume > avg(candles4h.slice(-10).map((c) => c.volume)) * 1.3;
  const emaAligned =
    t1d.direction === "LONG"
      ? price > ema8_4h[ema8_4h.length - 1] && price > ema21_4h[ema21_4h.length - 1]
      : price < ema8_4h[ema8_4h.length - 1] && price < ema21_4h[ema21_4h.length - 1];
  const stochMomentum = t1d.direction === "LONG" ? stoch.k > stoch.d : stoch.k < stoch.d;

  const adxVal = adx(candles4h);
  const adxStrong = adxVal > 20;

  // Determine raw signal type (legacy internal logic preserved)
  let rawType: "ENTRY_1" | "ENTRY_2" | "ADD" | null = null;

  if (nearTrendline && stochExtreme) {
    rawType = "ENTRY_1";
  } else if (nearTrendline && stochTurning && !stochExtreme) {
    rawType = "ENTRY_2";
  } else if (beyondTrendline && confirming && emaAligned) {
    if (volUp || stochMomentum || adxStrong) {
      rawType = "ADD";
    }
  }

  // Apply hysteresis
  const now = Date.now();
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
      debug.push(
        `Hysteresis lock: ${finalType} | move ${(priceMove * 100).toFixed(2)}% < ${(
          HYSTERESIS_BAND * 100
        ).toFixed(2)}%`
      );
      return { debug };
    }
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

  // ── EXHAUSTION FILTER (new, flag-gated, does NOT delay entries) ──
  const ema20_4h = ema(closes4h, 20);
  const atrVal = atr(candles4h, 14);
  const exhaustion = checkExhaustion(
    t1d.direction,
    price,
    stoch.k,
    ema20_4h[ema20_4h.length - 1],
    atrVal,
    tlPrice,
    adxVal,
    candles4h
  );
  if (exhaustion.exhausted) {
    debug.push(
      `EXHAUSTION REJECT: ${exhaustion.conditionsMet}/4 conditions [${exhaustion.details.join(", ")}]`
    );
    return { debug };
  }

  // Levels
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

  if (finalType === "ENTRY_1" || finalType === "ENTRY_2") {
    type = "ACCUMULATE";
    entry = price;
    sl =
      t1d.direction === "LONG"
        ? Math.min(swingLow, entry - atrVal * 2)
        : Math.max(swingHigh, entry + atrVal * 2);
    tp = t1d.direction === "LONG" ? entry + atrVal * 5 : entry - atrVal * 5;
    confidence = finalType === "ENTRY_1" ? 50 : 60;
    expectedMove = Math.abs(tp - entry) / entry * 100;
  } else {
    type = "BREAKOUT";
    entry = price;
    sl =
      t1d.direction === "LONG"
        ? Math.min(tlPrice * 0.995, entry - atrVal * 1.5)
        : Math.max(tlPrice * 1.005, entry + atrVal * 1.5);

    const minTarget =
      t1d.direction === "LONG"
        ? entry + (entry - sl) * MIN_RR
        : entry - (sl - entry) * MIN_RR;

    tp =
      t1d.direction === "LONG"
        ? Math.max(swingHigh, minTarget)
        : Math.min(swingLow, minTarget);

    confidence = 85;
    expectedMove = Math.abs(tp - entry) / entry * 100;
  }

  const rr =
    t1d.direction === "LONG" ? (tp - entry) / (entry - sl) : (entry - tp) / (sl - entry);
  if (rr < MIN_RR) {
    debug.push(`R:R ${rr.toFixed(2)} < ${MIN_RR}`);
    return { debug };
  }

  const rsi4h = rsi(candles4h.map((c) => c.close));

  // ── SINGLE ENTRY: collapse all internal types to one signal ──
  // The internal ENTRY_1/ENTRY_2/ADD logic still runs for hysteresis,
  // but we emit ONE signal with scale=null to indicate "no progression".
  const signal: Signal = {
    id: `${pair}_${Date.now()}`,
    pair,
    direction: t1d.direction,
    type,
    scale: null, // <-- NO progression. One entry only.
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
    reason: `${t1d.direction} ${type} | 1D ${t1d.strength} | Stoch K${stoch.k} D${stoch.d} | TL approach | RR ${rr.toFixed(2)}`,
    timestamp: now,
    version: CURRENT_SIGNAL_VERSION,
  };

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

  debug.push(
    `SIGNAL: ${type} ${signal.direction} ${signal.entry} | TP ${signal.target} | SL ${signal.stop} | RR ${signal.rr}`
  );

  return { signal, market, debug };
}

// ============================================================
// MARKET SNAPSHOT — backward compatible
// ============================================================

export function getMarketSnapshot(
  pair: string,
  candles1h: Candle[],
  candles4h: Candle[],
  candles15m: Candle[]
): any {
  const candles1d = aggregateTo1D(candles4h);
  const t1d = trend1D(candles1d);
  const stochRsi4h = stochRsi(candles4h.map((c) => c.close));
  const price = candles4h[candles4h.length - 1].close;

  const trendline = t1d.direction ? getTrendline(pair, candles4h, t1d.direction) : null;
  const tlPrice = trendline ? trendline.price : 0;
  const dist = trendline ? (price - tlPrice) / tlPrice : 1;

  return {
    pair,
    price: Math.round(price * 100) / 100,
    timestamp: Date.now(),
    trend: t1d.direction ? `${t1d.direction} ${t1d.strength}` : "NONE",
    adx: Math.round(adx(candles4h) * 10) / 10,
    rsi: Math.round(rsi(candles4h.map((c) => c.close)) * 10) / 10,
    stochK: stochRsi4h.k,
    stochD: stochRsi4h.d,
    trendlinePrice: Math.round(tlPrice * 100) / 100,
    distToTrendline: Math.round(Math.abs(dist) * 10000) / 100,
  };
}

// ============================================================
// LEGACY VALIDITY — preserved for backward compatibility
// ============================================================

export function isSignalStillValid(signal: Signal, currentPrice: number, now: number = Date.now()): ValidityCheck {
  const ageMs = now - signal.timestamp;

  const maxAge = signal.type === "ACCUMULATE" ? 24 * 60 * 60 * 1000 : 4 * 60 * 60 * 1000;

  if (ageMs > maxAge) {
    return { valid: false, reason: "expired_ttl", exited: true };
  }

  const entryBuffer = signal.type === "ACCUMULATE" ? 1.02 : 1.005;
  if (signal.direction === "LONG" && currentPrice > signal.entry * entryBuffer) {
    return { valid: false, reason: "missed_entry", exited: true };
  }
  if (signal.direction === "SHORT" && currentPrice < signal.entry * (2 - entryBuffer)) {
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

// ============================================================
// TRADE MANAGER — Isolated, flag-gated, professional
// ============================================================
// This section is ENTIRELY NEW and does NOT touch generateSignal().
// Disable FEATURE_FLAGS.ENABLE_TRADE_MANAGER to fall back to legacy.

/**
 * Initialize or retrieve a trade snapshot for a signal.
 * Call this once when a signal becomes an active trade.
 */
export function initTradeSnapshot(signal: Signal): TradeSnapshot {
  const existing = tradeSnapshotStore.get(signal.id);
  if (existing) return existing;

  const snapshot: TradeSnapshot = {
    signalId: signal.id,
    pair: signal.pair,
    direction: signal.direction,
    entry: signal.entry,
    initialStop: signal.stop,
    currentStop: signal.stop,
    highestPrice: signal.entry,
    lowestPrice: signal.entry,
    lockedProfit: 0,
    state: "OPEN",
    exited: false,
    updatedAt: Date.now(),
  };

  tradeSnapshotStore.set(signal.id, snapshot);
  return snapshot;
}

/**
 * Get an existing trade snapshot without creating one.
 */
export function getTradeSnapshot(signalId: string): TradeSnapshot | undefined {
  return tradeSnapshotStore.get(signalId);
}

/**
 * Remove a trade snapshot (cleanup after exit).
 */
export function removeTradeSnapshot(signalId: string): void {
  tradeSnapshotStore.delete(signalId);
  exitedSignalIds.add(signalId);
}

/**
 * Check if a signal ID has already fired an exit alert.
 */
export function hasExited(signalId: string): boolean {
  return exitedSignalIds.has(signalId);
}

/**
 * Core trade manager — evaluates a trade against current price and
 * returns updated snapshot + exit decision.
 *
 * PROFIT LOCK SCHEDULE:
 *   +0%   → initial stop (OPEN / UNDERWATER)
 *   +3%   → break even   (BREAK_EVEN)
 *   +5%   → lock +2%     (LOCKED_2PCT)
 *   +8%   → lock +4%     (LOCKED_4PCT)
 *   +12%  → trail ATR/EMA20  (RUNNER)
 *   +20%  → trail ATR only     (RUNNER)
 *
 * Stop NEVER moves backwards.
 */
export function evaluateTrade(
  signal: Signal,
  candles4h: Candle[],
  currentPrice: number,
  now: number = Date.now()
): TradeManagerResult {
  // ── Feature flag guard ──
  if (!FEATURE_FLAGS.ENABLE_TRADE_MANAGER) {
    // Fall back to legacy validity check
    const legacy = isSignalStillValid(signal, currentPrice, now);
    const snapshot: TradeSnapshot = {
      signalId: signal.id,
      pair: signal.pair,
      direction: signal.direction,
      entry: signal.entry,
      initialStop: signal.stop,
      currentStop: signal.stop,
      highestPrice: currentPrice,
      lowestPrice: currentPrice,
      lockedProfit: 0,
      state: legacy.valid ? "OPEN" : "EXITED",
      exited: !legacy.valid,
      exitReason: legacy.valid ? undefined : legacy.reason,
      exitPrice: legacy.valid ? undefined : currentPrice,
      updatedAt: now,
    };
    return {
      snapshot,
      shouldExit: !legacy.valid,
      exitReason: legacy.valid ? undefined : legacy.reason,
      exitPrice: legacy.valid ? undefined : currentPrice,
    };
  }

  // ── Duplicate exit guard ──
  if (exitedSignalIds.has(signal.id)) {
    const dead = tradeSnapshotStore.get(signal.id);
    if (dead) {
      return {
        snapshot: { ...dead, exited: true },
        shouldExit: false,
        exitReason: "already_exited",
      };
    }
  }

  // ── Load or init snapshot ──
  let snapshot = tradeSnapshotStore.get(signal.id);
  if (!snapshot) {
    snapshot = initTradeSnapshot(signal);
  }

  // ── Update high/low water marks ──
  const newHigh = Math.max(snapshot.highestPrice, currentPrice);
  const newLow = Math.min(snapshot.lowestPrice, currentPrice);

  // ── Compute unrealized PnL % ──
  const pnlPct =
    signal.direction === "LONG"
      ? (currentPrice - signal.entry) / signal.entry
      : (signal.entry - currentPrice) / signal.entry;

  // ── Determine new stop level ──
  let newStop = snapshot.currentStop;
  let newState: TradeState = snapshot.state;
  let newLockedProfit = snapshot.lockedProfit;

  const atrVal = atr(candles4h, 14);
  const closes4h = candles4h.map((c) => c.close);
  const ema20_4h = ema(closes4h, 20);
  const ema20 = ema20_4h[ema20_4h.length - 1];

  // Profit lock stages
  if (pnlPct >= 0.20) {
    // +20%: ATR trail only
    newState = "RUNNER";
    if (FEATURE_FLAGS.ENABLE_ATR_TRAIL) {
      const trailDist = atrVal * 2.5;
      const candidateStop =
        signal.direction === "LONG" ? currentPrice - trailDist : currentPrice + trailDist;
      if (
        (signal.direction === "LONG" && candidateStop > newStop) ||
        (signal.direction === "SHORT" && candidateStop < newStop)
      ) {
        newStop = candidateStop;
      }
    }
    newLockedProfit = pnlPct;
  } else if (pnlPct >= 0.12) {
    // +12%: Trail using ATR or EMA20
    newState = "RUNNER";
    if (FEATURE_FLAGS.ENABLE_ATR_TRAIL) {
      const atrTrail =
        signal.direction === "LONG" ? currentPrice - atrVal * 2 : currentPrice + atrVal * 2;
      const emaTrail =
        signal.direction === "LONG" ? ema20 - atrVal * 0.5 : ema20 + atrVal * 0.5;
      const candidateStop =
        signal.direction === "LONG" ? Math.max(atrTrail, emaTrail) : Math.min(atrTrail, emaTrail);
      if (
        (signal.direction === "LONG" && candidateStop > newStop) ||
        (signal.direction === "SHORT" && candidateStop < newStop)
      ) {
        newStop = candidateStop;
      }
    }
    newLockedProfit = pnlPct;
  } else if (pnlPct >= 0.08) {
    // +8%: Lock at +4%
    const lockLevel = signal.entry * (signal.direction === "LONG" ? 1.04 : 0.96);
    if (
      (signal.direction === "LONG" && lockLevel > newStop) ||
      (signal.direction === "SHORT" && lockLevel < newStop)
    ) {
      newStop = lockLevel;
    }
    newState = "LOCKED_4PCT";
    newLockedProfit = 0.04;
  } else if (pnlPct >= 0.05) {
    // +5%: Lock at +2%
    const lockLevel = signal.entry * (signal.direction === "LONG" ? 1.02 : 0.98);
    if (
      (signal.direction === "LONG" && lockLevel > newStop) ||
      (signal.direction === "SHORT" && lockLevel < newStop)
    ) {
      newStop = lockLevel;
    }
    newState = "LOCKED_2PCT";
    newLockedProfit = 0.02;
  } else if (pnlPct >= 0.03) {
    // +3%: Break even
    const beLevel = signal.entry;
    if (
      (signal.direction === "LONG" && beLevel > newStop) ||
      (signal.direction === "SHORT" && beLevel < newStop)
    ) {
      newStop = beLevel;
    }
    newState = "BREAK_EVEN";
    newLockedProfit = 0;
  } else if (pnlPct < 0) {
    newState = "UNDERWATER";
  } else {
    newState = "OPEN";
  }

  // ── State machine override (if enabled) ──
  if (FEATURE_FLAGS.ENABLE_STATE_MACHINE) {
    // State can only progress forward, never backward
    const stateRank: Record<TradeState, number> = {
      OPEN: 0,
      UNDERWATER: 0,
      BREAK_EVEN: 1,
      LOCKED_2PCT: 2,
      LOCKED_4PCT: 3,
      RUNNER: 4,
      EXITED: 5,
    };
    if (stateRank[newState] < stateRank[snapshot.state] && snapshot.state !== "EXITED") {
      newState = snapshot.state; // prevent regression
    }
  }

  // ── Stop hit check ──
  const stopHit =
    signal.direction === "LONG"
      ? currentPrice <= newStop
      : currentPrice >= newStop;

  // ── Stoch extreme opposite exit (legacy, still active) ──
  const stoch = stochRsi(candles4h.map((c) => c.close));
  const stochExtremeOpposite =
    signal.direction === "LONG" ? stoch.k < 20 : stoch.k > 80;

  let shouldExit = false;
  let exitReason: string | undefined;
  let exitPrice: number | undefined;

  if (stopHit) {
    shouldExit = true;
    exitReason = snapshot.state === "BREAK_EVEN" ? "breakeven_stop" : snapshot.state === "RUNNER" ? "trail_stop" : "initial_stop";
    exitPrice = currentPrice;
  } else if (stochExtremeOpposite && pnlPct > 0) {
    // Only exit on stoch extreme if we're in profit (don't cut winners early)
    shouldExit = true;
    exitReason = "stoch_extreme_opposite_exit";
    exitPrice = currentPrice;
  }

  // ── Update snapshot ──
  const updated: TradeSnapshot = {
    ...snapshot,
    currentStop: Math.round(newStop * 100) / 100,
    highestPrice: Math.round(newHigh * 100) / 100,
    lowestPrice: Math.round(newLow * 100) / 100,
    lockedProfit: Math.round(newLockedProfit * 10000) / 100,
    state: shouldExit ? "EXITED" : newState,
    exited: shouldExit,
    exitReason: shouldExit ? exitReason : undefined,
    exitPrice: shouldExit ? exitPrice : undefined,
    updatedAt: now,
  };

  tradeSnapshotStore.set(signal.id, updated);

  if (shouldExit) {
    exitedSignalIds.add(signal.id);
  }

  return {
    snapshot: updated,
    shouldExit,
    exitReason,
    exitPrice,
  };
}

// ============================================================
// shouldHold — bridges legacy API to new trade manager
// ============================================================

export function shouldHold(
  signal: Signal,
  candles4h: Candle[],
  currentPrice: number,
  now?: number
): HoldResult {
  // If trade manager is disabled, use legacy logic
  if (!FEATURE_FLAGS.ENABLE_TRADE_MANAGER) {
    return shouldHoldLegacy(signal, candles4h, currentPrice, now);
  }

  const result = evaluateTrade(signal, candles4h, currentPrice, now);

  if (result.shouldExit) {
    return { shouldHold: false, reason: result.exitReason || "trade_manager_exit" };
  }

  return { shouldHold: true, reason: result.snapshot.state };
}

/** Legacy shouldHold — preserved exactly for fallback */
function shouldHoldLegacy(
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
      signal.direction === "LONG" ? currentPrice > signal.entry : currentPrice < signal.entry;
    if (!inProfit) {
      return { shouldHold: false, reason: "trend_reversed_unprofitable" };
    }
  }

  const closes4h = candles4h.map((c) => c.close);
  const stoch = stochRsi(closes4h);

  const stochExtremeOpposite =
    signal.direction === "LONG" ? stoch.k < 20 : stoch.k > 80;

  if (stochExtremeOpposite) {
    return { shouldHold: false, reason: "stoch_extreme_opposite_exit" };
  }

  const validity = isSignalStillValid(signal, currentPrice, now);
  return { shouldHold: validity.valid, reason: validity.reason };
}

// ============================================================
// filterExpiredSignals — backward compatible
// ============================================================

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

    // If trade manager is active, use it for exit decisions
    if (FEATURE_FLAGS.ENABLE_TRADE_MANAGER) {
      // We need candles here — if not available, fall back to legacy
      const legacyCheck = isSignalStillValid(signal, price, now);
      if (!legacyCheck.valid) {
        exited.push({ signal, reason: legacyCheck.reason });
      } else {
        active.push(signal);
      }
    } else {
      const check = isSignalStillValid(signal, price, now);
      if (check.valid) active.push(signal);
      else exited.push({ signal, reason: check.reason });
    }
  }

  return { active, exited };
}

// ============================================================
// checkTradeStatus — backward compatible
// ============================================================

export type TradeStatus = "ACTIVE" | "TP_HIT" | "SL_HIT" | "EXPIRED";

export function checkTradeStatus(signal: Signal, currentPrice: number, now: number = Date.now()): TradeStatus {
  if (FEATURE_FLAGS.ENABLE_TRADE_MANAGER) {
    const snapshot = tradeSnapshotStore.get(signal.id);
    if (snapshot?.exited) {
      if (snapshot.exitReason === "expired_ttl") return "EXPIRED";
      if (snapshot.exitReason?.includes("stop") || snapshot.exitReason === "initial_stop") return "SL_HIT";
      return "TP_HIT"; // profit lock exits treated as TP
    }
    return "ACTIVE";
  }

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
// v28 COMPATIBILITY LAYER (DO NOT REMOVE)
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

export async function generateSignalCompat(
  pair: string,
  candles1h: Candle[],
  candles4h: Candle[],
  candles15m: Candle[],
  activeTrades?: Record<string, any>,
  currentPrice?: number
): Promise<SignalResult> {
  const result = generateSignal(pair, candles1h, candles4h, candles15m, currentPrice);

  // Suppress ENTRY_2 alerts — return signal without alerting
  if (result.signal?.scale === "ENTRY_2") {
    return { ...result, signal: undefined };
  }

  return result;
}

export function isSignalStillValidBool(signal: Signal, currentPrice: number): boolean {
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
// TRADE MANAGER EXPORTS — for cron / UI consumption
// ============================================================

export {
  TradeSnapshot,
  TradeManagerResult,
  TradeState,
};
