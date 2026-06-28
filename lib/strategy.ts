// lib/strategy.ts — v30.12.1 "Sync market snapshot with trendline invalidation"
// ============================================================
// Fixed: getMarketSnapshot now applies the same TL_MAX_DIST check as getContext,
// so the dashboard shows "no trendline" instead of stale +97% values

import { getTrendlineState, setTrendlineState } from "@/lib/state";

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
  type: "ACCUMULATE" | "BREAKOUT";
  scale: "ENTRY_1" | "ADD";
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

export const CURRENT_SIGNAL_VERSION = 30;

// --- CONFIG ---
const MIN_RR = 1.5;
const MIN_R2 = 0.45;
const TL_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const ADX_EXHAUSTION = 45;
const STOCH_EXTREME_LONG = 85;
const STOCH_EXTREME_SHORT = 15;
const CORRECT_SIDE_BUFFER = 0.015;
const TL_MAX_DIST = 0.05; // 5% — invalidate trendline if price broke too far

// --- STATE ---
interface TrendlineState {
  pivots: { index: number; price: number; timestamp: number }[];
  lastUpdated: number;
  direction: "LONG" | "SHORT";
}

const trendlineStore: Map<string, TrendlineState> = new Map();

export async function loadTrendlinesFromKV(): Promise<void> {
  const state = await getTrendlineState();
  if (state) {
    for (const [key, value] of Object.entries(state)) {
      trendlineStore.set(key, value as TrendlineState);
    }
  }
}

export async function saveTrendlinesToKV(): Promise<void> {
  const obj: Record<string, TrendlineState> = {};
  for (const [key, value] of trendlineStore.entries()) {
    obj[key] = value;
  }
  await setTrendlineState(obj);
}

// --- MATH UTILS ---
function avg(arr: number[]): number {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function linearRegression(points: { x: number; y: number }[]): { slope: number; intercept: number; r2: number; rawR2: number } | null {
  const n = points.length;
  if (n < 2) return null;
  const sumX = points.reduce((s, p) => s + p.x, 0);
  const sumY = points.reduce((s, p) => s + p.y, 0);
  const sumXY = points.reduce((s, p) => s + p.x * p.y, 0);
  const sumX2 = points.reduce((s, p) => s + p.x * p.x, 0);
  const denom = n * sumX2 - sumX * sumX;
  if (Math.abs(denom) < 1e-9) return null;
  const slope = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;
  const yMean = sumY / n;
  const ssTotal = points.reduce((s, p) => s + Math.pow(p.y - yMean, 2), 0);
  const ssResidual = points.reduce((s, p) => s + Math.pow(p.y - (slope * p.x + intercept), 2), 0);
  const rawR2 = ssTotal === 0 ? 0 : 1 - (ssResidual / ssTotal);
  const r2 = Math.max(0, Math.min(1, rawR2));
  return { slope, intercept, r2, rawR2 };
}

// --- INDICATORS ---
function rsi(closes: number[], period: number = 14): number {
  if (closes.length < period + 1) return 50;
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) avgGain += change; else avgLoss += Math.abs(change);
  }
  avgGain /= period; avgLoss /= period;
  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (change > 0 ? change : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (change < 0 ? Math.abs(change) : 0)) / period;
  }
  if (avgLoss === 0) return 100;
  return 100 - (100 / (1 + avgGain / avgLoss));
}

function rsiSeries(closes: number[], period: number = 14): number[] {
  if (closes.length < period + 1) return [];
  const series: number[] = [];
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) avgGain += change; else avgLoss += Math.abs(change);
  }
  avgGain /= period; avgLoss /= period;
  series.push(avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss)));
  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (change > 0 ? change : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (change < 0 ? Math.abs(change) : 0)) / period;
    series.push(avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss)));
  }
  return series;
}

