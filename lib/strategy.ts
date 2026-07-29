// lib/strategy.ts — v50.5 "First Wave Open"
// ============================================================
// Architecture: Daily Trend → 4H Location → 4H Stoch Trigger → Entry/ADD
// Philosophy: Capture the first pullback in a daily trend.
// v50 clean structure + v28 frequency characteristics.
//
// Changes from v50.4:
// 1. Pair-specific configuration system (PairConfig + getPairConfig)
//    - BTC/ETH/SOL: 6% TL, 3×ATR swing, 4% cache dev, 10-candle lookback
//    - HYPE: 8% TL, 4×ATR swing, 6% cache dev, 12-candle lookback
// 2. Cross lookback: 10 candles (was 6) — 40h validity window
// 3. Removed entry-zone gating: cross below/above 50 is enough
//    (was: K must stay below 55/above 45 after cross)
// 4. Pre-cross trigger: K converging toward D within 3 pts
//    captures early entries in strong trends
// 5. Trendline proximity: 6% default, 8% HYPE (was 4% global)
// 6. Swing fallback: always active, 3×ATR default, 4×ATR HYPE
// 7. Trendline cache: 4% dev tolerance default, 6% HYPE (was 2%)
// 8. RR: calculated but never blocks (unchanged from v50.4)
// 9. Architecture: Daily Trend → 4H Location → 4H StochRSI → ENTRY/ADD
// Philosophy: "First Wave Open" — v28 frequency, v50 structure, asset-aware

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

export const CURRENT_SIGNAL_VERSION = 50.5;
const MIN_RR = 1.5; // v50.4: informational only, no longer gates signals
const COOLDOWN_MS = 4 * 60 * 60 * 1000;
const TL_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// ── v50.5: Pair-specific configuration ─────────────────────
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
  tlProximity: 0.06,          // 6%
  beyondTL: 0.008,            // 0.8%
  crossLookback: 10,          // 10 candles
  swingAtrMult: 3,            // 3×ATR
  cacheDevTolerance: 0.04,    // 4%
  r2Minimum: 0.05,
  preCrossEnabled: true,
  preCrossThreshold: 3,       // K within 3 pts of D
};

const PAIR_CONFIGS: Record<string, PairConfig> = {
  BTC: { ...DEFAULT_CONFIG, pair: "BTC" },
  ETH: { ...DEFAULT_CONFIG, pair: "ETH" },
  SOL: { ...DEFAULT_CONFIG, pair: "SOL" },
  HYPE: {
    pair: "HYPE",
    tlProximity: 0.08,        // 8%
    beyondTL: 0.0175,
    crossLookback: 12,        // 12 candles
    swingAtrMult: 4,          // 4×ATR
    cacheDevTolerance: 0.06,  // 6%
    r2Minimum: 0.05,
    preCrossEnabled: true,
    preCrossThreshold: 3,
  },
};

export function getPairConfig(pair: string): PairConfig {
  return PAIR_CONFIGS[pair] || DEFAULT_CONFIG;
}

// Legacy constants kept for backwards compatibility (unused internally)
const TL_PROXIMITY = 0.060;
const SWING_PROXIMITY = 0.030;
const STOCH_EXTREME_LONG = 25;
const STOCH_EXTREME_SHORT = 75;
const STOCH_MIDPOINT = 50;
const STOCH_ENTRY_ZONE_LONG = 55;
const STOCH_ENTRY_ZONE_SHORT = 45;
const STOCH_CROSS_LOOKBACK = 10;
const R2_MINIMUM = 0.05;

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

// --- RSI (Wilder smoothing, TradingView exact) ---
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

// --- StochRSI (TradingView exact) ---
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

// ============================================================
// TRENDLINE ENGINE — v50.5: Pair-specific config
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
  // v50.4: Relaxed to 1 candle left/right for developing trend detection
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

