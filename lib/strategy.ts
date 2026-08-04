// lib/strategy.ts — v54 "Restored Philosophy"
// ============================================================
// MERGED: v28 entry philosophy + v53.5 infrastructure fixes + new exit system
//
// PHILOSOPHY:
// Capture trends early. Stay in healthy trends. Exit when thesis fails.
// Do not predict tops. Do not predict bottoms. Protect capital.
//
// ENTRY PIPELINE (v28 restored):
// Daily Bias → Pullback into Structure → StochRSI Trigger → Enter
//
// INFRASTRUCTURE (v53.5 kept):
// • Timestamp-based duplicate cycle detection (stable hash)
// • ${pair}_${direction} trendline store keys
// • 24h cycle store expiration
// • State rebuilding from persisted trades
// • Proper Wilder smoothing for ADX
// • Deterministic state handling
//
// EXIT SYSTEM (new):
// Three deterministic states: HEALTHY, WARNING, FAILED
// Exit only on FAILED. Alert on WARNING. Hold on HEALTHY.
//
// ABSOLUTE RULES:
// • No scoring systems
// • No confidence values
// • No weighted calculations
// • No additional indicators
// • No extra entry filters
// • No hidden penalties
// • No unnecessary abstractions

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
  newStop?: number;
}

export const CURRENT_SIGNAL_VERSION = 54;

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
  preCrossEnabled: false,
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
    preCrossEnabled: false,
    preCrossThreshold: 3,
  },
};

export function getPairConfig(pair: string): PairConfig {
  return PAIR_CONFIGS[pair] || DEFAULT_CONFIG;
}

// ============================================================
// MATH UTILITIES
// ============================================================

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

