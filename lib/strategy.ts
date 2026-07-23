// lib/strategy.ts — v42.2 "Trend Rider" — Canonical Rewrite
// ============================================================
// Timeframe architecture:
//   4H  →  Market Bias (LONG / SHORT / NEUTRAL)
//   1H  →  Market Structure (trendline, ATR, swing levels, volume)
//   15m →  Entry Trigger (StochRSI cross from extreme)
//
// Entry:  4H bias aligns + 1H near trendline + 15m StochRSI cross
// Stop:   ATR(14) on 1H × 1.5, hard cap 4%, swing floor/ceiling
// Exit:   4H bias flip OR 15m Stoch opposite extreme OR stop/target
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
}

export interface SignalResult {
  signal?: Signal;
  debug: string[];
}

export interface HoldResult {
  shouldHold: boolean;
  reason: string;
}

export interface BiasResult {
  direction: "LONG" | "SHORT" | "NEUTRAL";
  strength: "STRONG" | "MEDIUM" | "WEAK";
  adx: number | null;
  ema8: number | null;
  ema21: number | null;
  debug: string[];
}

export interface StructureResult {
  atr: number;
  swingLow: number;
  swingHigh: number;
  trendlinePrice: number | null;
  trendlineR2: number | null;
  trendlineAgeMs: number;
  volumeOk: boolean;
  volumeRatio: number;
  nearTrendline: boolean;
  distToTrendline: number;
  debug: string[];
}

export interface TriggerResult {
  fired: boolean;
  reason: string;
  stochK: number;
  stochD: number;
  prevK: number | null;
  prevD: number | null;
  debug: string[];
}

// ─── Constants ─────────────────────────────────────────────

export const CURRENT_SIGNAL_VERSION = 42.2;
const MIN_RR = 1.5;
const MAX_STOP_PCT = 0.04;
const ATR_MULT = 1.5;
const STOCH_OVERSOLD = 20;
const STOCH_OVERBOUGHT = 80;
const MIN_ADX = 20;
const MIN_TRENDLINE_R2 = 0.50;
const TRENDLINE_PROXIMITY_PCT = 0.012;
const VOL_THRESHOLD = 1.2;
const HYSTERESIS_ENTRY_MS = 4 * 60 * 60 * 1000;      // 4h after entry
const COOLDOWN_STOP_MS = 2 * 60 * 60 * 1000;         // 2h after stop loss
const COOLDOWN_TP_MS = 1 * 60 * 60 * 1000;           // 1h after target hit
const SIGNAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;       // 7 days
const A_SETUP_CONFIDENCE = 80;
const B_SETUP_CONFIDENCE = 60;
const A_SETUP_SIZE_PCT = 1.0;
const B_SETUP_SIZE_PCT = 0.5;

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

// ─── 4H → 1D (compatibility only, not used for bias) ───────

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

// ─── 4H BIAS ───────────────────────────────────────────────

export function calculateBias4H(candles4h: Candle[]): BiasResult {
  const debug: string[] = [];
  if (candles4h.length < 50) {
    debug.push("[BIAS-4H] Insufficient data (<50 bars)");
    return { direction: "NEUTRAL", strength: "WEAK", adx: null, ema8: null, ema21: null, debug };
  }
  const closes = candles4h.map(c => c.close);
  const e8 = ema(closes, 8);
  const e21 = ema(closes, 21);
  if (!e8.length || !e21.length) {
    debug.push("[BIAS-4H] EMA calc failed");
    return { direction: "NEUTRAL", strength: "WEAK", adx: null, ema8: null, ema21: null, debug };
  }
  const lastE8 = e8[e8.length - 1];
  const lastE21 = e21[e21.length - 1];
  const direction = lastE8 > lastE21 ? "LONG" : "SHORT";

  const adxVal = adx(candles4h);
  let strength: "STRONG" | "MEDIUM" | "WEAK" = "WEAK";
  if (adxVal !== null) {
    if (adxVal >= 25) strength = "STRONG";
    else if (adxVal >= MIN_ADX) strength = "MEDIUM";
  }

  // Optional: price on correct side of EMA21
  const lastClose = closes[closes.length - 1];
  const priceOnSide = direction === "LONG" ? lastClose >= lastE21 : lastClose <= lastE21;
  if (!priceOnSide) {
    debug.push(`[BIAS-4H] Price ${sf(lastClose,2)} on wrong side of EMA21 ${sf(lastE21,2)} — NEUTRAL`);
    return { direction: "NEUTRAL", strength, adx: adxVal, ema8: lastE8, ema21: lastE21, debug };
  }

  if (adxVal !== null && adxVal < MIN_ADX) {
    debug.push(`[BIAS-4H] ADX ${adxVal} < ${MIN_ADX} — NEUTRAL`);
    return { direction: "NEUTRAL", strength, adx: adxVal, ema8: lastE8, ema21: lastE21, debug };
  }

  debug.push(`[BIAS-4H] ${direction} ${strength} | ADX=${sf(adxVal ?? 0,1)} | EMA8=${sf(lastE8,2)} EMA21=${sf(lastE21,2)}`);
  return { direction, strength, adx: adxVal, ema8: lastE8, ema21: lastE21, debug };
}

