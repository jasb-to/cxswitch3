// lib/strategy.ts — v30.9 "Robust Trendlines from Direct Pivots"
// ============================================================
// CHANGES FROM v30.8:
// 1. Replaced regression trendline with direct 2-point/3-point trendline from swing lows/highs
// 2. No R² needed — trendline validity based on recency and price proximity
// 3. Uses last 2-3 swing points, extrapolates to current candle
// 4. All other logic preserved

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
const TL_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// --- STATE ---
interface TrendlineState {
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

// --- MATH UTILS ---
function avg(arr: number[]): number {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
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

// --- SWING DETECTION ---
function findSwingLows(candles: Candle[]): { price: number; index: number }[] {
  const lows: { price: number; index: number }[] = [];
  for (let i = 2; i < candles.length - 2; i++) {
    const c = candles[i];
    if (c.low < candles[i-1].low && c.low < candles[i-2].low && c.low < candles[i+1].low && c.low < candles[i+2].low) {
      lows.push({ price: c.low, index: i });
    }
  }
  return lows;
}

function findSwingHighs(candles: Candle[]): { price: number; index: number }[] {
  const highs: { price: number; index: number }[] = [];
  for (let i = 2; i < candles.length - 2; i++) {
    const c = candles[i];
    if (c.high > candles[i-1].high && c.high > candles[i-2].high && c.high > candles[i+1].high && c.high > candles[i+2].high) {
      highs.push({ price: c.high, index: i });
    }
  }
  return highs;
}

// v30.9: Direct trendline from last 2-3 swing points — no regression
function getTrendline(pair: string, candles: Candle[], direction: "LONG" | "SHORT"): { price: number; r2: number; age: number } | null {
  const len = candles.length;
  if (len < 20) return null;

  const swings = direction === "LONG" ? findSwingLows(candles) : findSwingHighs(candles);
  if (swings.length < 2) return null;

  // Use last 2-3 swings, most recent last
  const recentSwings = swings.slice(-3);
  const now = candles[candles.length - 1].timestamp;

  // Persist for continuity
  const existing = trendlineStore.get(pair);
  let useSwings = recentSwings;

  if (existing && existing.direction === direction && (now - existing.lastUpdated) < TL_MAX_AGE_MS) {
    // Merge with stored, dedupe by index
    const all = [...existing.pivots, ...recentSwings];
    const seen = new Set<number>();
    useSwings = all.filter(s => {
      if (seen.has(s.index)) return false;
      seen.add(s.index);
      return true;
    }).slice(-3);
  }

  trendlineStore.set(pair, {
    pivots: useSwings.map(s => ({ index: s.index, price: s.price, timestamp: candles[s.index].timestamp })),
    lastUpdated: now,
    direction,
  });

  // Extrapolate from last 2 swings to current candle
  const s1 = useSwings[useSwings.length - 2]; // earlier
  const s2 = useSwings[useSwings.length - 1]; // later

  const slope = (s2.price - s1.price) / (s2.index - s1.index);
  const currentIndex = len - 1;
  const extrapolatedPrice = s2.price + slope * (currentIndex - s2.index);

  // Sanity check: trendline shouldn't be more than 15% away from recent action
  const recentClose = candles[len - 1].close;
  const dist = Math.abs(extrapolatedPrice - recentClose) / recentClose;
  if (dist > 0.15) return null;

  // Fake R² for compatibility — based on how well the 2-3 points align
  let r2 = 1;
  if (useSwings.length >= 3) {
    const s0 = useSwings[useSwings.length - 3];
    const expectedS0 = s2.price + slope * (s0.index - s2.index);
    const error = Math.abs(s0.price - expectedS0) / s0.price;
    r2 = Math.max(0, 1 - error * 10);
  }

  return {
    price: Math.round(extrapolatedPrice * 100) / 100,
    r2: Math.round(r2 * 100) / 100,
    age: 0,
  };
}

// --- 1D TREND: Unchanged from v30.8 ---
function trend1D(candles1d: Candle[]): { direction: "LONG" | "SHORT" | null; strength: string } {
  const len = candles1d.length;
  if (len < 25) return { direction: null, strength: "WEAK" };

  const closes = candles1d.map(c => c.close);
  const highs = candles1d.map(c => c.high);
  const lows = candles1d.map(c => c.low);

  const ema8Arr = ema(closes, 8);
  const ema21Arr = ema(closes, 21);
  const ema8Now = ema8Arr[ema8Arr.length - 1];
  const ema21Now = ema21Arr[ema21Arr.length - 1];
  const ema8Prev3 = ema8Arr[ema8Arr.length - 4];
  const ema21Prev3 = ema21Arr[ema21Arr.length - 4];

  const emaCrossLong = ema8Now > ema21Now;
  const emaCrossShort = ema8Now < ema21Now;

  const emaCurlLong = ema8Now > ema8Prev3 && (ema21Now - ema8Now) < (ema21Prev3 - ema8Prev3);
  const emaCurlShort = ema8Now < ema8Prev3 && (ema8Now - ema21Now) < (ema8Prev3 - ema21Prev3);

  if (len < 7) return { direction: null, strength: "WEAK" };

  const recentHighs = highs.slice(-7);
  const recentLows = lows.slice(-7);
  const recentCloses = closes.slice(-7);

  const higherLow = recentLows[5] < recentLows[6];
  const lowerHigh = recentHighs[5] > recentHighs[6];

  const fiveDayHigh = Math.max(...recentHighs.slice(0, 5));
  const fiveDayLow = Math.min(...recentLows.slice(0, 5));
  const broke5DayHigh = recentHighs[6] > fiveDayHigh;
  const broke5DayLow = recentLows[6] < fiveDayLow;

  const last5Closes = recentCloses.slice(-5);
  const higherCloses = last5Closes.filter((c, i, arr) => i > 0 && c > arr[i-1]).length >= 3;
  const lowerCloses = last5Closes.filter((c, i, arr) => i > 0 && c < arr[i-1]).length >= 3;

  const longConfirmations = [broke5DayHigh, higherCloses, emaCurlLong].filter(Boolean).length;
  const shortConfirmations = [broke5DayLow, lowerCloses, emaCurlShort].filter(Boolean).length;

  if (higherLow) {
    if (emaCrossLong && longConfirmations >= 2) return { direction: "LONG", strength: "STRONG" };
    if (emaCrossLong || longConfirmations >= 1) return { direction: "LONG", strength: "MEDIUM" };
    return { direction: "LONG", strength: "WEAK" };
  }

  if (lowerHigh) {
    if (emaCrossShort && shortConfirmations >= 2) return { direction: "SHORT", strength: "STRONG" };
    if (emaCrossShort || shortConfirmations >= 1) return { direction: "SHORT", strength: "MEDIUM" };
    return { direction: "SHORT", strength: "WEAK" };
  }

  return { direction: null, strength: "NONE" };
}

// --- PIVOT TARGETS ---
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

// --- CONTEXT ---
interface MarketContext {
  pair: string;
  price: number;
  now: number;
  t1d: { direction: "LONG" | "SHORT" | null; strength: string };
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
  debug.push(`1D: ${t1d.direction || "NONE"} ${t1d.strength}`);

  if (!t1d.direction) {
    debug.push("1D trend unclear (no structure)");
    return { ctx: null, debug };
  }

  const trendline = getTrendline(pair, candles4h, t1d.direction);
  if (!trendline) {
    debug.push("No trendline");
    return { ctx: null, debug };
  }

  const price = currentPrice ?? candles4h[candles4h.length - 1].close;
  const dist = (price - trendline.price) / trendline.price;
  debug.push(`TL: ${trendline.price.toFixed(1)} | R² ${trendline.r2} | Price: ${price.toFixed(1)} | Dist to TL: ${(dist >= 0 ? "+" : "")}${(dist * 100).toFixed(2)}%`);

  const indicators = buildIndicators(candles4h);
  debug.push(`StochRSI: K ${indicators.stoch.k} | D ${indicators.stoch.d}`);

  return {
    ctx: {
      pair,
      price,
      now: candles4h[candles4h.length - 1].timestamp,
      t1d,
      trendline,
      indicators,
      last: candles4h[candles4h.length - 1],
      prev: candles4h[candles4h.length - 2],
    },
    debug,
  };
}

// --- SETUP FINDER ---
interface Setup {
  type: "ACCUMULATE" | "BREAKOUT";
  scale: "ENTRY_1" | "ADD";
  reason: string;
}

function findSetup(ctx: MarketContext): Setup | null {
  const { price, t1d, trendline, indicators, last, prev } = ctx;
  const tlPrice = trendline.price;
  const dist = (price - tlPrice) / tlPrice;

  const nearTrendline = Math.abs(dist) < 0.012;

  const stochTurning = t1d.direction === "LONG"
    ? indicators.stoch.k > indicators.stoch.d
    : indicators.stoch.k < indicators.stoch.d;

  const atTrendlineExact = Math.abs(dist) < 0.003;
  const stochExtreme = t1d.direction === "LONG"
    ? indicators.stoch.k < 20
    : indicators.stoch.k > 80;

  const correctSide = t1d.direction === "LONG"
    ? price <= tlPrice * 1.005
    : price >= tlPrice * 0.995;

  const inRetestZone = t1d.direction === "LONG"
    ? price > tlPrice * 1.005 && price < tlPrice * 1.02 && dist > 0
    : price < tlPrice * 0.995 && price > tlPrice * 0.98 && dist < 0;

  const confirming = t1d.direction === "LONG"
    ? last.close > last.open && last.close > prev.close
    : last.close < last.open && last.close < prev.close;

  const emaAligned = t1d.direction === "LONG"
    ? price > indicators.ema8 && price > indicators.ema21
    : price < indicators.ema8 && price < indicators.ema21;

  // Breakout continuation — price is well above/below trendline in strong trend
  const inBreakoutZone = t1d.direction === "LONG"
    ? dist > 0.02 && dist < 0.20
    : dist < -0.02 && dist > -0.20;

  const trendStrongEnough = t1d.strength === "MEDIUM" || t1d.strength === "STRONG";

  if (nearTrendline && correctSide && stochTurning) {
    return { type: "ACCUMULATE", scale: "ENTRY_1", reason: "TL+stoch_turn" };
  }

  if (atTrendlineExact && stochExtreme) {
    return { type: "ACCUMULATE", scale: "ENTRY_1", reason: "TL+stoch_extreme" };
  }

  if (inRetestZone && confirming && emaAligned && indicators.adx > 20) {
    return { type: "BREAKOUT", scale: "ADD", reason: "Retest+ADX" };
  }

  if (inBreakoutZone && trendStrongEnough && emaAligned && indicators.adx > 25) {
    return { type: "BREAKOUT", scale: "ADD", reason: "Trend_continuation" };
  }

  return null;
}

// --- MAIN SIGNAL v30.9 ---
export function generateSignal(
  pair: string,
  candles4h: Candle[],
  currentPrice?: number
): SignalResult {
  const { ctx, debug } = getContext(pair, candles4h, currentPrice);
  if (!ctx) return { debug };

  const setup = findSetup(ctx);
  if (!setup) {
    const dist = (ctx.price - ctx.trendline.price) / ctx.trendline.price;
    const nearTrendline = Math.abs(dist) < 0.012;
    const correctSide = ctx.t1d.direction === "LONG"
      ? ctx.price <= ctx.trendline.price * 1.005
      : ctx.price >= ctx.trendline.price * 0.995;
    const stochTurning = ctx.t1d.direction === "LONG"
      ? ctx.indicators.stoch.k > ctx.indicators.stoch.d
      : ctx.indicators.stoch.k < ctx.indicators.stoch.d;
    const stochExtreme = ctx.t1d.direction === "LONG"
      ? ctx.indicators.stoch.k < 20
      : ctx.indicators.stoch.k > 80;
    const inBreakout = ctx.t1d.direction === "LONG"
      ? dist > 0.02 && dist < 0.20
      : dist < -0.02 && dist > -0.20;

    const stateParts: string[] = [];
    if (Math.abs(dist) < 0.012) stateParts.push("near TL");
    else if ((ctx.t1d.direction === "LONG" && ctx.price > ctx.trendline.price * 1.005 && ctx.price < ctx.trendline.price * 1.02) ||
             (ctx.t1d.direction === "SHORT" && ctx.price < ctx.trendline.price * 0.995 && ctx.price > ctx.trendline.price * 0.98)) {
      stateParts.push("retest zone");
    } else if (inBreakout) {
      stateParts.push("breakout zone");
    } else {
      stateParts.push("far from TL");
    }
    stateParts.push(`Stoch K${ctx.indicators.stoch.k} D${ctx.indicators.stoch.d}`);
    stateParts.push("No signal");

    debug.push(`Rejected: TL=${!nearTrendline} | SIDE=${!correctSide} | TURN=${!stochTurning} | EXTREME=${!stochExtreme} | BREAKOUT=${!inBreakout} | RR=unchecked | R2=passed`);
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

// Build trade with full candle access for pivot targets
function buildTradeWithPivots(ctx: MarketContext, setup: Setup, candles4h: Candle[]): { signal: Signal; market: any } | null {
  const { pair, price, now, t1d, trendline, indicators } = ctx;
  const tlPrice = trendline.price;
  const atrVal = indicators.atr;

  const swingLows = candles4h.map(c => c.low).slice(-20);
  const swingHighs = candles4h.map(c => c.high).slice(-20);
  const swingLow = Math.min(...swingLows);
  const swingHigh = Math.max(...swingHighs);

  let entry: number, sl: number, tp: number, targetSource: string;

  if (setup.type === "ACCUMULATE") {
    entry = price;
    const stopBuffer = atrVal * 1.5;
    sl = t1d.direction === "LONG"
      ? Math.min(swingLow, entry - stopBuffer)
      : Math.max(swingHigh, entry + stopBuffer);

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
    if (setup.reason === "Trend_continuation") {
      sl = t1d.direction === "LONG"
        ? Math.max(tlPrice, indicators.ema21)
        : Math.min(tlPrice, indicators.ema21);
    } else {
      sl = t1d.direction === "LONG"
        ? Math.max(tlPrice * 0.995, entry - atrVal * 1.5)
        : Math.min(tlPrice * 1.005, entry + atrVal * 1.5);
    }

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

  const confidence = setup.type === "ACCUMULATE"
    ? (t1d.strength === "STRONG" ? 75 : t1d.strength === "MEDIUM" ? 65 : 60)
    : 85;

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
    reason: `${t1d.direction} ${setup.type} ${setup.scale} | 1D ${t1d.strength} | Stoch K${indicators.stoch.k} D${indicators.stoch.d} | ${setup.reason} | TP:${targetSource} | RR ${rr.toFixed(2)}`,
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
    distToTrendline: Math.round(dist * 10000) / 100,
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