function computeAdxSeries(candles: Candle[], count: number): number[] {
  const series: number[] = [];
  for (let i = 0; i < count; i++) {
    const slice = candles.slice(0, Math.max(0, candles.length - i));
    if (slice.length < 15) break;
    series.push(adx(slice));
  }
  return series;
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
// TRENDLINE ENGINE (v28 restored: wider pivots, 5-pivot fit, composite keys)
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

// RESTORED from v28: wider swing detection (i-3 to i+3)
function findPivots(candles: Candle[], direction: "LONG" | "SHORT"): Pivot[] {
  const pivots: Pivot[] = [];
  for (let i = 3; i < candles.length - 3; i++) {
    const c = candles[i];
    const isSwingLow = c.low < candles[i-1].low && c.low < candles[i-2].low && c.low < candles[i+1].low && c.low < candles[i+2].low;
    const isSwingHigh = c.high > candles[i-1].high && c.high > candles[i-2].high && c.high > candles[i+1].high && c.high > candles[i+2].high;
    if (direction === "LONG" && isSwingLow) pivots.push({ index: i, price: c.low, timestamp: c.timestamp });
    if (direction === "SHORT" && isSwingHigh) pivots.push({ index: i, price: c.high, timestamp: c.timestamp });
  }
  return pivots;
}

function getLastConfirmedStructure(candles: Candle[], direction: "LONG" | "SHORT"): number | null {
  const pivots = findPivots(candles, direction);
  if (pivots.length === 0) return null;
  return pivots[pivots.length - 1].price;
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

// RESTORED from v28: last 5 pivots (faster adaptation), composite key
function getTrendline(pair: string, candles: Candle[], direction: "LONG" | "SHORT"): { price: number; r2: number; slope: number; regressionDirection: string } | null {
  const config = getPairConfig(pair);
  if (candles.length < 30) return null;
  const pivots = findPivots(candles, direction);
  const now = candles[candles.length - 1].timestamp;
  const currentIndex = candles.length - 1;
  if (pivots.length < 3) return null;

  // v28: use last 5 pivots for faster adaptation (v53.5 used 10)
  const recentPivots = pivots.slice(-5);
  const existing = trendlineStore.get(`${pair}_${direction}`);

  if (existing && existing.direction === direction) {
    const lastPivot = recentPivots[recentPivots.length - 1];
    const projected = existing.slope * lastPivot.index + existing.intercept;
    const deviation = Math.abs(lastPivot.price - projected) / projected;
    if (deviation > config.cacheDevTolerance) {
      trendlineStore.delete(`${pair}_${direction}`);
    } else {
      const tlPrice = existing.slope * currentIndex + existing.intercept;
      return { price: tlPrice, r2: existing.r2, slope: existing.slope, regressionDirection: existing.slope > 0 ? "rising" : "falling" };
    }
  }

  const fit = fitTrendline(recentPivots);
  if (!fit) return null;
  trendlineStore.set(`${pair}_${direction}`, { slope: fit.slope, intercept: fit.intercept, lastUpdated: now, direction, r2: Math.round(fit.r2 * 100) / 100 });
  return { price: fit.slope * currentIndex + fit.intercept, r2: Math.round(fit.r2 * 100) / 100, slope: fit.slope, regressionDirection: fit.slope > 0 ? "rising" : "falling" };
}

// ============================================================
// DAILY TREND (kept from v53.5 — proven, simple)
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
// 4H LOCATION (simplified — v28 philosophy restored)
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
// 4H STOCHRSI TRIGGER (v28 restored: simple, no pre-cross)
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
  crossStochK?: number;
  crossStochD?: number;
}

// v53.5 fix: timestamp-based hash (stable)
function computeCrossHash(pair: string, direction: "LONG" | "SHORT", crossTimestamp: number, crossK: number, crossD: number): string {
  return `${pair}_${direction}_${crossTimestamp}_${Math.round(crossK)}_${Math.round(crossD)}`;
}

// v53.5 fix: 24h expiration
function isDuplicateCycle(pair: string, direction: "LONG" | "SHORT", crossHash: string): boolean {
  const existing = cycleStore.get(`${pair}_${direction}`);
  if (!existing) return false;
  const ageMs = Date.now() - existing.timestamp;
  if (ageMs > 24 * 60 * 60 * 1000) {
    cycleStore.delete(`${pair}_${direction}`);
    return false;
  }
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
        crossHash: computeCrossHash(pair, direction, candles4h[idx].timestamp, stochAt.k, stochAt.d),
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

// RESTORED v28 simplicity: no pre-cross, no complex gating
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
        return { fired: false, detail: `Cross ${crossAge} candles ago already signaled`, triggerType: "duplicate_cycle", stochK: recentCross.currentStochK, stochD: recentCross.currentStochD, crossAge, crossHash, momentumDesc, crossStochK: recentCross.crossStochK, crossStochD: recentCross.crossStochD };
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
    } else {
      detail = `No recent cross. Stoch K=${stoch.k} D=${stoch.d}`;
    }
  } else {
    if (recentCross) {
      crossAge = recentCross.crossAge;
      crossHash = recentCross.crossHash;
      if (isDuplicateCycle(pair, direction, crossHash)) {
        return { fired: false, detail: `Cross ${crossAge} candles ago already signaled`, triggerType: "duplicate_cycle", stochK: recentCross.currentStochK, stochD: recentCross.currentStochD, crossAge, crossHash, momentumDesc, crossStochK: recentCross.crossStochK, crossStochD: recentCross.crossStochD };
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
    } else {
      detail = `No recent cross. Stoch K=${stoch.k} D=${stoch.d}`;
    }
  }
  return { fired, detail, triggerType, stochK: stoch.k, stochD: stoch.d, crossAge, crossHash, momentumDesc, crossStochK: recentCross?.crossStochK, crossStochD: recentCross?.crossStochD };
}

// ============================================================
// ADD TRIGGER (v28 restored: simple confirmation logic)
// ============================================================

export interface AddTriggerResult {
  fired: boolean;
  detail: string;
  confirmations: string[];
  stochK: number;
  stochD: number;
}