function getTrendline(pair: string, candles: Candle[], direction: "LONG" | "SHORT"): { price: number; r2: number } | null {
  const config = getPairConfig(pair);
  const price = candles[candles.length - 1].close;

  if (candles.length < 30) {
    console.log(`[TL ${pair}] candles=${candles.length} < 30, abort`);
    return null;
  }

  const pivots = findPivots(candles, direction);
  const now = candles[candles.length - 1].timestamp;
  const currentIndex = candles.length - 1;

  console.log(`[TL ${pair}] direction=${direction} pivots=${pivots.length} price=${price.toFixed(2)}`);

  if (pivots.length < 3) {
    console.log(`[TL ${pair}] FAIL: only ${pivots.length} pivots (need 3+)`);
    return null;
  }

  const recentPivots = pivots.slice(-10);
  console.log(`[TL ${pair}] recentPivots=${recentPivots.length} lastPivotPrice=${recentPivots[recentPivots.length-1].price.toFixed(2)}`);

  const existing = trendlineStore.get(pair);

  if (existing && existing.direction === direction) {
    const age = now - existing.lastUpdated;
    const lastPivot = recentPivots[recentPivots.length - 1];
    const projected = existing.slope * lastPivot.index + existing.intercept;
    const deviation = Math.abs(lastPivot.price - projected) / projected;

    console.log(`[TL ${pair}] CACHED: r²=${existing.r2.toFixed(3)} age=${(age/60000).toFixed(1)}min deviation=${(deviation*100).toFixed(2)}% tolerance=${(config.cacheDevTolerance*100).toFixed(2)}%`);

    if (deviation > config.cacheDevTolerance) {
      console.log(`[TL ${pair}] CACHE REJECT: deviation ${(deviation*100).toFixed(2)}% > ${(config.cacheDevTolerance*100).toFixed(2)}%`);
      trendlineStore.delete(pair);
    } else if (age >= TL_MAX_AGE_MS) {
      console.log(`[TL ${pair}] CACHE REJECT: age ${(age/3600000).toFixed(1)}h > max ${TL_MAX_AGE_MS/3600000}h`);
      trendlineStore.delete(pair);
    } else {
      const tlPrice = existing.slope * currentIndex + existing.intercept;
      console.log(`[TL ${pair}] CACHE HIT: price=${tlPrice.toFixed(2)} dist=${(Math.abs(price-tlPrice)/tlPrice*100).toFixed(2)}%`);
      return { price: tlPrice, r2: existing.r2 };
    }
  } else {
    console.log(`[TL ${pair}] NO CACHE: existing=${existing ? 'yes' : 'no'} directionMatch=${existing ? existing.direction === direction : 'N/A'}`);
  }

  // ── Rebuild from latest pivots ──
  const fit = fitTrendline(recentPivots);
  if (!fit) {
    console.log(`[TL ${pair}] FAIL: fitTrendline returned null`);
    return null;
  }

  console.log(`[TL ${pair}] FIT: r²=${fit.r2.toFixed(3)} slope=${fit.slope.toFixed(4)} intercept=${fit.intercept.toFixed(2)}`);

  if (fit.r2 < config.r2Minimum) {
    console.log(`[TL ${pair}] REJECT: r² ${fit.r2.toFixed(3)} < ${config.r2Minimum} (garbage fit)`);
    return null;
  }

  trendlineStore.set(pair, {
    slope: fit.slope,
    intercept: fit.intercept,
    lastUpdated: now,
    direction,
    r2: Math.round(fit.r2 * 100) / 100,
  });

  const tlPrice = fit.slope * currentIndex + fit.intercept;
  console.log(`[TL ${pair}] BUILT: price=${tlPrice.toFixed(2)} dist=${(Math.abs(price-tlPrice)/tlPrice*100).toFixed(2)}%`);
  return { price: tlPrice, r2: Math.round(fit.r2 * 100) / 100 };
}

// ============================================================
// DAILY TREND
// ============================================================

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

// ============================================================
// 4H LOCATION — v50.5: Pair-specific config, always fallback
// ============================================================

interface LocationResult {
  ready: boolean;
  detail: string;
  trendlinePrice: number;
  locationType: string;
}

