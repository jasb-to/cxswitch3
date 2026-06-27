// lib/strategy.ts — v30 "Clean Slate"
// ============================================================
// STRIP: Hysteresis, ENTRY_2, monitor state, compat layer, dead inputs
// KEEP: 1D trend, trendline, pivot targets, stoch exit
// FIX: State respects market, trendline validates 3+ pivots, no RR fighting

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

export async function loadTrendlinesFromKV(): Promise<void> {
  const state = await getTrendlineState();
  trendlineStore.clear();
  for (const [pair, data] of Object.entries(state)) {
    trendlineStore.set(pair, data as TrendlineState);
  }
}

export async function saveTrendlinesToKV(): Promise<void> {
  const state: Record<string, any> = {};
  for (const [pair, data] of trendlineStore.entries()) {
    state[pair] = data;
  }
  await setTrendlineState(state);
}

function avg(arr: number[]): number {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

// --- RSI (Wilder smoothed) ---
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

// --- RSI SERIES ---
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

// --- STOCHRSI ---
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

// --- AGGREGATE 4H TO 1D ---
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

// --- FIND PIVOTS ---
function findPivots(candles: Candle[], direction: "LONG" | "SHORT"): { index: number; price: number; timestamp: number }[] {
  const pivots: { index: number; price: number; timestamp: number }[] = [];
  for (let i = 3; i < candles.length - 3; i++) {
    const c = candles[i];
    const isSwingLow = c.low < candles[i-1].low && c.low < candles[i-2].low && c.low < candles[i+1].low && c.low < candles[i+2].low;
    const isSwingHigh = c.high > candles[i-1].high && c.high > candles[i-2].high && c.high > candles[i+1].high && c.high > candles[i+2].high;
    if (direction === "LONG" && isSwingLow) pivots.push({ index: i, price: c.low, timestamp: c.timestamp });
    if (direction === "SHORT" && isSwingHigh) pivots.push({ index: i, price: c.high, timestamp: c.timestamp });
  }
  return pivots;
}

// --- FIND ALL SWING HIGHS/LOWS ---
function findSwingHighs(candles: Candle[]): { price: number; index: number }[] {
  const highs: { price: number; index: number }[] = [];
  for (let i = 3; i < candles.length - 3; i++) {
    const c = candles[i];
    if (c.high > candles[i-1].high && c.high > candles[i-2].high && c.high > candles[i+1].high && c.high > candles[i+2].high) {
      highs.push({ price: c.high, index: i });
    }
  }
  return highs;
}

function findSwingLows(candles: Candle[]): { price: number; index: number }[] {
  const lows: { price: number; index: number }[] = [];
  for (let i = 3; i < candles.length - 3; i++) {
    const c = candles[i];
    if (c.low < candles[i-1].low && c.low < candles[i-2].low && c.low < candles[i+1].low && c.low < candles[i+2].low) {
      lows.push({ price: c.low, index: i });
    }
  }
  return lows;
}

// --- STATEFUL TRENDLINE (v30: 3+ pivot agreement) ---
function getTrendline(pair: string, candles: Candle[], direction: "LONG" | "SHORT"): { price: number; r2: number; age: number } | null {
  const len = candles.length;
  if (len < 20) return null;
  const pivots = findPivots(candles, direction);
  if (pivots.length < 3) return null;
  const recentPivots = pivots.slice(-5);
  const now = candles[candles.length - 1].timestamp;
  const existing = trendlineStore.get(pair);
  const maxAge = 7 * 24 * 60 * 60 * 1000;
  
  if (existing && existing.direction === direction && (now - existing.lastUpdated) < maxAge) {
    // v30: Require 3+ pivot agreement, not just latest
    const agreement = recentPivots.filter(p => {
      const projected = existing.slope * p.index + existing.intercept;
      return Math.abs(p.price - projected) / p.price < 0.02;
    }).length;
    if (agreement >= 3) {
      const currentIndex = len - 1;
      return { price: existing.slope * currentIndex + existing.intercept, r2: 0.85, age: now - existing.lastUpdated };
    }
  }
  
  const n = recentPivots.length;
  const sumX = recentPivots.reduce((s, p) => s + p.index, 0);
  const sumY = recentPivots.reduce((s, p) => s + p.price, 0);
  const sumXY = recentPivots.reduce((s, p) => s + p.index * p.price, 0);
  const sumX2 = recentPivots.reduce((s, p) => s + p.index * p.index, 0);
  const denom = n * sumX2 - sumX * sumX;
  if (Math.abs(denom) < 1e-9) return null;
  const slope = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;
  const yMean = sumY / n;
  const ssTotal = recentPivots.reduce((s, p) => s + Math.pow(p.price - yMean, 2), 0);
  const ssResidual = recentPivots.reduce((s, p) => s + Math.pow(p.price - (slope * p.index + intercept), 2), 0);
  const r2 = ssTotal === 0 ? 0 : 1 - (ssResidual / ssTotal);
  trendlineStore.set(pair, { slope, intercept, pivots: recentPivots, lastUpdated: now, direction });
  return { price: slope * (len - 1) + intercept, r2: Math.round(r2 * 100) / 100, age: 0 };
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

function ema(closes: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const ema: number[] = [closes[0]];
  for (let i = 1; i < closes.length; i++) ema.push(closes[i] * k + ema[i - 1] * (1 - k));
  return ema;
}

// --- ATR ---
function atr(candles: Candle[], period: number = 14): number {
  const start = Math.max(1, candles.length - period);
  const trs: number[] = [];
  for (let i = start; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
  }
  return avg(trs);
}

// --- PIVOT TARGETS (v30: unified MIN_RR) ---
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
      if (rr >= minRR * 0.75) return { target: highestHigh, source: "extended_pivot_high" };
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
      if (rr >= minRR * 0.75) return { target: lowestLow, source: "extended_pivot_low" };
    }
    const atrTarget = entry - atrVal * 2;
    const atrRR = (entry - atrTarget) / (sl - entry);
    if (atrRR >= minRR) return { target: atrTarget, source: "atr_x2" };
  }
  return null;
}