// ─── 1H STRUCTURE ──────────────────────────────────────────

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

// Redis-backed trendline store — caller provides get/set
export interface TrendlineStore {
  get(pair: string, direction: "LONG" | "SHORT"): Promise<TrendlineState | null>;
  set(pair: string, state: TrendlineState): Promise<void>;
}

// In-memory fallback (for tests / single-process)
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

export async function calculateStructure1H(
  pair: string,
  candles1h: Candle[],
  direction: "LONG" | "SHORT",
  store: TrendlineStore = defaultTrendlineStore
): Promise<StructureResult> {
  const debug: string[] = [];
  const result: StructureResult = {
    atr: 0, swingLow: 0, swingHigh: 0,
    trendlinePrice: null, trendlineR2: null, trendlineAgeMs: 0,
    volumeOk: false, volumeRatio: 0,
    nearTrendline: false, distToTrendline: 0,
    debug,
  };

  if (candles1h.length < 50) {
    debug.push("[STRUCTURE-1H] Insufficient data (<50 bars)");
    return result;
  }

  // ATR
  result.atr = atr(candles1h, 14);
  debug.push(`[STRUCTURE-1H] ATR=${sf(result.atr,4)}`);

  // Swing levels (last 20 bars)
  const recent = candles1h.slice(-20);
  result.swingLow = Math.min(...recent.map(c => c.low));
  result.swingHigh = Math.max(...recent.map(c => c.high));
  debug.push(`[STRUCTURE-1H] SwingLow=${sf(result.swingLow,2)} SwingHigh=${sf(result.swingHigh,2)}`);

  // Volume
  const vols = candles1h.slice(-10).map(c => c.volume);
  const avgVol = avg(vols.slice(0, -1));
  const currentVol = candles1h[candles1h.length - 1].volume;
  result.volumeRatio = avgVol > 0 ? currentVol / avgVol : 0;
  result.volumeOk = result.volumeRatio > VOL_THRESHOLD;
  debug.push(`[STRUCTURE-1H] VolRatio=${sf(result.volumeRatio,2)} OK=${result.volumeOk}`);

  // Trendline
  const pivots = findPivots(candles1h, direction);
  if (pivots.length < 3) {
    debug.push(`[STRUCTURE-1H] Only ${pivots.length} pivots, need >=3`);
    return result;
  }
  const recentPivots = pivots.slice(-5);
  const fit = fitTrendline(recentPivots);
  if (!fit) {
    debug.push("[STRUCTURE-1H] Trendline fit failed");
    return result;
  }
  if (fit.r2 < MIN_TRENDLINE_R2) {
    debug.push(`[STRUCTURE-1H] R² ${sf(fit.r2,3)} < ${MIN_TRENDLINE_R2} — rejected`);
    return result;
  }

  const now = candles1h[candles1h.length - 1].timestamp;
  const currentIndex = candles1h.length - 1;
  const trendlinePrice = fit.slope * currentIndex + fit.intercept;

  // Store
  await store.set(pair, {
    slope: fit.slope,
    intercept: fit.intercept,
    lastUpdated: now,
    direction,
    r2: fit.r2,
  });

  const lastPrice = candles1h[candles1h.length - 1].close;
  result.trendlinePrice = trendlinePrice;
  result.trendlineR2 = fit.r2;
  result.trendlineAgeMs = 0; // just rebuilt
  result.distToTrendline = (lastPrice - trendlinePrice) / trendlinePrice;
  result.nearTrendline = Math.abs(result.distToTrendline) < TRENDLINE_PROXIMITY_PCT;

  debug.push(`[STRUCTURE-1H] TL=${sf(trendlinePrice,2)} R²=${sf(fit.r2,3)} Dist=${sf(result.distToTrendline*100,2)}% Near=${result.nearTrendline}`);
  return result;
}

// ─── 15m TRIGGER ───────────────────────────────────────────