// RESTORED from v28: beyond TL + confirming candle + EMA aligned + momentum
function addTrigger4H(candles4h: Candle[], direction: "LONG" | "SHORT", location: LocationResult, pair: string): AddTriggerResult {
  const defaultFail = { fired: false, detail: "No ADD conditions met", confirmations: [] as string[], stochK: 50, stochD: 50 };
  if (candles4h.length < 30) return defaultFail;
  const price = candles4h[candles4h.length - 1].close;
  const prev = candles4h[candles4h.length - 2];
  const last = candles4h[candles4h.length - 1];
  const closes = candles4h.map(c => c.close);
  const ema8_4h = ema(closes, 8);
  const ema21_4h = ema(closes, 21);
  const stoch = stochRsi(closes);
  const confirmations: string[] = [];

  if (location.locationType === "BEYOND_TL") confirmations.push("beyond_tl");
  if (direction === "LONG" && last.close > last.open && last.close > prev.close) confirmations.push("confirming_candle");
  else if (direction === "SHORT" && last.close < last.open && last.close < prev.close) confirmations.push("confirming_candle");
  if (direction === "LONG" && price > ema8_4h[ema8_4h.length - 1] && price > ema21_4h[ema21_4h.length - 1]) confirmations.push("ema_aligned");
  else if (direction === "SHORT" && price < ema8_4h[ema8_4h.length - 1] && price < ema21_4h[ema21_4h.length - 1]) confirmations.push("ema_aligned");
  if (direction === "LONG" && stoch.k > stoch.d) confirmations.push("stoch_momentum");
  else if (direction === "SHORT" && stoch.k < stoch.d) confirmations.push("stoch_momentum");
  const volUp = last.volume > avg(candles4h.slice(-10).map(c => c.volume)) * 1.3;
  if (volUp) confirmations.push("volume_surge");
  const adxVal = adx(candles4h);
  if (adxVal > 20) confirmations.push("adx_strong");

  const hasBeyond = confirmations.includes("beyond_tl");
  const otherCount = confirmations.filter(c => c !== "beyond_tl").length;
  const fired = hasBeyond && otherCount >= 1;

  const detail = fired
    ? `ADD fired: ${confirmations.join(", ")}`
    : `ADD waiting: ${hasBeyond ? "beyond TL but no confirmations" : "not beyond TL"} (${confirmations.join(", ") || "none"})`;

  return { fired, detail, confirmations, stochK: stoch.k, stochD: stoch.d };
}