function stochRsi(closes: number[], rsiPeriod: number = 14, stochPeriod: number = 14, kSmooth: number = 3, dSmooth: number = 3): { k: number; d: number } {
  const rsiValues = rsiSeries(closes, rsiPeriod);
  if (rsiValues.length < stochPeriod + kSmooth - 1) return { k: 50, d: 50 };
  const rawK: number[] = [];
  for (let i = stochPeriod - 1; i < rsiValues.length; i++) {
    const window = rsiValues.slice(i - stochPeriod + 1, i + 1);
    const lowest = Math.min(...window), highest = Math.max(...window);
    rawK.push(highest === lowest ? 50 : ((rsiValues[i] - lowest) / (highest - lowest)) * 100);
  }
  const kValues: number[] = [];
  for (let i = kSmooth - 1; i < rawK.length; i++) {
    kValues.push(avg(rawK.slice(i - kSmooth + 1, i + 1)));
  }
  if (kValues.length < dSmooth) return { k: 50, d: 50 };
  return { k: Math.round(kValues[kValues.length - 1] * 10) / 10, d: Math.round(avg(kValues.slice(-dSmooth)) * 10) / 10 };
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
  const trs: number[] = [], plusDMs: number[] = [], minusDMs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
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
    dxValues.push((pDI + mDI === 0) ? 0 : (Math.abs(pDI - mDI) / (pDI + mDI)) * 100);
  }
  return Math.round(wilderSmooth(dxValues, period).slice(-1)[0] * 10) / 10;
}

function ema(closes: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const ema: number[] = [closes[0]];
  for (let i = 1; i < closes.length; i++) ema.push(closes[i] * k + ema[i - 1] * (1 - k));
  return ema;
}

function atr(candles: Candle[], period: number = 14): number {
  const start = Math.max(1, candles.length - period);
  const trs: number[] = [];
  for (let i = start; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
  }
  return avg(trs);
}

