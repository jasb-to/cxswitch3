// lib/strategy.ts — v50 "First Wave" — Trend → Location → Momentum
// ============================================================
// Philosophy: Trade the first wave after a pullback.
// Sequence: Daily Trend → 4H Location → 15M Momentum → Enter
// No scoring. No weighting. No gates. Just: trend, location, trigger.

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
  type: "ENTRY" | "ADD" | "EXIT";
  scale: "ENTRY" | "ADD" | null;
  entry: number;
  stop: number;
  target: number;
  rr: number;
  adx: number;
  rsi: number;
  stochK: number;
  stochD: number;
  expectedMove: number;
  reason: string;
  timestamp: number;
  version: number;
  trend: string;
  location: string;
  trigger: string;
}

export interface SignalResult {
  signal?: Signal;
  market?: MarketSnapshot;
  debug: string[];
}

export interface MarketSnapshot {
  pair: string;
  price: number;
  timestamp: number;
  trend: string;
  location: string;
  trigger: string;
  adx: number;
  rsi: number;
  stochK: number;
  stochD: number;
  trendlinePrice: number;
  distToTrendline: number;
  ema8_15m: number;
  ema21_15m: number;
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

export const CURRENT_SIGNAL_VERSION = 50;
const MIN_RR = 1.5;
const TL_PROXIMITY = 0.012;
const SWING_PROXIMITY = 0.008;
const STOCH_EXTREME_LONG = 20;
const STOCH_EXTREME_SHORT = 80;
const COOLDOWN_MS = 4 * 60 * 60 * 1000;
const TL_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function avg(arr: number[]): number {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
}

function ema(values: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const out: number[] = [values[0]];
  for (let i = 1; i < values.length; i++) {
    out.push(values[i] * k + out[i - 1] * (1 - k));
  }
  return out;
}

function wilderRsi(closes: number[], period = 14): number {
  if (closes.length < period + 1) return 50;
  const diffs: number[] = [];
  for (let i = 1; i < closes.length; i++) diffs.push(closes[i] - closes[i - 1]);
  let avgGain = 0, avgLoss = 0;
  for (let i = 0; i < period; i++) {
    avgGain += Math.max(0, diffs[i]);
    avgLoss += Math.max(0, -diffs[i]);
  }
  avgGain /= period;
  avgLoss /= period;
  for (let i = period; i < diffs.length; i++) {
    avgGain = (avgGain * (period - 1) + Math.max(0, diffs[i])) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(0, -diffs[i])) / period;
  }
  if (avgLoss === 0) return avgGain > 0 ? 100 : 50;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

function wilderRsiSeries(closes: number[], period = 14): number[] {
  const series: number[] = [];
  for (let i = period; i < closes.length; i++) {
    series.push(wilderRsi(closes.slice(0, i + 1), period));
  }
  return series;
}

function stochRsi(closes: number[], rsiPeriod = 14, stochPeriod = 14, kSmooth = 3, dSmooth = 3): { k: number; d: number } {
  const rsiValues = wilderRsiSeries(closes, rsiPeriod);
  if (rsiValues.length < stochPeriod + kSmooth - 1) return { k: 50, d: 50 };
  const rawK: number[] = [];
  for (let i = stochPeriod - 1; i < rsiValues.length; i++) {
    const w = rsiValues.slice(i - stochPeriod + 1, i + 1);
    const lo = Math.min(...w), hi = Math.max(...w);
    rawK.push(hi === lo ? 50 : ((rsiValues[i] - lo) / (hi - lo)) * 100);
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

function atr(candles: Candle[], period = 14): number {
  const trs: number[] = [];
  for (let i = Math.max(1, candles.length - period); i < candles.length; i++) {
    trs.push(Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close)
    ));
  }
  return avg(trs);
}

function wilderSmooth(values: number[], period: number): number[] {
  const result: number[] = [avg(values.slice(0, period))];
  for (let i = period; i < values.length; i++) {
    result.push((result[result.length - 1] * (period - 1) + values[i]) / period);
  }
  return result;
}

function adx(candles: Candle[], period = 14): number {
  if (candles.length < period + 1) return 0;
  const trs: number[] = [];
  const plusDMs: number[] = [];
  const minusDMs: number[] = [];
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
  const adxSmooth = wilderSmooth(dxValues, period);
  return Math.round(adxSmooth[adxSmooth.length - 1] * 10) / 10;
}

export function aggregateTo1D(candles4h: Candle[]): Candle[] {
  if (!candles4h?.length) return [];
  const sorted = [...candles4h].sort((a, b) => a.timestamp - b.timestamp);
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

interface TrendlineState {
  slope: number;
  intercept: number;
  lastUpdated: number;
  direction: "LONG" | "SHORT";
  r2: number;
}

const trendlineStore: Map<string, TrendlineState> = new Map();

interface Pivot { index: number; price: number; timestamp: number; }

function findPivots(candles: Candle[], direction: "LONG" | "SHORT"): Pivot[] {
  const pivots: Pivot[] = [];
  for (let i = 3; i < candles.length - 3; i++) {
    const isSwingLow = candles[i].low < candles[i-1].low && candles[i].low < candles[i-2].low &&
                       candles[i].low < candles[i+1].low && candles[i].low < candles[i+2].low;
    const isSwingHigh = candles[i].high > candles[i-1].high && candles[i].high > candles[i-2].high &&
                        candles[i].high > candles[i+1].high && candles[i].high > candles[i+2].high;
    if (direction === "LONG" && isSwingLow) pivots.push({ index: i, price: candles[i].low, timestamp: candles[i].timestamp });
    if (direction === "SHORT" && isSwingHigh) pivots.push({ index: i, price: candles[i].high, timestamp: candles[i].timestamp });
  }
  return pivots;
}

function fitTrendline(pivots: Pivot[]): { slope: number; intercept: number; r2: number } | null {
  const n = pivots.length;
  if (n < 3) return null;
  const sumX = pivots.reduce((s, p) => s + p.index, 0);
  const sumY = pivots.reduce((s, p) => s + p.price, 0);
  const sumXY = pivots.reduce((s, p) => s + p.index * p.price, 0);
  const sumX2 = pivots.reduce((s, p) => s + p.index * p.index, 0);
  const denom = n * sumX2 - sumX * sumX;
  if (denom === 0) return null;
  const slope = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;
  const yMean = sumY / n;
  const ssTot = pivots.reduce((s, p) => s + Math.pow(p.price - yMean, 2), 0);
  const ssRes = pivots.reduce((s, p) => s + Math.pow(p.price - (slope * p.index + intercept), 2), 0);
  return { slope, intercept, r2: ssTot === 0 ? 0 : 1 - ssRes / ssTot };
}

function getTrendline(pair: string, candles: Candle[], direction: "LONG" | "SHORT"): { price: number; r2: number } | null {
  if (candles.length < 30) return null;
  const pivots = findPivots(candles, direction);
  if (pivots.length < 3) return null;
  const recentPivots = pivots.slice(-5);
  const now = candles[candles.length - 1].timestamp;
  const existing = trendlineStore.get(pair);
  if (existing && existing.direction === direction && (now - existing.lastUpdated) < TL_MAX_AGE_MS) {
    const lastPivot = recentPivots[recentPivots.length - 1];
    const projected = existing.slope * lastPivot.index + existing.intercept;
    const deviation = Math.abs(lastPivot.price - projected) / projected;
    if (deviation < 0.02) {
      const currentIndex = candles.length - 1;
      return { price: existing.slope * currentIndex + existing.intercept, r2: existing.r2 };
    }
  }
  const fit = fitTrendline(recentPivots);
  if (!fit || fit.r2 < 0.50) return null;
  trendlineStore.set(pair, {
    slope: fit.slope,
    intercept: fit.intercept,
    lastUpdated: now,
    direction,
    r2: Math.round(fit.r2 * 100) / 100,
  });
  const currentIndex = candles.length - 1;
  return { price: fit.slope * currentIndex + fit.intercept, r2: Math.round(fit.r2 * 100) / 100 };
}

function dailyTrend(candles1d: Candle[]): { direction: "LONG" | "SHORT" | "NONE"; detail: string } {
  if (candles1d.length < 50) {
    return { direction: "NONE", detail: "Insufficient daily data" };
  }
  const closes = candles1d.map(c => c.close);
  const e21 = ema(closes, 21);
  const e50 = ema(closes, 50);
  const last21 = e21[e21.length - 1];
  const last50 = e50[e50.length - 1];
  if (last21 > last50) return { direction: "LONG", detail: `EMA21 ${last21.toFixed(1)} > EMA50 ${last50.toFixed(1)}` };
  if (last21 < last50) return { direction: "SHORT", detail: `EMA21 ${last21.toFixed(1)} < EMA50 ${last50.toFixed(1)}` };
  return { direction: "NONE", detail: `EMA21 ${last21.toFixed(1)} ≈ EMA50 ${last50.toFixed(1)}` };
}

function location4H(
  pair: string,
  candles4h: Candle[],
  direction: "LONG" | "SHORT"
): { ready: boolean; detail: string; trendlinePrice: number } {
  const price = candles4h[candles4h.length - 1].close;
  const tl = getTrendline(pair, candles4h, direction);
  if (tl) {
    const dist = Math.abs(price - tl.price) / tl.price;
    if (dist < TL_PROXIMITY) {
      return { ready: true, detail: `Trendline ${(dist * 100).toFixed(2)}% (R² ${tl.r2.toFixed(2)})`, trendlinePrice: tl.price };
    }
  }
  const recent = candles4h.slice(-20);
  if (direction === "LONG") {
    const swingLow = Math.min(...recent.map(c => c.low));
    const dist = (price - swingLow) / swingLow;
    if (dist >= 0 && dist < SWING_PROXIMITY) {
      return { ready: true, detail: `Swing low ${(dist * 100).toFixed(2)}%`, trendlinePrice: swingLow };
    }
  } else {
    const swingHigh = Math.max(...recent.map(c => c.high));
    const dist = (swingHigh - price) / swingHigh;
    if (dist >= 0 && dist < SWING_PROXIMITY) {
      return { ready: true, detail: `Swing high ${(dist * 100).toFixed(2)}%`, trendlinePrice: swingHigh };
    }
  }
  return { ready: false, detail: "No valid location", trendlinePrice: tl?.price || 0 };
}

function momentum15M(candles15m: Candle[], direction: "LONG" | "SHORT"): {
  fired: boolean;
  detail: string;
  triggerType: string;
  stochK: number;
  stochD: number;
  ema8: number;
  ema21: number;
} {
  const defaultFail = {
    fired: false,
    detail: "Insufficient 15M data",
    triggerType: "none",
    stochK: 50,
    stochD: 50,
    ema8: 0,
    ema21: 0,
  };
  if (candles15m.length < 30) return defaultFail;
  const closes = candles15m.map(c => c.close);
  const prevCloses = closes.slice(0, -1);
  const stoch = stochRsi(closes);
  const prevStoch = stochRsi(prevCloses);
  const e8 = ema(closes, 8);
  const e21 = ema(closes, 21);
  const lastE8 = e8[e8.length - 1];
  const lastE21 = e21[e21.length - 1];
  const prevE8 = e8.length >= 2 ? e8[e8.length - 2] : lastE8;
  const prevE21 = e21.length >= 2 ? e21[e21.length - 2] : lastE21;
  let fired = false;
  let detail = "";
  let triggerType = "none";
  if (direction === "LONG") {
    if (prevStoch.k < prevStoch.d && stoch.k >= stoch.d && stoch.k < STOCH_EXTREME_LONG) {
      fired = true;
      triggerType = "stoch_cross";
      detail = `Stoch K crossed above D from oversold (K=${stoch.k}, D=${stoch.d})`;
    } else if (prevE8 <= prevE21 && lastE8 > lastE21) {
      fired = true;
      triggerType = "ema_cross";
      detail = `EMA8 crossed above EMA21 (${lastE8.toFixed(1)} > ${lastE21.toFixed(1)})`;
    } else if (stoch.k > stoch.d && stoch.k < STOCH_EXTREME_LONG) {
      fired = true;
      triggerType = "stoch_momentum";
      detail = `Stoch K above D in oversold zone (K=${stoch.k}, D=${stoch.d})`;
    }
  } else {
    if (prevStoch.k > prevStoch.d && stoch.k <= stoch.d && stoch.k > STOCH_EXTREME_SHORT) {
      fired = true;
      triggerType = "stoch_cross";
      detail = `Stoch K crossed below D from overbought (K=${stoch.k}, D=${stoch.d})`;
    } else if (prevE8 >= prevE21 && lastE8 < lastE21) {
      fired = true;
      triggerType = "ema_cross";
      detail = `EMA8 crossed below EMA21 (${lastE8.toFixed(1)} < ${lastE21.toFixed(1)})`;
    } else if (stoch.k < stoch.d && stoch.k > STOCH_EXTREME_SHORT) {
      fired = true;
      triggerType = "stoch_momentum";
      detail = `Stoch K below D in overbought zone (K=${stoch.k}, D=${stoch.d})`;
    }
  }
  if (!fired) {
    detail = `No trigger. Stoch K=${stoch.k} D=${stoch.d} | EMA8=${lastE8.toFixed(1)} EMA21=${lastE21.toFixed(1)}`;
  }
  return { fired, detail, triggerType, stochK: stoch.k, stochD: stoch.d, ema8: lastE8, ema21: lastE21 };
}

const cooldownStore: Map<string, number> = new Map();

function isOnCooldown(pair: string, now: number): boolean {
  const until = cooldownStore.get(pair);
  return until !== undefined && now < until;
}

function setCooldown(pair: string, now: number): void {
  cooldownStore.set(pair, now + COOLDOWN_MS);
}

export function generateSignal(
  pair: string,
  candles1h: Candle[],
  candles4h: Candle[],
  candles15m: Candle[],
  activeSignals: Signal[],
  currentPrice?: number
): SignalResult {
  const debug: string[] = [];
  const now = Date.now();
  const price = currentPrice ?? candles4h[candles4h.length - 1]?.close ?? 0;
  const hasActive = activeSignals.some(s => s.pair === pair && !s.exited);
  if (hasActive) {
    debug.push("Rejected: active trade");
    return { debug };
  }
  if (isOnCooldown(pair, now)) {
    const mins = Math.round((cooldownStore.get(pair)! - now) / 60000);
    debug.push(`Rejected: cooldown (${mins}min)`);
    return { debug };
  }
  const candles1d = aggregateTo1D(candles4h);
  const trend = dailyTrend(candles1d);
  debug.push(`Trend: ${trend.direction} | ${trend.detail}`);
  if (trend.direction === "NONE") {
    debug.push("Rejected: no trend");
    return { debug };
  }
  const location = location4H(pair, candles4h, trend.direction);
  debug.push(`Location: ${location.ready ? "READY" : "WAIT"} | ${location.detail}`);
  if (!location.ready) {
    debug.push("Rejected: location not ready");
    return { debug };
  }
  const momentum = momentum15M(candles15m, trend.direction);
  debug.push(`Momentum: ${momentum.fired ? "FIRED" : "WAITING"} | ${momentum.detail}`);
  if (!momentum.fired) {
    debug.push("Rejected: no momentum trigger");
    return { debug };
  }
  const atrVal = atr(candles4h, 14);
  const recent4h = candles4h.slice(-20);
  const swingLow = Math.min(...recent4h.map(c => c.low));
  const swingHigh = Math.max(...recent4h.map(c => c.high));
  let stop: number;
  let target: number;
  if (trend.direction === "LONG") {
    const atrStop = price - atrVal * 2;
    stop = Math.max(atrStop, swingLow);
    const minTarget = price + (price - stop) * MIN_RR;
    target = Math.max(swingHigh, minTarget);
  } else {
    const atrStop = price + atrVal * 2;
    stop = Math.min(atrStop, swingHigh);
    const minTarget = price - (stop - price) * MIN_RR;
    target = Math.min(swingLow, minTarget);
  }
  const risk = Math.abs(price - stop);
  const reward = Math.abs(target - price);
  const rr = risk > 0 ? reward / risk : 0;
  if (rr < MIN_RR) {
    debug.push(`Rejected: RR ${rr.toFixed(2)} < ${MIN_RR}`);
    return { debug };
  }
  setCooldown(pair, now);
  const rsi4h = wilderRsi(candles4h.map(c => c.close));
  const adxVal = adx(candles4h);
  const signal: Signal = {
    id: `${pair}_${now}`,
    pair,
    direction: trend.direction,
    type: "ENTRY",
    scale: "ENTRY",
    entry: Math.round(price * 100) / 100,
    stop: Math.round(stop * 100) / 100,
    target: Math.round(target * 100) / 100,
    rr: Math.round(rr * 100) / 100,
    adx: Math.round(adxVal * 10) / 10,
    rsi: Math.round(rsi4h * 10) / 10,
    stochK: momentum.stochK,
    stochD: momentum.stochD,
    expectedMove: Math.round(((target - price) / price) * 1000) / 10,
    reason: `${trend.direction} | ${location.detail} | ${momentum.detail}`,
    timestamp: now,
    version: CURRENT_SIGNAL_VERSION,
    trend: trend.direction,
    location: location.detail,
    trigger: momentum.detail,
  };
  debug.push(`SIGNAL: ${trend.direction} ${pair} | Entry $${signal.entry} | SL $${signal.stop} | TP $${signal.target} | RR ${signal.rr} | ${momentum.triggerType}`);
  const market: MarketSnapshot = {
    pair,
    price: Math.round(price * 100) / 100,
    timestamp: now,
    trend: trend.direction,
    location: location.ready ? "READY" : "WAIT",
    trigger: momentum.fired ? "FIRED" : "WAITING",
    adx: signal.adx,
    rsi: signal.rsi,
    stochK: signal.stochK,
    stochD: signal.stochD,
    trendlinePrice: Math.round(location.trendlinePrice * 100) / 100,
    distToTrendline: Math.round(Math.abs((price - location.trendlinePrice) / location.trendlinePrice) * 10000) / 100,
    ema8_15m: Math.round(momentum.ema8 * 100) / 100,
    ema21_15m: Math.round(momentum.ema21 * 100) / 100,
  };
  return { signal, market, debug };
}

export function generateAddSignal(
  pair: string,
  candles4h: Candle[],
  candles15m: Candle[],
  existingSignal: Signal,
  currentPrice?: number
): SignalResult {
  const debug: string[] = [];
  const now = Date.now();
  const price = currentPrice ?? candles4h[candles4h.length - 1]?.close ?? 0;
  const candles1d = aggregateTo1D(candles4h);
  const trend = dailyTrend(candles1d);
  if (trend.direction !== existingSignal.direction) {
    debug.push("Add rejected: trend flipped");
    return { debug };
  }
  const location = location4H(pair, candles4h, trend.direction);
  const beyondTL = trend.direction === "LONG"
    ? price > location.trendlinePrice * 1.008
    : price < location.trendlinePrice * 0.992;
  if (!beyondTL) {
    debug.push("Add rejected: not beyond trendline");
    return { debug };
  }
  const last = candles4h[candles4h.length - 1];
  const prev = candles4h[candles4h.length - 2];
  const confirming = trend.direction === "LONG"
    ? last.close > last.open && last.close > prev.close
    : last.close < last.open && last.close < prev.close;
  if (!confirming) {
    debug.push("Add rejected: no confirming candle");
    return { debug };
  }
  const atrVal = atr(candles4h, 14);
  const recent4h = candles4h.slice(-20);
  const swingLow = Math.min(...recent4h.map(c => c.low));
  const swingHigh = Math.max(...recent4h.map(c => c.high));
  let stop: number;
  let target: number;
  if (trend.direction === "LONG") {
    stop = Math.min(location.trendlinePrice * 0.995, price - atrVal * 1.5);
    const minTarget = price + (price - stop) * MIN_RR;
    target = Math.max(swingHigh, minTarget);
  } else {
    stop = Math.max(location.trendlinePrice * 1.005, price + atrVal * 1.5);
    const minTarget = price - (stop - price) * MIN_RR;
    target = Math.min(swingLow, minTarget);
  }
  const risk = Math.abs(price - stop);
  const reward = Math.abs(target - price);
  const rr = risk > 0 ? reward / risk : 0;
  if (rr < MIN_RR) {
    debug.push(`Add rejected: RR ${rr.toFixed(2)} < ${MIN_RR}`);
    return { debug };
  }
  const rsi4h = wilderRsi(candles4h.map(c => c.close));
  const adxVal = adx(candles4h);
  const momentum = momentum15M(candles15m, trend.direction);
  const signal: Signal = {
    id: `${pair}_ADD_${now}`,
    pair,
    direction: trend.direction,
    type: "ADD",
    scale: "ADD",
    entry: Math.round(price * 100) / 100,
    stop: Math.round(stop * 100) / 100,
    target: Math.round(target * 100) / 100,
    rr: Math.round(rr * 100) / 100,
    adx: Math.round(adxVal * 10) / 10,
    rsi: Math.round(rsi4h * 10) / 10,
    stochK: momentum.stochK,
    stochD: momentum.stochD,
    expectedMove: Math.round(((target - price) / price) * 1000) / 10,
    reason: `${trend.direction} ADD | Breakout continuation | ${momentum.detail}`,
    timestamp: now,
    version: CURRENT_SIGNAL_VERSION,
    trend: trend.direction,
    location: location.detail,
    trigger: momentum.detail,
  };
  debug.push(`ADD: ${trend.direction} ${pair} | Entry $${signal.entry} | SL $${signal.stop} | TP $${signal.target} | RR ${signal.rr}`);
  return { signal, debug };
}

export function getMarketSnapshot(
  pair: string,
  candles1h: Candle[],
  candles4h: Candle[],
  candles15m: Candle[]
): MarketSnapshot {
  const candles1d = aggregateTo1D(candles4h);
  const trend = dailyTrend(candles1d);
  const location = trend.direction !== "NONE" ? location4H(pair, candles4h, trend.direction) : { ready: false, detail: "No trend", trendlinePrice: 0 };
  const momentum = trend.direction !== "NONE" ? momentum15M(candles15m, trend.direction) : { fired: false, detail: "No trend", triggerType: "none", stochK: 50, stochD: 50, ema8: 0, ema21: 0 };
  const price = candles4h[candles4h.length - 1]?.close ?? 0;
  return {
    pair,
    price: Math.round(price * 100) / 100,
    timestamp: Date.now(),
    trend: trend.direction,
    location: location.ready ? "READY" : "WAIT",
    trigger: momentum.fired ? "FIRED" : "WAITING",
    adx: Math.round(adx(candles4h) * 10) / 10,
    rsi: Math.round(wilderRsi(candles4h.map(c => c.close)) * 10) / 10,
    stochK: momentum.stochK,
    stochD: momentum.stochD,
    trendlinePrice: Math.round(location.trendlinePrice * 100) / 100,
    distToTrendline: Math.round(Math.abs((price - location.trendlinePrice) / location.trendlinePrice) * 10000) / 100,
    ema8_15m: Math.round(momentum.ema8 * 100) / 100,
    ema21_15m: Math.round(momentum.ema21 * 100) / 100,
  };
}

export function isSignalStillValid(signal: Signal, currentPrice: number, now: number = Date.now()): ValidityCheck {
  const ageMs = now - signal.timestamp;
  const maxAge = signal.type === "ENTRY" ? 24 * 60 * 60 * 1000 : 4 * 60 * 60 * 1000;
  if (ageMs > maxAge) {
    return { valid: false, reason: "expired_ttl", exited: true };
  }
  const entryBuffer = signal.type === "ENTRY" ? 1.02 : 1.005;
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

export function shouldHold(signal: Signal, candles4h: Candle[], currentPrice: number, now?: number): HoldResult {
  const candles1d = aggregateTo1D(candles4h);
  const trend = dailyTrend(candles1d);
  const trendReversed = (signal.direction === "LONG" && trend.direction === "SHORT") ||
                        (signal.direction === "SHORT" && trend.direction === "LONG");
  if (trendReversed) {
    const inProfit = signal.direction === "LONG" ? currentPrice > signal.entry : currentPrice < signal.entry;
    if (!inProfit) {
      return { shouldHold: false, reason: "trend_reversed_unprofitable" };
    }
  }
  const closes4h = candles4h.map(c => c.close);
  const stoch = stochRsi(closes4h);
  const stochExtremeOpposite = signal.direction === "LONG"
    ? stoch.k < STOCH_EXTREME_LONG
    : stoch.k > STOCH_EXTREME_SHORT;
  if (stochExtremeOpposite) {
    return { shouldHold: false, reason: "stoch_extreme_opposite" };
  }
  const validity = isSignalStillValid(signal, currentPrice, now);
  return { shouldHold: validity.valid, reason: validity.reason };
}

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
  const activeSignals: Signal[] = [];
  if (activeTrades) {
    for (const [p, t] of Object.entries(activeTrades)) {
      if (t && t.direction) {
        activeSignals.push({
          id: t.id || `${p}_${t.timestamp}`,
          pair: p,
          direction: t.direction,
          type: "ENTRY",
          scale: "ENTRY",
          entry: t.entry,
          stop: t.stop,
          target: t.target,
          rr: 0,
          adx: 0,
          rsi: 0,
          stochK: 0,
          stochD: 0,
          expectedMove: 0,
          reason: "",
          timestamp: t.timestamp,
          version: CURRENT_SIGNAL_VERSION,
          trend: t.direction,
          location: "",
          trigger: "",
        });
      }
    }
  }
  return generateSignal(pair, candles1h, candles4h, candles15m, activeSignals, currentPrice);
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
