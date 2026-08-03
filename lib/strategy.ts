// lib/strategy.ts — v53.2 "Adaptive R²"
// ============================================================
// CHANGES:
// - Fixed R² threshold replaced with adaptive threshold based on ADX
// - ADX < 18  → blocked by ADX filter (no R² check reached)
// - ADX 18–25 → min R² = 0.75
// - ADX 25–30 → min R² = 0.65
// - ADX 30–35 → min R² = 0.60
// - ADX > 35  → min R² = 0.55
// - Telemetry added for trend quality pass/fail
// - Hard counter-trend block
// - ADX > 18 AND rising required
// - ADD logic removed from entry path
// - Stoch zones tightened: ENTRY_1 <20/>80, ENTRY_2 <50/>50
// - crossLookback respected (no infinite scan)
// - v28 stoch extreme exit ported to shouldHold
//
// Architecture: Context → Trigger → Signal → Directional State → Execute

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
  signals: Signal[];
  market?: MarketSnapshot;
  longContext: DirectionalContext;
  shortContext: DirectionalContext;
  debug: string[];
}

export interface DirectionalContext {
  direction: "LONG" | "SHORT";
  trend: string;
  location: LocationResult;
  trigger: TriggerResult | null;
  addTrigger: AddTriggerResult | null;
  signal?: Signal;
  canEnter: boolean;
  reason: string;
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

export const CURRENT_SIGNAL_VERSION = 53;

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
    preCrossEnabled: true,
    preCrossThreshold: 3,
  },
};

export function getPairConfig(pair: string): PairConfig {
  return PAIR_CONFIGS[pair] || DEFAULT_CONFIG;
}

// ============================================================
// ADAPTIVE R² THRESHOLD
// ============================================================

