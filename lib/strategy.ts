// lib/strategy.ts — v44.1 "Confirmed Sequence" — Production Build
// ============================================================

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
  entry: number;
  stop: number;
  target: number;
  confidence: number;
  timestamp: number;
  exited: boolean;
  status?: "ACTIVE" | "EXITED";
  exitReason?: string;
  exitTimestamp?: number;
  exitPrice?: number;
  entryType?: "PULLBACK";
  rr?: number;
  adx?: number;
  stochK?: number;
  stochD?: number;
  version?: number;
  setupGrade?: "A" | "B";
  positionSizePct?: number;
  triggerCandle?: {
    open: number;
    high: number;
    low: number;
    close: number;
    timestamp: number;
  };
  checklist?: SetupChecklist;
}

export interface SignalResult {
  signal?: Signal;
  debug: string[];
}

export interface HoldResult {
  shouldHold: boolean;
  reason: string;
}

export interface TrendResult {
  direction: "LONG" | "SHORT" | "NEUTRAL";
  strength: "STRONG" | "MEDIUM" | "WEAK";
  adx: number | null;
  ema8: number | null;
  ema21: number | null;
  ema50: number | null;
  hh: boolean;
  hl: boolean;
  lh: boolean;
  ll: boolean;
  debug: string[];
}

// ─── CHECKLIST TYPES ───────────────────────────────────────

export interface CheckItem {
  name: string;
  passed: boolean;
  detail: string;
}

export interface SetupChecklist {
  bias: CheckItem;
  location: CheckItem;
  trigger: CheckItem;
  timing: CheckItem | null;
  grade: "A" | "B" | null;
  allPassed: boolean;
}

// ─── CONSTANTS ─────────────────────────────────────────────

export const CURRENT_SIGNAL_VERSION = 44.1;
const MIN_RR = 1.5;
const MAX_STOP_PCT = 0.04;
const ATR_MULT = 1.5;
const STOCH_OVERSOLD = 20;
const STOCH_OVERBOUGHT = 80;
const MIN_ADX = 20;
const TRENDLINE_PROXIMITY_PCT = 0.012;
const VOL_THRESHOLD = 1.2;
const HYSTERESIS_ENTRY_MS = 4 * 60 * 60 * 1000;
const COOLDOWN_STOP_MS = 2 * 60 * 60 * 1000;
const COOLDOWN_TP_MS = 1 * 60 * 60 * 1000;
const SIGNAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const SIZE_A = 1.0;
const SIZE_B = 0.65;

// ─── HELPERS ───────────────────────────────────────────────

function avg(arr: number[]): number {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
}

function isValid(v: any): boolean {
  return typeof v === "number" && Number.isFinite(v);
}

function sf(v: number, d: number): string {
  return isValid(v) ? v.toFixed(d) : "0";
}

// ─── EMA ───────────────────────────────────────────────────

export function ema(values: number[], period: number): number[] {
  if (values.length < period || !values.every(isValid)) return [];
  const k = 2 / (period + 1);
  const out: number[] = [];
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out.push(prev);
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out.push(prev);
  }
  return out.every(isValid) ? out : [];
}

// ─── RSI (Wilder) ──────────────────────────────────────────

export function wilderRsi(values: number[], period = 14): number | null {
  if (values.length < period + 1 || !values.every(isValid)) return null;
  const diffs: number[] = [];
  for (let i = 1; i < values.length; i++) diffs.push(values[i] - values[i - 1]);
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

// ─── StochRSI ──────────────────────────────────────────────

export function stochRsi(
  values: number[],
  rsiPeriod = 14,
  stochPeriod = 14,
  kSmooth = 3,
  dSmooth = 3
): { k: number; d: number; prevK: number | null; prevD: number | null } {
  if (!values.every(isValid)) return { k: 50, d: 50, prevK: null, prevD: null };
  const rsiValues: number[] = [];
  for (let i = rsiPeriod; i < values.length; i++) {
    const r = wilderRsi(values.slice(0, i + 1), rsiPeriod);
    if (r !== null) rsiValues.push(r);
  }
  if (rsiValues.length < stochPeriod + kSmooth) {
    const last = rsiValues[rsiValues.length - 1] ?? 50;
    return { k: last, d: 50, prevK: null, prevD: null };
  }
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
  if (kValues.length < dSmooth + 1) {
    const k = kValues[kValues.length - 1] ?? 50;
    return { k: Math.round(k * 10) / 10, d: Math.round(k * 10) / 10, prevK: null, prevD: null };
  }
  const dValues: number[] = [];
  for (let i = dSmooth - 1; i < kValues.length; i++) {
    dValues.push(avg(kValues.slice(i - dSmooth + 1, i + 1)));
  }
  return {
    k: Math.round(kValues[kValues.length - 1] * 10) / 10,
    d: Math.round(dValues[dValues.length - 1] * 10) / 10,
    prevK: kValues.length >= 2 ? Math.round(kValues[kValues.length - 2] * 10) / 10 : null,
    prevD: dValues.length >= 2 ? Math.round(dValues[dValues.length - 2] * 10) / 10 : null,
  };
}

// ─── ADX ───────────────────────────────────────────────────

export function adx(candles: Candle[], period = 14): number | null {
  if (candles.length < period * 2) return null;
  const h = candles.map(c => c.high), l = candles.map(c => c.low), c = candles.map(c => c.close);
  const trs: number[] = [], pDM: number[] = [], mDM: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    trs.push(Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1])));
    pDM.push(h[i] - h[i - 1] > l[i - 1] - l[i] ? Math.max(h[i] - h[i - 1], 0) : 0);
    mDM.push(l[i - 1] - l[i] > h[i] - h[i - 1] ? Math.max(l[i - 1] - l[i], 0) : 0);
  }
  const wilderSmooth = (vals: number[], lookback: number) => {
    const r = [avg(vals.slice(0, lookback))];
    for (let i = lookback; i < vals.length; i++) {
      r.push((r[r.length - 1] * (lookback - 1) + vals[i]) / lookback);
    }
    return r;
  };
  const atrS = wilderSmooth(trs, period);
  const pDIS = wilderSmooth(pDM, period);
  const mDIS = wilderSmooth(mDM, period);
  const pDI = atrS.map((_, i) => (pDIS[i] / atrS[i]) * 100);
  const mDI = atrS.map((_, i) => (mDIS[i] / atrS[i]) * 100);
  const dx = atrS.map((_, i) => {
    const sum = pDI[i] + mDI[i];
    return sum === 0 ? 0 : (Math.abs(pDI[i] - mDI[i]) / sum) * 100;
  });
  const adxS = wilderSmooth(dx, period);
  const v = adxS[adxS.length - 1];
  return isValid(v) ? Math.round(v * 10) / 10 : null;
}

