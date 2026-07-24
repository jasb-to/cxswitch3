// lib/strategy.ts — v43.0 "Trend Rider" — Scored Setup Architecture
// ============================================================
// Timeframe architecture:
//   4H  →  Trend Direction (LONG / SHORT / NEUTRAL / EARLY_*)
//   1H  →  Setup Location (score-based, no hard gates)
//   15m →  Trigger (momentum ignition + 1-candle confirmation)
//
// Philosophy: Higher TF trend, lower TF entry. Score, don't gate.
// ============================================================

// ─── Types ─────────────────────────────────────────────────

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
  confidence: number;      // total score 0-100
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
  setupGrade?: "A+" | "A" | "B";
  positionSizePct?: number;
  earlyTrend?: boolean;     // true if entered on early trend detection
  triggerCandle?: {         // the confirming candle that fired the trigger
    open: number;
    high: number;
    low: number;
    close: number;
    timestamp: number;
  };
  scoreBreakdown?: Record<string, number>; // for observability
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
  direction: "LONG" | "SHORT" | "NEUTRAL" | "EARLY_LONG" | "EARLY_SHORT";
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

export interface SetupScore {
  total: number;
  breakdown: Record<string, number>;
  debug: string[];
}

export interface TriggerResult {
  fired: boolean;
  reason: string;
  stochK: number;
  stochD: number;
  prevK: number | null;
  prevD: number | null;
  confirmingCandle: Candle | null;
  debug: string[];
}

// ─── Constants ─────────────────────────────────────────────

export const CURRENT_SIGNAL_VERSION = 43.0;
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

// Score thresholds
const SCORE_A_PLUS = 90;
const SCORE_A = 80;
const SCORE_B = 70;
const MIN_SCORE = 70;

// Position sizing by grade
const SIZE_A_PLUS = 1.0;
const SIZE_A = 0.85;
const SIZE_B = 0.65;

// ─── Score Weights ─────────────────────────────────────────
// Configurable — pass overrides via options.scoreWeights

const DEFAULT_SCORE_WEIGHTS = {
  // 4H Trend
  trendStrong: 25,
  trendMedium: 15,
  trendWeak: 5,
  adxAbove25: 15,
  adxAbove20: 8,
  earlyTrend: 20,          // bonus for EARLY_LONG / EARLY_SHORT

  // 1H Setup
  ema21Pullback: 20,
  ema50Pullback: 15,
  nearTrendline: 10,       // optional bonus
  atSupportResistance: 10, // optional bonus
  volumeGood: 10,          // > 1.2x avg
  volumeVeryHigh: 20,      // > 2.0x avg
  atrContraction: 15,      // ATR < 80% of 20-bar avg
  structure: 10,           // higher low / lower high

  // 15m Trigger
  stochCross: 10,
  confirmingCandle: 10,    // one candle confirmation
} as const;

export type ScoreWeights = typeof DEFAULT_SCORE_WEIGHTS;