// ============================================================
// ACTIVE TRADE MANAGEMENT (v53.5 infrastructure kept)
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
// DIRECTIONAL COMMITMENT STATE (v53.5 kept — proven)
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
// DIRECTIONAL ANALYSIS BUILDER (v28 philosophy restored)
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
  let reason = "not_ready";

  debug.push(`=== ${pair} ${direction} ===`);

  // --- TREND CONTEXT ---
  const isSameDirection = trend.direction === direction;
  const isCounterTrend = trend.direction !== "FLAT" && !isSameDirection;

  if (trend.direction === "FLAT") {
    debug.push(`Trend        ❌ FLAT`);
  } else if (isCounterTrend) {
    debug.push(`Trend        ⚠️ ${trend.direction} (counter-trend)`);
  } else {
    debug.push(`Trend        ✅ ${trend.direction}`);
  }

  // --- LOCATION (always calculate for dashboard) ---
  const adxSeries = computeAdxSeries(candles4h, 7);
  const adxCurrent = adxSeries[0] ?? 0;
  const location = location4H(pair, candles4h, direction);

  debug.push(`Location     ${location.locationType} | ${location.marketPhase} | ${location.structureDesc}`);

  // ADX logged as context only (NOT a hard gate — restored from v28)
  const last3Adx = adxSeries.slice(0, 3);
  const prev3Adx = adxSeries.slice(3, 6);
  const avgLast3 = last3Adx.length ? avg(last3Adx) : 0;
  const avgPrev3 = prev3Adx.length ? avg(prev3Adx) : 0;
  const adxWeakening = avgLast3 < avgPrev3 - 1.0;
  const adxState = adxWeakening ? "cooling" : "stable";

  debug.push(`ADX          ${adxCurrent.toFixed(1)} (state: ${adxState}, last3 ${avgLast3.toFixed(1)} vs prev3 ${avgPrev3.toFixed(1)})`);

  // R² logged as context only (NOT a hard gate)
  const rawTl = getTrendline(pair, candles4h, direction);
  const currentR2 = rawTl?.r2 ?? 0;

  debug.push(`R²           ${currentR2.toFixed(2)} (context only)`);

  // Hard blocks (minimal — v28 style)
  if (trend.direction === "FLAT") {
    debug.push(`Trigger      —`);
    debug.push(`Result       BLOCKED — FLAT trend`);
    return { direction, trend: trend.detail, location, trigger: null, addTrigger: null, signal: undefined, canEnter: false, reason: "Daily trend FLAT — no entries" };
  }

  // REMOVED: ADX < 18 hard gate (v28 did not have this)
  // REMOVED: R2 hard gate
  // REMOVED: Counter-trend ENTRY_1 blocking (v28 allowed all entries)

  // --- TRIGGER EVALUATION ---
  const anyActive = hasActiveSignal(pair);
  const sameDirActive = hasActiveSignal(pair, direction);

  trigger = stochTrigger4H(candles4h, direction, pair);
  debug.push(`Trigger      ${trigger.fired ? '✅' : '❌'} ${trigger.detail}`);

  if (anyActive) {
    reason = sameDirActive ? `Active ${direction} trade exists` : `Active opposite-direction trade exists`;
    debug.push(`Result       WAITING — ${reason}`);
  } else if (trigger?.fired) {
    // v28: no cross freshness check, no counter-trend blocking
    canEnter = true;
    reason = trigger.detail;
  } else {
    if (trigger?.triggerType === "duplicate_cycle") {
      reason = "duplicate_cycle";
      debug.push(`Result       BLOCKED — duplicate cycle`);
    } else {
      reason = trigger?.detail || "no_valid_trigger";
      debug.push(`Result       WAITING — no valid trigger`);
    }
    // Trigger rejection telemetry
    if (trigger) {
      const kAboveD = trigger.stochK >= trigger.stochD;
      const kBelowD = trigger.stochK <= trigger.stochD;
      const crossK = trigger.crossStochK ?? trigger.stochK;
      debug.push(`${direction} TRIGGER TELEMETRY:`);
      debug.push(`  crossAge: ${trigger.crossAge} candles`);
      debug.push(`  crossK: ${crossK.toFixed(1)}`);
      debug.push(`  currentK: ${trigger.stochK.toFixed(1)}  currentD: ${trigger.stochD.toFixed(1)}`);
      if (direction === "LONG") {
        debug.push(`  kAboveD: ${kAboveD} ${kAboveD ? "✅" : "❌"} (required for entry)`);
        const zoneOk = crossK < 50;
        const extremeOk = crossK < 20;
        debug.push(`  zone: required <50, actual ${crossK.toFixed(1)} ${zoneOk ? "✅" : "❌"}`);
        debug.push(`  extreme: <20 ${extremeOk ? "✅" : "❌"}`);
      } else {
        debug.push(`  kBelowD: ${kBelowD} ${kBelowD ? "✅" : "❌"} (required for entry)`);
        const zoneOk = crossK > 50;
        const extremeOk = crossK > 80;
        debug.push(`  zone: required >50, actual ${crossK.toFixed(1)} ${zoneOk ? "✅" : "❌"}`);
        debug.push(`  extreme: >80 ${extremeOk ? "✅" : "❌"}`);
      }
      debug.push(`  cycle: ${trigger.triggerType === "duplicate_cycle" ? "duplicate ❌" : "fresh ✅"}`);
      debug.push(`  momentum: ${trigger.momentumDesc}`);
    }
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
    else if (trigger?.triggerType === "entry_2_early_momentum") signalType = "ENTRY_2";
    else signalType = "ENTRY_1";

    // v28-style level calculation
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

    // v28: minimum R/R check
    if (rr < 1.5) {
      debug.push(`Result       BLOCKED — R:R ${rr.toFixed(2)} < 1.5`);
      return { direction, trend: trend.detail, location, trigger, addTrigger: null, signal: undefined, canEnter: false, reason: `R:R ${rr.toFixed(2)} < 1.5` };
    }

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

    debug.push(`Result       ✅ SIGNAL ${signalType} @ ${signal.entry} | SL ${signal.stop} | TP ${signal.target} | RR ${signal.rr}`);
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
// TRIGGER TELEMETRY FORMATTER
// ============================================================

function formatDirectionTelemetry(
  pair: string,
  direction: "LONG" | "SHORT",
  context: DirectionalContext,
  commitment: { allowed: boolean; reason: string }
): string[] {
  const lines: string[] = [];
  const trigger = context.trigger;
  lines.push(`=== ${direction} TELEMETRY ===`);
  if (!trigger) {
    lines.push(`  trigger: null ❌`);
    lines.push(`  reason: ${context.reason}`);
    return lines;
  }
  const crossK = trigger.crossStochK ?? trigger.stochK;
  const kAboveD = trigger.stochK >= trigger.stochD;
  const kBelowD = trigger.stochK <= trigger.stochD;
  lines.push(`  crossAge: ${trigger.crossAge} ${trigger.crossAge > 0 ? "✅" : "❌"}`);
  lines.push(`  crossK: ${crossK.toFixed(1)}`);
  lines.push(`  currentK: ${trigger.stochK.toFixed(1)}  currentD: ${trigger.stochD.toFixed(1)}`);
  if (direction === "LONG") {
    lines.push(`  kAboveD: ${kAboveD} ${kAboveD ? "✅" : "❌"} (required for entry)`);
    lines.push(`  zone: required <50, actual ${crossK.toFixed(1)} ${crossK < 50 ? "✅" : "❌"}`);
    lines.push(`  extreme: <20 ${crossK < 20 ? "✅" : "❌"}`);
  } else {
    lines.push(`  kBelowD: ${kBelowD} ${kBelowD ? "✅" : "❌"} (required for entry)`);
    lines.push(`  zone: required >50, actual ${crossK.toFixed(1)} ${crossK > 50 ? "✅" : "❌"}`);
    lines.push(`  extreme: >80 ${crossK > 80 ? "✅" : "❌"}`);
  }
  lines.push(`  location: ${context.location.locationType} | ${context.location.marketPhase} ✅`);
  lines.push(`  commitment: ${commitment.allowed ? "allowed" : "BLOCKED"} ${commitment.allowed ? "✅" : "❌"} (${commitment.reason})`);
  lines.push(`  cycle: ${trigger.triggerType === "duplicate_cycle" ? "duplicate ❌" : "fresh ✅"}`);
  lines.push(`  canEnter: ${context.canEnter} ${context.canEnter ? "✅" : "❌"}`);
  lines.push(`  blocker: ${context.reason}`);
  return lines;
}

// ============================================================
// MAIN SIGNAL GENERATOR — v54
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
    debug.push(...formatDirectionTelemetry(pair, "LONG", longContext, longCommitment));
    debug.push(...formatDirectionTelemetry(pair, "SHORT", shortContext, shortCommitment));
    debug.push(`NO SIGNAL: LONG=${longContext.canEnter ? "ready" : "blocked"} (${longContext.reason}), SHORT=${shortContext.canEnter ? "ready" : "blocked"} (${shortContext.reason})`);
  }

  // Step 5: Market snapshot
  const closes4h = candles4h.map(c => c.close);
  const ema8_4h = ema(closes4h, 8);
  const ema21_4h = ema(closes4h, 21);
  const ema50_4h = ema(closes4h, 50);
  const dominantContext = longContext.canEnter ? longContext : shortContext.canEnter ? shortContext : (trend.direction === "SHORT" ? shortContext : longContext);
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

  const dominantLoc = trend.direction === "SHORT" ? shortLoc : longLoc;
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
// NEW EXIT SYSTEM — Three Deterministic States
// ============================================================

