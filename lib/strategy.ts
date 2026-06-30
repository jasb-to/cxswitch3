// lib/strategy.ts — v29 "Trendline Break: StochRSI Timing + Position Build + Trend Override"
// ============================================================
// CHANGELOG v29:
// - Strengthened exhaustion_block: Stoch pinned (>95/<5) blocks ALL entries
// - Stoch flat extreme (>90/<10) + extended price blocks entries
// - ADX threshold lowered to 28 for exhaustion detection
// - Late-cycle ADD protection: Stoch >90 for LONG, <10 for SHORT

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
  uiAlert?: UIAlert;
}

export interface UIAlert {
  type: "SHORT_ALERT_OVERSOLD_CROSS" | "LONG_ALERT_OVERBOUGHT_CROSS";
  message: string;
  stochK: number;
  stochD: number;
  timestamp: number;
}

export const CURRENT_SIGNAL_VERSION = 29;
const MIN_RR = 1.5;

// --- STATEFUL TRENDLINE STORE ---
interface TrendlineState {
  slope: number;
  intercept: number;
  pivots: { index: number; price: number; timestamp: number }[];
  lastUpdated: number;
  direction: "LONG" | "SHORT";
}

const trendlineStore: Map<string, TrendlineState> = new Map();
const TRENDLINE_MAX_AGE = 7 * 24 * 60 * 60 * 1000;

function avg(arr: number[]): number {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

// --- RSI (TradingView exact — Wilder smoothing) ---
function rsi(closes: number[], period: number = 14): number {
  if (closes.length < period + 1) return 50;
  
  let gains = 0;
  let losses = 0;
  
  for (let i = 1; i <= period; i++) {
    const change = closes[closes.length - period - 1 + i] - closes[closes.length - period - 2 + i];
    if (change > 0) gains += change;
    else losses += Math.abs(change);
  }
  
  let avgGain = gains / period;
  let avgLoss = losses / period;
  
  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? Math.abs(change) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }
  
  if (avgLoss === 0) return 100;
  return 100 - (100 / (1 + avgGain / avgLoss));
}

// --- RSI SERIES ---
function rsiSeries(closes: number[], period: number = 14): number[] {
  const series: number[] = [];
  for (let i = period; i < closes.length; i++) {
    const window = closes.slice(0, i + 1);
    series.push(rsi(window, period));
  }
  return series;
}

// --- STOCHRSI (TradingView exact) ---
function stochRsi(closes: number[], rsiPeriod: number = 14, stochPeriod: number = 14, kSmooth: number = 3, dSmooth: number = 3): { k: number; d: number } {
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

// --- ADX ---
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
    const dx = (pDI + mDI === 0) ? 0 : (Math.abs(pDI - mDI) / (pDI + mDI)) * 100;
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
    const key = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(c);
  }
  
  const daily: Candle[] = [];
  for (const [, bars] of groups) {
    if (bars.length === 0) continue;
    daily.push({
      timestamp: bars[0].timestamp,
      open: bars[0].open,
      high: Math.max(...bars.map(b => b.high)),
      low: Math.min(...bars.map(b => b.low)),
      close: bars[bars.length - 1].close,
      volume: bars.reduce((sum, b) => sum + b.volume, 0),
    });
  }
  
  return daily.sort((a, b) => a.timestamp - b.timestamp);
}