function location4H(
  pair: string,
  candles4h: Candle[],
  direction: "LONG" | "SHORT"
): LocationResult {
  const config = getPairConfig(pair);
  const price = candles4h[candles4h.length - 1].close;
  const tl = getTrendline(pair, candles4h, direction);

  if (tl) {
    const dist = Math.abs(price - tl.price) / tl.price;
    console.log(`[LOC ${pair}] TL found: price=${price.toFixed(2)} tlPrice=${tl.price.toFixed(2)} dist=${(dist*100).toFixed(2)}% proximity=${(config.tlProximity*100).toFixed(2)}%`);

    // ENTRY zone: price near trendline (within pair-specific proximity)
    if (dist < config.tlProximity) {
      console.log(`[LOC ${pair}] TL READY (ENTRY zone)`);
      return {
        ready: true,
        detail: `Trendline ${(dist * 100).toFixed(2)}% (R² ${tl.r2.toFixed(2)})`,
        trendlinePrice: tl.price,
        locationType: "TRENDLINE"
      };
    }

    // ADD zone: price beyond trendline in trend direction (broken through)
    const beyondTL = direction === "LONG" 
      ? price > tl.price * (1 + config.beyondTL)
      : price < tl.price * (1 - config.beyondTL);

    if (beyondTL) {
      const beyondDist = direction === "LONG"
        ? ((price - tl.price) / tl.price) * 100
        : ((tl.price - price) / tl.price) * 100;
      console.log(`[LOC ${pair}] TL BEYOND — ADD zone: ${beyondDist.toFixed(2)}% past TL`);
      return {
        ready: true,
        detail: `Beyond TL ${beyondDist.toFixed(2)}% (R² ${tl.r2.toFixed(2)})`,
        trendlinePrice: tl.price,
        locationType: "BEYOND_TL"
      };
    }

    console.log(`[LOC ${pair}] TL too far: ${(dist*100).toFixed(2)}% >= ${(config.tlProximity*100).toFixed(2)}%`);
  }

  // v50.5: Always fall back to ATR-based swing logic — no rejection
  const atrVal = atr(candles4h, 14);
  const lookback = 30;
  const recent = candles4h.slice(-lookback);
  if (recent.length < 3) {
    console.log(`[LOC ${pair}] No valid location — insufficient candles`);
    return { ready: false, detail: "No valid location", trendlinePrice: tl?.price || 0, locationType: "NONE" };
  }

  const maxDist = atrVal * config.swingAtrMult;

  if (direction === "LONG") {
    // Use the most recent meaningful swing low (pivot or recent low)
    let swingLow = Infinity;
    for (let i = 1; i < recent.length - 1; i++) {
      const isPivotLow = recent[i].low < recent[i-1].low && recent[i].low < recent[i+1].low;
      if (isPivotLow && recent[i].low < swingLow) {
        swingLow = recent[i].low;
      }
    }
    // If no pivot found, use the lowest low in the lookback
    if (swingLow === Infinity) {
      swingLow = Math.min(...recent.map(c => c.low));
    }
    const dist = price - swingLow;
    console.log(`[LOC ${pair}] SWING_LONG: price=${price.toFixed(2)} swingLow=${swingLow.toFixed(2)} dist=${dist.toFixed(2)} maxDist=${maxDist.toFixed(2)} (${config.swingAtrMult}×ATR)`);
    if (dist >= 0 && dist <= maxDist) {
      console.log(`[LOC ${pair}] SWING_LOW READY`);
      return {
        ready: true,
        detail: `Swing low ${dist.toFixed(2)} away (${config.swingAtrMult}×ATR=${maxDist.toFixed(2)})`,
        trendlinePrice: swingLow,
        locationType: "SWING_LOW"
      };
    }
  } else {
    // Use the most recent meaningful swing high (pivot or recent high)
    let swingHigh = -Infinity;
    for (let i = 1; i < recent.length - 1; i++) {
      const isPivotHigh = recent[i].high > recent[i-1].high && recent[i].high > recent[i+1].high;
      if (isPivotHigh && recent[i].high > swingHigh) {
        swingHigh = recent[i].high;
      }
    }
    // If no pivot found, use the highest high in the lookback
    if (swingHigh === -Infinity) {
      swingHigh = Math.max(...recent.map(c => c.high));
    }
    const dist = swingHigh - price;
    console.log(`[LOC ${pair}] SWING_SHORT: price=${price.toFixed(2)} swingHigh=${swingHigh.toFixed(2)} dist=${dist.toFixed(2)} maxDist=${maxDist.toFixed(2)} (${config.swingAtrMult}×ATR)`);
    if (dist >= 0 && dist <= maxDist) {
      console.log(`[LOC ${pair}] SWING_HIGH READY`);
      return {
        ready: true,
        detail: `Swing high ${dist.toFixed(2)} away (${config.swingAtrMult}×ATR=${maxDist.toFixed(2)})`,
        trendlinePrice: swingHigh,
        locationType: "SWING_HIGH"
      };
    }
  }
  console.log(`[LOC ${pair}] No valid location`);
  return { ready: false, detail: "No valid location", trendlinePrice: tl?.price || 0, locationType: "NONE" };
}

// ============================================================
// 4H STOCHRSI TRIGGER — v50.5: Cross + pre-cross
// ============================================================

interface TriggerResult {
  fired: boolean;
  detail: string;
  triggerType: string;
  stochK: number;
  stochD: number;
}

function stochRsiForSlice(closes: number[]): { k: number; d: number } {
  return stochRsi(closes);
}