export interface ExitAnalysis {
  state: "HEALTHY" | "WARNING" | "FAILED";
  reason: string;
  newStop?: number;
}

/**
 * Evaluate trade health using only existing data.
 * 
 * HEALTHY: Original thesis intact. Hold.
 * WARNING: Early deterioration. Alert. Optionally tighten stop.
 * FAILED: Thesis invalidated. Exit immediately.
 */
export function analyzeTradeHealth(
  signal: Signal,
  candles4h: Candle[],
  currentPrice: number
): ExitAnalysis {
  const candles1d = aggregateTo1D(candles4h);
  const trend = dailyTrend(candles1d);
  const closes4h = candles4h.map(c => c.close);
  const stoch = stochRsi(closes4h);
  const atrVal = atr(candles4h, 14);
  const ema21_4h = ema(closes4h, 21);
  const lastEma21 = ema21_4h[ema21_4h.length - 1];

  // ==================== FAILED CHECKS ====================

  // 1. Structural failure — last confirmed swing broken
  const lastStructure = getLastConfirmedStructure(candles4h, signal.direction);
  if (lastStructure !== null) {
    if (signal.direction === "LONG" && currentPrice < lastStructure) {
      return { state: "FAILED", reason: "structure_broken" };
    }
    if (signal.direction === "SHORT" && currentPrice > lastStructure) {
      return { state: "FAILED", reason: "structure_broken" };
    }
  }

  // 2. Trendline failure — 3 consecutive closes beyond trendline
  const location = location4H(signal.pair, candles4h, signal.direction);
  if (location.trendlinePrice > 0) {
    let consecutiveBeyond = 0;
    for (let i = candles4h.length - 1; i >= Math.max(0, candles4h.length - 6); i--) {
      const c = candles4h[i];
      if (signal.direction === "LONG" && c.close < location.trendlinePrice) {
        consecutiveBeyond++;
      } else if (signal.direction === "SHORT" && c.close > location.trendlinePrice) {
        consecutiveBeyond++;
      } else {
        break;
      }
    }
    if (consecutiveBeyond >= 3) {
      return { state: "FAILED", reason: `trendline_failed_${consecutiveBeyond}_consecutive_closes` };
    }
  }

  // 3. Adverse movement — 3 ATR against entry
  const maxAdverseMove = atrVal * 3;
  const adverseMove = signal.direction === "LONG"
    ? signal.entry - currentPrice
    : currentPrice - signal.entry;
  if (adverseMove > maxAdverseMove) {
    return { state: "FAILED", reason: `adverse_move_${adverseMove.toFixed(2)}_vs_${maxAdverseMove.toFixed(2)}` };
  }

  // 4. Daily trend reversal
  const trendReversed = (signal.direction === "LONG" && trend.direction === "SHORT") ||
                        (signal.direction === "SHORT" && trend.direction === "LONG");
  if (trendReversed) {
    return { state: "FAILED", reason: "daily_trend_reversed" };
  }

  // 5. Momentum exhaustion — Stoch extreme + price loses EMA21
  const stochExtreme = signal.direction === "LONG" ? stoch.k < 20 : stoch.k > 80;
  const priceLosesEma21 = signal.direction === "LONG" ? currentPrice < lastEma21 : currentPrice > lastEma21;
  if (stochExtreme && priceLosesEma21) {
    return { state: "FAILED", reason: "momentum_exhausted" };
  }

  // ==================== WARNING CHECKS ====================
  // Any one of: ADX falling sharply, price loses EMA21, stoch divergence

  // ADX declining significantly
  const adxSeries = computeAdxSeries(candles4h, 7);
  const adxCurrent = adxSeries[0] ?? 0;
  const adxPrev = adxSeries[3] ?? adxCurrent;
  const adxDeclining = adxCurrent < adxPrev - 3;

  // Stoch divergence
  const stochSeries = stochRsiSeries(closes4h);
  let stochDivergence = false;
  if (stochSeries.length >= 3) {
    const last3 = stochSeries.slice(-3);
    if (signal.direction === "LONG") {
      const priceHigher = candles4h[candles4h.length - 1].low > candles4h[candles4h.length - 3].low;
      const stochLower = last3[2].k < last3[0].k;
      stochDivergence = priceHigher && stochLower;
    } else {
      const priceLower = candles4h[candles4h.length - 1].high < candles4h[candles4h.length - 3].high;
      const stochHigher = last3[2].k > last3[0].k;
      stochDivergence = priceLower && stochHigher;
    }
  }

  if (adxDeclining || priceLosesEma21 || stochDivergence) {
    const reasons: string[] = [];
    if (adxDeclining) reasons.push("adx_declining");
    if (priceLosesEma21) reasons.push("price_loses_ema21");
    if (stochDivergence) reasons.push("stoch_divergence");
    return { state: "WARNING", reason: reasons.join("_") };
  }

  // ==================== HEALTHY ====================
  return { state: "HEALTHY", reason: "thesis_intact" };
}
// Convenience: get config for location4H calls
const config = DEFAULT_CONFIG;