export function calculateTrigger15m(
  candles15m: Candle[],
  direction: "LONG" | "SHORT"
): TriggerResult {
  const debug: string[] = [];
  const closes = candles15m.map(c => c.close);
  const stoch = stochRsi(closes);

  debug.push(`[TRIGGER-15m] K=${stoch.k} D=${stoch.d} prevK=${stoch.prevK} prevD=${stoch.prevD}`);

  let fired = false;
  let reason = "";

  if (direction === "LONG") {
    // K crosses above D from oversold
    if (stoch.prevK !== null && stoch.prevD !== null) {
      if (stoch.prevK < stoch.prevD && stoch.k >= stoch.d && stoch.k < STOCH_OVERSOLD) {
        fired = true;
        reason = `K crossed above D from oversold (K=${stoch.k}, D=${stoch.d})`;
      }
    }
    // Fallback: K is in oversold zone (for when we don't have enough history for cross)
    if (!fired && stoch.k < STOCH_OVERSOLD) {
      fired = true;
      reason = `K in oversold zone (K=${stoch.k})`;
    }
  } else {
    // K crosses below D from overbought
    if (stoch.prevK !== null && stoch.prevD !== null) {
      if (stoch.prevK > stoch.prevD && stoch.k <= stoch.d && stoch.k > STOCH_OVERBOUGHT) {
        fired = true;
        reason = `K crossed below D from overbought (K=${stoch.k}, D=${stoch.d})`;
      }
    }
    // Fallback
    if (!fired && stoch.k > STOCH_OVERBOUGHT) {
      fired = true;
      reason = `K in overbought zone (K=${stoch.k})`;
    }
  }

  if (!fired) {
    reason = direction === "LONG"
      ? `No LONG trigger: K=${stoch.k} not < ${STOCH_OVERSOLD}`
      : `No SHORT trigger: K=${stoch.k} not > ${STOCH_OVERBOUGHT}`;
  }

  debug.push(`[TRIGGER-15m] Fired=${fired} | ${reason}`);
  return { fired, reason, stochK: stoch.k, stochD: stoch.d, prevK: stoch.prevK, prevD: stoch.prevD, debug };
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
  // Check active signal (entry hysteresis)
  const active = activeSignals.find(s => s.pair === pair && !s.exited);
  if (active) {
    const elapsed = now - active.timestamp;
    if (elapsed < HYSTERESIS_ENTRY_MS) {
      return { locked: true, reason: `Active signal (${Math.round(elapsed/60000)}min old)` };
    }
  }

  // Check cooldown store
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
  }
): Promise<SignalResult> {
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
  if (candles1h.length < 100) {
    debug.push(`[SIGNAL] REJECTED — 1H insufficient data (${candles1h.length} < 100)`);
    return { debug };
  }
  if (candles15m.length < 100) {
    debug.push(`[SIGNAL] REJECTED — 15m insufficient data (${candles15m.length} < 100)`);
    return { debug };
  }

  // ── 4H Bias ──
  const bias = calculateBias4H(candles4h);
  debug.push(...bias.debug);
  if (bias.direction === "NEUTRAL") {
    if (bias.adx !== null && bias.adx < MIN_ADX) {
      debug.push("[SIGNAL] REJECTED — 4H ADX too low");
    } else {
      debug.push("[SIGNAL] REJECTED — 4H bias NEUTRAL");
    }
    return { debug };
  }
  const direction = bias.direction;

  // ── 1H Structure ──
  const structure = await calculateStructure1H(pair, candles1h, direction, options?.trendlineStore);
  debug.push(...structure.debug);
  if (!structure.nearTrendline) {
    debug.push(`[SIGNAL] REJECTED — Not near trendline (dist=${sf(structure.distToTrendline*100,2)}%)`);
    return { debug };
  }

  // ── 15m Trigger ──
  const trigger = calculateTrigger15m(candles15m, direction);
  debug.push(...trigger.debug);
  if (!trigger.fired) {
    debug.push("[SIGNAL] REJECTED — No 15m trigger");
    return { debug };
  }

  // ── Risk Management ──
  const entry = price;
  let stop: number;
  let target: number;

  if (direction === "LONG") {
    const atrStop = entry - structure.atr * ATR_MULT;
    const pctStop = entry * (1 - MAX_STOP_PCT);
    const swingStop = structure.swingLow * 0.998;
    stop = Math.max(atrStop, pctStop, swingStop);
    // Cap: never let trendline push stop unreasonably wide
    const maxStop = entry * (1 - MAX_STOP_PCT);
    if (stop < maxStop) stop = maxStop;
    target = entry + (entry - stop) * 3;
  } else {
    const atrStop = entry + structure.atr * ATR_MULT;
    const pctStop = entry * (1 + MAX_STOP_PCT);
    const swingStop = structure.swingHigh * 1.002;
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

  // ── Setup Grade ──
  let setupGrade: "A" | "B" = "B";
  let confidence = B_SETUP_CONFIDENCE;
  let positionSizePct = B_SETUP_SIZE_PCT;
  if (bias.strength === "STRONG" && structure.volumeOk && structure.trendlineR2 && structure.trendlineR2 > 0.70) {
    setupGrade = "A";
    confidence = A_SETUP_CONFIDENCE;
    positionSizePct = A_SETUP_SIZE_PCT;
  }

  // ── Build Signal ──
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
    adx: bias.adx ?? undefined,
    stochK: trigger.stochK,
    stochD: trigger.stochD,
    version: CURRENT_SIGNAL_VERSION,
    setupGrade,
    positionSizePct,
  };

  await setCooldown(pair, "entry", now, options?.cooldownStore);

  debug.push(`[SIGNAL] ✅ ACCEPTED ${direction} ${setupGrade} | Entry=$${sf(entry,2)} Stop=$${sf(stop,2)} Target=$${sf(target,2)} RR=${sf(rr,2)} Conf=${confidence}% Size=${sf(positionSizePct*100,0)}%`);
  debug.push(`[SIGNAL] 4H: ${bias.direction} ${bias.strength} ADX=${sf(bias.adx ?? 0,1)}`);
  debug.push(`[SIGNAL] 1H: ATR=${sf(structure.atr,4)} TL=${sf(structure.trendlinePrice ?? 0,2)} R²=${sf(structure.trendlineR2 ?? 0,3)} Vol=${structure.volumeOk}`);
  debug.push(`[SIGNAL] 15m: K=${trigger.stochK} D=${trigger.stochD} ${trigger.reason}`);

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
  // 4H bias reversal
  if (candles4h.length >= 50) {
    const bias = calculateBias4H(candles4h);
    if (bias.direction && bias.direction !== signal.direction) {
      return { shouldHold: false, reason: "4h_bias_reversed" };
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
  const bias = calculateBias4H(candles4h);
  const structure = await calculateStructure1H(pair, candles1h, bias.direction || "LONG", options?.trendlineStore);

  const stoch15m = candles15m.length >= 100 ? stochRsi(candles15m.map(c => c.close)) : { k: 50, d: 50, prevK: null, prevD: null };
  const stoch1h = candles1h.length >= 100 ? stochRsi(candles1h.map(c => c.close)) : { k: 50, d: 50, prevK: null, prevD: null };
  const stoch4h = candles4h.length >= 50 ? stochRsi(candles4h.map(c => c.close)) : { k: 50, d: 50, prevK: null, prevD: null };

  const closes1h = candles1h.map(c => c.close);
  const e8_1h = ema(closes1h, 8);
  const e21_1h = ema(closes1h, 21);

  return {
    pair,
    price: Math.round(price * 100) / 100,
    timestamp: Date.now(),
    bias: bias.direction ? `${bias.direction} ${bias.strength}` : "NEUTRAL",
    biasDirection: bias.direction,
    biasStrength: bias.strength,
    stoch15m,
    stoch1h,
    stoch4h,
    adx: bias.adx,
    ema8_1h: e8_1h.length ? Math.round(e8_1h[e8_1h.length - 1] * 100) / 100 : 0,
    ema21_1h: e21_1h.length ? Math.round(e21_1h[e21_1h.length - 1] * 100) / 100 : 0,
    structure: {
      atr: structure.atr,
      swingLow: structure.swingLow,
      swingHigh: structure.swingHigh,
      trendlinePrice: structure.trendlinePrice,
      trendlineR2: structure.trendlineR2,
      nearTrendline: structure.nearTrendline,
      volumeOk: structure.volumeOk,
    },
    signal: signalResult?.signal || null,
    debug: signalResult?.debug || [],
    trend1d: null, // deprecated, kept for compatibility
    trend4h: bias.direction ? { direction: bias.direction, strength: bias.strength } : null,
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
  }
): Promise<SignalResult> {
  return generateSignal(
    pair,
    candles1h,
    candles4h,
    aggregateTo1D(candles4h), // 1D aggregated from 4H for compatibility
    candles15m,
    activeSignals || [],
    currentPrice,
    options
  );
}