// ─── ATR ───────────────────────────────────────────────────

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

function atrHistory(candles: Candle[], period = 14): number[] {
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    trs.push(Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close)
    ));
  }
  const out: number[] = [];
  for (let i = period - 1; i < trs.length; i++) {
    out.push(avg(trs.slice(i - period + 1, i + 1)));
  }
  return out;
}

// ─── 4H BIAS ───────────────────────────────────────────────

export function calculateTrend4H(candles4h: Candle[]): TrendResult {
  const debug: string[] = [];
  if (candles4h.length < 50) {
    debug.push("[BIAS-4H] Insufficient data");
    return { direction: "NEUTRAL", strength: "WEAK", adx: null, ema8: null, ema21: null, ema50: null, hh: false, hl: false, lh: false, ll: false, debug };
  }

  const closes = candles4h.map(c => c.close);
  const e8 = ema(closes, 8);
  const e21 = ema(closes, 21);
  const e50 = ema(closes, 50);

  if (!e8.length || !e21.length || !e50.length) {
    debug.push("[BIAS-4H] EMA calc failed");
    return { direction: "NEUTRAL", strength: "WEAK", adx: null, ema8: null, ema21: null, ema50: null, hh: false, hl: false, lh: false, ll: false, debug };
  }

  const lastE8 = e8[e8.length - 1];
  const lastE21 = e21[e21.length - 1];
  const lastE50 = e50[e50.length - 1];
  const lastClose = closes[closes.length - 1];

  const recent = candles4h.slice(-20);
  const highs = recent.map(c => c.high);
  const lows = recent.map(c => c.low);
  const hh = highs[highs.length - 1] > Math.max(...highs.slice(0, -1));
  const ll = lows[lows.length - 1] < Math.min(...lows.slice(0, -1));
  const hl = lows[lows.length - 1] > Math.min(...lows.slice(0, -1)) && lows[lows.length - 1] > lows[lows.length - 3];
  const lh = highs[highs.length - 1] < Math.max(...highs.slice(0, -1)) && highs[highs.length - 1] < highs[highs.length - 3];

  const adxVal = adx(candles4h);

  let direction: TrendResult["direction"] = "NEUTRAL";
  let strength: TrendResult["strength"] = "WEAK";

  const emaAlignedLong = lastE8 > lastE21 && lastE21 > lastE50;
  const emaAlignedShort = lastE8 < lastE21 && lastE21 < lastE50;
  const priceAboveE21 = lastClose > lastE21;
  const priceBelowE21 = lastClose < lastE21;

  if (emaAlignedLong && priceAboveE21) {
    direction = "LONG";
    if (adxVal !== null && adxVal >= 25 && hh) strength = "STRONG";
    else if (adxVal !== null && adxVal >= 20) strength = "MEDIUM";
  } else if (emaAlignedShort && priceBelowE21) {
    direction = "SHORT";
    if (adxVal !== null && adxVal >= 25 && ll) strength = "STRONG";
    else if (adxVal !== null && adxVal >= 20) strength = "MEDIUM";
  }

  if (direction !== "NEUTRAL" && adxVal !== null && adxVal < 18) {
    debug.push(`[BIAS-4H] ADX ${adxVal} < 18 → NEUTRAL`);
    return { direction: "NEUTRAL", strength: "WEAK", adx: adxVal, ema8: lastE8, ema21: lastE21, ema50: lastE50, hh, hl, lh, ll, debug };
  }

  debug.push(`[BIAS-4H] ${direction} ${strength} | ADX=${sf(adxVal ?? 0,1)}`);
  return { direction, strength, adx: adxVal, ema8: lastE8, ema21: lastE21, ema50: lastE50, hh, hl, lh, ll, debug };
}