// ============================================================
// VALIDITY & HOLD MANAGEMENT (updated with new exit system)
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

/**
 * shouldHold: Uses new three-state exit system.
 * 
 * FAILED → exit immediately (returns shouldHold: false with specific reason)
 * WARNING → hold but alert (caller should tighten stop if desired)
 * HEALTHY → hold normally
 */
export function shouldHold(signal: Signal, candles4h: Candle[], currentPrice: number, now?: number): HoldResult {
  // 1. Check hard stops/TP
  const validity = isSignalStillValid(signal, currentPrice, now);
  if (!validity.valid) {
    return { shouldHold: false, reason: validity.reason };
  }

  // 2. Evaluate trade health
  const health = analyzeTradeHealth(signal, candles4h, currentPrice);

  if (health.state === "FAILED") {
    return { shouldHold: false, reason: health.reason };
  }

  // 3. Profit protection — compute new stop level
  const risk = Math.abs(signal.entry - signal.stop);
  const profit = signal.direction === "LONG" ? currentPrice - signal.entry : signal.entry - currentPrice;
  const rMultiple = risk > 0 ? profit / risk : 0;

  let newStop: number | undefined;

  if (rMultiple >= 2) {
    // Trail at 4H EMA21
    const closes4h = candles4h.map(c => c.close);
    const ema21_4h = ema(closes4h, 21);
    const ema21 = ema21_4h[ema21_4h.length - 1];
    newStop = signal.direction === "LONG"
      ? Math.max(signal.stop, ema21)
      : Math.min(signal.stop, ema21);
  } else if (rMultiple >= 1) {
    // Move to breakeven
    newStop = signal.direction === "LONG"
      ? Math.max(signal.stop, signal.entry)
      : Math.min(signal.stop, signal.entry);
  }

  if (health.state === "WARNING") {
    return { shouldHold: true, reason: `warning: ${health.reason}`, newStop };
  }

  return { shouldHold: true, reason: "healthy", newStop };
}export function filterExpiredSignals(signals: Signal[], currentPrices: Record<string, number>, now?: number): { active: Signal[]; exited: { signal: Signal; reason: string }[] } {
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
// STATE RECONSTRUCTION (v53.5 kept — proven)
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
