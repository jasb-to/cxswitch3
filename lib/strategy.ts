// lib/strategy.ts — v52.0 "Pure Wave"
// ============================================================
// Philosophy: Every indicator provides information. Nothing blocks.
// Architecture: Daily Context → 4H Context → Stoch Trigger → Signal
//
// v52.0 Changes from v51.0:
// REMOVED: dailyTrend blocking on "NONE"
// REMOVED: location4H ready=false blocking
// REMOVED: ADD trigger 2/3 confirmation gate
// REMOVED: findRecentCross lookback limit (now reports age only)
// REMOVED: "No valid location" rejection
// CHANGED: Trend = context, Location = context, Trigger = signal generator
// CHANGED: ADD fires on any single confirmation
// CHANGED: Every signal carries full context regardless of "quality"

export interface Candle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface SignalContext {
  marketPhase: string;
  structure: string;
  momentum: string;
  pullback: string;
  trendDescription: string;
  triggerDetails: string;
  crossAge: number;
  crossHash: string;
}

export interface Signal {
  id: string;
  pair: string;
  direction: "LONG" | "SHORT";
  type: "ENTRY_1" | "ENTRY_2" | "ADD" | "EXIT";
  scale: "ENTRY_1" | "ENTRY_2" | "ADD" | null;
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
  context: SignalContext;
  exited?: boolean;
  exitReason?: string;
  exitPrice?: number;
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
  distToTrendline: number | null;
  locationType: string;
  ema8_4h: number;
  ema21_4h: number;
  ema50_4h: number;
  marketPhase: string;
  momentumDesc: string;
  pullbackDesc: string;
  structureDesc: string;
  crossAge: number;
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

export const CURRENT_SIGNAL_VERSION = 52.0;

// v52.0: Duplicate prevention only — not a gate
interface CycleEntry {
  crossHash: string;
  timestamp: number;
  pair: string;
  direction: "LONG" | "SHORT";
}

const cycleStore: Map<string, CycleEntry> = new Map();

export interface PairConfig {
  pair: string;
  tlProximity: number;
  beyondTL: number;
  crossLookback: number;
  swingAtrMult: number;
  cacheDevTolerance: number;
  r2Minimum: number;
  preCrossEnabled: boolean;
  preCrossThreshold: number;
}

const DEFAULT_CONFIG: PairConfig = {
  pair: "DEFAULT",
  tlProximity: 0.06,
  beyondTL: 0.008,
  crossLookback: 10,
  swingAtrMult: 3,
  cacheDevTolerance: 0.04,
  r2Minimum: 0.05,
  preCrossEnabled: true,
  preCrossThreshold: 3,
};

const PAIR_CONFIGS: Record<string, PairConfig> = {
  BTC: { ...DEFAULT_CONFIG, pair: "BTC" },
  ETH: { ...DEFAULT_CONFIG, pair: "ETH" },
  SOL: { ...DEFAULT_CONFIG, pair: "SOL" },
  HYPE: {
    pair: "HYPE",
    tlProximity: 0.08,
    beyondTL: 0.0175,
    crossLookback: 12,
    swingAtrMult: 4,
    cacheDevTolerance: 0.06,
    r2Minimum: 0.05,
    preCrossEnabled: true,
    preCrossThreshold: 3,
  },
};

export function getPairConfig(pair: string): PairConfig {
  return PAIR_CONFIGS[pair] || DEFAULT_CONFIG;
}

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

function stochRsiSeries(closes: number[], rsiPeriod = 14, stochPeriod = 14, kSmooth = 3, dSmooth = 3): { k: number; d: number }[] {
  const rsiValues = wilderRsiSeries(closes, rsiPeriod);
  if (rsiValues.length < stochPeriod + kSmooth - 1) return [];
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
  const result: { k: number; d: number }[] = [];
  for (let i = dSmooth - 1; i < kValues.length; i++) {
    result.push({
      k: Math.round(kValues[i] * 10) / 10,
      d: Math.round(avg(kValues.slice(i - dSmooth + 1, i + 1)) * 10) / 10,
    });
  }
  return result;
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

// ============================================================
// TRENDLINE ENGINE — v52.0: Context only, never blocks
// ============================================================

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
  for (let i = 2; i < candles.length - 2; i++) {
    const isSwingLow = candles[i].low < candles[i-1].low && candles[i].low < candles[i+1].low;
    const isSwingHigh = candles[i].high > candles[i-1].high && candles[i].high > candles[i+1].high;
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

function getTrendline(pair: string, candles: Candle[], direction: "LONG" | "SHORT"): { price: number; r2: number; slope: number; regressionDirection: string } | null {
  const config = getPairConfig(pair);
  const price = candles[candles.length - 1].close;
  if (candles.length < 30) return null;
  const pivots = findPivots(candles, direction);
  const now = candles[candles.length - 1].timestamp;
  const currentIndex = candles.length - 1;
  if (pivots.length < 3) return null;
  const recentPivots = pivots.slice(-10);
  const existing = trendlineStore.get(pair);
  if (existing && existing.direction === direction) {
    const age = now - existing.lastUpdated;
    const lastPivot = recentPivots[recentPivots.length - 1];
    const projected = existing.slope * lastPivot.index + existing.intercept;
    const deviation = Math.abs(lastPivot.price - projected) / projected;
    if (deviation > config.cacheDevTolerance) {
      trendlineStore.delete(pair);
    } else {
      const tlPrice = existing.slope * currentIndex + existing.intercept;
      return { price: tlPrice, r2: existing.r2, slope: existing.slope, regressionDirection: existing.slope > 0 ? "rising" : "falling" };
    }
  }
  const fit = fitTrendline(recentPivots);
  if (!fit || fit.r2 < config.r2Minimum) return null;
  trendlineStore.set(pair, { slope: fit.slope, intercept: fit.intercept, lastUpdated: now, direction, r2: Math.round(fit.r2 * 100) / 100 });
  return { price: fit.slope * currentIndex + fit.intercept, r2: Math.round(fit.r2 * 100) / 100, slope: fit.slope, regressionDirection: fit.slope > 0 ? "rising" : "falling" };
}

// ============================================================
// DAILY TREND — v52.0: Context only, never returns NONE
// ============================================================

function dailyTrend(candles1d: Candle[]): { direction: "LONG" | "SHORT" | "FLAT"; detail: string; ema21: number; ema50: number } {
  if (candles1d.length < 20) {
    return { direction: "FLAT", detail: `Insufficient data (${candles1d.length} candles)`, ema21: 0, ema50: 0 };
  }
  const closes = candles1d.map(c => c.close);
  const e21 = ema(closes, 21);
  const e50 = ema(closes, 50);
  const last21 = e21[e21.length - 1];
  const last50 = e50[e50.length - 1];
  const diff = Math.abs(last21 - last50) / last50;
  if (diff < 0.005) return { direction: "FLAT", detail: `EMA21 ${last21.toFixed(1)} ≈ EMA50 ${last50.toFixed(1)} (flat)`, ema21: last21, ema50: last50 };
  if (last21 > last50) return { direction: "LONG", detail: `EMA21 ${last21.toFixed(1)} > EMA50 ${last50.toFixed(1)}`, ema21: last21, ema50: last50 };
  return { direction: "SHORT", detail: `EMA21 ${last21.toFixed(1)} < EMA50 ${last50.toFixed(1)}`, ema21: last21, ema50: last50 };
}

// ============================================================
// 4H LOCATION — v52.0: Always returns context. Never blocks.
// ============================================================

interface LocationResult {
  detail: string;
  trendlinePrice: number;
  locationType: string;
  marketPhase: string;
  structureDesc: string;
  pullbackDesc: string;
  regressionDir: string;
  distToTL: number;
}

function location4H(pair: string, candles4h: Candle[], direction: "LONG" | "SHORT"): LocationResult {
  const config = getPairConfig(pair);
  const price = candles4h[candles4h.length - 1].close;
  const tl = getTrendline(pair, candles4h, direction);
  const atrVal = atr(candles4h, 14);
  const lookback = 30;
  const recent = candles4h.slice(-lookback);
  const closes4h = candles4h.map(c => c.close);
  const ema21_4h = ema(closes4h, 21);
  const lastEma21 = ema21_4h[ema21_4h.length - 1];

  let marketPhase = "unknown";
  let structureDesc = "";
  let pullbackDesc = "";
  let regressionDir = tl?.regressionDirection || "flat";
  let locationType = "NONE";
  let trendlinePrice = tl?.price || 0;
  let distToTL = 0;

  // Always compute EMA distance and ATR retracement for context
  const emaDist = Math.abs(price - lastEma21) / lastEma21;
  const range = Math.max(...recent.map(c => c.high)) - Math.min(...recent.map(c => c.low));
  const atrRetrace = range > 0
    ? (direction === "LONG"
      ? ((Math.max(...recent.map(c => c.high)) - price) / range) * 100
      : ((price - Math.min(...recent.map(c => c.low))) / range) * 100)
    : 0;
  pullbackDesc = `EMA distance ${(emaDist*100).toFixed(2)}%, ATR retracement ${atrRetrace.toFixed(1)}%`;

  if (tl) {
    distToTL = Math.abs(price - tl.price) / tl.price;
    const tlRelationship = direction === "LONG"
      ? (price > tl.price ? "above support" : price < tl.price ? "below support" : "at support")
      : (price < tl.price ? "below resistance" : price > tl.price ? "above resistance" : "at resistance");
    structureDesc = `Trendline ${tlRelationship}, regression ${regressionDir} (R² ${tl.r2.toFixed(2)})`;

    if (distToTL < config.tlProximity) {
      marketPhase = direction === "LONG" ? "pullback_to_support" : "pullback_to_resistance";
      locationType = "TRENDLINE";
    } else {
      const beyondTL = direction === "LONG"
        ? price > tl.price * (1 + config.beyondTL)
        : price < tl.price * (1 - config.beyondTL);
      if (beyondTL) {
        marketPhase = "continuation";
        locationType = "BEYOND_TL";
      } else {
        marketPhase = "approaching_structure";
        locationType = "NEAR_TL";
      }
    }
  } else {
    // No trendline — describe swing structure
    if (direction === "LONG") {
      let swingLow = Infinity;
      for (let i = 1; i < recent.length - 1; i++) {
        const isPivotLow = recent[i].low < recent[i-1].low && recent[i].low < recent[i+1].low;
        if (isPivotLow && recent[i].low < swingLow) swingLow = recent[i].low;
      }
      if (swingLow === Infinity) swingLow = Math.min(...recent.map(c => c.low));
      const dist = price - swingLow;
      const maxDist = atrVal * config.swingAtrMult;
      structureDesc = `Swing low at ${swingLow.toFixed(2)}, price ${dist.toFixed(2)} above (${(dist/maxDist*100).toFixed(0)}% of max ${maxDist.toFixed(2)})`;
      marketPhase = dist <= maxDist ? "pullback_to_structure" : "extended_above_structure";
      locationType = dist <= maxDist ? "SWING_LOW" : "EXTENDED";
      trendlinePrice = swingLow;
    } else {
      let swingHigh = -Infinity;
      for (let i = 1; i < recent.length - 1; i++) {
        const isPivotHigh = recent[i].high > recent[i-1].high && recent[i].high > recent[i+1].high;
        if (isPivotHigh && recent[i].high > swingHigh) swingHigh = recent[i].high;
      }
      if (swingHigh === -Infinity) swingHigh = Math.max(...recent.map(c => c.high));
      const dist = swingHigh - price;
      const maxDist = atrVal * config.swingAtrMult;
      structureDesc = `Swing high at ${swingHigh.toFixed(2)}, price ${dist.toFixed(2)} below (${(dist/maxDist*100).toFixed(0)}% of max ${maxDist.toFixed(2)})`;
      marketPhase = dist <= maxDist ? "pullback_to_structure" : "extended_below_structure";
      locationType = dist <= maxDist ? "SWING_HIGH" : "EXTENDED";
      trendlinePrice = swingHigh;
    }
  }

  return { detail: structureDesc, trendlinePrice, locationType, marketPhase, structureDesc, pullbackDesc, regressionDir, distToTL };
}

// ============================================================
// 4H STOCHRSI TRIGGER — v52.0: Finds cross, reports age, never blocks on age
// ============================================================

interface TriggerResult {
  fired: boolean;
  detail: string;
  triggerType: string;
  stochK: number;
  stochD: number;
  crossAge: number;
  crossHash: string;
  momentumDesc: string;
}

function computeCrossHash(pair: string, direction: "LONG" | "SHORT", crossIndex: number, crossK: number, crossD: number): string {
  return `${pair}_${direction}_${crossIndex}_${Math.round(crossK)}_${Math.round(crossD)}`;
}

function isDuplicateCycle(pair: string, crossHash: string): boolean {
  const existing = cycleStore.get(pair);
  if (!existing) return false;
  return existing.crossHash === crossHash;
}

function recordCycle(pair: string, crossHash: string, direction: "LONG" | "SHORT"): void {
  cycleStore.set(pair, { crossHash, timestamp: Date.now(), pair, direction });
}

// v52.0: findRecentCross scans ALL history, not limited by lookback
// It reports the most recent cross and its age. Never blocks.
function findRecentCross(candles4h: Candle[], direction: "LONG" | "SHORT", pair: string): { crossIndex: number; crossStochK: number; crossStochD: number; currentStochK: number; currentStochD: number; crossHash: string; crossAge: number } | null {
  if (candles4h.length < 35) return null;
  const closes = candles4h.map(c => c.close);
  const currentStoch = stochRsi(closes);
  // Scan from most recent backward to find the LAST cross
  for (let i = 1; i < candles4h.length - 30; i++) {
    const idx = candles4h.length - 1 - i;
    if (idx < 30) break;
    const sliceAtCross = closes.slice(0, idx + 1);
    const sliceBeforeCross = closes.slice(0, idx);
    const stochAt = stochRsi(sliceAtCross);
    const stochBefore = stochRsi(sliceBeforeCross);
    let crossed = false;
    if (direction === "LONG") crossed = stochBefore.k < stochBefore.d && stochAt.k >= stochAt.d;
    else crossed = stochBefore.k > stochBefore.d && stochAt.k <= stochAt.d;
    if (crossed) {
      return {
        crossIndex: idx,
        crossStochK: stochAt.k,
        crossStochD: stochAt.d,
        currentStochK: currentStoch.k,
        currentStochD: currentStoch.d,
        crossHash: computeCrossHash(pair, direction, idx, stochAt.k, stochAt.d),
        crossAge: i,
      };
    }
  }
  return null;
}

function analyzeMomentum(candles4h: Candle[], direction: "LONG" | "SHORT"): string {
  const closes = candles4h.map(c => c.close);
  const series = stochRsiSeries(closes);
  if (series.length < 3) return "insufficient data";
  const current = series[series.length - 1];
  const prev = series[series.length - 2];
  const prev2 = series[series.length - 3];
  const kRising = current.k > prev.k;
  const kFalling = current.k < prev.k;
  const kAboveD = current.k > current.d;
  const kBelowD = current.k < current.d;
  const accelerating = Math.abs(current.k - prev.k) > Math.abs(prev.k - prev2.k);
  const decelerating = Math.abs(current.k - prev.k) < Math.abs(prev.k - prev2.k);
  const parts: string[] = [];
  if (direction === "LONG") {
    if (kAboveD) parts.push("K above D");
    else parts.push("K below D");
    if (kRising) parts.push("rising");
    else if (kFalling) parts.push("falling");
  } else {
    if (kBelowD) parts.push("K below D");
    else parts.push("K above D");
    if (kFalling) parts.push("falling");
    else if (kRising) parts.push("rising");
  }
  if (accelerating) parts.push("accelerating");
  else if (decelerating) parts.push("weakening");
  return parts.join(", ");
}

function stochTrigger4H(candles4h: Candle[], direction: "LONG" | "SHORT", pair: string): TriggerResult {
  const config = getPairConfig(pair);
  const defaultFail = { fired: false, detail: "Insufficient 4H data", triggerType: "none", stochK: 50, stochD: 50, crossAge: 0, crossHash: "", momentumDesc: "" };
  if (candles4h.length < 35) return defaultFail;
  const closes = candles4h.map(c => c.close);
  const stoch = stochRsi(closes);
  const momentumDesc = analyzeMomentum(candles4h, direction);
  let fired = false;
  let detail = "";
  let triggerType = "none";
  let crossAge = 0;
  let crossHash = "";
  const recentCross = findRecentCross(candles4h, direction, pair);

  if (direction === "LONG") {
    if (recentCross) {
      crossAge = recentCross.crossAge;
      crossHash = recentCross.crossHash;
      if (isDuplicateCycle(pair, crossHash)) {
        return { fired: false, detail: `Cross ${crossAge} candles ago already signaled`, triggerType: "duplicate_cycle", stochK: recentCross.currentStochK, stochD: recentCross.currentStochD, crossAge, crossHash, momentumDesc };
      }
      // v52.0: Cross age is INFORMATION, not a gate. Signal fires regardless of age.
      const crossWasDeep = recentCross.crossStochK < 50;
      const kAboveD = recentCross.currentStochK >= recentCross.currentStochD;
      if (crossWasDeep && kAboveD) {
        fired = true;
        triggerType = "entry_1_deep_pullback";
        detail = `ENTRY_1: K crossed above D ${crossAge} candles ago below 50 (cross K=${recentCross.crossStochK}, now K=${recentCross.currentStochK}, D=${recentCross.currentStochD})`;
      } else if (kAboveD) {
        fired = true;
        triggerType = "entry_2_early_momentum";
        detail = `ENTRY_2: K crossed above D ${crossAge} candles ago (cross K=${recentCross.crossStochK}, now K=${recentCross.currentStochK}, D=${recentCross.currentStochD})`;
      } else {
        detail = `Cross ${crossAge} candles ago faded: K=${recentCross.currentStochK} < D=${recentCross.currentStochD}`;
      }
    } else if (config.preCrossEnabled) {
      const prevCloses = closes.slice(0, -1);
      const prevStoch = stochRsi(prevCloses);
      const converging = stoch.k < stoch.d && stoch.k > prevStoch.k;
      const closeEnough = Math.abs(stoch.k - stoch.d) <= config.preCrossThreshold;
      if (converging && closeEnough) {
        fired = true;
        triggerType = "entry_2_pre_cross";
        detail = `ENTRY_2 (pre-cross): K=${stoch.k} converging toward D=${stoch.d} (within ${config.preCrossThreshold} pts, rising)`;
      } else {
        detail = `No cross. Stoch K=${stoch.k} D=${stoch.d}`;
      }
    } else {
      detail = `No recent cross. Stoch K=${stoch.k} D=${stoch.d}`;
    }
  } else {
    if (recentCross) {
      crossAge = recentCross.crossAge;
      crossHash = recentCross.crossHash;
      if (isDuplicateCycle(pair, crossHash)) {
        return { fired: false, detail: `Cross ${crossAge} candles ago already signaled`, triggerType: "duplicate_cycle", stochK: recentCross.currentStochK, stochD: recentCross.currentStochD, crossAge, crossHash, momentumDesc };
      }
      const crossWasDeep = recentCross.crossStochK > 50;
      const kBelowD = recentCross.currentStochK <= recentCross.currentStochD;
      if (crossWasDeep && kBelowD) {
        fired = true;
        triggerType = "entry_1_deep_pullback";
        detail = `ENTRY_1: K crossed below D ${crossAge} candles ago above 50 (cross K=${recentCross.crossStochK}, now K=${recentCross.currentStochK}, D=${recentCross.currentStochD})`;
      } else if (kBelowD) {
        fired = true;
        triggerType = "entry_2_early_momentum";
        detail = `ENTRY_2: K crossed below D ${crossAge} candles ago (cross K=${recentCross.crossStochK}, now K=${recentCross.currentStochK}, D=${recentCross.currentStochD})`;
      } else {
        detail = `Cross ${crossAge} candles ago faded: K=${recentCross.currentStochK} > D=${recentCross.currentStochD}`;
      }
    } else if (config.preCrossEnabled) {
      const prevCloses = closes.slice(0, -1);
      const prevStoch = stochRsi(prevCloses);
      const converging = stoch.k > stoch.d && stoch.k < prevStoch.k;
      const closeEnough = Math.abs(stoch.k - stoch.d) <= config.preCrossThreshold;
      if (converging && closeEnough) {
        fired = true;
        triggerType = "entry_2_pre_cross";
        detail = `ENTRY_2 (pre-cross): K=${stoch.k} converging toward D=${stoch.d} (within ${config.preCrossThreshold} pts, falling)`;
      } else {
        detail = `No cross. Stoch K=${stoch.k} D=${stoch.d}`;
      }
    } else {
      detail = `No recent cross. Stoch K=${stoch.k} D=${stoch.d}`;
    }
  }
  return { fired, detail, triggerType, stochK: stoch.k, stochD: stoch.d, crossAge, crossHash, momentumDesc };
}

// ============================================================
// ADD TRIGGER — v52.0: Any single confirmation fires ADD
// ============================================================

interface AddTriggerResult {
  fired: boolean;
  detail: string;
  confirmations: string[];
  stochK: number;
  stochD: number;
}

function addTrigger4H(candles4h: Candle[], direction: "LONG" | "SHORT", location: LocationResult, pair: string): AddTriggerResult {
  const defaultFail = { fired: false, detail: "No ADD conditions met", confirmations: [] as string[], stochK: 50, stochD: 50 };
  if (candles4h.length < 30) return defaultFail;
  const price = candles4h[candles4h.length - 1].close;
  const prev = candles4h[candles4h.length - 2];
  const last = candles4h[candles4h.length - 1];
  const closes = candles4h.map(c => c.close);
  const stoch = stochRsi(closes);
  const confirmations: string[] = [];

  if (location.locationType === "BEYOND_TL") confirmations.push("beyond_tl");
  if (direction === "LONG" && last.close > last.open && last.close > prev.close) confirmations.push("confirming_candle");
  else if (direction === "SHORT" && last.close < last.open && last.close < prev.close) confirmations.push("confirming_candle");
  if (direction === "LONG" && stoch.k > stoch.d) confirmations.push("stoch_momentum");
  else if (direction === "SHORT" && stoch.k < stoch.d) confirmations.push("stoch_momentum");

  // v52.0: Any single confirmation fires ADD. No gate.
  const fired = confirmations.length >= 1;
  const detail = fired
    ? `ADD fired: ${confirmations.join(", ")}`
    : `ADD waiting: no confirmations (${location.locationType}, stoch K=${stoch.k} D=${stoch.d})`;

  return { fired, detail, confirmations, stochK: stoch.k, stochD: stoch.d };
}

// ============================================================
// ACTIVE TRADE MANAGEMENT — v52.0
// ============================================================

interface ActiveSignalState {
  pair: string;
  scale: "ENTRY_1" | "ENTRY_2" | "ADD";
  timestamp: number;
  entryPrice: number;
  crossHash: string;
}

const activeSignalStore: Map<string, ActiveSignalState> = new Map();

function hasActiveSignal(pair: string): boolean {
  const state = activeSignalStore.get(pair);
  if (!state) return false;
  const age = Date.now() - state.timestamp;
  if ((state.scale === "ENTRY_1" || state.scale === "ENTRY_2") && age < 24 * 60 * 60 * 1000) return true;
  if (state.scale === "ADD" && age < 4 * 60 * 60 * 1000) return true;
  activeSignalStore.delete(pair);
  return false;
}

function hasActiveAdd(pair: string): boolean {
  const state = activeSignalStore.get(pair);
  return state?.scale === "ADD" && (Date.now() - state.timestamp) < 4 * 60 * 60 * 1000;
}

function setActiveSignal(pair: string, scale: "ENTRY_1" | "ENTRY_2" | "ADD", entryPrice: number, crossHash: string): void {
  activeSignalStore.set(pair, { pair, scale, timestamp: Date.now(), entryPrice, crossHash });
}

function canAddToPair(pair: string): boolean {
  const state = activeSignalStore.get(pair);
  if (!state) return false;
  if (state.scale === "ADD") return false;
  const age = Date.now() - state.timestamp;
  if (age < 60 * 60 * 1000) return false;
  if (age > 24 * 60 * 60 * 1000) { activeSignalStore.delete(pair); return false; }
  return true;
}

// ============================================================
// MAIN SIGNAL GENERATOR — v52.0: No gates. Context + trigger only.
// ============================================================

export function generateSignal(pair: string, candles1h: Candle[], candles4h: Candle[], candles15m: Candle[], activeSignals: Signal[], currentPrice?: number): SignalResult {
  const debug: string[] = [];
  const now = Date.now();
  const price = currentPrice ?? candles4h[candles4h.length - 1]?.close ?? 0;
  const hasActive = activeSignals.some(s => s.pair === pair && !s.exited) || hasActiveSignal(pair);

  // Step 1: Daily Trend — CONTEXT ONLY, never blocks
  const candles1d = aggregateTo1D(candles4h);
  const trend = dailyTrend(candles1d);
  debug.push(`Trend: ${trend.direction} | ${trend.detail}`);
  // v52.0: Trend is context. We proceed regardless of direction.
  // If FLAT, we still look for triggers but note it in context.

  // Step 2: 4H Location — CONTEXT ONLY, never blocks
  const location = location4H(pair, candles4h, trend.direction === "FLAT" ? "LONG" : trend.direction);
  debug.push(`Location: ${location.locationType} | ${location.detail} | Phase: ${location.marketPhase}`);
  // v52.0: Location describes where price is. Never blocks entry.

  // Step 3: Determine signal type
  let signalType: "ENTRY_1" | "ENTRY_2" | "ADD" | null = null;
  let trigger: TriggerResult | AddTriggerResult | null = null;

  // ENTRY: fires if stoch trigger fires. Location type does NOT block.
  // v52.0: ENTRY can fire from ANY location type — trendline, beyond TL, extended, etc.
  if (!hasActive) {
    const entryTrigger = stochTrigger4H(candles4h, trend.direction === "FLAT" ? "LONG" : trend.direction, pair);
    debug.push(`Trigger: ${entryTrigger.fired ? "FIRED" : "WAITING"} | ${entryTrigger.detail} | Momentum: ${entryTrigger.momentumDesc}`);
    if (entryTrigger.fired) {
      if (entryTrigger.triggerType === "entry_1_deep_pullback") signalType = "ENTRY_1";
      else if (entryTrigger.triggerType === "entry_2_early_momentum" || entryTrigger.triggerType === "entry_2_pre_cross") signalType = "ENTRY_2";
      trigger = entryTrigger;
    }
  }

  // ADD: fires on any single confirmation. Location does NOT need to be BEYOND_TL.
  if (!signalType && canAddToPair(pair) && !hasActiveAdd(pair)) {
    const addTrigger = addTrigger4H(candles4h, trend.direction === "FLAT" ? "LONG" : trend.direction, location, pair);
    debug.push(`ADD: ${addTrigger.fired ? "FIRED" : "WAITING"} | ${addTrigger.detail}`);
    if (addTrigger.fired) { signalType = "ADD"; trigger = addTrigger; }
  }

  if (!signalType) {
    if (hasActive) debug.push("No signal: active trade exists");
    else debug.push("No stochastic trigger detected");
    return { debug };
  }

  // Step 4: Calculate levels
  const atrVal = atr(candles4h, 14);
  const recent4h = candles4h.slice(-20);
  const swingLow = Math.min(...recent4h.map(c => c.low));
  const swingHigh = Math.max(...recent4h.map(c => c.high));
  let stop: number;
  let target: number;

  if (signalType === "ENTRY_1" || signalType === "ENTRY_2") {
    if (trend.direction === "LONG" || trend.direction === "FLAT") {
      const atrStop = price - atrVal * 2;
      stop = Math.max(atrStop, swingLow);
      target = price + (price - stop) * 1.5;
      target = Math.max(swingHigh, target);
    } else {
      const atrStop = price + atrVal * 2;
      stop = Math.min(atrStop, swingHigh);
      target = price - (stop - price) * 1.5;
      target = Math.min(swingLow, target);
    }
  } else {
    if (trend.direction === "LONG" || trend.direction === "FLAT") {
      const atrStop = price - atrVal * 1.5;
      const tlStop = location.trendlinePrice > 0 ? location.trendlinePrice * 0.995 : atrStop;
      stop = Math.max(atrStop, tlStop, swingLow);
      target = price + (price - stop) * 1.5;
      target = Math.max(swingHigh, target);
    } else {
      const atrStop = price + atrVal * 1.5;
      const tlStop = location.trendlinePrice > 0 ? location.trendlinePrice * 1.005 : atrStop;
      stop = Math.min(atrStop, tlStop, swingHigh);
      target = price - (stop - price) * 1.5;
      target = Math.min(swingLow, target);
    }
  }

  const risk = Math.abs(price - stop);
  const reward = Math.abs(target - price);
  const rr = risk > 0 ? reward / risk : 0;

  // Step 5: Build context
  const triggerResult = trigger as TriggerResult;
  const context: SignalContext = {
    marketPhase: location.marketPhase,
    structure: location.structureDesc,
    momentum: triggerResult.momentumDesc || "neutral",
    pullback: location.pullbackDesc,
    trendDescription: trend.detail,
    triggerDetails: triggerResult.detail,
    crossAge: triggerResult.crossAge || 0,
    crossHash: triggerResult.crossHash || "",
  };

  // Step 6: Record cycle
  if (triggerResult.crossHash) recordCycle(pair, triggerResult.crossHash, trend.direction === "FLAT" ? "LONG" : trend.direction);
  setActiveSignal(pair, signalType, price, triggerResult.crossHash || "");

  const rsi4h = wilderRsi(candles4h.map(c => c.close));
  const adxVal = adx(candles4h);

  const signal: Signal = {
    id: `${pair}_${signalType}_${now}`,
    pair,
    direction: trend.direction === "FLAT" ? "LONG" : trend.direction,
    type: signalType,
    scale: signalType,
    entry: Math.round(price * 100) / 100,
    stop: Math.round(stop * 100) / 100,
    target: Math.round(target * 100) / 100,
    rr: Math.round(rr * 100) / 100,
    adx: Math.round(adxVal * 10) / 10,
    rsi: Math.round(rsi4h * 10) / 10,
    stochK: triggerResult.stochK,
    stochD: triggerResult.stochD,
    expectedMove: Math.round(((target - price) / price) * 1000) / 10,
    reason: `${signalType} | ${trend.direction} | ${location.marketPhase} | ${triggerResult.detail}`,
    timestamp: now,
    version: CURRENT_SIGNAL_VERSION,
    trend: trend.direction,
    location: location.detail,
    trigger: triggerResult.detail,
    context,
  };

  debug.push(`SIGNAL: ${signalType} ${signal.direction} ${pair} | Entry $${signal.entry} | SL $${signal.stop} | TP $${signal.target} | RR ${signal.rr}`);

  // Step 7: Market snapshot
  const closes4h = candles4h.map(c => c.close);
  const ema8_4h = ema(closes4h, 8);
  const ema21_4h = ema(closes4h, 21);
  const ema50_4h = ema(closes4h, 50);
  const distToTrendline = location.trendlinePrice > 0 ? Math.round(Math.abs((price - location.trendlinePrice) / location.trendlinePrice) * 10000) / 100 : null;

  const market: MarketSnapshot = {
    pair,
    price: Math.round(price * 100) / 100,
    timestamp: now,
    trend: trend.direction,
    location: location.locationType,
    trigger: triggerResult.fired ? "FIRED" : "WAITING",
    adx: signal.adx,
    rsi: signal.rsi,
    stochK: signal.stochK,
    stochD: signal.stochD,
    trendlinePrice: Math.round(location.trendlinePrice * 100) / 100,
    distToTrendline,
    locationType: location.locationType,
    ema8_4h: Math.round(ema8_4h[ema8_4h.length - 1] * 100) / 100,
    ema21_4h: Math.round(ema21_4h[ema21_4h.length - 1] * 100) / 100,
    ema50_4h: Math.round(ema50_4h[ema50_4h.length - 1] * 100) / 100,
    marketPhase: location.marketPhase,
    momentumDesc: triggerResult.momentumDesc || "neutral",
    pullbackDesc: location.pullbackDesc,
    structureDesc: location.structureDesc,
    crossAge: triggerResult.crossAge || 0,
  };

  return { signal, market, debug };
}

// ============================================================
// MARKET SNAPSHOT
// ============================================================

export function getMarketSnapshot(pair: string, candles1h: Candle[], candles4h: Candle[], candles15m: Candle[]): MarketSnapshot {
  const candles1d = aggregateTo1D(candles4h);
  const trend = dailyTrend(candles1d);
  const direction = trend.direction === "FLAT" ? "LONG" : trend.direction;
  const location = location4H(pair, candles4h, direction);
  const trigger = stochTrigger4H(candles4h, direction, pair);
  const price = candles4h[candles4h.length - 1]?.close ?? 0;
  const closes4h = candles4h.map(c => c.close);
  const ema8_4h = ema(closes4h, 8);
  const ema21_4h = ema(closes4h, 21);
  const ema50_4h = ema(closes4h, 50);
  const distToTrendline = location.trendlinePrice > 0 ? Math.round(Math.abs((price - location.trendlinePrice) / location.trendlinePrice) * 10000) / 100 : null;

  return {
    pair,
    price: Math.round(price * 100) / 100,
    timestamp: Date.now(),
    trend: trend.direction,
    location: location.locationType,
    trigger: trigger.fired ? "FIRED" : "WAITING",
    adx: Math.round(adx(candles4h) * 10) / 10,
    rsi: Math.round(wilderRsi(candles4h.map(c => c.close)) * 10) / 10,
    stochK: trigger.stochK,
    stochD: trigger.stochD,
    trendlinePrice: Math.round(location.trendlinePrice * 100) / 100,
    distToTrendline,
    locationType: location.locationType,
    ema8_4h: Math.round(ema8_4h[ema8_4h.length - 1] * 100) / 100,
    ema21_4h: Math.round(ema21_4h[ema21_4h.length - 1] * 100) / 100,
    ema50_4h: Math.round(ema50_4h[ema50_4h.length - 1] * 100) / 100,
    marketPhase: location.marketPhase,
    momentumDesc: trigger.momentumDesc || "neutral",
    pullbackDesc: location.pullbackDesc,
    structureDesc: location.structureDesc,
    crossAge: trigger.crossAge || 0,
  };
}

// ============================================================
// VALIDITY & HOLD MANAGEMENT
// ============================================================

export function isSignalStillValid(signal: Signal, currentPrice: number, now: number = Date.now()): ValidityCheck {
  const ageMs = now - signal.timestamp;
  const maxAge = signal.type === "ENTRY_1" || signal.type === "ENTRY_2" ? 24 * 60 * 60 * 1000 : 4 * 60 * 60 * 1000;
  if (ageMs > maxAge) return { valid: false, reason: "expired_ttl", exited: true };
  const entryBuffer = signal.type === "ENTRY_1" || signal.type === "ENTRY_2" ? 1.02 : 1.005;
  if (signal.direction === "LONG" && currentPrice > signal.entry * entryBuffer) return { valid: false, reason: "missed_entry", exited: true };
  if (signal.direction === "SHORT" && currentPrice < signal.entry * (2 - entryBuffer)) return { valid: false, reason: "missed_entry", exited: true };
  if (signal.direction === "LONG" && currentPrice <= signal.stop) return { valid: false, reason: "sl_hit", exited: true };
  if (signal.direction === "SHORT" && currentPrice >= signal.stop) return { valid: false, reason: "sl_hit", exited: true };
  if (signal.direction === "LONG" && currentPrice >= signal.target) return { valid: false, reason: "tp_hit", exited: true };
  if (signal.direction === "SHORT" && currentPrice <= signal.target) return { valid: false, reason: "tp_hit", exited: true };
  return { valid: true, reason: "active", exited: false };
}

export function shouldHold(signal: Signal, candles4h: Candle[], currentPrice: number, now?: number): HoldResult {
  const candles1d = aggregateTo1D(candles4h);
  const trend = dailyTrend(candles1d);
  const trendReversed = (signal.direction === "LONG" && trend.direction === "SHORT") || (signal.direction === "SHORT" && trend.direction === "LONG");
  if (trendReversed) {
    const inProfit = signal.direction === "LONG" ? currentPrice > signal.entry : currentPrice < signal.entry;
    if (!inProfit) return { shouldHold: false, reason: "trend_reversed_unprofitable" };
  }
  const validity = isSignalStillValid(signal, currentPrice, now);
  return { shouldHold: validity.valid, reason: validity.reason };
}

export function filterExpiredSignals(signals: Signal[], currentPrices: Record<string, number>, now?: number): { active: Signal[]; exited: { signal: Signal; reason: string }[] } {
  const active: Signal[] = [];
  const exited: { signal: Signal; reason: string }[] = [];
  for (const signal of signals) {
    const price = currentPrices[signal.pair];
    if (price === undefined) { active.push(signal); continue; }
    const check = isSignalStillValid(signal, price, now);
    if (check.valid) { active.push(signal); }
    else {
      if (check.reason === "tp_hit" || check.reason === "sl_hit") {
        signal.exited = true; signal.exitReason = check.reason; signal.exitPrice = price;
        active.push(signal);
      }
      exited.push({ signal, reason: check.reason });
    }
  }
  return { active, exited };
}

export type TradeStatus = "ACTIVE" | "TP_HIT" | "SL_HIT" | "EXPIRED";

export function checkTradeStatus(signal: Signal, currentPrice: number, now: number = Date.now()): TradeStatus {
  if (signal.exited) return signal.exitReason === "tp_hit" ? "TP_HIT" : signal.exitReason === "sl_hit" ? "SL_HIT" : "EXPIRED";
  const validity = isSignalStillValid(signal, currentPrice, now);
  if (!validity.valid && validity.reason === "expired_ttl") return "EXPIRED";
  if (signal.direction === "LONG") { if (currentPrice >= signal.target) return "TP_HIT"; if (currentPrice <= signal.stop) return "SL_HIT"; }
  else { if (currentPrice <= signal.target) return "TP_HIT"; if (currentPrice >= signal.stop) return "SL_HIT"; }
  return "ACTIVE";
}

// ============================================================
// STATE RECONSTRUCTION
// ============================================================

export interface PersistedTrade {
  direction: "LONG" | "SHORT";
  timestamp: number;
  entry: number;
  stop: number;
  target: number;
  id: string;
  type: "ENTRY_1" | "ENTRY_2" | "ADD";
  crossHash?: string;
}

export function rebuildStateFromTrades(activeTrades: Record<string, PersistedTrade>): void {
  for (const [pair, trade] of Object.entries(activeTrades)) {
    if (!trade || !trade.direction) continue;
    activeSignalStore.set(pair, { pair, scale: trade.type, timestamp: trade.timestamp, entryPrice: trade.entry, crossHash: trade.crossHash || "" });
    console.log(`[STATE_REBUILD] ${pair}: ${trade.type} ${trade.direction} @ ${trade.entry}`);
  }
}

export function clearAllState(): void {
  trendlineStore.clear();
  activeSignalStore.clear();
  cycleStore.clear();
  console.log("[STATE] All in-memory state cleared");
}

// ============================================================
// COMPATIBILITY LAYER
// ============================================================

export async function getMonitorState(pair: string): Promise<any | undefined> { return undefined; }
export async function clearMonitorState(pair: string): Promise<void> { return; }
export async function setMonitorState(pair: string, state: any): Promise<void> { return; }
export function setRedisClient(_: any): void { return; }

export async function generateSignalCompat(pair: string, candles1h: Candle[], candles4h: Candle[], candles15m: Candle[], activeTrades?: Record<string, any>, currentPrice?: number): Promise<SignalResult> {
  const activeSignals: Signal[] = [];
  if (activeTrades) {
    for (const [p, t] of Object.entries(activeTrades)) {
      if (t && t.direction) {
        activeSignals.push({
          id: t.id || `${p}_${t.timestamp}`, pair: p, direction: t.direction, type: "ENTRY_1", scale: "ENTRY_1",
          entry: t.entry, stop: t.stop, target: t.target, rr: 0, adx: 0, rsi: 0, stochK: 0, stochD: 0,
          expectedMove: 0, reason: "", timestamp: t.timestamp, version: CURRENT_SIGNAL_VERSION,
          trend: t.direction, location: "", trigger: "",
          context: { marketPhase: "", structure: "", momentum: "", pullback: "", trendDescription: "", triggerDetails: "", crossAge: 0, crossHash: "" },
        });
      }
    }
  }
  return generateSignal(pair, candles1h, candles4h, candles15m, activeSignals, currentPrice);
}

export function isSignalStillValidBool(signal: Signal, currentPrice: number): boolean {
  return isSignalStillValid(signal, currentPrice).valid;
}

export function shouldHoldCompat(signal: Signal, candles4h: Candle[], candles1h: Candle[], currentPrice: number): HoldResult {
  return shouldHold(signal, candles4h, currentPrice);
}