// ─── 1H LOCATION ───────────────────────────────────────────

interface Pivot { index: number; price: number; }

function findPivots(candles: Candle[], direction: "LONG" | "SHORT"): Pivot[] {
  const pivots: Pivot[] = [];
  for (let i = 3; i < candles.length - 3; i++) {
    const isSwingLow = candles[i].low < candles[i-1].low && candles[i].low < candles[i-2].low &&
                       candles[i].low < candles[i+1].low && candles[i].low < candles[i+2].low;
    const isSwingHigh = candles[i].high > candles[i-1].high && candles[i].high > candles[i-2].high &&
                        candles[i].high > candles[i+1].high && candles[i].high > candles[i+2].high;
    if (direction === "LONG" && isSwingLow) pivots.push({ index: i, price: candles[i].low });
    if (direction === "SHORT" && isSwingHigh) pivots.push({ index: i, price: candles[i].high });
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
  const sumY2 = pivots.reduce((s, p) => s + p.price * p.price, 0);
  const denom = n * sumX2 - sumX * sumX;
  if (denom === 0) return null;
  const slope = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;
  const ssTot = sumY2 - (sumY * sumY) / n;
  let ssRes = 0;
  for (const p of pivots) {
    const predicted = slope * p.index + intercept;
    ssRes += (p.price - predicted) ** 2;
  }
  const r2 = ssTot === 0 ? 1 : 1 - ssRes / ssTot;
  return { slope, intercept, r2 };
}

export interface TrendlineState {
  slope: number;
  intercept: number;
  lastUpdated: number;
  direction: "LONG" | "SHORT";
  r2: number;
}

export interface TrendlineStore {
  get(pair: string, direction: "LONG" | "SHORT"): Promise<TrendlineState | null>;
  set(pair: string, state: TrendlineState): Promise<void>;
}

class InMemoryTrendlineStore implements TrendlineStore {
  private map = new Map<string, TrendlineState>();
  private key(pair: string, direction: string) { return `${pair}:${direction}`; }
  async get(pair: string, direction: "LONG" | "SHORT"): Promise<TrendlineState | null> {
    return this.map.get(this.key(pair, direction)) ?? null;
  }
  async set(pair: string, state: TrendlineState): Promise<void> {
    this.map.set(this.key(pair, state.direction), state);
  }
}

export const defaultTrendlineStore = new InMemoryTrendlineStore();

export async function check1HLocation(
  pair: string,
  candles1h: Candle[],
  direction: "LONG" | "SHORT",
  trend: TrendResult,
  store: TrendlineStore = defaultTrendlineStore
): Promise<{ passed: boolean; detail: string; items: CheckItem[] }> {
  const items: CheckItem[] = [];

  if (candles1h.length < 50) {
    return { passed: false, detail: "Insufficient 1H data", items };
  }

  const lastPrice = candles1h[candles1h.length - 1].close;
  const closes1h = candles1h.map(c => c.close);
  const e21_1h = ema(closes1h, 21);
  const e50_1h = ema(closes1h, 50);
  const lastE21_1h = e21_1h[e21_1h.length - 1];
  const lastE50_1h = e50_1h[e50_1h.length - 1];

  let emaPullback = false;
  if (direction === "LONG") {
    emaPullback = lastPrice <= lastE21_1h * 1.005 || lastPrice <= lastE50_1h * 1.005;
    items.push({
      name: "EMA Pullback",
      passed: emaPullback,
      detail: emaPullback
        ? `Price ${sf(lastPrice,2)} near EMA21 ${sf(lastE21_1h,2)}`
        : `Price ${sf(lastPrice,2)} above EMA21 ${sf(lastE21_1h,2)}`
    });
  } else {
    emaPullback = lastPrice >= lastE21_1h * 0.995 || lastPrice >= lastE50_1h * 0.995;
    items.push({
      name: "EMA Pullback",
      passed: emaPullback,
      detail: emaPullback
        ? `Price ${sf(lastPrice,2)} near EMA21 ${sf(lastE21_1h,2)}`
        : `Price ${sf(lastPrice,2)} below EMA21 ${sf(lastE21_1h,2)}`
    });
  }

  const pivots = findPivots(candles1h, direction);
  let trendlineOk = false;
  if (pivots.length >= 3) {
    const recentPivots = pivots.slice(-5);
    const fit = fitTrendline(recentPivots);
    if (fit && fit.r2 >= 0.50) {
      const currentIndex = candles1h.length - 1;
      const tlPrice = fit.slope * currentIndex + fit.intercept;
      const dist = Math.abs(lastPrice - tlPrice) / tlPrice;
      trendlineOk = dist < TRENDLINE_PROXIMITY_PCT;
      items.push({
        name: "Trendline",
        passed: trendlineOk,
        detail: trendlineOk
          ? `Near trendline (R²=${sf(fit.r2,2)}, dist=${sf(dist*100,1)}%)`
          : `Far from trendline (dist=${sf(dist*100,1)}%)`
      });
      await store.set(pair, {
        slope: fit.slope,
        intercept: fit.intercept,
        lastUpdated: candles1h[candles1h.length - 1].timestamp,
        direction,
        r2: fit.r2,
      });
    } else {
      items.push({ name: "Trendline", passed: false, detail: "No valid trendline found" });
    }
  } else {
    items.push({ name: "Trendline", passed: false, detail: "Insufficient pivots" });
  }

  let structureOk = false;
  if (direction === "LONG") {
    const prevLow = Math.min(...candles1h.slice(-10, -5).map(c => c.low));
    const recentLow = Math.min(...candles1h.slice(-5).map(c => c.low));
    structureOk = recentLow > prevLow;
    items.push({
      name: "Structure",
      passed: structureOk,
      detail: structureOk
        ? `Higher low: ${sf(recentLow,2)} > ${sf(prevLow,2)}`
        : `No higher low`
    });
  } else {
    const prevHigh = Math.max(...candles1h.slice(-10, -5).map(c => c.high));
    const recentHigh = Math.max(...candles1h.slice(-5).map(c => c.high));
    structureOk = recentHigh < prevHigh;
    items.push({
      name: "Structure",
      passed: structureOk,
      detail: structureOk
        ? `Lower high: ${sf(recentHigh,2)} < ${sf(prevHigh,2)}`
        : `No lower high`
    });
  }

  const vols = candles1h.slice(-11, -1).map(c => c.volume);
  const avgVol = avg(vols.slice(0, -1));
  const currentVol = candles1h[candles1h.length - 2].volume;
  const volRatio = avgVol > 0 ? currentVol / avgVol : 0;
  const volumeOk = volRatio >= VOL_THRESHOLD;
  items.push({
    name: "Volume",
    passed: volumeOk,
    detail: volumeOk
      ? `Volume ${sf(volRatio,1)}x avg`
      : `Volume ${sf(volRatio,1)}x avg (below ${VOL_THRESHOLD}x)`
  });

  const passedItems = items.filter(i => i.passed).length;
  const passed = emaPullback && passedItems >= 2;

  return {
    passed,
    detail: passed
      ? `Location valid: ${passedItems}/4 checks passed`
      : `Location weak: ${passedItems}/4 checks, EMA pullback=${emaPullback}`,
    items
  };
}

// ─── 15m TRIGGER ───────────────────────────────────────────

export interface TriggerResult {
  fired: boolean;
  reason: string;
  stochK: number;
  stochD: number;
  prevK: number | null;
  prevD: number | null;
  confirmingCandle: Candle | null;
  triggerType: "stoch_cross" | "ema_cross" | "engulfing" | "rejection" | null;
  debug: string[];
}

export function check15mTrigger(
  candles15m: Candle[],
  direction: "LONG" | "SHORT"
): TriggerResult {
  const debug: string[] = [];
  const result: TriggerResult = {
    fired: false,
    reason: "",
    stochK: 50,
    stochD: 50,
    prevK: null,
    prevD: null,
    confirmingCandle: null,
    triggerType: null,
    debug
  };

  if (candles15m.length < 5) {
    debug.push("[TRIGGER-15m] Insufficient data");
    result.reason = "Insufficient data";
    return result;
  }

  const closes = candles15m.map(c => c.close);
  const stoch = stochRsi(closes);
  result.stochK = stoch.k;
  result.stochD = stoch.d;
  result.prevK = stoch.prevK;
  result.prevD = stoch.prevD;

  let stochFired = false;
  if (direction === "LONG" && stoch.prevK !== null && stoch.prevD !== null) {
    if (stoch.prevK < stoch.prevD && stoch.k >= stoch.d && stoch.k < STOCH_OVERSOLD) {
      stochFired = true;
      result.triggerType = "stoch_cross";
      result.reason = `Stoch cross up from oversold (K=${stoch.k}, D=${stoch.d})`;
    }
  } else if (direction === "SHORT" && stoch.prevK !== null && stoch.prevD !== null) {
    if (stoch.prevK > stoch.prevD && stoch.k <= stoch.d && stoch.k > STOCH_OVERBOUGHT) {
      stochFired = true;
      result.triggerType = "stoch_cross";
      result.reason = `Stoch cross down from overbought (K=${stoch.k}, D=${stoch.d})`;
    }
  }

  const e8_15m = ema(closes, 8);
  const e21_15m = ema(closes, 21);
  let emaFired = false;
  if (e8_15m.length >= 2 && e21_15m.length >= 2) {
    const prevE8 = e8_15m[e8_15m.length - 2];
    const prevE21 = e21_15m[e21_15m.length - 2];
    const lastE8 = e8_15m[e8_15m.length - 1];
    const lastE21 = e21_15m[e21_15m.length - 1];

    if (direction === "LONG" && prevE8 <= prevE21 && lastE8 > lastE21) {
      emaFired = true;
      result.triggerType = "ema_cross";
      result.reason = `EMA8 crossed above EMA21`;
    } else if (direction === "SHORT" && prevE8 >= prevE21 && lastE8 < lastE21) {
      emaFired = true;
      result.triggerType = "ema_cross";
      result.reason = `EMA8 crossed below EMA21`;
    }
  }

  const last = candles15m[candles15m.length - 1];
  const prev = candles15m[candles15m.length - 2];
  let engulfingFired = false;
  if (direction === "LONG") {
    if (last.close > last.open && prev.close < prev.open &&
        last.close > prev.open && last.open < prev.close) {
      engulfingFired = true;
      result.triggerType = "engulfing";
      result.reason = `Bullish engulfing`;
    }
  } else {
    if (last.close < last.open && prev.close > prev.open &&
        last.close < prev.open && last.open > prev.close) {
      engulfingFired = true;
      result.triggerType = "engulfing";
      result.reason = `Bearish engulfing`;
    }
  }

  const body = Math.abs(last.close - last.open);
  const range = last.high - last.low;
  const upperWick = last.high - Math.max(last.open, last.close);
  const lowerWick = Math.min(last.open, last.close) - last.low;
  let rejectionFired = false;

  if (direction === "LONG" && body > 0 && lowerWick > body * 1.5 && last.close > last.open) {
    rejectionFired = true;
    result.triggerType = "rejection";
    result.reason = `Strong bullish rejection (lower wick ${sf(lowerWick,2)} > body ${sf(body,2)})`;
  } else if (direction === "SHORT" && body > 0 && upperWick > body * 1.5 && last.close < last.open) {
    rejectionFired = true;
    result.triggerType = "rejection";
    result.reason = `Strong bearish rejection (upper wick ${sf(upperWick,2)} > body ${sf(body,2)})`;
  }

  result.fired = stochFired || emaFired || engulfingFired || rejectionFired;

  if (result.fired) {
    result.confirmingCandle = last;
    debug.push(`[TRIGGER-15m] ✅ ${result.triggerType?.toUpperCase()}: ${result.reason}`);
  } else {
    result.reason = `No trigger: Stoch=${stoch.k}/${stoch.d}, no EMA cross, no engulfing, no rejection`;
    debug.push(`[TRIGGER-15m] ${result.reason}`);
  }

  return result;
}

// ─── 5m TIMING ─────────────────────────────────────────────

export interface TimingResult {
  improved: boolean;
  entry: number;
  reason: string;
  candlesWaited: number;
  debug: string[];
}

export function check5mTiming(
  candles5m: Candle[],
  direction: "LONG" | "SHORT",
  maxWaitCandles: number = 3
): TimingResult {
  const debug: string[] = [];

  if (candles5m.length < maxWaitCandles + 1) {
    return { improved: false, entry: 0, reason: "Insufficient 5m data", candlesWaited: 0, debug };
  }

  const recent = candles5m.slice(-maxWaitCandles - 1, -1);
  let bestEntry = direction === "LONG" ? Infinity : 0;
  let bestReason = "";
  let improved = false;

  for (let i = 0; i < recent.length; i++) {
    const c = recent[i];

    if (direction === "LONG") {
      if (c.close > c.open && c.close < bestEntry) {
        bestEntry = c.close;
        bestReason = `Bullish candle at 5m[${i}]`;
        improved = true;
      }
      if (i > 0 && c.low > recent[i-1].low && c.low < bestEntry) {
        bestEntry = c.low;
        bestReason = `Higher low at 5m[${i}]`;
        improved = true;
      }
    } else {
      if (c.close < c.open && c.close > bestEntry) {
        bestEntry = c.close;
        bestReason = `Bearish candle at 5m[${i}]`;
        improved = true;
      }
      if (i > 0 && c.high < recent[i-1].high && c.high > bestEntry) {
        bestEntry = c.high;
        bestReason = `Lower high at 5m[${i}]`;
        improved = true;
      }
    }
  }

  if (!improved) {
    bestEntry = candles5m[candles5m.length - 1].close;
    bestReason = `No 5m improvement after ${maxWaitCandles} candles — entering at market`;
  }

  debug.push(`[TIMING-5m] ${bestReason}, entry=${sf(bestEntry,2)}`);

  return {
    improved,
    entry: bestEntry,
    reason: bestReason,
    candlesWaited: improved ? recent.findIndex(c =>
      direction === "LONG" ? c.close === bestEntry : c.close === bestEntry
    ) + 1 : maxWaitCandles,
    debug
  };
}

// ─── HYSTERESIS / COOLDOWN ─────────────────────────────────

export interface CooldownState {
  lockUntil: number;
  reason: "entry" | "stop" | "target";
}

export interface CooldownStore {
  get(pair: string): Promise<CooldownState | null>;
  set(pair: string, state: CooldownState): Promise<void>;
}

class InMemoryCooldownStore implements CooldownStore {
  private map = new Map<string, CooldownState>();
  async get(pair: string): Promise<CooldownState | null> {
    return this.map.get(pair) ?? null;
  }
  async set(pair: string, state: CooldownState): Promise<void> {
    this.map.set(pair, state);
  }
}

export const defaultCooldownStore = new InMemoryCooldownStore();

async function isLocked(
  pair: string,
  now: number,
  activeSignals: Signal[],
  store: CooldownStore = defaultCooldownStore
): Promise<{ locked: boolean; reason: string }> {
  const active = activeSignals.find(s => s.pair === pair && !s.exited);
  if (active) {
    const elapsed = now - active.timestamp;
    if (elapsed < HYSTERESIS_ENTRY_MS) {
      return { locked: true, reason: `Active signal (${Math.round(elapsed/60000)}min old)` };
    }
  }
  const cd = await store.get(pair);
  if (cd && now < cd.lockUntil) {
    const mins = Math.round((cd.lockUntil - now) / 60000);
    return { locked: true, reason: `Cooldown: ${cd.reason} (${mins}min remaining)` };
  }
  return { locked: false, reason: "" };
}

async function setCooldown(
  pair: string,
  reason: "entry" | "stop" | "target",
  now: number,
  store: CooldownStore = defaultCooldownStore
): Promise<void> {
  let duration = HYSTERESIS_ENTRY_MS;
  if (reason === "stop") duration = COOLDOWN_STOP_MS;
  if (reason === "target") duration = COOLDOWN_TP_MS;
  await store.set(pair, { lockUntil: now + duration, reason });
}

// ─── SIGNAL GENERATION ─────────────────────────────────────

export async function generateSignal(
  pair: string,
  candles1h: Candle[],
  candles4h: Candle[],
  candles15m: Candle[],
  candles5m: Candle[],
  activeSignals: Signal[],
  currentPrice?: number,
  options?: {
    trendlineStore?: TrendlineStore;
    cooldownStore?: CooldownStore;
  }
): Promise<SignalResult> {
  const debug: string[] = [];
  const now = Date.now();
  const price = currentPrice ?? candles5m[candles5m.length - 1]?.close ?? 0;

  if (!Array.isArray(activeSignals)) activeSignals = [];

  const lock = await isLocked(pair, now, activeSignals, options?.cooldownStore);
  if (lock.locked) {
    debug.push(`[SIGNAL] REJECTED — ${lock.reason}`);
    return { debug };
  }

  if (candles4h.length < 50) {
    debug.push(`[SIGNAL] REJECTED — 4H insufficient data`);
    return { debug };
  }
  if (candles1h.length < 50) {
    debug.push(`[SIGNAL] REJECTED — 1H insufficient data`);
    return { debug };
  }
  if (candles15m.length < 5) {
    debug.push(`[SIGNAL] REJECTED — 15m insufficient data`);
    return { debug };
  }

  const trend = calculateTrend4H(candles4h);
  debug.push(...trend.debug);

  const biasItem: CheckItem = {
    name: "4H Bias",
    passed: trend.direction !== "NEUTRAL",
    detail: trend.direction === "NEUTRAL"
      ? `NEUTRAL (ADX=${sf(trend.adx ?? 0,1)})`
      : `${trend.direction} ${trend.strength}`
  };

  if (!biasItem.passed) {
    debug.push("[SIGNAL] REJECTED — 4H bias NEUTRAL");
    return { debug };
  }

  const direction = trend.direction as "LONG" | "SHORT";

  const location = await check1HLocation(pair, candles1h, direction, trend, options?.trendlineStore);
  debug.push(`[LOCATION-1H] ${location.detail}`);
  location.items.forEach(i => debug.push(`  ${i.passed ? "✓" : "✗"} ${i.name}: ${i.detail}`));

  const locationItem: CheckItem = {
    name: "1H Location",
    passed: location.passed,
    detail: location.detail
  };

  const trigger = check15mTrigger(candles15m, direction);
  debug.push(...trigger.debug);

  const triggerItem: CheckItem = {
    name: "15m Trigger",
    passed: trigger.fired,
    detail: trigger.fired ? trigger.reason : "No trigger detected"
  };

  if (!trigger.fired) {
    debug.push("[SIGNAL] REJECTED — No 15m trigger");
    return { debug };
  }

  let timingItem: CheckItem;
  let entryPrice = price;

  if (candles5m && candles5m.length >= 4) {
    const timing = check5mTiming(candles5m, direction);
    debug.push(...timing.debug);

    timingItem = {
      name: "5m Timing",
      passed: true,
      detail: timing.reason
    };

    if (timing.improved) {
      entryPrice = timing.entry;
    }
  } else {
    timingItem = {
      name: "5m Timing",
      passed: true,
      detail: "No 5m data — using market price"
    };
    debug.push("[TIMING-5m] No 5m data available");
  }

  const checklist: SetupChecklist = {
    bias: biasItem,
    location: locationItem,
    trigger: triggerItem,
    timing: timingItem,
    grade: null,
    allPassed: biasItem.passed && locationItem.passed && triggerItem.passed
  };

  let grade: "A" | "B" | null = null;
  let positionSizePct = 0;

  const timingImproved = timingItem.detail.includes("Bullish") || timingItem.detail.includes("Bearish");

  if (biasItem.passed && locationItem.passed && triggerItem.passed && timingImproved) {
    grade = "A";
    positionSizePct = SIZE_A;
    checklist.grade = "A";
  } else if (biasItem.passed && triggerItem.passed) {
    grade = "B";
    positionSizePct = SIZE_B;
    checklist.grade = "B";
  }

  if (!grade) {
    debug.push("[SIGNAL] REJECTED — Below minimum quality (B)");
    return { debug };
  }

  const entry = entryPrice;
  const atr1h = atr(candles1h, 14);
  const recent1h = candles1h.slice(-20);
  const swingLow = Math.min(...recent1h.map(c => c.low));
  const swingHigh = Math.max(...recent1h.map(c => c.high));

  let stop: number;
  let target: number;

  if (direction === "LONG") {
    const atrStop = entry - atr1h * ATR_MULT;
    const pctStop = entry * (1 - MAX_STOP_PCT);
    const swingStop = swingLow * 0.998;
    stop = Math.max(atrStop, pctStop, swingStop);
    const maxStop = entry * (1 - MAX_STOP_PCT);
    if (stop < maxStop) stop = maxStop;
    target = entry + (entry - stop) * 3;
  } else {
    const atrStop = entry + atr1h * ATR_MULT;
    const pctStop = entry * (1 + MAX_STOP_PCT);
    const swingStop = swingHigh * 1.002;
    stop = Math.min(atrStop, pctStop, swingStop);
    const maxStop = entry * (1 + MAX_STOP_PCT);
    if (stop > maxStop) stop = maxStop;
    target = entry - (stop - entry) * 3;
  }

  const risk = Math.abs(entry - stop);
  const reward = Math.abs(target - entry);
  const rr = risk > 0 ? reward / risk : 0;

  if (rr < MIN_RR) {
    debug.push(`[SIGNAL] REJECTED — RR ${sf(rr,2)} < ${MIN_RR}`);
    return { debug };
  }

  const confidence = Math.round(
    (biasItem.passed ? 25 : 0) +
    (locationItem.passed ? 35 : 15) +
    (triggerItem.passed ? 25 : 0) +
    (timingImproved ? 15 : 5)
  );

  const signal: Signal = {
    id: `${pair}_${now}`,
    pair,
    direction,
    entry: Math.round(entry * 100) / 100,
    stop: Math.round(stop * 100) / 100,
    target: Math.round(target * 100) / 100,
    confidence,
    timestamp: now,
    exited: false,
    entryType: "PULLBACK",
    rr: Math.round(rr * 100) / 100,
    adx: trend.adx ?? undefined,
    stochK: trigger.stochK,
    stochD: trigger.stochD,
    version: CURRENT_SIGNAL_VERSION,
    setupGrade: grade,
    positionSizePct,
    triggerCandle: trigger.confirmingCandle ? {
      open: trigger.confirmingCandle.open,
      high: trigger.confirmingCandle.high,
      low: trigger.confirmingCandle.low,
      close: trigger.confirmingCandle.close,
      timestamp: trigger.confirmingCandle.timestamp,
    } : undefined,
    checklist
  };

  await setCooldown(pair, "entry", now, options?.cooldownStore);

  debug.push(`[SIGNAL] ✅ ACCEPTED ${direction} ${grade} | Entry=$${sf(entry,2)} Stop=$${sf(stop,2)} Target=$${sf(target,2)} RR=${sf(rr,2)}`);
  debug.push(`[CHECKLIST] ${biasItem.passed ? "✓" : "✗"} Bias | ${locationItem.passed ? "✓" : "✗"} Location | ${triggerItem.passed ? "✓" : "✗"} Trigger | ${timingItem.passed ? "✓" : "✗"} Timing`);

  return { signal, debug };
}

// ─── EXIT LOGIC ────────────────────────────────────────────
// v44.1 — StochRSI extreme exit REMOVED.
// Exits: hard stop, target, or 4H trend reversal only.

export function shouldHold(
  signal: Signal,
  candles1h: Candle[],
  candles4h: Candle[],
  candles15m: Candle[],
  currentPrice: number
): HoldResult {
  if (signal.direction === "LONG" && currentPrice <= signal.stop) {
    return { shouldHold: false, reason: "stop_loss" };
  }
  if (signal.direction === "SHORT" && currentPrice >= signal.stop) {
    return { shouldHold: false, reason: "stop_loss" };
  }

  if (signal.direction === "LONG" && currentPrice >= signal.target) {
    return { shouldHold: false, reason: "target_hit" };
  }
  if (signal.direction === "SHORT" && currentPrice <= signal.target) {
    return { shouldHold: false, reason: "target_hit" };
  }

  if (candles4h.length >= 50) {
    const trend = calculateTrend4H(candles4h);
    if (trend.direction !== signal.direction && trend.direction !== "NEUTRAL") {
      return { shouldHold: false, reason: "4h_trend_reversed" };
    }
  }

  return { shouldHold: true, reason: "active" };
}

// ─── Validity checks ───────────────────────────────────────

export function isSignalStillValid(signal: Signal, currentPrice: number): {
  valid: boolean; reason: string; exited: boolean;
} {
  if (signal.direction === "LONG" && currentPrice <= signal.stop) return { valid: false, reason: "sl_hit", exited: true };
  if (signal.direction === "SHORT" && currentPrice >= signal.stop) return { valid: false, reason: "sl_hit", exited: true };
  if (signal.direction === "LONG" && currentPrice >= signal.target) return { valid: false, reason: "tp_hit", exited: true };
  if (signal.direction === "SHORT" && currentPrice <= signal.target) return { valid: false, reason: "tp_hit", exited: true };
  return { valid: true, reason: "active", exited: false };
}

export function filterExpiredSignals(
  signals: Signal[],
  currentPrices?: Record<string, number>
) {
  const active: Signal[] = [];
  const exited: { signal: Signal; reason: string }[] = [];
  const now = Date.now();

  for (const signal of signals) {
    if (!signal.exited) {
      const price = currentPrices?.[signal.pair];
      if (price !== undefined) {
        const check = isSignalStillValid(signal, price);
        if (!check.valid) { exited.push({ signal, reason: check.reason }); continue; }
      }
      active.push(signal); continue;
    }
    if (now - signal.timestamp < SIGNAL_TTL_MS) active.push(signal);
  }
  return { active, exited };
}

// ─── Market Snapshot ───────────────────────────────────────

export async function getMarketSnapshot(
  pair: string,
  candles1h: Candle[],
  candles4h: Candle[],
  candles15m: Candle[],
  candles5m: Candle[],
  currentPrice?: number,
  signalResult?: SignalResult,
  options?: {
    trendlineStore?: TrendlineStore;
  }
) {
  const price = currentPrice ?? candles5m?.[candles5m.length - 1]?.close ?? candles15m?.[candles15m.length - 1]?.close ?? 0;
  const trend = calculateTrend4H(candles4h);
  const location = candles1h.length >= 50
    ? await check1HLocation(pair, candles1h, trend.direction === "LONG" ? "LONG" : "SHORT", trend, options?.trendlineStore)
    : { passed: false, detail: "No data", items: [] };

  const stoch15m = candles15m.length >= 5 ? stochRsi(candles15m.map(c => c.close)) : { k: 50, d: 50, prevK: null, prevD: null };
  const stoch1h = candles1h.length >= 50 ? stochRsi(candles1h.map(c => c.close)) : { k: 50, d: 50, prevK: null, prevD: null };
  const stoch4h = candles4h.length >= 50 ? stochRsi(candles4h.map(c => c.close)) : { k: 50, d: 50, prevK: null, prevD: null };

  const closes1h = candles1h.map(c => c.close);
  const e8_1h = ema(closes1h, 8);
  const e21_1h = ema(closes1h, 21);

  return {
    pair,
    price: Math.round(price * 100) / 100,
    timestamp: Date.now(),
    trend: trend.direction ? `${trend.direction} ${trend.strength}` : "NEUTRAL",
    trendDirection: trend.direction,
    trendStrength: trend.strength,
    locationPassed: location.passed,
    locationDetail: location.detail,
    stoch15m,
    stoch1h,
    stoch4h,
    adx: trend.adx,
    ema8_1h: e8_1h.length ? Math.round(e8_1h[e8_1h.length - 1] * 100) / 100 : 0,
    ema21_1h: e21_1h.length ? Math.round(e21_1h[e21_1h.length - 1] * 100) / 100 : 0,
    signal: signalResult?.signal || null,
    debug: signalResult?.debug || [],
    trend4h: trend.direction ? { direction: trend.direction, strength: trend.strength } : null,
    stochK: stoch15m.k,
    stochD: stoch15m.d,
    rsi: stoch15m.k,
  };
}

// ─── 4H → 1D (compatibility) ─────────────────────────────

export function aggregateTo1D(candles4h: Candle[]): Candle[] {
  if (!candles4h?.length) return [];
  const sorted = [...candles4h].sort((a, b) => a.timestamp - b.timestamp);
  const groups = new Map<string, Candle[]>();
  for (const c of sorted) {
    const date = new Date(c.timestamp);
    const key = `${date.getUTCFullYear()}-${date.getUTCMonth()}-${date.getUTCDate()}`;
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

// ─── Compatibility ─────────────────────────────────────────

export function shouldHoldCompat(
  signal: Signal,
  candles4h: Candle[],
  candles1h: Candle[],
  candles15m: Candle[],
  currentPrice: number
): HoldResult {
  return shouldHold(signal, candles1h, candles4h, candles15m, currentPrice);
}

export async function generateSignalAsync(
  pair: string,
  candles1h: Candle[],
  candles4h: Candle[],
  candles15m: Candle[],
  candles5m: Candle[],
  activeSignals?: Signal[],
  currentPrice?: number,
  options?: {
    trendlineStore?: TrendlineStore;
    cooldownStore?: CooldownStore;
  }
): Promise<SignalResult> {
  return generateSignal(
    pair,
    candles1h,
    candles4h,
    candles15m,
    candles5m,
    activeSignals || [],
    currentPrice,
    options
  );
}