// ─── Helpers ───────────────────────────────────────────────

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
  const currentK = kValues[kValues.length - 1];
  const currentD = dValues[dValues.length - 1];
  const prevK = kValues.length >= 2 ? kValues[kValues.length - 2] : null;
  const prevD = dValues.length >= 2 ? dValues[dValues.length - 2] : null;
  return {
    k: Math.round(currentK * 10) / 10,
    d: Math.round(currentD * 10) / 10,
    prevK: prevK !== null ? Math.round(prevK * 10) / 10 : null,
    prevD: prevD !== null ? Math.round(prevD * 10) / 10 : null,
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
  if (!atrS.length) return null;
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

// ─── 4H → 1D (compatibility only) ──────────────────────────

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

// ─── 4H TREND ──────────────────────────────────────────────

export function calculateTrend4H(candles4h: Candle[]): TrendResult {
  const debug: string[] = [];
  if (candles4h.length < 50) {
    debug.push("[TREND-4H] Insufficient data (<50 bars)");
    return { direction: "NEUTRAL", strength: "WEAK", adx: null, ema8: null, ema21: null, ema50: null, hh: false, hl: false, lh: false, ll: false, debug };
  }

  const closes = candles4h.map(c => c.close);
  const e8 = ema(closes, 8);
  const e21 = ema(closes, 21);
  const e50 = ema(closes, 50);

  if (!e8.length || !e21.length || !e50.length) {
    debug.push("[TREND-4H] EMA calc failed");
    return { direction: "NEUTRAL", strength: "WEAK", adx: null, ema8: null, ema21: null, ema50: null, hh: false, hl: false, lh: false, ll: false, debug };
  }

  const lastE8 = e8[e8.length - 1];
  const lastE21 = e21[e21.length - 1];
  const lastE50 = e50[e50.length - 1];
  const lastClose = closes[closes.length - 1];

  // Market structure (last 20 bars)
  const recent = candles4h.slice(-20);
  const highs = recent.map(c => c.high);
  const lows = recent.map(c => c.low);
  const hh = highs[highs.length - 1] > Math.max(...highs.slice(0, -1));
  const ll = lows[lows.length - 1] < Math.min(...lows.slice(0, -1));
  const hl = lows[lows.length - 1] > Math.min(...lows.slice(0, -1)) && lows[lows.length - 1] > lows[lows.length - 3];
  const lh = highs[highs.length - 1] < Math.max(...highs.slice(0, -1)) && highs[highs.length - 1] < highs[highs.length - 3];

  const adxVal = adx(candles4h);

  // Determine trend
  let direction: TrendResult["direction"] = "NEUTRAL";
  let strength: TrendResult["strength"] = "WEAK";
  let earlyTrend = false;

  const emaAlignedLong = lastE8 > lastE21 && lastE21 > lastE50;
  const emaAlignedShort = lastE8 < lastE21 && lastE21 < lastE50;
  const priceAboveE21 = lastClose > lastE21;
  const priceBelowE21 = lastClose < lastE21;

  if (emaAlignedLong && priceAboveE21) {
    direction = "LONG";
    if (adxVal !== null) {
      if (adxVal >= 25 && hh) strength = "STRONG";
      else if (adxVal >= 20) strength = "MEDIUM";
    }
  } else if (emaAlignedShort && priceBelowE21) {
    direction = "SHORT";
    if (adxVal !== null) {
      if (adxVal >= 25 && ll) strength = "STRONG";
      else if (adxVal >= 20) strength = "MEDIUM";
    }
  } else {
    // Early trend detection
    const e8CrossedE21 = e8.length >= 2 && e21.length >= 2 &&
      ((e8[e8.length - 2] <= e21[e21.length - 2] && lastE8 > lastE21) ||
       (e8[e8.length - 2] >= e21[e21.length - 2] && lastE8 < lastE21));
    const adxRising = adxVal !== null && adxVal >= 15;

    if (lastE8 > lastE21 && priceAboveE21 && e8CrossedE21 && adxRising && hl) {
      direction = "EARLY_LONG";
      strength = "WEAK";
      earlyTrend = true;
    } else if (lastE8 < lastE21 && priceBelowE21 && e8CrossedE21 && adxRising && lh) {
      direction = "EARLY_SHORT";
      strength = "WEAK";
      earlyTrend = true;
    }
  }

  // ADX filter with buffer for non-early trends
  if (!earlyTrend && adxVal !== null) {
    if (adxVal < 18) {
      debug.push(`[TREND-4H] ADX ${adxVal} < 18 — NEUTRAL`);
      return { direction: "NEUTRAL", strength, adx: adxVal, ema8: lastE8, ema21: lastE21, ema50: lastE50, hh, hl, lh, ll, debug };
    } else if (adxVal < MIN_ADX) {
      strength = "WEAK";
      debug.push(`[TREND-4H] ADX ${adxVal} in buffer zone (18–20) — WEAK trend allowed`);
    }
  }

  debug.push(`[TREND-4H] ${direction} ${strength} | ADX=${sf(adxVal ?? 0,1)} | EMA8=${sf(lastE8,2)} EMA21=${sf(lastE21,2)} EMA50=${sf(lastE50,2)} | HH=${hh} HL=${hl} LH=${lh} LL=${ll}`);
  return { direction, strength, adx: adxVal, ema8: lastE8, ema21: lastE21, ema50: lastE50, hh, hl, lh, ll, debug };
}

// ─── 1H SETUP SCORING ──────────────────────────────────────

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

export async function calculateSetupScore(
  pair: string,
  candles1h: Candle[],
  direction: "LONG" | "SHORT",
  trend: TrendResult,
  store: TrendlineStore = defaultTrendlineStore,
  weightOverrides?: Partial<ScoreWeights>
): Promise<SetupScore> {
  const W = { ...DEFAULT_SCORE_WEIGHTS, ...weightOverrides };
  const debug: string[] = [];
  const breakdown: Record<string, number> = {};
  let total = 0;

  if (candles1h.length < 50) {
    debug.push("[SETUP-1H] Insufficient data");
    return { total: 0, breakdown, debug };
  }

  const lastPrice = candles1h[candles1h.length - 1].close;
  const closes1h = candles1h.map(c => c.close);
  const e21_1h = ema(closes1h, 21);
  const e50_1h = ema(closes1h, 50);
  const lastE21_1h = e21_1h[e21_1h.length - 1];
  const lastE50_1h = e50_1h[e50_1h.length - 1];

  // EMA Pullback score
  if (direction === "LONG") {
    if (lastPrice <= lastE21_1h * 1.005) {
      total += W.ema21Pullback;
      breakdown["ema21Pullback"] = W.ema21Pullback;
      debug.push(`[SETUP-1H] EMA21 pullback +${W.ema21Pullback}`);
    } else if (lastPrice <= lastE50_1h * 1.005) {
      total += W.ema50Pullback;
      breakdown["ema50Pullback"] = W.ema50Pullback;
      debug.push(`[SETUP-1H] EMA50 pullback +${W.ema50Pullback}`);
    }
  } else {
    if (lastPrice >= lastE21_1h * 0.995) {
      total += W.ema21Pullback;
      breakdown["ema21Pullback"] = W.ema21Pullback;
      debug.push(`[SETUP-1H] EMA21 pullback +${W.ema21Pullback}`);
    } else if (lastPrice >= lastE50_1h * 0.995) {
      total += W.ema50Pullback;
      breakdown["ema50Pullback"] = W.ema50Pullback;
      debug.push(`[SETUP-1H] EMA50 pullback +${W.ema50Pullback}`);
    }
  }

  // Trendline (optional bonus)
  const pivots = findPivots(candles1h, direction);
  if (pivots.length >= 3) {
    const recentPivots = pivots.slice(-5);
    const fit = fitTrendline(recentPivots);
    if (fit && fit.r2 >= 0.50) {
      const currentIndex = candles1h.length - 1;
      const tlPrice = fit.slope * currentIndex + fit.intercept;
      const dist = Math.abs(lastPrice - tlPrice) / tlPrice;
      if (dist < TRENDLINE_PROXIMITY_PCT) {
        total += W.nearTrendline;
        breakdown["nearTrendline"] = W.nearTrendline;
        debug.push(`[SETUP-1H] Near trendline +${W.nearTrendline} (R²=${sf(fit.r2,3)})`);
      }
      await store.set(pair, {
        slope: fit.slope,
        intercept: fit.intercept,
        lastUpdated: candles1h[candles1h.length - 1].timestamp,
        direction,
        r2: fit.r2,
      });
    }
  }

  // Market structure bonus
  if (direction === "LONG") {
    const prevLow = Math.min(...candles1h.slice(-10, -5).map(c => c.low));
    const recentLow = Math.min(...candles1h.slice(-5).map(c => c.low));
    if (recentLow > prevLow) {
      total += 10;
      breakdown["higherLow"] = 10;
      debug.push(`[SETUP-1H] Higher low +10 (${sf(recentLow,2)} > ${sf(prevLow,2)})`);
    }
  } else {
    const prevHigh = Math.max(...candles1h.slice(-10, -5).map(c => c.high));
    const recentHigh = Math.max(...candles1h.slice(-5).map(c => c.high));
    if (recentHigh < prevHigh) {
      total += 10;
      breakdown["lowerHigh"] = 10;
      debug.push(`[SETUP-1H] Lower high +10 (${sf(recentHigh,2)} < ${sf(prevHigh,2)})`);
    }
  }

  // Volume scoring (never reject, just score)
  // Use 2nd-to-last candle as "current" — last candle is in-progress and often has volume=0
  const vols = candles1h.slice(-11, -1).map(c => c.volume); // last 10 COMPLETE candles
  const avgVol = avg(vols.slice(0, -1)); // avg of first 9
  const currentVol = candles1h[candles1h.length - 2].volume; // most recent complete candle
  const volRatio = avgVol > 0 ? currentVol / avgVol : 0;
  if (volRatio > 2.0) {
    total += W.volumeVeryHigh;
    breakdown["volumeVeryHigh"] = W.volumeVeryHigh;
    debug.push(`[SETUP-1H] Very high volume +${W.volumeVeryHigh} (${sf(volRatio,1)}x)`);
  } else if (volRatio > VOL_THRESHOLD) {
    total += W.volumeGood;
    breakdown["volumeGood"] = W.volumeGood;
    debug.push(`[SETUP-1H] Good volume +${W.volumeGood} (${sf(volRatio,1)}x)`);
  } else {
    breakdown["volumeNormal"] = 0;
    debug.push(`[SETUP-1H] Normal volume +0 (${sf(volRatio,1)}x)`);
  }

  // ATR contraction
  const atrs = atrHistory(candles1h, 14);
  if (atrs.length >= 20) {
    const currentATR = atrs[atrs.length - 1];
    const avgATR = avg(atrs.slice(-20));
    if (avgATR > 0 && currentATR < avgATR * 0.80) {
      total += W.atrContraction;
      breakdown["atrContraction"] = W.atrContraction;
      debug.push(`[SETUP-1H] ATR contraction +${W.atrContraction} (${sf(currentATR/avgATR*100,0)}% of avg)`);
    }
  }

  // 4H trend score contribution
  if (trend.direction === "EARLY_LONG" || trend.direction === "EARLY_SHORT") {
    total += W.earlyTrend;
    breakdown["earlyTrend"] = W.earlyTrend;
    debug.push(`[SETUP-1H] Early trend +${W.earlyTrend}`);
  } else if (trend.strength === "STRONG") {
    total += W.trendStrong;
    breakdown["trendStrong"] = W.trendStrong;
    debug.push(`[SETUP-1H] Strong trend +${W.trendStrong}`);
  } else if (trend.strength === "MEDIUM") {
    total += W.trendMedium;
    breakdown["trendMedium"] = W.trendMedium;
    debug.push(`[SETUP-1H] Medium trend +${W.trendMedium}`);
  } else {
    total += W.trendWeak;
    breakdown["trendWeak"] = W.trendWeak;
    debug.push(`[SETUP-1H] Weak trend +${W.trendWeak}`);
  }

  if (trend.adx !== null && trend.adx >= 25) {
    total += W.adxAbove25;
    breakdown["adxAbove25"] = W.adxAbove25;
    debug.push(`[SETUP-1H] ADX >25 +${W.adxAbove25}`);
  } else if (trend.adx !== null && trend.adx >= 20) {
    total += W.adxAbove20;
    breakdown["adxAbove20"] = W.adxAbove20;
    debug.push(`[SETUP-1H] ADX >20 +${W.adxAbove20}`);
  }

  debug.push(`[SETUP-1H] Total score: ${total}`);
  return { total, breakdown, debug };
}

// ─── 15m TRIGGER ───────────────────────────────────────────

export function calculateTrigger15m(
  candles15m: Candle[],
  direction: "LONG" | "SHORT"
): TriggerResult {
  const debug: string[] = [];

  if (candles15m.length < 5) {
    debug.push("[TRIGGER-15m] Insufficient data");
    return { fired: false, reason: "Insufficient data", stochK: 50, stochD: 50, prevK: null, prevD: null, confirmingCandle: null, debug };
  }

  const closes = candles15m.map(c => c.close);
  const stoch = stochRsi(closes);

  debug.push(`[TRIGGER-15m] K=${stoch.k} D=${stoch.d} prevK=${stoch.prevK} prevD=${stoch.prevD}`);

  let fired = false;
  let reason = "";

  // StochRSI cross detection
  if (direction === "LONG") {
    if (stoch.prevK !== null && stoch.prevD !== null) {
      if (stoch.prevK < stoch.prevD && stoch.k >= stoch.d) {
        fired = true;
        reason = `K crossed above D (K=${stoch.k}, D=${stoch.d})`;
      }
    }
  } else {
    if (stoch.prevK !== null && stoch.prevD !== null) {
      if (stoch.prevK > stoch.prevD && stoch.k <= stoch.d) {
        fired = true;
        reason = `K crossed below D (K=${stoch.k}, D=${stoch.d})`;
      }
    }
  }

  if (!fired) {
    reason = direction === "LONG"
      ? `No LONG trigger: K=${stoch.k} D=${stoch.d}`
      : `No SHORT trigger: K=${stoch.k} D=${stoch.d}`;
    debug.push(`[TRIGGER-15m] ${reason}`);
    return { fired, reason, stochK: stoch.k, stochD: stoch.d, prevK: stoch.prevK, prevD: stoch.prevD, confirmingCandle: null, debug };
  }

  // One-candle confirmation — strict rules only
  const crossIndex = candles15m.length - 1; // cross happened on last candle
  if (crossIndex < 1) {
    debug.push("[TRIGGER-15m] Cross detected but no confirming candle yet");
    return { fired: false, reason: "Waiting for confirming candle", stochK: stoch.k, stochD: stoch.d, prevK: stoch.prevK, prevD: stoch.prevD, confirmingCandle: null, debug };
  }

  const confirmingCandle = candles15m[candles15m.length - 1];
  const crossCandle = candles15m[candles15m.length - 2];

  let confirmed = false;
  if (direction === "LONG") {
    // STRICT: Close must break above previous candle high
    // This proves buyers absorbed supply and took control
    if (confirmingCandle.close > crossCandle.high) {
      confirmed = true;
      reason += " | Confirmed: close above previous high";
    }
  } else {
    // STRICT: Close must break below previous candle low
    // This proves sellers overwhelmed demand and took control
    if (confirmingCandle.close < crossCandle.low) {
      confirmed = true;
      reason += " | Confirmed: close below previous low";
    }
  }

  if (!confirmed) {
    debug.push(`[TRIGGER-15m] Cross detected but no confirmation (${reason})`);
    return { fired: false, reason: "Cross without strong confirmation", stochK: stoch.k, stochD: stoch.d, prevK: stoch.prevK, prevD: stoch.prevD, confirmingCandle: null, debug };
  }

  debug.push(`[TRIGGER-15m] ✅ FIRED: ${reason}`);
  return { fired: true, reason, stochK: stoch.k, stochD: stoch.d, prevK: stoch.prevK, prevD: stoch.prevD, confirmingCandle, debug };
}

// ─── Hysteresis / Cooldown ─────────────────────────────────

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
  candles1d: Candle[],
  candles15m: Candle[],
  activeSignals: Signal[],
  currentPrice?: number,
  options?: {
    trendlineStore?: TrendlineStore;
    cooldownStore?: CooldownStore;
    scoreWeights?: Partial<ScoreWeights>;
  }
): Promise<SignalResult> {
  const W = { ...DEFAULT_SCORE_WEIGHTS, ...options?.scoreWeights };
  const debug: string[] = [];
  const now = Date.now();
  const price = currentPrice ?? candles15m[candles15m.length - 1]?.close ?? 0;

  if (!Array.isArray(activeSignals)) activeSignals = [];

  // ── Cooldown check ──
  const lock = await isLocked(pair, now, activeSignals, options?.cooldownStore);
  if (lock.locked) {
    debug.push(`[SIGNAL] REJECTED — ${lock.reason}`);
    return { debug };
  }

  // ── Data sufficiency ──
  if (candles4h.length < 50) {
    debug.push(`[SIGNAL] REJECTED — 4H insufficient data (${candles4h.length} < 50)`);
    return { debug };
  }
  if (candles1h.length < 50) {
    debug.push(`[SIGNAL] REJECTED — 1H insufficient data (${candles1h.length} < 50)`);
    return { debug };
  }
  if (candles15m.length < 5) {
    debug.push(`[SIGNAL] REJECTED — 15m insufficient data (${candles15m.length} < 5)`);
    return { debug };
  }

  // ── 4H Trend ──
  const trend = calculateTrend4H(candles4h);
  debug.push(...trend.debug);
  if (trend.direction === "NEUTRAL") {
    debug.push("[SIGNAL] REJECTED — 4H trend NEUTRAL");
    return { debug };
  }
  const direction = trend.direction === "EARLY_LONG" ? "LONG" : trend.direction === "EARLY_SHORT" ? "SHORT" : trend.direction;
  const isEarly = trend.direction === "EARLY_LONG" || trend.direction === "EARLY_SHORT";

  // ── 1H Setup Score ──
  const setup = await calculateSetupScore(pair, candles1h, direction, trend, options?.trendlineStore, options?.scoreWeights);
  debug.push(...setup.debug);

  // ── 15m Trigger ──
  const trigger = calculateTrigger15m(candles15m, direction);
  debug.push(...trigger.debug);
  if (!trigger.fired) {
    debug.push("[SIGNAL] REJECTED — No 15m trigger");
    return { debug };
  }

  // Add trigger score
  let totalScore = setup.total;
  totalScore += W.stochCross;
  setup.breakdown["stochCross"] = W.stochCross;
  if (trigger.confirmingCandle) {
    totalScore += W.confirmingCandle;
    setup.breakdown["confirmingCandle"] = W.confirmingCandle;
  }
  debug.push(`[SIGNAL] Score after trigger: ${totalScore}`);

  // Grade — only A+/A/B exist. Below B = no trade.
  let grade: "A+" | "A" | "B" | null = null;
  let positionSizePct = 0;
  if (totalScore >= SCORE_A_PLUS) {
    grade = "A+"; positionSizePct = SIZE_A_PLUS;
  } else if (totalScore >= SCORE_A) {
    grade = "A"; positionSizePct = SIZE_A;
  } else if (totalScore >= MIN_SCORE) {
    grade = "B"; positionSizePct = SIZE_B;
  }

  if (!grade) {
    debug.push(`[SIGNAL] REJECTED — Score ${totalScore} < ${MIN_SCORE} (minimum for B)`);
    return { debug };
  }

  // ── Risk Management ──
  const entry = price;
  const atr1h = atr(candles1h, 14);
  const recent = candles1h.slice(-20);
  const swingLow = Math.min(...recent.map(c => c.low));
  const swingHigh = Math.max(...recent.map(c => c.high));

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
    debug.push(`[SIGNAL] REJECTED — RR ${sf(rr,2)} < ${MIN_RR} (risk=$${sf(risk,2)}, reward=$${sf(reward,2)})`);
    return { debug };
  }

  // ── Build Signal ──
  const signal: Signal = {
    id: `${pair}_${now}`,
    pair,
    direction,
    entry: Math.round(entry * 100) / 100,
    stop: Math.round(stop * 100) / 100,
    target: Math.round(target * 100) / 100,
    confidence: totalScore,
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
    earlyTrend: isEarly,
    triggerCandle: trigger.confirmingCandle ? {
      open: trigger.confirmingCandle.open,
      high: trigger.confirmingCandle.high,
      low: trigger.confirmingCandle.low,
      close: trigger.confirmingCandle.close,
      timestamp: trigger.confirmingCandle.timestamp,
    } : undefined,
    scoreBreakdown: setup.breakdown,
  };

  await setCooldown(pair, "entry", now, options?.cooldownStore);

  debug.push(`[SIGNAL] ✅ ACCEPTED ${direction} ${grade} | Score=${totalScore} | Entry=$${sf(entry,2)} Stop=$${sf(stop,2)} Target=$${sf(target,2)} RR=${sf(rr,2)} Size=${sf(positionSizePct*100,0)}%`);
  debug.push(`[SIGNAL] 4H: ${trend.direction} ${trend.strength} ADX=${sf(trend.adx ?? 0,1)}`);
  debug.push(`[SIGNAL] 1H: Score=${setup.total} ${Object.entries(setup.breakdown).map(([k,v]) => `${k}=${v}`).join(" ")}`);
  debug.push(`[SIGNAL] 15m: ${trigger.reason}`);

  return { signal, debug };
}

