// lib/strategy.ts — v42.1 "Trend Rider" — 1H Trendline + 15m Entry
// ============================================================
// Timeframe architecture:
//   1D  →  Bias direction (EMA8/21), trend reversal exit, ADX filter
//   1H  →  Trendline pivots, ATR for stops, StochRSI for UI
//   4H  →  StochRSI for UI, 1D aggregation source
//   15m →  StochRSI for entry trigger and exit detection
//
// Entry:  1D trend LONG + 1H near trendline + 15m Stoch extreme
// Stop:   ATR(14) on 1H × 1.5, hard cap 4%
// Exit:   1D trend flip OR 15m Stoch opposite extreme OR stop
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
}

export interface SignalResult {
  signal?: Signal;
  debug: string[];
}

export interface HoldResult {
  shouldHold: boolean;
  reason: string;
}

export const CURRENT_SIGNAL_VERSION = 42.1;
const MIN_RR = 1.5;
const MAX_STOP_PCT = 0.04;
const ATR_MULT = 1.5;
const STOCH_ENTRY_LONG = 20;
const STOCH_ENTRY_SHORT = 80;
const STOCH_EXIT_LONG = 80;
const STOCH_EXIT_SHORT = 20;
const MIN_ADX = 20;

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
): { k: number; d: number } {
  if (!values.every(isValid)) return { k: 50, d: 50 };
  const rsiValues: number[] = [];
  for (let i = rsiPeriod; i < values.length; i++) {
    const r = wilderRsi(values.slice(0, i + 1), rsiPeriod);
    if (r !== null) rsiValues.push(r);
  }
  if (rsiValues.length < stochPeriod + kSmooth - 1) {
    return { k: rsiValues[rsiValues.length - 1] || 50, d: 50 };
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
  if (kValues.length < dSmooth) return { k: kValues[kValues.length - 1] || 50, d: 50 };
  return {
    k: Math.round(kValues[kValues.length - 1] * 10) / 10,
    d: Math.round(avg(kValues.slice(-dSmooth)) * 10) / 10,
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

// ─── 4H → 1D ───────────────────────────────────────────────

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

// ─── 1D Trend ──────────────────────────────────────────────

export function calculateTrend1D(candles1d: Candle[]): {
  direction: "LONG" | "SHORT" | null;
  strength: "STRONG" | "MEDIUM" | "WEAK";
  adx: number | null;
  debug: string[];
} {
  const debug: string[] = [];
  if (candles1d.length < 50) {
    debug.push("[TREND1D] Insufficient data");
    return { direction: null, strength: "WEAK", adx: null, debug };
  }
  const closes = candles1d.map(c => c.close);
  const e8 = ema(closes, 8);
  const e21 = ema(closes, 21);
  if (!e8.length || !e21.length) {
    debug.push("[TREND1D] EMA calc failed");
    return { direction: null, strength: "WEAK", adx: null, debug };
  }
  const direction = e8[e8.length - 1] > e21[e21.length - 1] ? "LONG" : "SHORT";

  const highs = candles1d.slice(-20).map(c => c.high);
  const lows = candles1d.slice(-20).map(c => c.low);
  const hh = highs[highs.length - 1] > Math.max(...highs.slice(0, -1));
  const ll = lows[lows.length - 1] < Math.min(...lows.slice(0, -1));
  const structureValid = (direction === "LONG" && hh) || (direction === "SHORT" && ll);

  const adxVal = adx(candles1d);
  let strength: "STRONG" | "MEDIUM" | "WEAK" = "WEAK";
  if (adxVal !== null) {
    if (adxVal >= 25 && structureValid) strength = "STRONG";
    else if (adxVal >= 20) strength = "MEDIUM";
  } else if (structureValid) {
    strength = "MEDIUM";
  }

  debug.push(`[TREND1D] ${direction} ${strength} | ADX=${sf(adxVal ?? 0,1)}`);
  return { direction, strength, adx: adxVal, debug };
}

// ─── Trendline (on 1H candles) ───────────────────────────

interface TrendlineState {
  slope: number;
  intercept: number;
  lastUpdated: number;
  direction: "LONG" | "SHORT";
}

const trendlineStore: Map<string, TrendlineState> = new Map();

function findPivots(candles: Candle[], direction: "LONG" | "SHORT") {
  const pivots: { index: number; price: number }[] = [];
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

function fitTrendline(pivots: { index: number; price: number }[]) {
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
  return { slope, intercept };
}

function getTrendline(pair: string, candles: Candle[], direction: "LONG" | "SHORT"): {
  price: number; age: number;
} | null {
  if (candles.length < 20) return null;
  const pivots = findPivots(candles, direction);
  if (pivots.length < 3) return null;

  const recentPivots = pivots.slice(-5);
  const now = candles[candles.length - 1].timestamp;
  const existing = trendlineStore.get(pair);
  const maxAge = 7 * 24 * 60 * 60 * 1000;

  let fit = null;
  if (existing && existing.direction === direction && (now - existing.lastUpdated) < maxAge) {
    const lastPivot = recentPivots[recentPivots.length - 1];
    const projected = existing.slope * lastPivot.index + existing.intercept;
    const deviation = Math.abs(lastPivot.price - projected) / projected;
    if (deviation < 0.02) {
      fit = existing;
    }
  }
  if (!fit) {
    fit = fitTrendline(recentPivots);
    if (!fit) return null;
    trendlineStore.set(pair, { ...fit, lastUpdated: now, direction });
  }

  const currentIndex = candles.length - 1;
  return {
    price: fit.slope * currentIndex + fit.intercept,
    age: now - (trendlineStore.get(pair)?.lastUpdated ?? now),
  };
}

// ─── Hysteresis (simple, in-memory) ────────────────────────

interface HystState {
  lockUntil: number;
}
const hystStore: Map<string, HystState> = new Map();

function getHyst(pair: string, now: number): boolean {
  const s = hystStore.get(pair);
  return !!(s && now <= s.lockUntil);
}

function setHyst(pair: string, now: number): void {
  hystStore.set(pair, { lockUntil: now + 24 * 60 * 60 * 1000 });
}

// ─── SIGNAL GENERATION ─────────────────────────────────────

export function generateSignal(
  pair: string,
  candles1h: Candle[],
  candles4h: Candle[],
  candles1d: Candle[],
  candles15m: Candle[],
  activeSignals: Signal[],
  currentPrice?: number
): SignalResult {
  const debug: string[] = [];
  const now = Date.now();

  if (!Array.isArray(activeSignals)) activeSignals = [];

  const active = activeSignals.find(s => s && s.pair === pair && s.exited === false);
  if (active) {
    debug.push(`[SIGNAL] Already active: ${active.id}`);
    return { debug };
  }

  if (getHyst(pair, now)) {
    debug.push(`[SIGNAL] Hysteresis lock active`);
    return { debug };
  }

  const recentExit = activeSignals
    .filter(s => s.pair === pair && s.exited === true && s.exitTimestamp)
    .sort((a, b) => (b.exitTimestamp || 0) - (a.exitTimestamp || 0))[0];
  if (recentExit && recentExit.exitTimestamp && now - recentExit.exitTimestamp < 2 * 60 * 60 * 1000) {
    debug.push(`[SIGNAL] Cooldown: ${Math.round((now - recentExit.exitTimestamp) / 60000)}min since exit`);
    return { debug };
  }

  if (candles4h.length < 50 || candles1d.length < 50 || candles1h.length < 100 || candles15m.length < 100) {
    debug.push(`[SIGNAL] Insufficient data`);
    return { debug };
  }

  const price = currentPrice ?? candles15m[candles15m.length - 1].close;

  const trend1d = calculateTrend1D(candles1d);
  debug.push(...trend1d.debug);

  if (!trend1d.direction) {
    debug.push("[SIGNAL] No 1D trend");
    return { debug };
  }

  if (trend1d.adx !== null && trend1d.adx < MIN_ADX) {
    debug.push(`[SIGNAL] 1D ADX ${trend1d.adx} < ${MIN_ADX} — ranging, no trade`);
    return { debug };
  }

  const direction = trend1d.direction;

  const tl = getTrendline(pair, candles1h, direction);
  const tlPrice = tl?.price ?? price;
  const dist = (price - tlPrice) / tlPrice;
  debug.push(`[TL-1H] Price=${sf(price,2)} TL=${sf(tlPrice,2)} Dist=${sf(dist*100,2)}%`);

  const nearTrendline = Math.abs(dist) < 0.012;
  if (!nearTrendline) {
    debug.push(`[SIGNAL] No signal: far from TL (${sf(Math.abs(dist)*100,2)}% > 1.2%)`);
    return { debug };
  }

  const closes15m = candles15m.map(c => c.close);
  const stoch = stochRsi(closes15m);
  debug.push(`[STOCH-15m] K=${stoch.k} D=${stoch.d}`);

  const stochExtreme = direction === "LONG" ? stoch.k < STOCH_ENTRY_LONG : stoch.k > STOCH_ENTRY_SHORT;
  if (!stochExtreme) {
    debug.push(`[SIGNAL] No signal: Stoch not extreme (K=${stoch.k}, need ${direction === "LONG" ? "<" + STOCH_ENTRY_LONG : ">" + STOCH_ENTRY_SHORT})`);
    return { debug };
  }

  const vols = candles1h.slice(-10).map(c => c.volume);
  const avgVol = avg(vols.slice(0, -1));
  const volOk = candles1h[candles1h.length - 1].volume > avgVol * 1.2;
  debug.push(`[VOL-1H] Ratio=${sf(vols[vols.length-1]/avgVol,2)} | OK=${volOk}`);

  const atr1h = atr(candles1h, 14);
  const swingLows = candles1h.map(c => c.low).slice(-20);
  const swingHighs = candles1h.map(c => c.high).slice(-20);
  const swingLow = Math.min(...swingLows);
  const swingHigh = Math.max(...swingHighs);

  let entry = price;
  let stop: number;
  let target: number;

  if (direction === "LONG") {
    const atrStop = entry - atr1h * ATR_MULT;
    const pctStop = entry * (1 - MAX_STOP_PCT);
    stop = Math.max(atrStop, pctStop, swingLow * 0.998);
    target = entry + (entry - stop) * 3;
  } else {
    const atrStop = entry + atr1h * ATR_MULT;
    const pctStop = entry * (1 + MAX_STOP_PCT);
    stop = Math.min(atrStop, pctStop, swingHigh * 1.002);
    target = entry - (stop - entry) * 3;
  }

  const risk = Math.abs(entry - stop);
  const reward = Math.abs(target - entry);
  const rr = risk > 0 ? reward / risk : 0;

  if (rr < MIN_RR) {
    debug.push(`[SIGNAL] RR ${sf(rr,2)} < ${MIN_RR}`);
    return { debug };
  }

  let confidence = 60;
  if (trend1d.strength === "STRONG") confidence += 15;
  else if (trend1d.strength === "MEDIUM") confidence += 5;
  if (volOk) confidence += 5;
  if (Math.abs(dist) < 0.006) confidence += 10;
  confidence = Math.min(90, Math.max(40, confidence));

  setHyst(pair, now);

  const adx1h = adx(candles1h);

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
    adx: adx1h !== null ? Math.round(adx1h * 10) / 10 : undefined,
    stochK: stoch.k,
    stochD: stoch.d,
    version: CURRENT_SIGNAL_VERSION,
  };

  debug.push(`[SIGNAL] ✅ ENTRY ${direction} | Entry=$${sf(entry,2)} Stop=$${sf(stop,2)} Target=$${sf(target,2)} RR=${sf(rr,2)} Conf=${confidence}%`);

  return { signal, debug };
}

// ─── EXIT LOGIC ────────────────────────────────────────────

export function shouldHold(
  signal: Signal,
  candles1h: Candle[],
  candles1d: Candle[],
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

  if (candles1d.length >= 50) {
    const trend = calculateTrend1D(candles1d);
    if (trend.direction && trend.direction !== signal.direction) {
      return { shouldHold: false, reason: "1d_trend_reversed" };
    }
  }

  const closes15m = candles15m.map(c => c.close);
  const stoch = stochRsi(closes15m);

  const stochOpposite = signal.direction === "LONG"
    ? stoch.k > STOCH_EXIT_LONG
    : stoch.k < STOCH_EXIT_SHORT;

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
  const TTL = 7 * 24 * 60 * 60 * 1000;

  for (const signal of signals) {
    if (!signal.exited) {
      const price = currentPrices?.[signal.pair];
      if (price !== undefined) {
        const check = isSignalStillValid(signal, price);
        if (!check.valid) { exited.push({ signal, reason: check.reason }); continue; }
      }
      active.push(signal); continue;
    }
    if (now - signal.timestamp < TTL) active.push(signal);
  }
  return { active, exited };
}

// ─── Market Snapshot ───────────────────────────────────────
// Computes StochRSI on ALL timeframes for UI display

export function getMarketSnapshot(
  pair: string,
  candles1h: Candle[],
  candles4h: Candle[],
  candles15m: Candle[],
  candles1d: Candle[],
  currentPrice?: number,
  signalResult?: SignalResult
) {
  const price = currentPrice ?? candles15m[candles15m.length - 1]?.close ?? 0;
  const trend1d = calculateTrend1D(candles1d);

  // Compute StochRSI on all timeframes for UI
  const stoch15m = candles15m.length >= 100 ? stochRsi(candles15m.map(c => c.close)) : { k: 50, d: 50 };
  const stoch1h = candles1h.length >= 100 ? stochRsi(candles1h.map(c => c.close)) : { k: 50, d: 50 };
  const stoch4h = candles4h.length >= 50 ? stochRsi(candles4h.map(c => c.close)) : { k: 50, d: 50 };

  const adxVal = adx(candles1h) ?? 0;
  const adx1d = adx(candles1d);

  const closes1h = candles1h.map(c => c.close);
  const e8 = ema(closes1h, 8);
  const e21 = ema(closes1h, 21);

  // Compute 4H EMA for trend4h display
  const closes4h = candles4h.map(c => c.close);
  const e8_4h = ema(closes4h, 8);
  const e21_4h = ema(closes4h, 21);
  const trend4hDir = e8_4h.length && e21_4h.length
    ? (e8_4h[e8_4h.length - 1] > e21_4h[e21_4h.length - 1] ? "LONG" : "SHORT")
    : null;
  const trend4hStrength = trend4hDir
    ? (adx(candles4h) ?? 0) >= 25 ? "STRONG" : (adx(candles4h) ?? 0) >= 20 ? "MEDIUM" : "WEAK"
    : "WEAK";

  return {
    pair,
    price: Math.round(price * 100) / 100,
    timestamp: Date.now(),
    trend: trend1d.direction ? `${trend1d.direction} ${trend1d.strength}` : "NONE",
    trendDirection: trend1d.direction,
    trendStrength: trend1d.strength,
    stoch15m,
    stoch1h,
    stoch4h,
    adx: Math.round(adxVal * 10) / 10,
    adx1d: adx1d !== null ? Math.round(adx1d * 10) / 10 : null,
    ema8: e8.length ? Math.round(e8[e8.length - 1] * 100) / 100 : 0,
    ema21: e21.length ? Math.round(e21[e21.length - 1] * 100) / 100 : 0,
    signal: signalResult?.signal || null,
    debug: signalResult?.debug || [],
    // v41-compatible fields for UI
    trend1d: trend1d.direction ? { direction: trend1d.direction, strength: trend1d.strength } : null,
    trend4h: trend4hDir ? { direction: trend4hDir, strength: trend4hStrength } : null,
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
  currentPrice: number
): HoldResult {
  return shouldHold(signal, candles1h, aggregateTo1D(candles4h), candles1h, currentPrice);
}

export async function generateSignalAsync(
  pair: string,
  candles1h: Candle[],
  candles4h: Candle[],
  candles15m: Candle[],
  activeSignals?: Signal[],
  currentPrice?: number
): Promise<SignalResult> {
  return generateSignal(pair, candles1h, candles4h, aggregateTo1D(candles4h), candles15m, activeSignals || [], currentPrice);
}
