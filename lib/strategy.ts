// lib/strategy.ts — v50.1 "First Wave Hybrid"
// ============================================================
// Architecture: Daily Trend → 4H Location → 4H Stoch Trigger → Entry/ADD
// Philosophy: Capture the first pullback in a daily trend.
// v50 clean structure + v28 frequency characteristics.
//
// Changes from v50:
// 1. R² soft floor at 0.10 (was 0.30 hard reject)
// 2. Trigger moved from 15M back to 4H StochRSI
// 3. TL proximity 4% (was 2%), swing proximity 3% (was 0.8%)
// 4. ENTRY_1: deep pullback (Stoch extreme zone)
// 5. ENTRY_2: early momentum (Stoch below/above midpoint)
// 6. ADD: continuation after active entry (2 of 3 confirmations)
// 7. No scoring, no confidence, no AI, no volume gates

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

export const CURRENT_SIGNAL_VERSION = 50.1;
const MIN_RR = 1.5;
const TL_PROXIMITY = 0.040;        // 4% — captures imperfect pullbacks
const SWING_PROXIMITY = 0.030;     // 3% — captures imperfect swing entries
const STOCH_EXTREME_LONG = 25;     // Deep pullback zone for ENTRY_1
const STOCH_EXTREME_SHORT = 75;    // Deep pullback zone for ENTRY_1
const STOCH_MIDPOINT = 50;         // Midpoint for ENTRY_2 discrimination
const R2_MINIMUM = 0.10;           // Soft floor — reject only garbage fits
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
// TRENDLINE ENGINE — v50.1: R² soft floor at 0.10
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

  const recentPivots = pivots.slice(-5);
  console.log(`[TL ${pair}] recentPivots=${recentPivots.length} lastPivotPrice=${recentPivots[recentPivots.length-1].price.toFixed(2)}`);

  const existing = trendlineStore.get(pair);

  if (existing && existing.direction === direction) {
    const age = now - existing.lastUpdated;
    const lastPivot = recentPivots[recentPivots.length - 1];
    const projected = existing.slope * lastPivot.index + existing.intercept;
    const deviation = Math.abs(lastPivot.price - projected) / projected;

    console.log(`[TL ${pair}] CACHED: r²=${existing.r2.toFixed(3)} age=${(age/60000).toFixed(1)}min deviation=${(deviation*100).toFixed(2)}%`);

    if (deviation > 0.02) {
      console.log(`[TL ${pair}] CACHE REJECT: deviation ${(deviation*100).toFixed(2)}% > 2%`);
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

  // v50.1: Soft floor at R² >= 0.10. Reject only garbage fits.
  if (fit.r2 < R2_MINIMUM) {
    console.log(`[TL ${pair}] REJECT: r² ${fit.r2.toFixed(3)} < ${R2_MINIMUM} (garbage fit)`);
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
// 4H LOCATION — v50.1: 4% TL, 3% swing, BEYOND_TL for ADD
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
  const price = candles4h[candles4h.length - 1].close;
  const tl = getTrendline(pair, candles4h, direction);

  if (tl) {
    const dist = Math.abs(price - tl.price) / tl.price;
    console.log(`[LOC ${pair}] TL found: price=${price.toFixed(2)} tlPrice=${tl.price.toFixed(2)} dist=${(dist*100).toFixed(2)}% proximity=${(TL_PROXIMITY*100).toFixed(2)}%`);

    // ENTRY zone: price near trendline (within 4%)
    if (dist < TL_PROXIMITY) {
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
      ? price > tl.price * 1.008   // LONG: price above TL (broke resistance)
      : price < tl.price * 0.992;  // SHORT: price below TL (broke support)

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

    console.log(`[LOC ${pair}] TL too far: ${(dist*100).toFixed(2)}% >= ${(TL_PROXIMITY*100).toFixed(2)}%`);
  } else {
    console.log(`[LOC ${pair}] No TL, falling back to swing`);
  }

  // Swing fallback — 3% proximity
  const recent = candles4h.slice(-20);
  if (direction === "LONG") {
    const swingLow = Math.min(...recent.map(c => c.low));
    const dist = (price - swingLow) / swingLow;
    console.log(`[LOC ${pair}] SWING_LONG: price=${price.toFixed(2)} swingLow=${swingLow.toFixed(2)} dist=${(dist*100).toFixed(2)}% proximity=${(SWING_PROXIMITY*100).toFixed(2)}%`);
    if (dist >= 0 && dist < SWING_PROXIMITY) {
      console.log(`[LOC ${pair}] SWING_LOW READY`);
      return {
        ready: true,
        detail: `Swing low ${(dist * 100).toFixed(2)}%`,
        trendlinePrice: swingLow,
        locationType: "SWING_LOW"
      };
    }
  } else {
    const swingHigh = Math.max(...recent.map(c => c.high));
    const dist = (swingHigh - price) / swingHigh;
    console.log(`[LOC ${pair}] SWING_SHORT: price=${price.toFixed(2)} swingHigh=${swingHigh.toFixed(2)} dist=${(dist*100).toFixed(2)}% proximity=${(SWING_PROXIMITY*100).toFixed(2)}%`);
    if (dist >= 0 && dist < SWING_PROXIMITY) {
      console.log(`[LOC ${pair}] SWING_HIGH READY`);
      return {
        ready: true,
        detail: `Swing high ${(dist * 100).toFixed(2)}%`,
        trendlinePrice: swingHigh,
        locationType: "SWING_HIGH"
      };
    }
  }
  console.log(`[LOC ${pair}] No valid location`);
  return { ready: false, detail: "No valid location", trendlinePrice: tl?.price || 0, locationType: "NONE" };
}

// ============================================================
// 4H STOCHRSI TRIGGER — ENTRY_1 and ENTRY_2
// ============================================================

interface TriggerResult {
  fired: boolean;
  detail: string;
  triggerType: string;
  stochK: number;
  stochD: number;
}

function stochTrigger4H(candles4h: Candle[], direction: "LONG" | "SHORT"): TriggerResult {
  const defaultFail = {
    fired: false,
    detail: "Insufficient 4H data",
    triggerType: "none",
    stochK: 50,
    stochD: 50,
  };
  if (candles4h.length < 30) return defaultFail;

  const closes = candles4h.map(c => c.close);
  const prevCloses = closes.slice(0, -1);
  const stoch = stochRsi(closes);
  const prevStoch = stochRsi(prevCloses);

  let fired = false;
  let detail = "";
  let triggerType = "none";

  if (direction === "LONG") {
    // ENTRY_1: Deep pullback — K crosses above D from extreme zone
    if (prevStoch.k < STOCH_EXTREME_LONG && prevStoch.k < prevStoch.d && stoch.k >= stoch.d) {
      fired = true;
      triggerType = "entry_1_deep_pullback";
      detail = `ENTRY_1: K crossed above D from deep pullback (prev K=${prevStoch.k}, now K=${stoch.k}, D=${stoch.d})`;
    }
    // ENTRY_2: Early momentum — K crosses above D, below midpoint
    else if (prevStoch.k < STOCH_MIDPOINT && prevStoch.k < prevStoch.d && stoch.k >= stoch.d) {
      fired = true;
      triggerType = "entry_2_early_momentum";
      detail = `ENTRY_2: K crossed above D below midpoint (prev K=${prevStoch.k}, now K=${stoch.k}, D=${stoch.d})`;
    }
  } else {
    // ENTRY_1: Deep pullback — K crosses below D from extreme zone
    if (prevStoch.k > STOCH_EXTREME_SHORT && prevStoch.k > prevStoch.d && stoch.k <= stoch.d) {
      fired = true;
      triggerType = "entry_1_deep_pullback";
      detail = `ENTRY_1: K crossed below D from deep pullback (prev K=${prevStoch.k}, now K=${stoch.k}, D=${stoch.d})`;
    }
    // ENTRY_2: Early momentum — K crosses below D, above midpoint
    else if (prevStoch.k > STOCH_MIDPOINT && prevStoch.k > prevStoch.d && stoch.k <= stoch.d) {
      fired = true;
      triggerType = "entry_2_early_momentum";
      detail = `ENTRY_2: K crossed below D above midpoint (prev K=${prevStoch.k}, now K=${stoch.k}, D=${stoch.d})`;
    }
  }

  if (!fired) {
    detail = `No trigger. Stoch K=${stoch.k} D=${stoch.d} | prev K=${prevStoch.k} D=${prevStoch.d}`;
  }
  return { fired, detail, triggerType, stochK: stoch.k, stochD: stoch.d };
}

// ============================================================
// ADD TRIGGER — v50.1: Continuation (2 of 3 confirmations, no volume gate)
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
  location: LocationResult
): AddTriggerResult {
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
// MAIN SIGNAL GENERATOR — v50.1
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
    const entryTrigger = stochTrigger4H(candles4h, trend.direction);
    debug.push(`Trigger: ${entryTrigger.fired ? "FIRED" : "WAITING"} | ${entryTrigger.detail}`);
    if (entryTrigger.fired) {
      if (entryTrigger.triggerType === "entry_1_deep_pullback") {
        signalType = "ENTRY_1";
      } else if (entryTrigger.triggerType === "entry_2_early_momentum") {
        signalType = "ENTRY_2";
      }
      trigger = entryTrigger;
    }
  } else if (!hasActive && location.locationType === "BEYOND_TL") {
    debug.push("ENTRY blocked: price beyond TL (ADD zone)");
  }

  // ADD: only when we have an active entry and location is beyond TL
  if (!signalType && canAddToPair(pair) && !hasActiveAdd(pair) && location.locationType === "BEYOND_TL") {
    const addTrigger = addTrigger4H(candles4h, trend.direction, location);
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

  if (rr < MIN_RR) {
    debug.push(`Rejected: RR ${rr.toFixed(2)} < ${MIN_RR}`);
    return { debug };
  }

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
  const trigger = trend.direction !== "NONE" ? stochTrigger4H(candles4h, trend.direction) : { fired: false, detail: "No trend", triggerType: "none", stochK: 50, stochD: 50 };
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