function findRecentCross(
  candles4h: Candle[],
  direction: "LONG" | "SHORT",
  pair: string
): { crossIndex: number; crossStochK: number; crossStochD: number; currentStochK: number; currentStochD: number } | null {
  const config = getPairConfig(pair);
  const lookback = config.crossLookback;

  // We need at least lookback + 30 candles to compute StochRSI at each point
  const minNeeded = 30 + lookback;
  if (candles4h.length < minNeeded) return null;

  const closes = candles4h.map(c => c.close);
  const currentStoch = stochRsi(closes);

  // Check the last 'lookback' completed candles (not including the current forming one)
  for (let i = 1; i <= lookback; i++) {
    const idx = candles4h.length - 1 - i;
    if (idx < 30) continue;

    const sliceAtCross = closes.slice(0, idx + 1);
    const sliceBeforeCross = closes.slice(0, idx);

    const stochAt = stochRsi(sliceAtCross);
    const stochBefore = stochRsi(sliceBeforeCross);

    let crossed = false;
    if (direction === "LONG") {
      crossed = stochBefore.k < stochBefore.d && stochAt.k >= stochAt.d;
    } else {
      crossed = stochBefore.k > stochBefore.d && stochAt.k <= stochAt.d;
    }

    if (crossed) {
      return {
        crossIndex: idx,
        crossStochK: stochAt.k,
        crossStochD: stochAt.d,
        currentStochK: currentStoch.k,
        currentStochD: currentStoch.d,
      };
    }
  }

  return null;
}