// --- MAIN SIGNAL v30 ---
export function generateSignal(
  pair: string,
  candles4h: Candle[],
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
  
  debug.push(`TL: ${tlPrice.toFixed(1)} | R² ${trendline.r2} | Price: ${price.toFixed(1)} | Dist: ${(dist * 100).toFixed(2)}%`);
  
  // --- INDICATORS (computed once) ---
  const closes4h = candles4h.map(c => c.close);
  const stoch = stochRsi(closes4h);
  const rsi4h = rsi(closes4h);
  const adxVal = adx(candles4h);
  const ema8_4h = ema(closes4h, 8);
  const ema21_4h = ema(closes4h, 21);
  const atrVal = atr(candles4h, 14);
  
  debug.push(`StochRSI: K ${stoch.k} | D ${stoch.d}`);
  
  const last = candles4h[candles4h.length - 1];
  const prev = candles4h[candles4h.length - 2];
  
  // --- v30 ENTRY LOGIC ---
  
  // ACCUMULATE: Near trendline, Stoch extreme or turning
  const nearTrendline = Math.abs(dist) < 0.012;
  const stochExtreme = t1d.direction === "LONG" ? stoch.k < 20 : stoch.k > 80;
  const stochTurning = t1d.direction === "LONG" ? stoch.k > stoch.d : stoch.k < stoch.d;
  
  // ADD: Retest zone — price broke TL, now pulling back to it
  const inRetestZone = t1d.direction === "LONG"
    ? price > tlPrice * 1.005 && price < tlPrice * 1.02 && dist > 0
    : price < tlPrice * 0.995 && price > tlPrice * 0.98 && dist < 0;
  
  const confirming = t1d.direction === "LONG" 
    ? last.close > last.open && last.close > prev.close 
    : last.close < last.open && last.close < prev.close;
  
  const volUp = last.volume > avg(candles4h.slice(-10).map(c => c.volume)) * 1.3;
  const emaAligned = t1d.direction === "LONG" 
    ? price > ema8_4h[ema8_4h.length - 1] && price > ema21_4h[ema21_4h.length - 1]
    : price < ema8_4h[ema8_4h.length - 1] && price < ema21_4h[ema21_4h.length - 1];
  
  const stochMomentum = t1d.direction === "LONG" ? stoch.k > stoch.d : stoch.k < stoch.d;
  const stochNotExtreme = t1d.direction === "LONG" ? stoch.k < 80 : stoch.k > 20;
  
  // Determine signal type
  let signalType: "ACCUMULATE" | "BREAKOUT" | null = null;
  let scale: "ENTRY_1" | "ADD" | null = null;
  
  if (nearTrendline && (stochExtreme || stochTurning)) {
    signalType = "ACCUMULATE";
    scale = "ENTRY_1";
  } else if (inRetestZone && confirming && emaAligned && stochNotExtreme && stochMomentum) {
    if (volUp || adxVal > 20) {
      signalType = "BREAKOUT";
      scale = "ADD";
    }
  }
  
  if (!signalType || !scale) {
    const stateParts: string[] = [];
    if (nearTrendline) stateParts.push("near TL");
    else if (inRetestZone) stateParts.push("retest zone");
    else stateParts.push("far from TL");
    stateParts.push(`Stoch K${stoch.k} D${stoch.d}`);
    stateParts.push("No signal");
    debug.push(`State: ${stateParts.join(" | ")}`);
    return { debug };
  }
  
  // --- LEVELS ---
  const swingLows = candles4h.map(c => c.low).slice(-20);
  const swingHighs = candles4h.map(c => c.high).slice(-20);
  const swingLow = Math.min(...swingLows);
  const swingHigh = Math.max(...swingHighs);
  
  let entry: number, sl: number, tp: number, targetSource: string;
  
  if (signalType === "ACCUMULATE") {
    entry = price;
    sl = t1d.direction === "LONG" 
      ? Math.min(swingLow, entry - atrVal * 2) 
      : Math.max(swingHigh, entry + atrVal * 2);
    
    const pivotTarget = getPivotTarget(candles4h, t1d.direction, entry, sl, atrVal);
    if (pivotTarget) {
      tp = pivotTarget.target;
      targetSource = pivotTarget.source;
    } else {
      tp = t1d.direction === "LONG" ? entry + atrVal * 2 : entry - atrVal * 2;
      targetSource = "atr_x2";
    }
  } else {
    // BREAKOUT/ADD: Stop at trendline (retest level)
    entry = price;
    sl = t1d.direction === "LONG" 
      ? tlPrice * 0.995  // Just below trendline
      : tlPrice * 1.005; // Just above trendline
    
    const pivotTarget = getPivotTarget(candles4h, t1d.direction, entry, sl, atrVal);
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
  if (rr < MIN_RR) {
    debug.push(`R:R ${rr.toFixed(2)} < ${MIN_RR} (target: ${targetSource})`);
    return { debug };
  }
  
  const confidence = signalType === "ACCUMULATE" ? (stochExtreme ? 50 : 60) : 85;
  const expectedMove = Math.abs(tp - entry) / entry * 100;
  
  const now = candles4h[candles4h.length - 1].timestamp;
  
  const signal: Signal = {
    id: `${pair}_${now}`,
    pair,
    direction: t1d.direction,
    type: signalType,
    scale,
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
    reason: `${t1d.direction} ${signalType} ${scale} | 1D ${t1d.strength} | Stoch K${stoch.k} D${stoch.d} | ${scale === "ADD" ? "Retest" + (volUp ? "+Vol" : "") + (stochMomentum ? "+Stoch" : "") : "TL approach"} | TP:${targetSource} | RR ${rr.toFixed(2)}`,
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
    distToTrendline: Math.round(Math.abs(dist) * 10000) / 100,
    ema8: Math.round(ema8_4h[ema8_4h.length - 1] * 100) / 100,
    ema21: Math.round(ema21_4h[ema21_4h.length - 1] * 100) / 100,
  };
  
  debug.push(`SIGNAL: ${signalType} ${scale} ${signal.direction} ${signal.entry} | TP ${signal.target} (${targetSource}) | SL ${signal.stop} | RR ${signal.rr}`);
  
  return { signal, market, debug };
}

// --- MARKET SNAPSHOT ---
export function getMarketSnapshot(
  pair: string,
  candles4h: Candle[]
): any {
  const candles1d = aggregateTo1D(candles4h);
  const t1d = trend1D(candles1d);
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
    ema8: Math.round(ema(candles4h.map(c => c.close), 8).slice(-1)[0] * 100) / 100,
    ema21: Math.round(ema(candles4h.map(c => c.close), 21).slice(-1)[0] * 100) / 100,
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

// ============================================================
// COMPATIBILITY LAYER (minimal)
// ============================================================

export async function getMonitorState(pair: string): Promise<any | undefined> { return undefined; }
export async function clearMonitorState(pair: string): Promise<void> { return; }
export async function setMonitorState(pair: string, state: any): Promise<void> { return; }
export function setRedisClient(_: any): void { return; }

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