// --- CANDLE UTILS ---
function aggregateTo1D(candles4h: Candle[]): Candle[] {
  const sorted = [...candles4h].sort((a, b) => a.timestamp - b.timestamp);
  const groups: Map<string, Candle[]> = new Map();
  for (const c of sorted) {
    const key = `${new Date(c.timestamp).getUTCFullYear()}-${new Date(c.timestamp).getUTCMonth()}-${new Date(c.timestamp).getUTCDate()}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(c);
  }
  const daily: Candle[] = [];
  for (const [, bars] of groups) {
    if (!bars.length) continue;
    daily.push({ timestamp: bars[0].timestamp, open: bars[0].open, high: Math.max(...bars.map(b => b.high)), low: Math.min(...bars.map(b => b.low)), close: bars[bars.length - 1].close, volume: bars.reduce((sum, b) => sum + b.volume, 0) });
  }
  return daily.sort((a, b) => a.timestamp - b.timestamp);
}

// --- SWING DETECTION (used for targets and trendline construction) ---
function findSwingHighs(candles: Candle[]): { index: number; price: number; timestamp: number }[] {
  const highs: { index: number; price: number; timestamp: number }[] = [];
  for (let i = 3; i < candles.length - 3; i++) {
    const c = candles[i];
    if (c.high > candles[i-1].high && c.high > candles[i-2].high && c.high > candles[i+1].high && c.high > candles[i+2].high) {
      highs.push({ index: i, price: c.high, timestamp: c.timestamp });
    }
  }
  return highs;
}

function findSwingLows(candles: Candle[]): { index: number; price: number; timestamp: number }[] {
  const lows: { index: number; price: number; timestamp: number }[] = [];
  for (let i = 3; i < candles.length - 3; i++) {
    const c = candles[i];
    if (c.low < candles[i-1].low && c.low < candles[i-2].low && c.low < candles[i+1].low && c.low < candles[i+2].low) {
      lows.push({ index: i, price: c.low, timestamp: c.timestamp });
    }
  }
  return lows;
}

// v30.11: Enforce structural consistency — each pivot must follow the trend direction
function enforceTrendStructure(
  pivots: { index: number; price: number; timestamp: number }[],
  direction: "LONG" | "SHORT"
): { index: number; price: number; timestamp: number }[] {
  if (pivots.length < 3) return pivots;
  const clean = [pivots[0]];
  for (let i = 1; i < pivots.length; i++) {
    const prev = clean[clean.length - 1];
    // SHORT: each high must be <= prior high + 2% (allows small wicks, rejects higher highs)
    // LONG: each low must be >= prior low - 2% (allows small wicks, rejects lower lows)
    const valid = direction === "SHORT"
      ? pivots[i].price <= prev.price * 1.02
      : pivots[i].price >= prev.price * 0.98;

    if (valid) clean.push(pivots[i]);
  }
  return clean.slice(-5);
}

// --- TRENDLINE: Directional + structural consistency + log-price regression ---
function getTrendline(pair: string, candles: Candle[], direction: "LONG" | "SHORT", debug: string[]): { price: number; r2: number; age: number } | null {
  const len = candles.length;
  if (len < 20) return null;
  // v30.11: Directional pivot selection — SHORT uses highs, LONG uses lows
  const rawPivots = direction === "SHORT" ? findSwingHighs(candles) : findSwingLows(candles);
  if (rawPivots.length < 3) return null;
  // v30.11: Enforce structural consistency (lower highs / higher lows)
  const structuredPivots = enforceTrendStructure(rawPivots, direction);
  if (structuredPivots.length < 3) return null;
  const recentPivots = structuredPivots.slice(-5);
  const now = candles[candles.length - 1].timestamp;
  const existing = trendlineStore.get(pair);
  let usePivots = recentPivots;
  if (existing && existing.direction === direction && (now - existing.lastUpdated) < TL_MAX_AGE_MS) {
    const allPivots = [...existing.pivots, ...recentPivots];
    const seen = new Set<number>();
    usePivots = allPivots.filter(p => {
      if (seen.has(p.index)) return false;
      seen.add(p.index);
      return true;
    }).sort((a, b) => a.index - b.index);
  }
  // Re-apply structure filter after merge (older pivots may break new structure)
  usePivots = enforceTrendStructure(usePivots, direction);
  if (usePivots.length < 3) return null;
  debug.push(`Pivots: ${usePivots.map(p => `${p.index}: ${p.price.toFixed(1)}`).join(",")}`);
  // Log-price regression for scale-independent crypto trendlines
  const points = usePivots.map((p, idx) => ({ x: idx, y: Math.log(p.price) }));
  const regression = linearRegression(points);
  if (!regression) return null;
  debug.push(`R2 raw=${regression.rawR2.toFixed(4)} clamped=${regression.r2.toFixed(4)} slope=${regression.slope.toFixed(6)} pivots=${points.length}`);
  trendlineStore.set(pair, {
    pivots: usePivots,
    lastUpdated: now,
    direction,
  });
  const currentIndex = usePivots.length - 1;
  return {
    price: Math.exp(regression.slope * currentIndex + regression.intercept),
    r2: Math.round(regression.r2 * 100) / 100,
    age: 0,
  };
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

// --- 4H TREND (confidence only) ---
function trend4H(candles4h: Candle[]): { direction: "LONG" | "SHORT" | null } {
  const len = candles4h.length;
  if (len < 25) return { direction: null };
  const closes = candles4h.map(c => c.close);
  const ema8 = ema(closes, 8);
  const ema21 = ema(closes, 21);
  return { direction: ema8[ema8.length - 1] > ema21[ema21.length - 1] ? "LONG" : "SHORT" };
}

// --- PIVOT TARGETS (Single MIN_RR threshold) ---
function getPivotTarget(
  candles4h: Candle[],
  direction: "LONG" | "SHORT",
  entry: number,
  sl: number,
  atrVal: number,
  minRR: number = MIN_RR
): { target: number; source: string } | null {
  const swingHighs = findSwingHighs(candles4h);
  const swingLows = findSwingLows(candles4h);
  if (direction === "LONG") {
    const validHighs = swingHighs.filter(h => h.price > entry).sort((a, b) => a.price - b.price);
    for (const high of validHighs) {
      const rr = (high.price - entry) / (entry - sl);
      if (rr >= minRR) return { target: high.price, source: "pivot_high" };
    }
    const highestHigh = swingHighs.length > 0 ? Math.max(...swingHighs.map(h => h.price)) : 0;
    if (highestHigh > entry) {
      const rr = (highestHigh - entry) / (entry - sl);
      if (rr >= minRR) return { target: highestHigh, source: "extended_pivot_high" };
    }
    const atrTarget = entry + atrVal * 2;
    const atrRR = (atrTarget - entry) / (entry - sl);
    if (atrRR >= minRR) return { target: atrTarget, source: "atr_x2" };
  } else {
    const validLows = swingLows.filter(l => l.price < entry).sort((a, b) => b.price - a.price);
    for (const low of validLows) {
      const rr = (entry - low.price) / (sl - entry);
      if (rr >= minRR) return { target: low.price, source: "pivot_low" };
    }
    const lowestLow = swingLows.length > 0 ? Math.min(...swingLows.map(l => l.price)) : Infinity;
    if (lowestLow < entry) {
      const rr = (entry - lowestLow) / (sl - entry);
      if (rr >= minRR) return { target: lowestLow, source: "extended_pivot_low" };
    }
    const atrTarget = entry - atrVal * 2;
    const atrRR = (entry - atrTarget) / (sl - entry);
    if (atrRR >= minRR) return { target: atrTarget, source: "atr_x2" };
  }
  return null;
}

// --- INDICATOR BUNDLE ---
interface Indicators {
  rsi: number;
  stoch: { k: number; d: number };
  adx: number;
  ema8: number;
  ema21: number;
  atr: number;
}

function buildIndicators(candles4h: Candle[]): Indicators {
  const closes = candles4h.map(c => c.close);
  const ema8Arr = ema(closes, 8);
  const ema21Arr = ema(closes, 21);
  return {
    rsi: rsi(closes),
    stoch: stochRsi(closes),
    adx: adx(candles4h),
    ema8: ema8Arr[ema8Arr.length - 1],
    ema21: ema21Arr[ema21Arr.length - 1],
    atr: atr(candles4h),
  };
}

// --- EXHAUSTION CHECK ---
interface ExhaustionResult {
  exhausted: boolean;
  reason: string;
}

function checkExhaustion(direction: "LONG" | "SHORT", indicators: Indicators): ExhaustionResult {
  if (indicators.adx > ADX_EXHAUSTION) {
    return { exhausted: true, reason: `ADX_${indicators.adx}` };
  }
  const stochExtreme = direction === "LONG"
    ? indicators.stoch.k > STOCH_EXTREME_LONG
    : indicators.stoch.k < STOCH_EXTREME_SHORT;
  const stochTurningAgainst = direction === "LONG"
    ? indicators.stoch.k < indicators.stoch.d
    : indicators.stoch.k > indicators.stoch.d;
  if (stochExtreme && stochTurningAgainst) {
    return {
      exhausted: true,
      reason: `stoch_extreme_${direction === "LONG" ? "overbought" : "oversold"}_${indicators.stoch.k}_turning`
    };
  }
  return { exhausted: false, reason: "healthy" };
}

// --- CONTEXT ---
interface MarketContext {
  pair: string;
  price: number;
  now: number;
  t1d: { direction: "LONG" | "SHORT" | null; strength: string };
  t4h: { direction: "LONG" | "SHORT" | null };
  trendline: { price: number; r2: number } | null;
  indicators: Indicators;
  last: Candle;
  prev: Candle;
}

function getContext(pair: string, candles4h: Candle[], currentPrice?: number): { ctx: MarketContext | null; debug: string[] } {
  const debug: string[] = [];
  for (let i = 1; i < candles4h.length; i++) {
    if (candles4h[i].timestamp < candles4h[i-1].timestamp) {
      debug.push("Candles not sorted");
      return { ctx: null, debug };
    }
  }
  const candles1d = aggregateTo1D(candles4h);
  if (candles1d.length < 25 || candles4h.length < 30) {
    debug.push("Insufficient candle data");
    return { ctx: null, debug };
  }
  const t1d = trend1D(candles1d);
  const t4h = trend4H(candles4h);
  debug.push(`1D: ${t1d.direction || "NONE"} ${t1d.strength} | 4H: ${t4h.direction || "NONE"}`);
  if (!t1d.direction) {
    debug.push("1D trend unclear");
    return { ctx: null, debug };
  }
  const trendline = getTrendline(pair, candles4h, t1d.direction, debug);
  if (!trendline) {
    debug.push("No trendline");
    return { ctx: null, debug };
  }
  const price = currentPrice ?? candles4h[candles4h.length - 1].close;
  const dist = (price - trendline.price) / trendline.price;
  debug.push(`TL: ${trendline.price.toFixed(1)} | R² ${trendline.r2} | Price: ${price.toFixed(1)} | Dist: ${(dist >= 0 ? "+" : "")}${(dist * 100).toFixed(2)}%`);
  
  // v30.12: Distance-based trendline invalidation
  if (t1d.direction === "SHORT" && dist > TL_MAX_DIST) {
    debug.push(`Trendline too far below price (${(dist * 100).toFixed(2)}% > ${(TL_MAX_DIST * 100).toFixed(0)}%), likely broken structure`);
    trendlineStore.delete(pair);
    return { ctx: null, debug };
  }
  if (t1d.direction === "LONG" && dist < -TL_MAX_DIST) {
    debug.push(`Trendline too far above price (${(dist * 100).toFixed(2)}% < -${(TL_MAX_DIST * 100).toFixed(0)}%), likely broken structure`);
    trendlineStore.delete(pair);
    return { ctx: null, debug };
  }
  
  const indicators = buildIndicators(candles4h);
  debug.push(`StochRSI: K ${indicators.stoch.k} | D ${indicators.stoch.d} | ADX ${indicators.adx}`);
  return {
    ctx: {
      pair,
      price,
      now: candles4h[candles4h.length - 1].timestamp,
      t1d,
      t4h,
      trendline,
      indicators,
      last: candles4h[candles4h.length - 1],
      prev: candles4h[candles4h.length - 2],
    },
    debug,
  };
}

// --- SETUP FINDER (ATR-scaled nearTrendline) ---
interface Setup {
  type: "ACCUMULATE" | "BREAKOUT";
  scale: "ENTRY_1" | "ADD";
  reason: string;
}

function findSetup(ctx: MarketContext): Setup | null {
  const { price, t1d, trendline, indicators, last, prev } = ctx;
  const tlPrice = trendline.price;
  const dist = (price - tlPrice) / tlPrice;
  const atrVal = indicators.atr;
  const nearTrendline = Math.abs(price - tlPrice) < atrVal * 0.8;
  const stochTurning = t1d.direction === "LONG"
    ? indicators.stoch.k > indicators.stoch.d
    : indicators.stoch.k < indicators.stoch.d;
  const atTrendlineExact = Math.abs(dist) < 0.003;
  const stochExtreme = t1d.direction === "LONG"
    ? indicators.stoch.k < 20
    : indicators.stoch.k > 80;
  const correctSide = t1d.direction === "LONG"
    ? price <= tlPrice * (1 + CORRECT_SIDE_BUFFER)
    : price >= tlPrice * (1 - CORRECT_SIDE_BUFFER);
  const inRetestZone = t1d.direction === "LONG"
    ? price > tlPrice * (1 + CORRECT_SIDE_BUFFER) && price < tlPrice * 1.02 && dist > 0
    : price < tlPrice * (1 - CORRECT_SIDE_BUFFER) && price > tlPrice * 0.98 && dist < 0;
  const confirming = t1d.direction === "LONG"
    ? last.close > last.open && last.close > prev.close
    : last.close < last.open && last.close < prev.close;
  const emaAligned = t1d.direction === "LONG"
    ? price > indicators.ema8 && price > indicators.ema21
    : price < indicators.ema8 && price < indicators.ema21;

  if (nearTrendline && correctSide) {
    return {
      type: "ACCUMULATE",
      scale: "ENTRY_1",
      reason: stochTurning ? "TL+stoch_turn" : "TL+proximity"
    };
  }
  if (atTrendlineExact && stochExtreme) {
    return { type: "ACCUMULATE", scale: "ENTRY_1", reason: "TL+stoch_extreme" };
  }
  if (inRetestZone && confirming && emaAligned && indicators.adx > 20) {
    return { type: "BREAKOUT", scale: "ADD", reason: "Retest+ADX" };
  }
  return null;
}

// --- MAIN SIGNAL v30.12 ---
export function generateSignal(
  pair: string,
  candles4h: Candle[],
  currentPrice?: number
): SignalResult {
  const { ctx, debug } = getContext(pair, candles4h, currentPrice);
  if (!ctx) return { debug };
  const exhaustion = checkExhaustion(ctx.t1d.direction!, ctx.indicators);
  debug.push(`Exhaustion: ${exhaustion.exhausted ? "YES" : "NO"} (${exhaustion.reason})`);
  if (exhaustion.exhausted) {
    debug.push(`Rejected: exhaustion — ${exhaustion.reason}`);
    return { debug };
  }
  if (ctx.trendline.r2 < MIN_R2) {
    debug.push(`Rejected: R² ${ctx.trendline.r2} < ${MIN_R2} (weak trendline)`);
    return { debug };
  }
  const setup = findSetup(ctx);
  if (!setup) {
    const dist = (ctx.price - ctx.trendline.price) / ctx.trendline.price;
    const nearTrendline = Math.abs(ctx.price - ctx.trendline.price) < ctx.indicators.atr * 0.8;
    const correctSide = ctx.t1d.direction === "LONG"
      ? ctx.price <= ctx.trendline.price * (1 + CORRECT_SIDE_BUFFER)
      : ctx.price >= ctx.trendline.price * (1 - CORRECT_SIDE_BUFFER);
    const stochTurning = ctx.t1d.direction === "LONG"
      ? ctx.indicators.stoch.k > ctx.indicators.stoch.d
      : ctx.indicators.stoch.k < ctx.indicators.stoch.d;
    const stochExtreme = ctx.t1d.direction === "LONG"
      ? ctx.indicators.stoch.k < 20
      : ctx.indicators.stoch.k > 80;

    const stateParts: string[] = [];
    if (Math.abs(ctx.price - ctx.trendline.price) < ctx.indicators.atr * 0.8) stateParts.push("near TL");
    else if ((ctx.t1d.direction === "LONG" && ctx.price > ctx.trendline.price * (1 + CORRECT_SIDE_BUFFER) && ctx.price < ctx.trendline.price * 1.02) ||
             (ctx.t1d.direction === "SHORT" && ctx.price < ctx.trendline.price * (1 - CORRECT_SIDE_BUFFER) && ctx.price > ctx.trendline.price * 0.98)) {
      stateParts.push("retest zone");
    } else {
      stateParts.push("far from TL");
    }
    stateParts.push(`Stoch K${ctx.indicators.stoch.k} D${ctx.indicators.stoch.d}`);
    stateParts.push("No signal");

    debug.push(`Check: nearTL=${nearTrendline} | correctSide=${correctSide} | stochTurning=${stochTurning} | stochExtreme=${stochExtreme} | RR=unchecked | R2=passed`);
    debug.push(`State: ${stateParts.join(" | ")}`);
    return { debug };
  }
  const result = buildTradeWithPivots(ctx, setup, candles4h);
  if (!result) {
    debug.push(`Rejected: TL=passed | SIDE=passed | STOCH=passed | RR=failed | R2=passed`);
    debug.push("R:R too low");
    return { debug };
  }
  debug.push(`SIGNAL: ${result.signal.type} ${result.signal.scale} ${result.signal.direction} ${result.signal.entry} | TP ${result.signal.target} | SL ${result.signal.stop} | RR ${result.signal.rr}`);
  return { signal: result.signal, market: result.market, debug };
}

// Build trade (Bounded stops + spread confidence)
function buildTradeWithPivots(ctx: MarketContext, setup: Setup, candles4h: Candle[]): { signal: Signal; market: any } | null {
  const { pair, price, now, t1d, t4h, trendline, indicators } = ctx;
  const tlPrice = trendline.price;
  const atrVal = indicators.atr;
  const swingLows = candles4h.map(c => c.low).slice(-20);
  const swingHighs = candles4h.map(c => c.high).slice(-20);
  const swingLow = Math.min(...swingLows);
  const swingHigh = Math.max(...swingHighs);
  let entry: number, sl: number, tp: number, targetSource: string;

  if (setup.type === "ACCUMULATE") {
    entry = price;
    // Bounded stops: trendline invalidation with ATR cap
    sl = t1d.direction === "LONG"
      ? Math.max(entry - atrVal * 1.2, tlPrice * 0.992)
      : Math.min(entry + atrVal * 1.2, tlPrice * 1.008);

    const pivotTarget = getPivotTarget(candles4h, t1d.direction!, entry, sl, atrVal);
    if (pivotTarget) {
      tp = pivotTarget.target;
      targetSource = pivotTarget.source;
    } else {
      tp = t1d.direction === "LONG" ? entry + atrVal * 2 : entry - atrVal * 2;
      targetSource = "atr_x2";
    }
  } else {
    entry = price;
    sl = t1d.direction === "LONG"
      ? Math.max(tlPrice * 0.995, entry - atrVal * 1.5)
      : Math.min(tlPrice * 1.005, entry + atrVal * 1.5);

    const pivotTarget = getPivotTarget(candles4h, t1d.direction!, entry, sl, atrVal);
    if (pivotTarget) {
      tp = pivotTarget.target;
      targetSource = pivotTarget.source;
    } else {
      const minTarget = t1d.direction === "LONG"
        ? entry + (entry - sl) * MIN_RR
        : entry - (sl - entry) * MIN_RR;
      tp = t1d.direction === "LONG" 
        ? Math.max(swingHigh, minTarget) 
        : Math.min(swingLow, minTarget);
      targetSource = "swing_or_minRR";
    }
  }

  const rr = t1d.direction === "LONG" ? (tp - entry) / (entry - sl) : (entry - tp) / (sl - entry);
  if (rr < MIN_RR) return null;

  // Spread confidence: 50 base, +10 per quality factor
  let confidence = 50;
  if (rr > 2.0) confidence += 10;
  const stochTurning = t1d.direction === "LONG"
    ? indicators.stoch.k > indicators.stoch.d
    : indicators.stoch.k < indicators.stoch.d;
  if (stochTurning) confidence += 10;
  if (t4h.direction === t1d.direction && indicators.adx > 20) confidence += 10;
  if (indicators.adx > 30) confidence += 10;
  if (trendline.r2 > 0.70) confidence += 10;

  const expectedMove = Math.abs(tp - entry) / entry * 100;

  const signal: Signal = {
    id: `${pair}_${now}`,
    pair,
    direction: t1d.direction!,
    type: setup.type,
    scale: setup.scale,
    entry: Math.round(entry * 100) / 100,
    stop: Math.round(sl * 100) / 100,
    target: Math.round(tp * 100) / 100,
    confidence,
    rr: Math.round(rr * 100) / 100,
    adx: Math.round(indicators.adx * 10) / 10,
    rsi: Math.round(indicators.rsi * 10) / 10,
    stochK: indicators.stoch.k,
    stochD: indicators.stoch.d,
    expectedMove: Math.round(expectedMove * 10) / 10,
    reason: `${t1d.direction} ${setup.type} ${setup.scale} | 1D ${t1d.strength} | 4H ${t4h.direction || "NONE"} | Stoch K${indicators.stoch.k} D${indicators.stoch.d} | ${setup.reason} | TP:${targetSource} | RR ${rr.toFixed(2)} | Conf ${confidence}`,
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
    distToTrendline: Math.round(((price - tlPrice) / tlPrice) * 10000) / 100,
    ema8: Math.round(indicators.ema8 * 100) / 100,
    ema21: Math.round(indicators.ema21 * 100) / 100,
  };

  return { signal, market };
}

// --- MARKET SNAPSHOT ---
export function getMarketSnapshot(pair: string, candles4h: Candle[]): any {
  const candles1d = aggregateTo1D(candles4h);
  const t1d = trend1D(candles1d);
  const stochRsi4h = stochRsi(candles4h.map(c => c.close));
  const price = candles4h[candles4h.length - 1].close;
  
  // v30.12.1: Apply same distance-based invalidation to keep UI in sync with signal logic
  let tlPrice = 0;
  let dist = 1;
  if (t1d.direction) {
    const tl = getTrendline(pair, candles4h, t1d.direction, []);
    if (tl) {
      const d = (price - tl.price) / tl.price;
      const valid = t1d.direction === "SHORT" ? d <= TL_MAX_DIST : d >= -TL_MAX_DIST;
      if (valid) {
        tlPrice = tl.price;
        dist = d;
      }
    }
  }
  
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
    distToTrendline: Math.round(dist * 10000) / 100,
    ema8: Math.round(ema(candles4h.map(c => c.close), 8).slice(-1)[0] * 100) / 100,
    ema21: Math.round(ema(candles4h.map(c => c.close), 21).slice(-1)[0] * 100) / 100,
  };
}

// --- VALIDITY (Extended TTL) ---
export interface ValidityCheck {
  valid: boolean;
  reason: string;
  exited: boolean;
}

export function isSignalStillValid(signal: Signal, currentPrice: number, now: number = Date.now()): ValidityCheck {
  const ageMs = now - signal.timestamp;
  const maxAge = signal.type === "ACCUMULATE" ? 36 * 60 * 60 * 1000 : 8 * 60 * 60 * 1000;
  if (ageMs > maxAge) return { valid: false, reason: "expired_ttl", exited: true };
  const entryBuffer = signal.type === "ACCUMULATE" ? 1.02 : 1.005;
  if (signal.direction === "LONG" && currentPrice > signal.entry * entryBuffer) return { valid: false, reason: "missed_entry", exited: true };
  if (signal.direction === "SHORT" && currentPrice < signal.entry * (2 - entryBuffer)) return { valid: false, reason: "missed_entry", exited: true };
  if (signal.direction === "LONG" && currentPrice <= signal.stop) return { valid: false, reason: "sl_hit", exited: true };
  if (signal.direction === "SHORT" && currentPrice >= signal.stop) return { valid: false, reason: "sl_hit", exited: true };
  if (signal.direction === "LONG" && currentPrice >= signal.target) return { valid: false, reason: "tp_hit", exited: true };
  if (signal.direction === "SHORT" && currentPrice <= signal.target) return { valid: false, reason: "tp_hit", exited: true };
  return { valid: true, reason: "active", exited: false };
}

// --- shouldHold ---
export interface HoldResult {
  shouldHold: boolean;
  reason: string;
}

export function shouldHold(signal: Signal, candles4h: Candle[], currentPrice: number, now?: number): HoldResult {
  const candles1d = aggregateTo1D(candles4h);
  const t1d = trend1D(candles1d);
  const trendReversed = (signal.direction === "LONG" && t1d.direction === "SHORT") || (signal.direction === "SHORT" && t1d.direction === "LONG");
  if (trendReversed) {
    const inProfit = signal.direction === "LONG" ? currentPrice > signal.entry : currentPrice < signal.entry;
    if (!inProfit) return { shouldHold: false, reason: "trend_reversed_unprofitable" };
  }
  const stoch = stochRsi(candles4h.map(c => c.close));
  const stochExtremeOpposite = signal.direction === "LONG" ? stoch.k > 80 : stoch.k < 20;
  if (stochExtremeOpposite) return { shouldHold: false, reason: "stoch_extreme_opposite_exit" };
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
    if (price === undefined) { active.push(signal); continue; }
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

// --- MINIMAL COMPAT ---
export async function generateSignalCompat(
  pair: string,
  candles1h: Candle[],
  candles4h: Candle[],
  candles15m: Candle[],
  activeTrades?: Record<string, any>,
  currentPrice?: number
): Promise<SignalResult> {
  return generateSignal(pair, candles4h, currentPrice);
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