function stochTrigger4H(candles4h: Candle[], direction: "LONG" | "SHORT", pair: string): TriggerResult {
  const config = getPairConfig(pair);
  const defaultFail = {
    fired: false,
    detail: "Insufficient 4H data",
    triggerType: "none",
    stochK: 50,
    stochD: 50,
  };
  if (candles4h.length < 35) return defaultFail;

  const closes = candles4h.map(c => c.close);
  const stoch = stochRsi(closes);

  let fired = false;
  let detail = "";
  let triggerType = "none";

  // ── v50.5: Check for actual cross first ──
  const recentCross = findRecentCross(candles4h, direction, pair);

  if (direction === "LONG") {
    // ── Actual cross found ──
    if (recentCross) {
      const crossWasDeep = recentCross.crossStochK < STOCH_MIDPOINT; // below 50
      const crossWasEarly = !crossWasDeep;
      const kAboveD = recentCross.currentStochK >= recentCross.currentStochD;

      if (crossWasDeep && kAboveD) {
        fired = true;
        triggerType = "entry_1_deep_pullback";
        detail = `ENTRY_1: K crossed above D ${candles4h.length - 1 - recentCross.crossIndex} candles ago below 50 (cross K=${recentCross.crossStochK}, now K=${recentCross.currentStochK}, D=${recentCross.currentStochD})`;
      } else if (crossWasEarly && kAboveD) {
        fired = true;
        triggerType = "entry_2_early_momentum";
        detail = `ENTRY_2: K crossed above D ${candles4h.length - 1 - recentCross.crossIndex} candles ago (cross K=${recentCross.crossStochK}, now K=${recentCross.currentStochK}, D=${recentCross.currentStochD})`;
      } else if (!kAboveD) {
        detail = `Cross found but K=${recentCross.currentStochK} < D=${recentCross.currentStochD} (cross faded)`;
      }
    }
    // ── Pre-cross: K converging toward D from below ──
    else if (config.preCrossEnabled) {
      const prevCloses = closes.slice(0, -1);
      const prevStoch = stochRsi(prevCloses);
      const converging = stoch.k < stoch.d && stoch.k > prevStoch.k; // K rising toward D
      const closeEnough = Math.abs(stoch.k - stoch.d) <= config.preCrossThreshold;
      const belowMidpoint = stoch.k < STOCH_MIDPOINT;

      if (converging && closeEnough && belowMidpoint) {
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
    // ── Actual cross found ──
    if (recentCross) {
      const crossWasDeep = recentCross.crossStochK > STOCH_MIDPOINT; // above 50
      const crossWasEarly = !crossWasDeep;
      const kBelowD = recentCross.currentStochK <= recentCross.currentStochD;

      if (crossWasDeep && kBelowD) {
        fired = true;
        triggerType = "entry_1_deep_pullback";
        detail = `ENTRY_1: K crossed below D ${candles4h.length - 1 - recentCross.crossIndex} candles ago above 50 (cross K=${recentCross.crossStochK}, now K=${recentCross.currentStochK}, D=${recentCross.currentStochD})`;
      } else if (crossWasEarly && kBelowD) {
        fired = true;
        triggerType = "entry_2_early_momentum";
        detail = `ENTRY_2: K crossed below D ${candles4h.length - 1 - recentCross.crossIndex} candles ago (cross K=${recentCross.crossStochK}, now K=${recentCross.currentStochK}, D=${recentCross.currentStochD})`;
      } else if (!kBelowD) {
        detail = `Cross found but K=${recentCross.currentStochK} > D=${recentCross.currentStochD} (cross faded)`;
      }
    }
    // ── Pre-cross: K converging toward D from above ──
    else if (config.preCrossEnabled) {
      const prevCloses = closes.slice(0, -1);
      const prevStoch = stochRsi(prevCloses);
      const converging = stoch.k > stoch.d && stoch.k < prevStoch.k; // K falling toward D
      const closeEnough = Math.abs(stoch.k - stoch.d) <= config.preCrossThreshold;
      const aboveMidpoint = stoch.k > STOCH_MIDPOINT;

      if (converging && closeEnough && aboveMidpoint) {
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

  return { fired, detail, triggerType, stochK: stoch.k, stochD: stoch.d };
}

// ============================================================
// ADD TRIGGER — v50.5: Continuation (2 of 3 confirmations)
// ============================================================

interface AddTriggerResult {
  fired: boolean;
  detail: string;
  confirmations: string[];
  stochK: number;
  stochD: number;
}

function addTrigger4H(
  candles4h: Candle[],
  direction: "LONG" | "SHORT",
  location: LocationResult,
  pair: string
): AddTriggerResult {
  const _config = getPairConfig(pair); // available for future pair-specific ADD logic
  const defaultFail = {
    fired: false,
    detail: "No ADD conditions met",
    confirmations: [] as string[],
    stochK: 50,
    stochD: 50,
  };
  if (candles4h.length < 30) return defaultFail;

  const price = candles4h[candles4h.length - 1].close;
  const prev = candles4h[candles4h.length - 2];
  const last = candles4h[candles4h.length - 1];
  const closes = candles4h.map(c => c.close);
  const stoch = stochRsi(closes);

  const confirmations: string[] = [];

  // Confirmation 1: Price is beyond trendline (location already validated this)
  if (location.locationType === "BEYOND_TL") {
    confirmations.push("beyond_tl");
  }

  // Confirmation 2: Confirming candle pattern
  if (direction === "LONG" && last.close > last.open && last.close > prev.close) {
    confirmations.push("confirming_candle");
  } else if (direction === "SHORT" && last.close < last.open && last.close < prev.close) {
    confirmations.push("confirming_candle");
  }

  // Confirmation 3: StochRSI momentum aligned with trend
  if (direction === "LONG" && stoch.k > stoch.d) {
    confirmations.push("stoch_momentum");
  } else if (direction === "SHORT" && stoch.k < stoch.d) {
    confirmations.push("stoch_momentum");
  }

  // Require at least 2 of 3 confirmations
  const fired = confirmations.length >= 2;
  const detail = fired
    ? `ADD fired with ${confirmations.length}/3 confirmations: ${confirmations.join(", ")}`
    : `ADD blocked: only ${confirmations.length}/3 confirmations (${confirmations.join(", ")})`;

  return { fired, detail, confirmations, stochK: stoch.k, stochD: stoch.d };
}

// ============================================================
// COOLDOWN & ACTIVE TRADE MANAGEMENT
// ============================================================

interface CooldownEntry {
  until: number;
  entryPrice: number;
  stop: number;
  target: number;
  type: "ENTRY_1" | "ENTRY_2" | "ADD";
}

const cooldownStore: Map<string, CooldownEntry> = new Map();

function isOnCooldown(pair: string, now: number, currentPrice?: number): boolean {
  const entry = cooldownStore.get(pair);
  if (!entry) return false;

  if (currentPrice !== undefined) {
    const hitTP = Math.abs(currentPrice - entry.target) / entry.target < 0.001;
    const hitSL = Math.abs(currentPrice - entry.stop) / entry.stop < 0.001;
    if (hitTP || hitSL) {
      cooldownStore.delete(pair);
      return false;
    }
  }

  // Early release: 90 minutes before cooldown ends
  if (now >= entry.until - (3 * 60 * 60 * 1000) + (90 * 60 * 1000)) {
    cooldownStore.delete(pair);
    return false;
  }

  return now < entry.until;
}

function setCooldown(pair: string, now: number, entryPrice: number, stop: number, target: number, type: "ENTRY_1" | "ENTRY_2" | "ADD"): void {
  const duration = type === "ADD" ? 4 * 60 * 60 * 1000 : COOLDOWN_MS;
  cooldownStore.set(pair, {
    until: now + duration,
    entryPrice,
    stop,
    target,
    type,
  });
}

function checkCooldownEarlyRelease(pair: string, currentPrice: number): void {
  const entry = cooldownStore.get(pair);
  if (!entry) return;

  const hitTP = Math.abs(currentPrice - entry.target) / entry.target < 0.001;
  const hitSL = Math.abs(currentPrice - entry.stop) / entry.stop < 0.001;
  const ninetyMinElapsed = Date.now() >= entry.until - (3 * 60 * 60 * 1000) + (90 * 60 * 1000);

  if (hitTP || hitSL || ninetyMinElapsed) {
    cooldownStore.delete(pair);
  }
}

// ============================================================
// ACTIVE SIGNAL TRACKING
// ============================================================

interface ActiveSignalState {
  pair: string;
  scale: "ENTRY_1" | "ENTRY_2" | "ADD";
  timestamp: number;
  entryPrice: number;
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

function setActiveSignal(pair: string, scale: "ENTRY_1" | "ENTRY_2" | "ADD", entryPrice: number): void {
  activeSignalStore.set(pair, {
    pair,
    scale,
    timestamp: Date.now(),
    entryPrice,
  });
}

function canAddToPair(pair: string): boolean {
  const state = activeSignalStore.get(pair);
  if (!state) return false;
  if (state.scale === "ADD") return false;
  const age = Date.now() - state.timestamp;
  if (age < 60 * 60 * 1000) return false;
  if (age > 24 * 60 * 60 * 1000) {
    activeSignalStore.delete(pair);
    return false;
  }
  return true;
}

// ============================================================
// MAIN SIGNAL GENERATOR — v50.5
// ============================================================

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

  checkCooldownEarlyRelease(pair, price);

  const hasActive = activeSignals.some(s => s.pair === pair && !s.exited) || hasActiveSignal(pair);

  // ── Step 1: Daily Trend ──
  const candles1d = aggregateTo1D(candles4h);
  const trend = dailyTrend(candles1d);
  debug.push(`Trend: ${trend.direction} | ${trend.detail}`);
  if (trend.direction === "NONE") {
    debug.push("Rejected: no trend");
    return { debug };
  }

  // ── Step 2: 4H Location ──
  const location = location4H(pair, candles4h, trend.direction);
  debug.push(`Location: ${location.ready ? "READY" : "WAIT"} | ${location.detail}`);
  if (!location.ready) {
    debug.push("Rejected: location not ready");
    return { debug };
  }

  // ── Step 3: Determine signal type ──
  let signalType: "ENTRY_1" | "ENTRY_2" | "ADD" | null = null;
  let trigger: TriggerResult | AddTriggerResult | null = null;

  // ENTRY_1 or ENTRY_2: only when location is pullback zone (not beyond TL)
  if (!hasActive && location.locationType !== "BEYOND_TL") {
    const entryTrigger = stochTrigger4H(candles4h, trend.direction, pair);
    debug.push(`Trigger: ${entryTrigger.fired ? "FIRED" : "WAITING"} | ${entryTrigger.detail}`);
    if (entryTrigger.fired) {
      if (entryTrigger.triggerType === "entry_1_deep_pullback") {
        signalType = "ENTRY_1";
      } else if (entryTrigger.triggerType === "entry_2_early_momentum" || entryTrigger.triggerType === "entry_2_pre_cross") {
        signalType = "ENTRY_2";
      }
      trigger = entryTrigger;
    }
  } else if (!hasActive && location.locationType === "BEYOND_TL") {
    debug.push("ENTRY blocked: price beyond TL (ADD zone)");
  }

  // ADD: only when we have an active entry and location is beyond TL
  if (!signalType && canAddToPair(pair) && !hasActiveAdd(pair) && location.locationType === "BEYOND_TL") {
    const addTrigger = addTrigger4H(candles4h, trend.direction, location, pair);
    debug.push(`ADD: ${addTrigger.fired ? "FIRED" : "BLOCKED"} | ${addTrigger.detail}`);
    if (addTrigger.fired) {
      signalType = "ADD";
      trigger = addTrigger;
    }
  } else if (!signalType && canAddToPair(pair) && !hasActiveAdd(pair) && location.locationType !== "BEYOND_TL") {
    debug.push("ADD blocked: price not beyond TL");
  }

  if (!signalType) {
    if (hasActive) {
      debug.push("No signal: active trade exists");
    } else {
      debug.push("Rejected: no trigger");
    }
    return { debug };
  }

  // ── Step 4: Check cooldown ──
  if (isOnCooldown(pair, now, price)) {
    const entry = cooldownStore.get(pair);
    const mins = entry ? Math.round((entry.until - now) / 60000) : 0;
    debug.push(`Rejected: cooldown (${mins}min)`);
    return { debug };
  }

  // ── Step 5: Calculate levels ──
  const atrVal = atr(candles4h, 14);
  const recent4h = candles4h.slice(-20);
  const swingLow = Math.min(...recent4h.map(c => c.low));
  const swingHigh = Math.max(...recent4h.map(c => c.high));

  let stop: number;
  let target: number;

  if (signalType === "ENTRY_1" || signalType === "ENTRY_2") {
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
  } else {
    // ADD: tighter stop for continuation
    if (trend.direction === "LONG") {
      const atrStop = price - atrVal * 1.5;
      const tlStop = location.trendlinePrice > 0 ? location.trendlinePrice * 0.995 : atrStop;
      stop = Math.max(atrStop, tlStop, swingLow);
      const minTarget = price + (price - stop) * MIN_RR;
      target = Math.max(swingHigh, minTarget);
    } else {
      const atrStop = price + atrVal * 1.5;
      const tlStop = location.trendlinePrice > 0 ? location.trendlinePrice * 1.005 : atrStop;
      stop = Math.min(atrStop, tlStop, swingHigh);
      const minTarget = price - (stop - price) * MIN_RR;
      target = Math.min(swingLow, minTarget);
    }
  }

  const risk = Math.abs(price - stop);
  const reward = Math.abs(target - price);
  const rr = risk > 0 ? reward / risk : 0;

  // v50.4: RR is calculated and included but never blocks the signal
  // ── Step 6: Build signal ──
  setCooldown(pair, now, price, stop, target, signalType);
  setActiveSignal(pair, signalType, price);

  const rsi4h = wilderRsi(candles4h.map(c => c.close));
  const adxVal = adx(candles4h);
  const triggerResult = trigger as TriggerResult | AddTriggerResult;

  const reasonPrefix = signalType === "ENTRY_1"
    ? `ENTRY_1 | Deep pullback reversal | ${trend.direction}`
    : signalType === "ENTRY_2"
    ? `ENTRY_2 | Early momentum continuation | ${trend.direction}`
    : `ADD | Trend continuation scaling | ${trend.direction}`;

  const signal: Signal = {
    id: `${pair}_${signalType}_${now}`,
    pair,
    direction: trend.direction,
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
    reason: `${reasonPrefix} | ${location.detail} | ${triggerResult.detail}`,
    timestamp: now,
    version: CURRENT_SIGNAL_VERSION,
    trend: trend.direction,
    location: location.detail,
    trigger: triggerResult.detail,
  };

  debug.push(`SIGNAL: ${signalType} ${trend.direction} ${pair} | Entry $${signal.entry} | SL $${signal.stop} | TP $${signal.target} | RR ${signal.rr}`);

  // ── Step 7: Market snapshot ──
  const closes4h = candles4h.map(c => c.close);
  const ema8_4h = ema(closes4h, 8);
  const ema21_4h = ema(closes4h, 21);

  const distToTrendline = location.trendlinePrice > 0
    ? Math.round(Math.abs((price - location.trendlinePrice) / location.trendlinePrice) * 10000) / 100
    : null;

  const market: MarketSnapshot = {
    pair,
    price: Math.round(price * 100) / 100,
    timestamp: now,
    trend: trend.direction,
    location: location.ready ? "READY" : "WAIT",
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
  };

  return { signal, market, debug };
}

// ============================================================
// MARKET SNAPSHOT
// ============================================================

export function getMarketSnapshot(
  pair: string,
  candles1h: Candle[],
  candles4h: Candle[],
  candles15m: Candle[]
): MarketSnapshot {
  const candles1d = aggregateTo1D(candles4h);
  const trend = dailyTrend(candles1d);
  const location = trend.direction !== "NONE" ? location4H(pair, candles4h, trend.direction) : { ready: false, detail: "No trend", trendlinePrice: 0, locationType: "NONE" };
  const trigger = trend.direction !== "NONE" ? stochTrigger4H(candles4h, trend.direction, pair) : { fired: false, detail: "No trend", triggerType: "none", stochK: 50, stochD: 50 };
  const price = candles4h[candles4h.length - 1]?.close ?? 0;

  const closes4h = candles4h.map(c => c.close);
  const ema8_4h = ema(closes4h, 8);
  const ema21_4h = ema(closes4h, 21);

  const distToTrendline = location.trendlinePrice > 0
    ? Math.round(Math.abs((price - location.trendlinePrice) / location.trendlinePrice) * 10000) / 100
    : null;

  return {
    pair,
    price: Math.round(price * 100) / 100,
    timestamp: Date.now(),
    trend: trend.direction,
    location: location.ready ? "READY" : "WAIT",
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
  };
}

// ============================================================
// VALIDITY & HOLD MANAGEMENT
// ============================================================

export function isSignalStillValid(signal: Signal, currentPrice: number, now: number = Date.now()): ValidityCheck {
  const ageMs = now - signal.timestamp;
  const maxAge = signal.type === "ENTRY_1" || signal.type === "ENTRY_2" ? 24 * 60 * 60 * 1000 : 4 * 60 * 60 * 1000;
  if (ageMs > maxAge) {
    return { valid: false, reason: "expired_ttl", exited: true };
  }
  const entryBuffer = signal.type === "ENTRY_1" || signal.type === "ENTRY_2" ? 1.02 : 1.005;
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
  // v50.5 FIX: Removed stoch_extreme_opposite exit. Signals now hold until TP/SL hit.
  // The stoch extreme was causing premature exits in strong trends.
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
    if (check.valid) {
      active.push(signal);
    } else {
      // v50.5 FIX: Keep TP_HIT and SL_HIT signals in active list with exited flag
      // so they remain visible in the UI until user acknowledges
      if (check.reason === "tp_hit" || check.reason === "sl_hit") {
        signal.exited = true;
        signal.exitReason = check.reason;
        signal.exitPrice = price;
        active.push(signal);
      }
      exited.push({ signal, reason: check.reason });
    }
  }
  return { active, exited };
}

export type TradeStatus = "ACTIVE" | "TP_HIT" | "SL_HIT" | "EXPIRED";

export function checkTradeStatus(signal: Signal, currentPrice: number, now: number = Date.now()): TradeStatus {
  // v50.5: Check exited flag first
  if (signal.exited) {
    return signal.exitReason === "tp_hit" ? "TP_HIT" : signal.exitReason === "sl_hit" ? "SL_HIT" : "EXPIRED";
  }
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


export interface PersistedTrade {
  direction: "LONG" | "SHORT";
  timestamp: number;
  entry: number;
  stop: number;
  target: number;
  id: string;
  type: "ENTRY_1" | "ENTRY_2" | "ADD";
}

/**
 * Rebuild in-memory state from persisted KV data.
 * Call this at cron startup before generateSignal().
 */
export function rebuildStateFromTrades(activeTrades: Record<string, PersistedTrade>): void {
  for (const [pair, trade] of Object.entries(activeTrades)) {
    if (!trade || !trade.direction) continue;

    // Rebuild activeSignalStore
    activeSignalStore.set(pair, {
      pair,
      scale: trade.type,
      timestamp: trade.timestamp,
      entryPrice: trade.entry,
    });

    // Rebuild cooldownStore
    const duration = trade.type === "ADD" ? 4 * 60 * 60 * 1000 : COOLDOWN_MS;
    cooldownStore.set(pair, {
      until: trade.timestamp + duration,
      entryPrice: trade.entry,
      stop: trade.stop,
      target: trade.target,
      type: trade.type,
    });

    console.log(`[STATE_REBUILD] ${pair}: ${trade.type} ${trade.direction} @ ${trade.entry}`);
  }
}

/**
 * Clear all in-memory state. Call on graceful shutdown if needed.
 */
export function clearAllState(): void {
  trendlineStore.clear();
  cooldownStore.clear();
  activeSignalStore.clear();
  console.log("[STATE] All in-memory state cleared");
}

// ============================================================
// COMPATIBILITY LAYER
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
  const activeSignals: Signal[] = [];
  if (activeTrades) {
    for (const [p, t] of Object.entries(activeTrades)) {
      if (t && t.direction) {
        activeSignals.push({
          id: t.id || `${p}_${t.timestamp}`,
          pair: p,
          direction: t.direction,
          type: "ENTRY_1",
          scale: "ENTRY_1",
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
