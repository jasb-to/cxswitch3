// lib/strategy.ts — v31.2 "Simplified + Exhaustion Guard + Pullback Exception"
// ============================================================
// CHANGES FROM v31.1b:
// 1. Added pullback exception to exhaustion check
//    - If price has moved 1+ ATR against the trend direction,
//      exhaustion is lifted and entries are allowed
//    - This catches mean-reversion pullbacks to EMA8 within stretched trends
// 2. Philosophy: Don't chase stretched trends, but DO enter on pullbacks

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

export const CURRENT_SIGNAL_VERSION = 31;

// --- CONFIG ---
const MIN_RR = 1.5;
const MIN_R2 = 0.30;
const ACCUM_ZONE = 0.015;
const RETEST_ZONE = 0.02;

// --- MATH UTILS ---
function avg(arr: number[]): number {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function linearRegression(points: { x: number; y: number }[]): { slope: number; intercept: number; r2: number } | null {
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
  const r2 = ssTotal === 0 ? 0 : 1 - (ssResidual / ssTotal);
  return { slope, intercept, r2 };
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

// --- PIVOTS ---
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

// --- TRENDLINE: Stateless, direction-agnostic ---
function getTrendline(pair: string, candles: Candle[]): { price: number; r2: number; type: "support" | "resistance" } | null {
  const len = candles.length;
  if (len < 20) return null;

  const longPivots = findPivots(candles, "LONG");
  const shortPivots = findPivots(candles, "SHORT");

  let bestLine: { price: number; r2: number; type: "support" | "resistance" } | null = null;

  if (longPivots.length >= 3) {
    const recentPivots = longPivots.slice(-5);
    const points = recentPivots.map(p => ({ x: p.index, y: p.price }));
    const regression = linearRegression(points);
    if (regression) {
      const currentIndex = len - 1;
      bestLine = {
        price: regression.slope * currentIndex + regression.intercept,
        r2: Math.round(regression.r2 * 100) / 100,
        type: "support",
      };
    }
  }

  if (shortPivots.length >= 3) {
    const recentPivots = shortPivots.slice(-5);
    const points = recentPivots.map(p => ({ x: p.index, y: p.price }));
    const regression = linearRegression(points);
    if (regression) {
      const currentIndex = len - 1;
      const price = regression.slope * currentIndex + regression.intercept;
      const r2 = Math.round(regression.r2 * 100) / 100;
      if (!bestLine || r2 > bestLine.r2) {
        bestLine = { price, r2, type: "resistance" };
      }
    }
  }

  return bestLine;
}

// --- 1D TREND: Single source of truth ---
function trend1D(candles1d: Candle[]): { direction: "LONG" | "SHORT" | null } {
  const len = candles1d.length;
  if (len < 25) return { direction: null };
  const closes = candles1d.map(c => c.close);
  const ema8 = ema(closes, 8);
  const ema21 = ema(closes, 21);
  const direction = ema8[ema8.length - 1] > ema21[ema21.length - 1] ? "LONG" : "SHORT";
  return { direction };
}

// --- TREND EXHAUSTION: v31.2 Prevent entries at trend ends + pullback exception ---
interface ExhaustionCheck {
  exhausted: boolean;
  reason: string;
}

function checkTrendExhaustion(
  candles1d: Candle[],
  direction: "LONG" | "SHORT",
  indicators: Indicators
): ExhaustionCheck {
  const len = candles1d.length;
  if (len < 25) return { exhausted: false, reason: "insufficient_data" };

  const closes = candles1d.map(c => c.close);
  const ema8Arr = ema(closes, 8);
  const ema21Arr = ema(closes, 21);
  const currentPrice = candles1d[len - 1].close;
  const atr1d = atr(candles1d, 14);

  const ema8 = ema8Arr[ema8Arr.length - 1];
  const ema21 = ema21Arr[ema21Arr.length - 1];
  const emaSpread = Math.abs(ema8 - ema21) / ema21;

  // v31.2: Pullback exception — if price has moved 1+ ATR against trend,
  // exhaustion is lifted. This catches mean-reversion entries.
  const pullbackAgainstTrend = direction === "LONG"
    ? currentPrice < ema8 - atr1d   // Dropped 1 ATR below EMA8 in uptrend
    : currentPrice > ema8 + atr1d;  // Rallied 1 ATR above EMA8 in downtrend

  if (pullbackAgainstTrend) {
    return { exhausted: false, reason: "pullback_against_trend" };
  }

  // 1. EMA divergence > 3%
  if (emaSpread > 0.03) {
    return { exhausted: true, reason: `EMA_spread_${(emaSpread * 100).toFixed(1)}%` };
  }

  // 2. Price > 2 ATR beyond EMA8
  const distFromEma8 = Math.abs(currentPrice - ema8) / atr1d;
  if (distFromEma8 > 2.0) {
    return { exhausted: true, reason: `price_${distFromEma8.toFixed(1)}x_ATR_beyond_EMA8` };
  }

  // 3. ADX > 40 (extreme strength = likely peak)
  if (indicators.adx > 40) {
    return { exhausted: true, reason: `ADX_extreme_${indicators.adx}` };
  }

  // 4. Stoch extreme
  if (direction === "LONG" && indicators.stoch.k > 90) {
    return { exhausted: true, reason: `stoch_overbought_${indicators.stoch.k}` };
  }
  if (direction === "SHORT" && indicators.stoch.k < 10) {
    return { exhausted: true, reason: `stoch_oversold_${indicators.stoch.k}` };
  }

  return { exhausted: false, reason: "trend_healthy" };
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
  trend: { direction: "LONG" | "SHORT" | null };
  exhaustion: ExhaustionCheck;
  trendline: { price: number; r2: number; type: "support" | "resistance" } | null;
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

  const trend = trend1D(candles1d);
  debug.push(`1D EMA: ${trend.direction || "NONE"}`);

  if (!trend.direction) {
    debug.push("1D trend unclear");
    return { ctx: null, debug };
  }

  const indicators = buildIndicators(candles4h);

  // v31.2: Exhaustion check with pullback exception
  const exhaustion = checkTrendExhaustion(candles1d, trend.direction, indicators);
  debug.push(`Exhaustion: ${exhaustion.exhausted ? "YES" : "NO"} (${exhaustion.reason})`);
  if (exhaustion.exhausted) {
    debug.push(`Rejected: trend_exhaustion — ${exhaustion.reason}`);
    return { ctx: null, debug };
  }

  const trendline = getTrendline(pair, candles4h);
  if (!trendline) {
    debug.push("No trendline");
    return { ctx: null, debug };
  }

  const price = currentPrice ?? candles4h[candles4h.length - 1].close;
  const dist = (price - trendline.price) / trendline.price;
  debug.push(`TL: ${trendline.price.toFixed(1)} | R² ${trendline.r2} | Type: ${trendline.type} | Price: ${price.toFixed(1)} | Dist: ${(dist >= 0 ? "+" : "")}${(dist * 100).toFixed(2)}%`);
  debug.push(`StochRSI: K ${indicators.stoch.k} | D ${indicators.stoch.d} | ADX ${indicators.adx}`);

  return {
    ctx: {
      pair,
      price,
      now: candles4h[candles4h.length - 1].timestamp,
      trend,
      exhaustion,
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
  const { price, trend, trendline, indicators, last, prev } = ctx;
  const tlPrice = trendline.price;
  const dist = (price - tlPrice) / tlPrice;

  const inAccumZone = Math.abs(dist) <= ACCUM_ZONE;
  const inRetestZone = Math.abs(dist) <= RETEST_ZONE && Math.abs(dist) > ACCUM_ZONE;
  const beyondAccum = Math.abs(dist) > ACCUM_ZONE;

  const stochTurning = trend.direction === "LONG"
    ? indicators.stoch.k > indicators.stoch.d
    : indicators.stoch.k < indicators.stoch.d;

  const confirming = trend.direction === "LONG"
    ? last.close > last.open && last.close > prev.close
    : last.close < last.open && last.close < prev.close;

  if (inAccumZone && stochTurning) {
    return { type: "ACCUMULATE", scale: "ENTRY_1", reason: "TL_accum+stoch_turn" };
  }

  if (beyondAccum && inRetestZone && confirming && indicators.adx > 20) {
    return { type: "BREAKOUT", scale: "ADD", reason: "TL_retest+confirm+ADX" };
  }

  return null;
}

// --- MAIN SIGNAL v31.2 ---
export function generateSignal(
  pair: string,
  candles4h: Candle[],
  currentPrice?: number
): SignalResult {
  const { ctx, debug } = getContext(pair, candles4h, currentPrice);
  if (!ctx) return { debug };

  if (ctx.trendline.r2 < MIN_R2) {
    debug.push(`Rejected: R² ${ctx.trendline.r2} < ${MIN_R2} (extremely poor fit)`);
    return { debug };
  }

  const setup = findSetup(ctx);
  if (!setup) {
    const dist = (ctx.price - ctx.trendline.price) / ctx.trendline.price;
    const inAccum = Math.abs(dist) <= ACCUM_ZONE;
    const inRetest = Math.abs(dist) <= RETEST_ZONE && Math.abs(dist) > ACCUM_ZONE;
    const stochTurning = ctx.trend.direction === "LONG"
      ? ctx.indicators.stoch.k > ctx.indicators.stoch.d
      : ctx.indicators.stoch.k < ctx.indicators.stoch.d;

    const stateParts: string[] = [];
    if (inAccum) stateParts.push("in accum zone");
    else if (inRetest) stateParts.push("in retest zone");
    else stateParts.push("far from TL");
    stateParts.push(`Stoch K${ctx.indicators.stoch.k} D${ctx.indicators.stoch.d}`);
    stateParts.push(`ADX ${ctx.indicators.adx}`);
    stateParts.push("No signal");

    debug.push(`Rejected: accum=${inAccum} | turn=${stochTurning} | retest=${inRetest} | ADX_ok=${ctx.indicators.adx > 20} | RR=unchecked | R2=passed`);
    debug.push(`State: ${stateParts.join(" | ")}`);
    return { debug };
  }

  const result = buildTradeWithPivots(ctx, setup, candles4h);
  if (!result) {
    debug.push(`Rejected: TL=passed | STOCH=passed | RR=failed | R2=passed`);
    debug.push("R:R too low");
    return { debug };
  }

  debug.push(`SIGNAL: ${result.signal.type} ${result.signal.scale} ${result.signal.direction} ${result.signal.entry} | TP ${result.signal.target} | SL ${result.signal.stop} | RR ${result.signal.rr}`);

  return { signal: result.signal, market: result.market, debug };
}

// Build trade
function buildTradeWithPivots(ctx: MarketContext, setup: Setup, candles4h: Candle[]): { signal: Signal; market: any } | null {
  const { pair, price, now, trend, trendline, indicators } = ctx;
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
    sl = trend.direction === "LONG"
      ? Math.min(swingLow, entry - stopBuffer)
      : Math.max(swingHigh, entry + stopBuffer);

    const pivotTarget = getPivotTarget(candles4h, trend.direction!, entry, sl, atrVal);
    if (pivotTarget) {
      tp = pivotTarget.target;
      targetSource = pivotTarget.source;
    } else {
      tp = trend.direction === "LONG" ? entry + atrVal * 2 : entry - atrVal * 2;
      targetSource = "atr_x2";
    }
  } else {
    entry = price;
    sl = trend.direction === "LONG"
      ? Math.max(tlPrice * 0.995, entry - atrVal * 1.5)
      : Math.min(tlPrice * 1.005, entry + atrVal * 1.5);

    const pivotTarget = getPivotTarget(candles4h, trend.direction!, entry, sl, atrVal);
    if (pivotTarget) {
      tp = pivotTarget.target;
      targetSource = pivotTarget.source;
    } else {
      const minTarget = trend.direction === "LONG"
        ? entry + (entry - sl) * MIN_RR
        : entry - (sl - entry) * MIN_RR;
      tp = trend.direction === "LONG"
        ? Math.max(swingHigh, minTarget)
        : Math.min(swingLow, minTarget);
      targetSource = "swing_or_minRR";
    }
  }

  const rr = trend.direction === "LONG" ? (tp - entry) / (entry - sl) : (entry - tp) / (sl - entry);
  if (rr < MIN_RR) return null;

  const confidence = setup.type === "ACCUMULATE" ? 65 : 85;
  const expectedMove = Math.abs(tp - entry) / entry * 100;

  const signal: Signal = {
    id: `${pair}_${now}`,
    pair,
    direction: trend.direction!,
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
    reason: `${trend.direction} ${setup.type} ${setup.scale} | 1D EMA | Exhaustion:${ctx.exhaustion.reason} | Stoch K${indicators.stoch.k} D${indicators.stoch.d} | ${setup.reason} | TP:${targetSource} | RR ${rr.toFixed(2)}`,
    timestamp: now,
    version: CURRENT_SIGNAL_VERSION,
  };

  // v31.2: UI-compatible trend string with strength
  const ema8Arr = ema(candles4h.map(c => c.close), 8);
  const ema21Arr = ema(candles4h.map(c => c.close), 21);
  const ema8 = ema8Arr[ema8Arr.length - 1];
  const ema21 = ema21Arr[ema21Arr.length - 1];
  const spread = Math.abs(ema8 - ema21) / ema21;
  const strength = spread > 0.02 ? "STRONG" : "MEDIUM";

  const market = {
    pair,
    price: Math.round(price * 100) / 100,
    timestamp: now,
    trend: trend.direction ? `${trend.direction} ${strength}` : "NONE",
    exhaustion: ctx.exhaustion.exhausted ? ctx.exhaustion.reason : "healthy",
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
  const trend = trend1D(candles1d);
  const stochRsi4h = stochRsi(candles4h.map(c => c.close));
  const price = candles4h[candles4h.length - 1].close;
  const trendline = getTrendline(pair, candles4h);
  const tlPrice = trendline ? trendline.price : 0;
  const dist = trendline ? (price - tlPrice) / tlPrice : 1;

  let exhaustion: ExhaustionCheck = { exhausted: false, reason: "no_trend" };
  if (trend.direction && candles1d.length >= 25) {
    const indicators = buildIndicators(candles4h);
    exhaustion = checkTrendExhaustion(candles1d, trend.direction, indicators);
  }

  // v31.2: UI-compatible trend string with strength
  const ema8Arr = ema(candles1d.map(c => c.close), 8);
  const ema21Arr = ema(candles1d.map(c => c.close), 21);
  const ema8 = ema8Arr[ema8Arr.length - 1];
  const ema21 = ema21Arr[ema21Arr.length - 1];
  const spread = Math.abs(ema8 - ema21) / ema21;
  const strength = spread > 0.02 ? "STRONG" : "MEDIUM";

  return {
    pair,
    price: Math.round(price * 100) / 100,
    timestamp: Date.now(),
    trend: trend.direction ? `${trend.direction} ${strength}` : "NONE",
    exhaustion: exhaustion.exhausted ? exhaustion.reason : "healthy",
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
  const trend = trend1D(candles1d);
  const trendReversed = (signal.direction === "LONG" && trend.direction === "SHORT") || (signal.direction === "SHORT" && trend.direction === "LONG");
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

// --- MINIMAL COMPAT (unchanged interfaces) ---
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