function getMinimumR2(adxVal: number): number {
  if (adxVal < 18) return 1.0;   // unreachable — ADX filter blocks first
  if (adxVal < 25) return 0.75;
  if (adxVal < 30) return 0.65;
  if (adxVal < 35) return 0.60;
  return 0.55;
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
// TRENDLINE ENGINE
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

function getTrendline(pair: string, candles: Candle[], direction: "LONG" | "SHORT", minR2?: number): { price: number; r2: number; slope: number; regressionDirection: string } | null {
  const config = getPairConfig(pair);
  if (candles.length < 30) return null;
  const pivots = findPivots(candles, direction);
  const now = candles[candles.length - 1].timestamp;
  const currentIndex = candles.length - 1;
  if (pivots.length < 3) return null;
  const recentPivots = pivots.slice(-10);
  const existing = trendlineStore.get(pair);
  if (existing && existing.direction === direction) {
    const lastPivot = recentPivots[recentPivots.length - 1];
    const projected = existing.slope * lastPivot.index + existing.intercept;
    const deviation = Math.abs(lastPivot.price - projected) / projected;
    if (deviation > config.cacheDevTolerance) {
      trendlineStore.delete(pair);
    } else {
      if (minR2 !== undefined && existing.r2 < minR2) return null;
      const tlPrice = existing.slope * currentIndex + existing.intercept;
      return { price: tlPrice, r2: existing.r2, slope: existing.slope, regressionDirection: existing.slope > 0 ? "rising" : "falling" };
    }
  }
  const fit = fitTrendline(recentPivots);
  if (!fit) return null;
  if (minR2 !== undefined && fit.r2 < minR2) return null;
  trendlineStore.set(pair, { slope: fit.slope, intercept: fit.intercept, lastUpdated: now, direction, r2: Math.round(fit.r2 * 100) / 100 });
  return { price: fit.slope * currentIndex + fit.intercept, r2: Math.round(fit.r2 * 100) / 100, slope: fit.slope, regressionDirection: fit.slope > 0 ? "rising" : "falling" };
}

// ============================================================
// DAILY TREND
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
// 4H LOCATION
// ============================================================

export interface LocationResult {
  detail: string;
  trendlinePrice: number;
  locationType: string;
  marketPhase: string;
  structureDesc: string;
  pullbackDesc: string;
  regressionDir: string;
  distToTL: number;
}

function location4H(pair: string, candles4h: Candle[], direction: "LONG" | "SHORT", minR2?: number): LocationResult {
  const config = getPairConfig(pair);
  const price = candles4h[candles4h.length - 1].close;
  const tl = getTrendline(pair, candles4h, direction, minR2);
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
// 4H STOCHRSI TRIGGER
// ============================================================

export interface TriggerResult {
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

function isDuplicateCycle(pair: string, direction: "LONG" | "SHORT", crossHash: string): boolean {
  const existing = cycleStore.get(`${pair}_${direction}`);
  if (!existing) return false;
  return existing.crossHash === crossHash;
}

function recordCycle(pair: string, crossHash: string, direction: "LONG" | "SHORT"): void {
  cycleStore.set(`${pair}_${direction}`, { crossHash, timestamp: Date.now(), pair, direction });
}

function findRecentCross(candles4h: Candle[], direction: "LONG" | "SHORT", pair: string): { crossIndex: number; crossStochK: number; crossStochD: number; currentStochK: number; currentStochD: number; crossHash: string; crossAge: number } | null {
  if (candles4h.length < 35) return null;
  const config = getPairConfig(pair);
  const closes = candles4h.map(c => c.close);
  const currentStoch = stochRsi(closes);
  const maxLookback = Math.min(config.crossLookback, candles4h.length - 35);

  for (let i = 1; i <= maxLookback; i++) {
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
      if (isDuplicateCycle(pair, direction, crossHash)) {
        return { fired: false, detail: `Cross ${crossAge} candles ago already signaled`, triggerType: "duplicate_cycle", stochK: recentCross.currentStochK, stochD: recentCross.currentStochD, crossAge, crossHash, momentumDesc };
      }
      const kAboveD = recentCross.currentStochK >= recentCross.currentStochD;
      const crossWasExtreme = recentCross.crossStochK < 20;
      const crossWasPullback = recentCross.crossStochK < 50;

      if (crossWasExtreme && kAboveD) {
        fired = true;
        triggerType = "entry_1_deep_pullback";
        detail = `ENTRY_1: K crossed above D ${crossAge} candles ago below 20 (cross K=${recentCross.crossStochK}, now K=${recentCross.currentStochK}, D=${recentCross.currentStochD})`;
      } else if (crossWasPullback && kAboveD) {
        fired = true;
        triggerType = "entry_2_early_momentum";
        detail = `ENTRY_2: K crossed above D ${crossAge} candles ago below 50 (cross K=${recentCross.crossStochK}, now K=${recentCross.currentStochK}, D=${recentCross.currentStochD})`;
      } else {
        detail = `Cross ${crossAge} candles ago at K=${recentCross.crossStochK} not in pullback zone (needs <50 for longs)`;
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
      if (isDuplicateCycle(pair, direction, crossHash)) {
        return { fired: false, detail: `Cross ${crossAge} candles ago already signaled`, triggerType: "duplicate_cycle", stochK: recentCross.currentStochK, stochD: recentCross.currentStochD, crossAge, crossHash, momentumDesc };
      }
      const kBelowD = recentCross.currentStochK <= recentCross.currentStochD;
      const crossWasExtreme = recentCross.crossStochK > 80;
      const crossWasPullback = recentCross.crossStochK > 50;

      if (crossWasExtreme && kBelowD) {
        fired = true;
        triggerType = "entry_1_deep_pullback";
        detail = `ENTRY_1: K crossed below D ${crossAge} candles ago above 80 (cross K=${recentCross.crossStochK}, now K=${recentCross.currentStochK}, D=${recentCross.currentStochD})`;
      } else if (crossWasPullback && kBelowD) {
        fired = true;
        triggerType = "entry_2_early_momentum";
        detail = `ENTRY_2: K crossed below D ${crossAge} candles ago above 50 (cross K=${recentCross.crossStochK}, now K=${recentCross.currentStochK}, D=${recentCross.currentStochD})`;
      } else {
        detail = `Cross ${crossAge} candles ago at K=${recentCross.crossStochK} not in pullback zone (needs >50 for shorts)`;
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
// ADD TRIGGER (RETAINED FOR COMPATIBILITY — NOT USED IN ENTRY PATH)
// ============================================================

export interface AddTriggerResult {
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

  const fired = confirmations.length >= 1;
  const detail = fired
    ? `ADD fired: ${confirmations.join(", ")}`
    : `ADD waiting: no confirmations (${location.locationType}, stoch K=${stoch.k} D=${stoch.d})`;

  return { fired, detail, confirmations, stochK: stoch.k, stochD: stoch.d };
}

// ============================================================
// ACTIVE TRADE MANAGEMENT
// ============================================================

interface ActiveSignalState {
  pair: string;
  direction: "LONG" | "SHORT";
  scale: "ENTRY_1" | "ENTRY_2" | "ADD";
  timestamp: number;
  entryPrice: number;
  crossHash: string;
}

const activeSignalStore: Map<string, ActiveSignalState> = new Map();

function hasActiveSignal(pair: string, direction?: "LONG" | "SHORT"): boolean {
  if (direction) {
    const state = activeSignalStore.get(`${pair}_${direction}`);
    if (!state) return false;
    const age = Date.now() - state.timestamp;
    if ((state.scale === "ENTRY_1" || state.scale === "ENTRY_2") && age < 24 * 60 * 60 * 1000) return true;
    if (state.scale === "ADD" && age < 4 * 60 * 60 * 1000) return true;
    activeSignalStore.delete(`${pair}_${direction}`);
    return false;
  }
  return hasActiveSignal(pair, "LONG") || hasActiveSignal(pair, "SHORT");
}

function hasActiveAdd(pair: string, direction: "LONG" | "SHORT"): boolean {
  const state = activeSignalStore.get(`${pair}_${direction}`);
  if (!state || state.direction !== direction) return false;
  return state?.scale === "ADD" && (Date.now() - state.timestamp) < 4 * 60 * 60 * 1000;
}

function setActiveSignal(pair: string, direction: "LONG" | "SHORT", scale: "ENTRY_1" | "ENTRY_2" | "ADD", entryPrice: number, crossHash: string): void {
  activeSignalStore.set(`${pair}_${direction}`, { pair, direction, scale, timestamp: Date.now(), entryPrice, crossHash });
}

function canAddToPair(pair: string, direction: "LONG" | "SHORT"): boolean {
  const state = activeSignalStore.get(`${pair}_${direction}`);
  if (!state || state.direction !== direction) return false;
  if (state.scale === "ADD") return false;
  const age = Date.now() - state.timestamp;
  if (age < 60 * 60 * 1000) return false;
  if (age > 24 * 60 * 60 * 1000) { activeSignalStore.delete(`${pair}_${direction}`); return false; }
  return true;
}

// ============================================================
// DIRECTIONAL COMMITMENT STATE
// ============================================================

interface DirectionState {
  pair: string;
  lastDirection: "LONG" | "SHORT";
  lastExitReason: "SL_HIT" | "TP_HIT" | "EXPIRED";
  exitTimestamp: number;
  exitPrice: number;
  trendPhaseAtExit: string;
}

const directionStateStore = new Map<string, DirectionState>();
const DIRECTION_COOLDOWN_CANDLES = 6;
const DIRECTION_COOLDOWN_MS = DIRECTION_COOLDOWN_CANDLES * 4 * 60 * 60 * 1000;

export function recordDirectionExit(
  pair: string,
  direction: "LONG" | "SHORT",
  exitReason: "SL_HIT" | "TP_HIT" | "EXPIRED",
  exitPrice: number,
  trendPhaseAtExit: string
): void {
  directionStateStore.set(pair, {
    pair,
    lastDirection: direction,
    lastExitReason: exitReason,
    exitTimestamp: Date.now(),
    exitPrice,
    trendPhaseAtExit,
  });
  console.log(`[DIR_STATE] ${pair}: recorded ${direction} ${exitReason} at ${exitPrice}, trend was ${trendPhaseAtExit}`);
}

export function recordTradeExit(
  pair: string,
  direction: "LONG" | "SHORT",
  exitReason: string,
  exitPrice: number,
  candles4h: Candle[]
): void {
  const candles1d = aggregateTo1D(candles4h);
  const trend = dailyTrend(candles1d);
  let normalizedReason: "SL_HIT" | "TP_HIT" | "EXPIRED";
  if (exitReason === "sl_hit") normalizedReason = "SL_HIT";
  else if (exitReason === "tp_hit") normalizedReason = "TP_HIT";
  else normalizedReason = "EXPIRED";
  recordDirectionExit(pair, direction, normalizedReason, exitPrice, trend.direction);
}

function getDirectionState(pair: string): DirectionState | undefined {
  return directionStateStore.get(pair);
}

function clearDirectionState(pair: string): void {
  directionStateStore.delete(pair);
}

function clearExpiredDirectionStates(): void {
  const now = Date.now();
  for (const [pair, state] of directionStateStore.entries()) {
    const cooldownExpired = now - state.exitTimestamp > DIRECTION_COOLDOWN_MS;
    const veryOld = now - state.exitTimestamp > DIRECTION_COOLDOWN_MS * 8;
    if (cooldownExpired || veryOld) {
      directionStateStore.delete(pair);
      console.log(`[DIR_STATE] ${pair}: cleared expired state`);
    }
  }
}

function checkDirectionalCommitment(
  pair: string,
  proposedDirection: "LONG" | "SHORT",
  currentTrendDirection: "LONG" | "SHORT" | "FLAT"
): { allowed: boolean; reason: string } {
  const state = getDirectionState(pair);
  if (!state) {
    return { allowed: true, reason: "No prior exit state" };
  }

  if (proposedDirection === state.lastDirection) {
    return { allowed: true, reason: `Same direction as last exit (${state.lastDirection})` };
  }

  const now = Date.now();
  const cooldownExpired = now - state.exitTimestamp > DIRECTION_COOLDOWN_MS;
  const trendChanged = currentTrendDirection !== "FLAT" && currentTrendDirection !== state.trendPhaseAtExit;
  const candlesAgo = Math.floor((now - state.exitTimestamp) / (4 * 60 * 60 * 1000));
  const reasonLabel = state.lastExitReason === "SL_HIT" ? "SL" : state.lastExitReason === "TP_HIT" ? "TP" : "expired";

  if (trendChanged) {
    clearDirectionState(pair);
    return { allowed: true, reason: `${proposedDirection} allowed: previous ${state.lastDirection} exit but daily trend changed to ${currentTrendDirection}.` };
  }

  if (cooldownExpired) {
    clearDirectionState(pair);
    return { allowed: true, reason: `${proposedDirection} allowed: previous ${state.lastDirection} exit but direction cooldown expired (${DIRECTION_COOLDOWN_CANDLES} candles).` };
  }

  return {
    allowed: false,
    reason: `${proposedDirection} blocked: previous ${state.lastDirection} ${reasonLabel} exit ${candlesAgo} candles ago. Daily trend unchanged ${state.trendPhaseAtExit}. Waiting for state reset.`,
  };
}

// ============================================================
// DIRECTIONAL ANALYSIS BUILDER
// ============================================================

function buildDirectionalContext(
  pair: string,
  candles4h: Candle[],
  trend: { direction: "LONG" | "SHORT" | "FLAT"; detail: string; ema21: number; ema50: number },
  direction: "LONG" | "SHORT",
  price: number,
  activeSignals: Signal[],
  debug: string[]
): DirectionalContext {
  let trigger: TriggerResult | null = null;
  let addTrigger: AddTriggerResult | null = null;
  let signal: Signal | undefined = undefined;
  let canEnter = false;
  let reason = "";

  const anyActive = hasActiveSignal(pair);
  const sameDirActive = hasActiveSignal(pair, direction);

  if (!anyActive) {
    trigger = stochTrigger4H(candles4h, direction, pair);
    debug.push(`[${direction}] Trigger: ${trigger.fired ? "FIRED" : "WAITING"} | ${trigger.detail} | Momentum: ${trigger.momentumDesc}`);
  }

  // === HARD RULE 1: No counter-trend entries ===
  if (trend.direction === "FLAT") {
    debug.push(`[${direction}] BLOCKED: Daily trend FLAT`);
    return { direction, trend: trend.detail, location: { detail: "", trendlinePrice: 0, locationType: "NONE", marketPhase: "unknown", structureDesc: "", pullbackDesc: "", regressionDir: "flat", distToTL: 0 }, trigger, addTrigger: null, signal: undefined, canEnter: false, reason: "Daily trend FLAT — no entries" };
  }
  if (trend.direction !== direction) {
    debug.push(`[${direction}] BLOCKED: Counter-trend (daily=${trend.direction})`);
    return { direction, trend: trend.detail, location: { detail: "", trendlinePrice: 0, locationType: "NONE", marketPhase: "unknown", structureDesc: "", pullbackDesc: "", regressionDir: "flat", distToTL: 0 }, trigger, addTrigger: null, signal: undefined, canEnter: false, reason: `Counter-trend blocked: daily is ${trend.direction}` };
  }

  // === HARD RULE 2: ADX > 18 and rising ===
  const adxCurrent = adx(candles4h);
  const adxPrevious = adx(candles4h.slice(0, -1));
  const adxRising = adxCurrent > adxPrevious;
  debug.push(`[${direction}] ADX: ${adxCurrent.toFixed(1)} (prev ${adxPrevious.toFixed(1)}) ${adxRising ? "rising" : "flat/falling"}`);
  if (adxCurrent < 18) {
    debug.push(`[${direction}] BLOCKED: ADX ${adxCurrent.toFixed(1)} < 18`);
    return { direction, trend: trend.detail, location: { detail: "", trendlinePrice: 0, locationType: "NONE", marketPhase: "unknown", structureDesc: "", pullbackDesc: "", regressionDir: "flat", distToTL: 0 }, trigger, addTrigger: null, signal: undefined, canEnter: false, reason: `ADX ${adxCurrent.toFixed(1)} < 18` };
  }
  if (!adxRising) {
    debug.push(`[${direction}] BLOCKED: ADX not rising`);
    return { direction, trend: trend.detail, location: { detail: "", trendlinePrice: 0, locationType: "NONE", marketPhase: "unknown", structureDesc: "", pullbackDesc: "", regressionDir: "flat", distToTL: 0 }, trigger, addTrigger: null, signal: undefined, canEnter: false, reason: `ADX ${adxCurrent.toFixed(1)} not rising (prev ${adxPrevious.toFixed(1)})` };
  }

  // === ADAPTIVE R²: compute threshold and telemetry ===
  const minR2 = getMinimumR2(adxCurrent);
  const rawTl = getTrendline(pair, candles4h, direction); // raw, no minR2 filter
  const currentR2 = rawTl?.r2 ?? 0;
  const r2Pass = currentR2 >= minR2;
  debug.push(`[${direction}] Trend Quality: ADX ${adxCurrent.toFixed(1)} | R² ${currentR2.toFixed(2)} | Required ${minR2.toFixed(2)} | Result: ${r2Pass ? 'PASS' : 'FAIL'}`);

  const location = location4H(pair, candles4h, direction, minR2);
  debug.push(`[${direction}] Location: ${location.locationType} | ${location.detail} | Phase: ${location.marketPhase}`);

  if (!r2Pass) {
    debug.push(`[${direction}] BLOCKED: R² ${currentR2.toFixed(2)} below adaptive minimum ${minR2.toFixed(2)}`);
    return { direction, trend: trend.detail, location, trigger, addTrigger: null, signal: undefined, canEnter: false, reason: `R² ${currentR2.toFixed(2)} below adaptive minimum ${minR2.toFixed(2)}` };
  }

  // === ENTRY (ADD removed) ===
  if (!anyActive && trigger?.fired) {
    canEnter = true;
    reason = trigger.detail;
  } else if (anyActive) {
    reason = sameDirActive ? `Active ${direction} trade exists` : `Active opposite-direction trade exists`;
    debug.push(`[${direction}] Entry blocked: ${reason}`);
  }

  // Build signal
  if (canEnter) {
    const atrVal = atr(candles4h, 14);
    const recent4h = candles4h.slice(-20);
    const swingLow = Math.min(...recent4h.map(c => c.low));
    const swingHigh = Math.max(...recent4h.map(c => c.high));
    let stop: number;
    let target: number;
    let signalType: "ENTRY_1" | "ENTRY_2" | "ADD";

    if (trigger?.triggerType === "entry_1_deep_pullback") signalType = "ENTRY_1";
    else if (trigger?.triggerType === "entry_2_early_momentum" || trigger?.triggerType === "entry_2_pre_cross") signalType = "ENTRY_2";
    else signalType = "ENTRY_1";

    if (signalType === "ENTRY_1" || signalType === "ENTRY_2") {
      if (direction === "LONG") {
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
      if (direction === "LONG") {
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

    const triggerResult = trigger!;
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

    signal = {
      id: `${pair}_${signalType}_${direction}_${Date.now()}`,
      pair,
      direction,
      type: signalType,
      scale: signalType,
      entry: Math.round(price * 100) / 100,
      stop: Math.round(stop * 100) / 100,
      target: Math.round(target * 100) / 100,
      rr: Math.round(rr * 100) / 100,
      adx: Math.round(adxCurrent * 10) / 10,
      rsi: Math.round(wilderRsi(candles4h.map(c => c.close)) * 10) / 10,
      stochK: triggerResult.stochK,
      stochD: triggerResult.stochD,
      expectedMove: Math.round(((target - price) / price) * 1000) / 10,
      reason: `${signalType} ${direction} | ${trend.direction} | ${location.marketPhase} | ${triggerResult.detail}`,
      timestamp: Date.now(),
      version: CURRENT_SIGNAL_VERSION,
      trend: trend.direction,
      location: location.detail,
      trigger: triggerResult.detail,
      context,
    };

    debug.push(`[${direction}] SIGNAL: ${signalType} ${direction} ${pair} | Entry $${signal.entry} | SL $${signal.stop} | TP $${signal.target} | RR ${signal.rr}`);
  }

  return {
    direction,
    trend: trend.detail,
    location,
    trigger,
    addTrigger,
    signal,
    canEnter,
    reason,
  };
}

// ============================================================
// MAIN SIGNAL GENERATOR — v53.2
// ============================================================

export function generateSignal(pair: string, candles1h: Candle[], candles4h: Candle[], candles15m: Candle[], activeSignals: Signal[], currentPrice?: number): SignalResult {
  const debug: string[] = [];
  const now = Date.now();
  const price = currentPrice ?? candles4h[candles4h.length - 1]?.close ?? 0;

  // Step 1: Daily Trend
  const candles1d = aggregateTo1D(candles4h);
  const trend = dailyTrend(candles1d);
  debug.push(`Trend: ${trend.direction} | ${trend.detail}`);

  // Step 2: Analyze both directions
  const longContext = buildDirectionalContext(pair, candles4h, trend, "LONG", price, activeSignals, debug);
  const shortContext = buildDirectionalContext(pair, candles4h, trend, "SHORT", price, activeSignals, debug);

  // Step 3: Directional Commitment Check
  clearExpiredDirectionStates();

  const longCommitment = checkDirectionalCommitment(pair, "LONG", trend.direction);
  const shortCommitment = checkDirectionalCommitment(pair, "SHORT", trend.direction);

  if (longContext.canEnter && !longCommitment.allowed) {
    longContext.canEnter = false;
    longContext.reason = longCommitment.reason;
    debug.push(`[LONG] BLOCKED: ${longCommitment.reason}`);
  } else if (longContext.canEnter && longCommitment.allowed) {
    debug.push(`[LONG] ALLOWED: ${longCommitment.reason}`);
  }

  if (shortContext.canEnter && !shortCommitment.allowed) {
    shortContext.canEnter = false;
    shortContext.reason = shortCommitment.reason;
    debug.push(`[SHORT] BLOCKED: ${shortCommitment.reason}`);
  } else if (shortContext.canEnter && shortCommitment.allowed) {
    debug.push(`[SHORT] ALLOWED: ${shortCommitment.reason}`);
  }

  // Step 4: Collect all allowed signals
  const allowedSignals: Signal[] = [];

  if (longContext.canEnter && longContext.signal) {
    allowedSignals.push(longContext.signal);
    const triggerResult = longContext.trigger || longContext.addTrigger;
    if (triggerResult?.crossHash) {
      recordCycle(pair, triggerResult.crossHash, "LONG");
    }
    setActiveSignal(pair, "LONG", longContext.signal.type, longContext.signal.entry, triggerResult?.crossHash || "");
    debug.push(`[LONG] EXECUTED: ${longContext.signal.type} @ ${longContext.signal.entry}`);
  }

  if (shortContext.canEnter && shortContext.signal) {
    allowedSignals.push(shortContext.signal);
    const triggerResult = shortContext.trigger || shortContext.addTrigger;
    if (triggerResult?.crossHash) {
      recordCycle(pair, triggerResult.crossHash, "SHORT");
    }
    setActiveSignal(pair, "SHORT", shortContext.signal.type, shortContext.signal.entry, triggerResult?.crossHash || "");
    debug.push(`[SHORT] EXECUTED: ${shortContext.signal.type} @ ${shortContext.signal.entry}`);
  }

  if (allowedSignals.length > 0) {
    clearDirectionState(pair);
  } else {
    debug.push(`NO SIGNAL: LONG=${longContext.canEnter ? "ready" : "blocked"} (${longContext.reason}), SHORT=${shortContext.canEnter ? "ready" : "blocked"} (${shortContext.reason})`);
  }

  // Step 5: Market snapshot
  const closes4h = candles4h.map(c => c.close);
  const ema8_4h = ema(closes4h, 8);
  const ema21_4h = ema(closes4h, 21);
  const ema50_4h = ema(closes4h, 50);
  const dominantContext = longContext.canEnter ? longContext : shortContext.canEnter ? shortContext : longContext;
  const distToTrendline = dominantContext.location.trendlinePrice > 0
    ? Math.round(Math.abs((price - dominantContext.location.trendlinePrice) / dominantContext.location.trendlinePrice) * 10000) / 100
    : null;

  const market: MarketSnapshot = {
    pair,
    price: Math.round(price * 100) / 100,
    timestamp: now,
    trend: trend.direction,
    location: dominantContext.location.locationType,
    trigger: allowedSignals.length > 0 ? "FIRED" : "WAITING",
    adx: Math.round(adx(candles4h) * 10) / 10,
    rsi: Math.round(wilderRsi(candles4h.map(c => c.close)) * 10) / 10,
    stochK: dominantContext.trigger?.stochK ?? dominantContext.addTrigger?.stochK ?? 50,
    stochD: dominantContext.trigger?.stochD ?? dominantContext.addTrigger?.stochD ?? 50,
    trendlinePrice: Math.round(dominantContext.location.trendlinePrice * 100) / 100,
    distToTrendline,
    locationType: dominantContext.location.locationType,
    ema8_4h: Math.round(ema8_4h[ema8_4h.length - 1] * 100) / 100,
    ema21_4h: Math.round(ema21_4h[ema21_4h.length - 1] * 100) / 100,
    ema50_4h: Math.round(ema50_4h[ema50_4h.length - 1] * 100) / 100,
    marketPhase: dominantContext.location.marketPhase,
    momentumDesc: dominantContext.trigger?.momentumDesc || dominantContext.addTrigger?.momentumDesc || "neutral",
    pullbackDesc: dominantContext.location.pullbackDesc,
    structureDesc: dominantContext.location.structureDesc,
    crossAge: dominantContext.trigger?.crossAge || 0,
  };

  return {
    signal: allowedSignals.length === 1 ? allowedSignals[0] : undefined,
    signals: allowedSignals,
    market,
    longContext,
    shortContext,
    debug,
  };
}

// ============================================================
// MARKET SNAPSHOT
// ============================================================

export function getMarketSnapshot(pair: string, candles1h: Candle[], candles4h: Candle[], candles15m: Candle[]): MarketSnapshot {
  const candles1d = aggregateTo1D(candles4h);
  const trend = dailyTrend(candles1d);
  const price = candles4h[candles4h.length - 1]?.close ?? 0;
  const closes4h = candles4h.map(c => c.close);
  const ema8_4h = ema(closes4h, 8);
  const ema21_4h = ema(closes4h, 21);
  const ema50_4h = ema(closes4h, 50);

  const longLoc = location4H(pair, candles4h, "LONG");
  const shortLoc = location4H(pair, candles4h, "SHORT");
  const longTrig = stochTrigger4H(candles4h, "LONG", pair);
  const shortTrig = stochTrigger4H(candles4h, "SHORT", pair);

  const dominantLoc = longTrig.fired ? longLoc : shortTrig.fired ? shortLoc : longLoc;
  const dominantTrig = longTrig.fired ? longTrig : shortTrig.fired ? shortTrig : longTrig;
  const distToTrendline = dominantLoc.trendlinePrice > 0
    ? Math.round(Math.abs((price - dominantLoc.trendlinePrice) / dominantLoc.trendlinePrice) * 10000) / 100
    : null;

  return {
    pair,
    price: Math.round(price * 100) / 100,
    timestamp: Date.now(),
    trend: trend.direction,
    location: dominantLoc.locationType,
    trigger: dominantTrig.fired ? "FIRED" : "WAITING",
    adx: Math.round(adx(candles4h) * 10) / 10,
    rsi: Math.round(wilderRsi(candles4h.map(c => c.close)) * 10) / 10,
    stochK: dominantTrig.stochK,
    stochD: dominantTrig.stochD,
    trendlinePrice: Math.round(dominantLoc.trendlinePrice * 100) / 100,
    distToTrendline,
    locationType: dominantLoc.locationType,
    ema8_4h: Math.round(ema8_4h[ema8_4h.length - 1] * 100) / 100,
    ema21_4h: Math.round(ema21_4h[ema21_4h.length - 1] * 100) / 100,
    ema50_4h: Math.round(ema50_4h[ema50_4h.length - 1] * 100) / 100,
    marketPhase: dominantLoc.marketPhase,
    momentumDesc: dominantTrig.momentumDesc || "neutral",
    pullbackDesc: dominantLoc.pullbackDesc,
    structureDesc: dominantLoc.structureDesc,
    crossAge: dominantTrig.crossAge || 0,
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

  // v28 PORT: Exit when Stoch hits extreme opposite
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
  activeSignalStore.clear();
  for (const [key, trade] of Object.entries(activeTrades)) {
    if (!trade || !trade.direction) continue;
    const pair = key.includes("_") ? key.split("_")[0] : key;
    const storeKey = `${pair}_${trade.direction}`;
    activeSignalStore.set(storeKey, {
      pair,
      direction: trade.direction,
      scale: trade.type,
      timestamp: trade.timestamp,
      entryPrice: trade.entry,
      crossHash: trade.crossHash || "",
    });
    console.log(`[STATE_REBUILD] ${storeKey}: ${trade.type} ${trade.direction} @ ${trade.entry}`);
  }
}

export function clearAllState(): void {
  trendlineStore.clear();
  activeSignalStore.clear();
  cycleStore.clear();
  directionStateStore.clear();
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