// ─── EXIT LOGIC ────────────────────────────────────────────

export function shouldHold(
  signal: Signal,
  candles1h: Candle[],
  candles4h: Candle[],
  candles15m: Candle[],
  currentPrice: number
): HoldResult {
  // Hard stops
  if (signal.direction === "LONG" && currentPrice <= signal.stop) {
    return { shouldHold: false, reason: "stop_loss" };
  }
  if (signal.direction === "SHORT" && currentPrice >= signal.stop) {
    return { shouldHold: false, reason: "stop_loss" };
  }
  // Targets
  if (signal.direction === "LONG" && currentPrice >= signal.target) {
    return { shouldHold: false, reason: "target_hit" };
  }
  if (signal.direction === "SHORT" && currentPrice <= signal.target) {
    return { shouldHold: false, reason: "target_hit" };
  }
  // 4H trend reversal
  if (candles4h.length >= 50) {
    const trend = calculateTrend4H(candles4h);
    const trendDir = trend.direction === "EARLY_LONG" ? "LONG" : trend.direction === "EARLY_SHORT" ? "SHORT" : trend.direction;
    if (trendDir && trendDir !== signal.direction) {
      return { shouldHold: false, reason: "4h_trend_reversed" };
    }
  }
  // 15m Stoch opposite extreme
  const closes15m = candles15m.map(c => c.close);
  const stoch = stochRsi(closes15m);
  const stochOpposite = signal.direction === "LONG"
    ? stoch.k > STOCH_OVERBOUGHT
    : stoch.k < STOCH_OVERSOLD;
  if (stochOpposite) {
    return { shouldHold: false, reason: "stoch_extreme_opposite" };
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
  candles1d: Candle[],
  currentPrice?: number,
  signalResult?: SignalResult,
  options?: {
    trendlineStore?: TrendlineStore;
  }
) {
  const price = currentPrice ?? candles15m[candles15m.length - 1]?.close ?? 0;
  const trend = calculateTrend4H(candles4h);
  const setup = await calculateSetupScore(pair, candles1h, trend.direction === "EARLY_LONG" ? "LONG" : trend.direction === "EARLY_SHORT" ? "SHORT" : trend.direction || "LONG", trend, options?.trendlineStore, options?.scoreWeights);

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
    setupScore: setup.total,
    stoch15m,
    stoch1h,
    stoch4h,
    adx: trend.adx,
    ema8_1h: e8_1h.length ? Math.round(e8_1h[e8_1h.length - 1] * 100) / 100 : 0,
    ema21_1h: e21_1h.length ? Math.round(e21_1h[e21_1h.length - 1] * 100) / 100 : 0,
    signal: signalResult?.signal || null,
    debug: signalResult?.debug || [],
    trend1d: null,
    trend4h: trend.direction ? { direction: trend.direction, strength: trend.strength } : null,
    stochK: stoch15m.k,
    stochD: stoch15m.d,
    rsi: stoch15m.k,
  };
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
  activeSignals?: Signal[],
  currentPrice?: number,
  options?: {
    trendlineStore?: TrendlineStore;
    cooldownStore?: CooldownStore;
    scoreWeights?: Partial<ScoreWeights>;
  }
): Promise<SignalResult> {
  return generateSignal(
    pair,
    candles1h,
    candles4h,
    aggregateTo1D(candles4h),
    candles15m,
    activeSignals || [],
    currentPrice,
    options
  );
}