// --- FIND PIVOTS ---
function findPivots(candles: Candle[], direction: "LONG" | "SHORT"): { index: number; price: number; timestamp: number }[] {
  const pivots: { index: number; price: number; timestamp: number }[] = [];
  
  for (let i = 3; i < candles.length - 3; i++) {
    const c = candles[i];
    const isSwingLow = c.low < candles[i-1].low && c.low < candles[i-2].low && c.low < candles[i+1].low && c.low < candles[i+2].low;
    const isSwingHigh = c.high > candles[i-1].high && c.high > candles[i-2].high && c.high > candles[i+1].high && c.high > candles[i+2].high;
    
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
function getTrendline(pair: string, candles: Candle[], direction: "LONG" | "SHORT"): { price: number; r2: number; age: number } | null {
  const len = candles.length;
  if (len < 20) return null;
  
  const pivots = findPivots(candles, direction);
  if (pivots.length < 3) return null;
  
  const recentPivots = pivots.slice(-5);
  const now = candles[candles.length - 1].timestamp;
  
  for (const [key, state] of trendlineStore.entries()) {
    if (now - state.lastUpdated > TRENDLINE_MAX_AGE * 2) {
      trendlineStore.delete(key);
    }
  }
  
  const existing = trendlineStore.get(pair);
  
  if (existing && existing.direction === direction && (now - existing.lastUpdated) < TRENDLINE_MAX_AGE) {
    const lastPivot = recentPivots[recentPivots.length - 1];
    const projectedPrice = existing.slope * lastPivot.index + existing.intercept;
    const deviation = Math.abs(lastPivot.price - projectedPrice) / projectedPrice;
    
    if (deviation < 0.02) {
      const currentIndex = len - 1;
      const price = existing.slope * currentIndex + existing.intercept;
      const yMean = recentPivots.reduce((s, p) => s + p.price, 0) / recentPivots.length;
      const ssTotal = recentPivots.reduce((s, p) => s + Math.pow(p.price - yMean, 2), 0);
      const ssResidual = recentPivots.reduce((s, p) => s + Math.pow(p.price - (existing.slope * p.index + existing.intercept), 2), 0);
      const actualR2 = ssTotal === 0 ? 0 : 1 - (ssResidual / ssTotal);
      return { price, r2: Math.round(actualR2 * 100) / 100, age: now - existing.lastUpdated };
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
function trend1D(candles1d: Candle[]): { direction: "LONG" | "SHORT" | null; strength: string } {
  const len = candles1d.length;
  if (len < 25) return { direction: null, strength: "WEAK" };
  
  const closes = candles1d.map(c => c.close);
  const ema8 = ema(closes, 8);
  const ema21 = ema(closes, 21);
  
  const direction = ema8[ema8.length - 1] > ema21[ema21.length - 1] ? "LONG" : "SHORT";
  
  const highs = candles1d.slice(-20).map(c => c.high);
  const lows = candles1d.slice(-20).map(c => c.low);
  const hh = highs[highs.length - 1] > Math.max(...highs.slice(0, -1));
  const ll = lows[lows.length - 1] < Math.min(...lows.slice(0, -1));
  
  const strength = (direction === "LONG" && hh) || (direction === "SHORT" && ll) ? "STRONG" : "MEDIUM";
  
  return { direction, strength };
}

// --- TREND BREAK OVERRIDE (v28.3 — for HYPE and SOL only) ---
// --- TREND BREAK OVERRIDE (v29 — applies to ALL tokens) ---
function trendBreakOverride(
  pair: string,
  candles1d: Candle[],
  baseDirection: "LONG" | "SHORT"
): "LONG" | "SHORT" {
  const len = candles1d.length;
  if (len < 10) return baseDirection;

  const closes = candles1d.map(c => c.close);
  const ema8 = ema(closes, 8);
  const ema21 = ema(closes, 21);

  const last1 = candles1d[len - 1];
  const last2 = candles1d[len - 2];
  const ema8_1 = ema8[ema8.length - 1];
  const ema21_1 = ema21[ema21.length - 1];
  const ema8_2 = ema8[ema8.length - 2];
  const ema21_2 = ema21[ema21.length - 2];

  // LONG override to SHORT: price below EMA21 for 2 consecutive candles
  // (EMA21 is the primary trend judge — if price is below it, trend is broken)
  if (baseDirection === "LONG") {
    const belowEMA21_1 = last1.close < ema21_1;
    const belowEMA21_2 = last2.close < ema21_2;
    const belowEMA8_1 = last1.close < ema8_1;
    const belowEMA8_2 = last2.close < ema8_2;
    // Require below EMA21 for both, and below EMA8 for at least one
    if (belowEMA21_1 && belowEMA21_2 && (belowEMA8_1 || belowEMA8_2)) {
      return "SHORT";
    }
  }

  // SHORT override to LONG: price above EMA21 for 2 consecutive candles
  if (baseDirection === "SHORT") {
    const aboveEMA21_1 = last1.close > ema21_1;
    const aboveEMA21_2 = last2.close > ema21_2;
    const aboveEMA8_1 = last1.close > ema8_1;
    const aboveEMA8_2 = last2.close > ema8_2;
    if (aboveEMA21_1 && aboveEMA21_2 && (aboveEMA8_1 || aboveEMA8_2)) {
      return "LONG";
    }
  }

  return baseDirection;
}

// --- WRAPPED 1D TREND (applies override everywhere) ---
function trend1DWithOverride(pair: string, candles1d: Candle[]): { direction: "LONG" | "SHORT" | null; strength: string } {
  const base = trend1D(candles1d);
  if (!base.direction) return base;
  const overridden = trendBreakOverride(pair, candles1d, base.direction);
  return { direction: overridden, strength: base.strength };
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
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
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
const HYSTERESIS_BAND = 0.005;
const HYSTERESIS_MAX_AGE = 48 * 60 * 60 * 1000;

function getHysteresis(pair: string, now: number): HysteresisState {
  for (const [key, state] of hysteresisStore.entries()) {
    if (now > state.lockUntil + HYSTERESIS_MAX_AGE) {
      hysteresisStore.delete(key);
    }
  }
  
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

// --- EXHAUSTION BLOCK (v28.2 — strengthened) ---
interface ExhaustionCheck {
  blocked: boolean;
  reason: string;
}

function checkExhaustion(
  adxVal: number,
  stoch: { k: number; d: number },
  dist: number,
  direction: "LONG" | "SHORT"
): ExhaustionCheck {
  // CRITICAL: Stoch pinned at absolute extreme — blocks ALL entries regardless of other conditions
  const stochPinned = stoch.k >= 99 || stoch.k <= 1;
  if (stochPinned) {
    return {
      blocked: true,
      reason: `exhaustion_block: Stoch pinned at ${stoch.k} — absolute momentum exhaustion, no entries`
    };
  }

  // Stoch very extended (>95/<5) + any distance from TL — late cycle protection
  const stochVeryExtended = direction === "LONG" ? stoch.k > 95 : stoch.k < 5;
  if (stochVeryExtended && Math.abs(dist) > 0.01) {
    return {
      blocked: true,
      reason: `exhaustion_block: Stoch ${stoch.k} extreme + price ${(dist * 100).toFixed(2)}% from TL — late cycle, avoid`
    };
  }

  // Stoch extended flat (>90/<10) + extended price — momentum stall
  const stochExtendedFlat = direction === "LONG"
    ? stoch.k > 90 && stoch.d > 90
    : stoch.k < 10 && stoch.d < 10;
  
  const priceExtended = Math.abs(dist) > 0.02;
  
  if (stochExtendedFlat && priceExtended) {
    return {
      blocked: true,
      reason: `exhaustion_block: Stoch K${stoch.k}/D${stoch.d} flat extreme, price ${(dist * 100).toFixed(2)}% from TL`
    };
  }

  // Original: High ADX + flat extreme + extended
  const adxHigh = adxVal > 28;
  const stochFlatExtreme = direction === "LONG"
    ? stoch.k > 80 && stoch.d > 80
    : stoch.k < 20 && stoch.d < 20;
  
  if (adxHigh && stochFlatExtreme && Math.abs(dist) > 0.025) {
    return {
      blocked: true,
      reason: `exhaustion_block: ADX ${adxVal.toFixed(1)} > 28, Stoch K${stoch.k}/D${stoch.d} extreme flat, price ${(dist * 100).toFixed(2)}% from TL`
    };
  }

  return { blocked: false, reason: "" };
}

// --- UI CROSSOVER ALERT DETECTION ---
function detectUICrossoverAlert(
  pair: string,
  stoch: { k: number; d: number },
  prevStoch: { k: number; d: number } | null,
  direction: "LONG" | "SHORT" | null
): UIAlert | undefined {
  if (!prevStoch || !direction) return undefined;
  
  if (prevStoch.k <= prevStoch.d && stoch.k > stoch.d && stoch.k < 20) {
    return {
      type: "SHORT_ALERT_OVERSOLD_CROSS",
      message: `${pair}: StochRSI K crossed above D in oversold zone (K=${stoch.k}). Early reversal warning / potential bounce.`,
      stochK: stoch.k,
      stochD: stoch.d,
      timestamp: Date.now(),
    };
  }
  
  if (prevStoch.k >= prevStoch.d && stoch.k < stoch.d && stoch.k > 80) {
    return {
      type: "LONG_ALERT_OVERBOUGHT_CROSS",
      message: `${pair}: StochRSI K crossed below D in overbought zone (K=${stoch.k}). Momentum exhaustion / potential pullback.`,
      stochK: stoch.k,
      stochD: stoch.d,
      timestamp: Date.now(),
    };
  }
  
  return undefined;
}

const prevStochStore: Map<string, { k: number; d: number; timestamp: number }> = new Map();

// --- MAIN SIGNAL ---
export function generateSignal(
  pair: string,
  candles1h: Candle[],
  candles4h: Candle[],
  candles15m: Candle[],
  currentPrice?: number
): SignalResult {
  const debug: string[] = [];
  
  for (let i = 1; i < candles4h.length; i++) {
    if (candles4h[i].timestamp < candles4h[i-1].timestamp) {
      debug.push("Candles not sorted");
      return { debug };
    }
  }
  
  const candles1d = aggregateTo1D(candles4h);
  
  if (candles1d.length < 25 || candles4h.length < 30) {
    debug.push("Insufficient candle data");
    return { debug };
  }
  
  const t1d = trend1DWithOverride(pair, candles1d);

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
  
  debug.push(`TL: ${tlPrice.toFixed(1)} | R² ${trendline.r2} | Price: ${price.toFixed(1)} | Dist: ${(dist * 100).toFixed(2)}%`);
  
  const stoch = stochRsi(candles4h.map(c => c.close));
  debug.push(`StochRSI: K ${stoch.k} | D ${stoch.d}`);
  
  // UI Crossover Alert (before any blocking logic)
  const now = Date.now();
  const prevStoch = prevStochStore.get(pair);
  const uiAlert = detectUICrossoverAlert(pair, stoch, prevStoch || null, t1d.direction);
  if (uiAlert) {
    debug.push(`UI_ALERT: ${uiAlert.type} | K${uiAlert.stochK} D${uiAlert.stochD}`);
  }
  prevStochStore.set(pair, { ...stoch, timestamp: now });
  
  for (const [key, state] of prevStochStore.entries()) {
    if (now - state.timestamp > 24 * 60 * 60 * 1000) {
      prevStochStore.delete(key);
    }
  }
  
  const last = candles4h[candles4h.length - 1];
  const prev = candles4h[candles4h.length - 2];
  
  const closes4h = candles4h.map(c => c.close);
  const ema8_4h = ema(closes4h, 8);
  const ema21_4h = ema(closes4h, 21);
  
  const nearTrendline = Math.abs(dist) < 0.008;
  const stochExtreme = t1d.direction === "LONG" ? stoch.k < 20 : stoch.k > 80;
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
  
  const adxVal = adx(candles4h);
  const adxStrong = adxVal > 20;
  
  // NEW: Exhaustion Block check (v28.2 — before signal determination)
  const exhaustion = checkExhaustion(adxVal, stoch, dist, t1d.direction);
  if (exhaustion.blocked) {
    debug.push(exhaustion.reason);
    return { debug, uiAlert };
  }
  
  let rawType: "ENTRY_1" | "ENTRY_2" | "ADD" | null = null;
  
  if (nearTrendline && stochExtreme && volUp) {
    rawType = "ENTRY_1";
  } else if (nearTrendline && stochTurning && !stochExtreme) {
    rawType = "ENTRY_2";
  } else if (beyondTrendline && confirming && emaAligned) {
    const confirmCount = (volUp ? 1 : 0) + (stochMomentum ? 1 : 0) + (adxStrong ? 1 : 0);
    if (confirmCount >= 2) {
      rawType = "ADD";
    }
  }
  
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
  
  if (hyst.lastSignalType && finalType === hyst.lastSignalType) {
    const priceMove = Math.abs(price - hyst.lastSignalPrice) / hyst.lastSignalPrice;
    if (priceMove < HYSTERESIS_BAND) {
      debug.push(`Hysteresis lock: ${finalType} | move ${(priceMove * 100).toFixed(2)}% < ${(HYSTERESIS_BAND * 100).toFixed(2)}%`);
      return { debug, uiAlert };
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
    return { debug, uiAlert };
  }
  
  if (finalType !== hyst.lastSignalType) {
    setHysteresis(pair, finalType, price, now);
  }
  
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
    tp = t1d.direction === "LONG" ? entry + atrVal * 5 : entry - atrVal * 5;
    confidence = finalType === "ENTRY_1" ? 50 : 60;
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
    
    tp = t1d.direction === "LONG" 
      ? Math.max(swingHigh, minTarget) 
      : Math.min(swingLow, minTarget);
    
    confidence = 85;
    expectedMove = Math.abs(tp - entry) / entry * 100;
  }
  
  const rr = t1d.direction === "LONG" ? (tp - entry) / (entry - sl) : (entry - tp) / (sl - entry);
  if (rr < MIN_RR) {
    debug.push(`R:R ${rr.toFixed(2)} < ${MIN_RR}`);
    return { debug, uiAlert };
  }
  
  const rsi4h = rsi(candles4h.map(c => c.close));
  
  const signal: Signal = {
    id: `${pair}_${Date.now()}`,
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
    closes4h: candles4h.slice(-50).map(c => c.close),
  };
  
  debug.push(`SIGNAL: ${type} ${finalType} ${signal.direction} ${signal.entry} | TP ${signal.target} | SL ${signal.stop} | RR ${signal.rr}`);
  
  return { signal, market, debug, uiAlert };
}

// --- MARKET SNAPSHOT ---
export function getMarketSnapshot(
  pair: string,
  candles1h: Candle[],
  candles4h: Candle[],
  candles15m: Candle[]
): any {
  const candles1d = aggregateTo1D(candles4h);
  const t1d = trend1DWithOverride(pair, candles1d);
  const stochRsi4h = stochRsi(candles4h.map(c => c.close));
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
    rsi: Math.round(rsi(candles4h.map(c => c.close)) * 10) / 10,
    stochK: stochRsi4h.k,
    stochD: stochRsi4h.d,
    trendlinePrice: Math.round(tlPrice * 100) / 100,
    distToTrendline: Math.round(Math.abs(dist) * 10000) / 100,
    closes4h: candles4h.slice(-50).map(c => c.close),
  };
}

// --- VALIDITY ---
export interface ValidityCheck {
  valid: boolean;
  reason: string;
  exited: boolean;
}

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

// --- shouldHold ---
export interface HoldResult {
  shouldHold: boolean;
  reason: string;
}

export function shouldHold(signal: Signal, candles4h: Candle[], currentPrice: number, now?: number): HoldResult {
  const candles1d = aggregateTo1D(candles4h);
  const t1d = trend1DWithOverride(pair, candles1d);
  const trendReversed = (signal.direction === "LONG" && t1d.direction === "SHORT") ||
                        (signal.direction === "SHORT" && t1d.direction === "LONG");
  
  if (trendReversed) {
    const inProfit = signal.direction === "LONG" 
      ? currentPrice > signal.entry 
      : currentPrice < signal.entry;
    if (!inProfit) {
      return { shouldHold: false, reason: "trend_reversed_unprofitable" };
    }
  }
  
  const closes4h = candles4h.map(c => c.close);
  const stoch = stochRsi(closes4h);
  
  const stochExtremeOpposite = signal.direction === "LONG" 
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

export function checkTradeStatus(signal: Signal, currentPrice: number, now: number = Date.now()): TradeStatus {
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

export async function generateSignalCompat(
  pair: string,
  candles1h: Candle[],
  candles4h: Candle[],
  candles15m: Candle[],
  activeTrades?: Record<string, any>,
  currentPrice?: number
): Promise<SignalResult> {
  const result = generateSignal(pair, candles1h, candles4h, candles15m, currentPrice);
  
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
