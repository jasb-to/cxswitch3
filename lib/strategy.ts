// lib/strategy.ts — v32.3 "Five Exits, Fixed"
// ============================================================
// Timeframe contract:
//   1D = bias only. Real 1D candles. Only closed candles flip regime.
//   4H = setup, entry, management, exit. Structure-based only.
//   1H = entry timing ONLY. After entry, SILENT.
//
// Five exits ONLY:
//   1. Stop loss hit
//   2. Take profit hit
//   3. Two consecutive 4H closes beyond EMA21 + EMA21 slope negative
//   4. 4H close beyond trendline by 1.5x ATR
//   5. 1D regime flips STRONG against position (closed candle only)
//
// NO other exits. NO oscillators exit trades. NO TTL. NO missed_entry.
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
  type: "ACCUMULATE" | "BREAKOUT";
  scale: "ENTRY_1" | "ENTRY_2" | "ADD" | null;
  entry: number;
  stop: number;
  target: number;
  confidence: number;
  rr: number;
  adx: number;
  rsi: number;
  stochK: number;
  stochD: number;
  expectedMove: number;
  reason: string;
  timestamp: number;
  version: number;
  exited?: boolean;
  highestPrice?: number;
  lowestPrice?: number;
  tradeState?: string;
  lockedStop?: number;
  profitLockActive?: boolean;
  entryTier?: EntryTier;
  entryMode?: string;
  positionSizePct?: number;
  regimeDirection?: string;
}

export interface SignalResult {
  signal?: Signal;
  market?: any;
  debug: string[];
}

export type EntryTier = "NO_TRADE" | "WATCH" | "EARLY_ENTRY" | "CONFIRMED_ENTRY";

export interface HoldResult {
  shouldHold: boolean;
  reason: string;
}

export const CURRENT_SIGNAL_VERSION = 32;
const MIN_RR = 1.5;
const EXITED_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SIGNAL_COOLDOWN_MS = 4 * 60 * 60 * 1000;
const DIRECTION_LOCK_MS = 8 * 60 * 60 * 1000;
const HYSTERESIS_BAND = 0.005;
const DEBUG = process.env.DEBUG === "true";

// ─── INDICATORS ───

function avg(arr: number[]): number {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
}

function isValidNumber(v: any): boolean {
  return typeof v === "number" && Number.isFinite(v);
}

export function ema(values: number[], period: number): number[] {
  if (values.length < period || !values.every(isValidNumber)) return [];
  const k = 2 / (period + 1);
  const out: number[] = [];
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out.push(prev);
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out.push(prev);
  }
  return out.every(isValidNumber) ? out : [];
}

export function wilderRsi(values: number[], period: number = 14): number | null {
  if (values.length < period + 1 || !values.every(isValidNumber)) return null;
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

export function stochRsi(values: number[], rsiPeriod = 14, stochPeriod = 14, kSmooth = 3, dSmooth = 3): { k: number; d: number } {
  if (!values.every(isValidNumber)) return { k: 50, d: 50 };
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
  return { k: Math.round(kValues[kValues.length - 1] * 10) / 10, d: Math.round(avg(kValues.slice(-dSmooth)) * 10) / 10 };
}

export function adx(candles: Candle[], period = 14): number | null {
  if (candles.length < period * 2) return null;
  const h = candles.map(c => c.high), l = candles.map(c => c.low), c = candles.map(c => c.close);
  const trs: number[] = [], pDM: number[] = [], mDM: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    trs.push(Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1])));
    pDM.push(h[i] - h[i - 1] > l[i - 1] - l[i] ? Math.max(h[i] - h[i - 1], 0) : 0);
    mDM.push(l[i - 1] - l[i] > h[i] - h[i - 1] ? Math.max(l[i - 1] - l[i], 0) : 0);
  }
  const smooth = (vals: number[], lookback: number) => {
    const r = [avg(vals.slice(0, lookback))];
    for (let i = lookback; i < vals.length; i++) r.push((r[r.length - 1] * (lookback - 1) + vals[i]) / lookback);
    return r;
  };
  const atrS = smooth(trs, period), pDIS = smooth(pDM, period), mDIS = smooth(mDM, period);
  if (!atrS.length) return null;
  const dx = atrS.map((_, i) => {
    const p = (pDIS[i] / atrS[i]) * 100, m = (mDIS[i] / atrS[i]) * 100;
    return p + m === 0 ? 0 : (Math.abs(p - m) / (p + m)) * 100;
  });
  const adxS = smooth(dx, period);
  const v = adxS[adxS.length - 1];
  return isValidNumber(v) ? Math.round(v * 10) / 10 : null;
}

function atr(candles: Candle[], period = 14): number {
  const trs: number[] = [];
  for (let i = Math.max(1, candles.length - period); i < candles.length; i++) {
    trs.push(Math.max(candles[i].high - candles[i].low, Math.abs(candles[i].high - candles[i - 1].close), Math.abs(candles[i].low - candles[i - 1].close)));
  }
  return avg(trs);
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
    daily.push({ timestamp: bars[0].timestamp, open: bars[0].open, high: Math.max(...bars.map(b => b.high)), low: Math.min(...bars.map(b => b.low)), close: bars[bars.length - 1].close, volume: bars.reduce((s, b) => s + b.volume, 0) });
  }
  return daily.sort((a, b) => a.timestamp - b.timestamp);
}

// ─── TRENDLINE ───

function findPivots(candles: Candle[], direction: "LONG" | "SHORT") {
  const pivots: { index: number; price: number; timestamp: number }[] = [];
  for (let i = 3; i < candles.length - 3; i++) {
    const c = candles[i];
    const isLow = c.low < candles[i - 1].low && c.low < candles[i - 2].low && c.low < candles[i + 1].low && c.low < candles[i + 2].low;
    const isHigh = c.high > candles[i - 1].high && c.high > candles[i - 2].high && c.high > candles[i + 1].high && c.high > candles[i + 2].high;
    if (direction === "LONG" && isLow) pivots.push({ index: i, price: c.low, timestamp: c.timestamp });
    if (direction === "SHORT" && isHigh) pivots.push({ index: i, price: c.high, timestamp: c.timestamp });
  }
  return pivots;
}

const trendlineStore = new Map<string, { slope: number; intercept: number; lastUpdated: number; direction: "LONG" | "SHORT" }>();

function getTrendline(pair: string, candles: Candle[], direction: "LONG" | "SHORT") {
  const len = candles.length;
  if (len < 20) return null;
  const pivots = findPivots(candles, direction);
  if (pivots.length < 3) return null;
  const recent = pivots.slice(-5);
  const now = candles[candles.length - 1].timestamp;

  const existing = trendlineStore.get(pair);
  if (existing && existing.direction === direction && (now - existing.lastUpdated) < 7 * 24 * 60 * 60 * 1000) {
    const last = recent[recent.length - 1];
    const projected = existing.slope * last.index + existing.intercept;
    if (Math.abs(last.price - projected) / projected < 0.02) {
      return { price: existing.slope * (len - 1) + existing.intercept, r2: 0.85 };
    }
  }

  const n = recent.length;
  const sx = recent.reduce((s, p) => s + p.index, 0);
  const sy = recent.reduce((s, p) => s + p.price, 0);
  const sxy = recent.reduce((s, p) => s + p.index * p.price, 0);
  const sx2 = recent.reduce((s, p) => s + p.index * p.index, 0);
  const slope = (n * sxy - sx * sy) / (n * sx2 - sx * sx);
  const intercept = (sy - slope * sx) / n;
  trendlineStore.set(pair, { slope, intercept, lastUpdated: now, direction });
  return { price: slope * (len - 1) + intercept, r2: 1 };
}

// ─── TREND ───

function detectTrend(candles: Candle[]) {
  if (candles.length < 25) return { direction: null as "LONG" | "SHORT" | null, strength: "WEAK" };
  const closes = candles.map(c => c.close);
  const e8 = ema(closes, 8), e21 = ema(closes, 21);
  if (!e8.length || !e21.length) return { direction: null as "LONG" | "SHORT" | null, strength: "WEAK" };
  const direction = e8[e8.length - 1] > e21[e21.length - 1] ? "LONG" : "SHORT";
  const highs = candles.slice(-20).map(c => c.high), lows = candles.slice(-20).map(c => c.low);
  const hh = highs[highs.length - 1] > Math.max(...highs.slice(0, -1));
  const ll = lows[lows.length - 1] < Math.min(...lows.slice(0, -1));
  const strength = (direction === "LONG" && hh) || (direction === "SHORT" && ll) ? "STRONG" : "MEDIUM";
  return { direction, strength };
}

// ─── 1D REGIME PERSISTENCE — CLOSED CANDLES ONLY ───

const regimeStore = new Map<string, { direction: "LONG" | "SHORT"; strength: string; lockedUntil: number; lastCandleTimestamp: number }>();

function getPersistentRegime(pair: string, candles1d: Candle[], now: number) {
  const current = detectTrend(candles1d);
  const stored = regimeStore.get(pair);

  if (!stored) {
    if (current.direction) {
      const lastCandle = candles1d[candles1d.length - 1];
      regimeStore.set(pair, {
        direction: current.direction,
        strength: current.strength,
        lockedUntil: now + DIRECTION_LOCK_MS,
        lastCandleTimestamp: lastCandle?.timestamp ?? now,
      });
    }
    return current;
  }

  // v32.3 FIX: Only update regime when we have a NEW closed daily candle
  const lastCandle = candles1d[candles1d.length - 1];
  if (!lastCandle || lastCandle.timestamp <= stored.lastCandleTimestamp) {
    // Same candle as before — don't re-evaluate intraday
    return { direction: stored.direction, strength: stored.strength };
  }

  // New daily candle closed — evaluate flip
  if (current.direction === stored.direction) {
    regimeStore.set(pair, { ...stored, strength: current.strength, lastCandleTimestamp: lastCandle.timestamp });
    return { direction: stored.direction, strength: current.strength };
  }

  if (now < stored.lockedUntil) {
    if (DEBUG) console.log(`[REGIME] ${pair} flip blocked until ${new Date(stored.lockedUntil).toISOString()}`);
    return { direction: stored.direction, strength: stored.strength };
  }

  if (current.strength === "STRONG") {
    regimeStore.set(pair, {
      direction: current.direction!,
      strength: current.strength,
      lockedUntil: now + DIRECTION_LOCK_MS,
      lastCandleTimestamp: lastCandle.timestamp,
    });
    return current;
  }

  return { direction: stored.direction, strength: stored.strength };
}

// ─── STATE ───

const hysteresisStore = new Map<string, { lastSignalType: "ENTRY_1" | "ENTRY_2" | "ADD" | null; lastSignalPrice: number; lockUntil: number }>();
const signalCooldowns = new Map<string, number>();
const directionCooldowns = new Map<string, { lastDirection: "LONG" | "SHORT"; lockUntil: number }>();

function getHysteresis(pair: string, now: number) {
  const s = hysteresisStore.get(pair);
  if (!s || now > s.lockUntil) return { lastSignalType: null, lastSignalPrice: 0, lockUntil: 0 };
  return s;
}

function setHysteresis(pair: string, type: "ENTRY_1" | "ENTRY_2" | "ADD", price: number, now: number) {
  hysteresisStore.set(pair, { lastSignalType: type, lastSignalPrice: price, lockUntil: now + (type === "ADD" ? 4 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000) });
}

// ─── SIGNAL GENERATION — v32.3: BLOCK OPPOSITE DIRECTION WHILE ACTIVE ───

export function generateSignal(
  pair: string,
  candles1h: Candle[],
  candles4h: Candle[],
  candles1d: Candle[],
  activeSignals: Signal[],
  currentPrice?: number
): SignalResult {
  const debug: string[] = [];
  const now = Date.now();

  // v32.3 FIX: Check if we already have an active trade on this pair
  const activeForPair = activeSignals.filter(s => s.pair === pair && !s.exited);
  if (activeForPair.length > 0) {
    debug.push(`Active trade exists — no new signals`);
    return { debug };
  }

  if (candles1d.length < 25 || candles4h.length < 30) {
    debug.push("Insufficient data");
    return { debug };
  }

  const t1d = getPersistentRegime(pair, candles1d, now);
  debug.push(`1D: ${t1d.direction || "NONE"} ${t1d.strength}`);

  if (!t1d.direction || t1d.strength === "WEAK") {
    debug.push("1D weak/unclear");
    return { debug };
  }

  const dirCooldown = directionCooldowns.get(pair);
  if (dirCooldown && now < dirCooldown.lockUntil && dirCooldown.lastDirection !== t1d.direction) {
    debug.push("Direction flip cooldown");
    return { debug };
  }

  const trendline = getTrendline(pair, candles4h, t1d.direction);
  if (!trendline) {
    debug.push("No trendline");
    return { debug };
  }

  const price = currentPrice ?? candles4h[candles4h.length - 1].close;
  const tlPrice = trendline.price;
  const dist = (price - tlPrice) / tlPrice;

  const stoch4h = stochRsi(candles4h.map(c => c.close));
  const last4h = candles4h[candles4h.length - 1];
  const prev4h = candles4h[candles4h.length - 2];

  const closes4h = candles4h.map(c => c.close);
  const ema8_4h = ema(closes4h, 8);
  const ema21_4h = ema(closes4h, 21);

  let stoch1h = { k: 50, d: 50 };
  if (candles1h.length >= 30) stoch1h = stochRsi(candles1h.map(c => c.close));

  const nearTL = Math.abs(dist) < 0.012;
  const stochExtreme = t1d.direction === "LONG" ? stoch4h.k < 35 : stoch4h.k > 65;
  const stochTurning = t1d.direction === "LONG" ? stoch4h.k > stoch4h.d : stoch4h.k < stoch4h.d;
  const beyondTL = t1d.direction === "LONG" ? price > tlPrice * 1.008 : price < tlPrice * 0.992;
  const confirming = t1d.direction === "LONG" ? last4h.close > last4h.open && last4h.close > prev4h.close : last4h.close < last4h.open && last4h.close < prev4h.close;
  const volUp = last4h.volume > avg(candles4h.slice(-10).map(c => c.volume)) * 1.3;
  const emaAligned = t1d.direction === "LONG" ? price > ema8_4h[ema8_4h.length - 1] && price > ema21_4h[ema21_4h.length - 1] : price < ema8_4h[ema8_4h.length - 1] && price < ema21_4h[ema21_4h.length - 1];

  const adxVal = adx(candles4h) ?? 0;

  let rawType: "ENTRY_1" | "ENTRY_2" | "ADD" | null = null;
  if (nearTL && stochExtreme) rawType = "ENTRY_1";
  else if (nearTL && stochTurning && !stochExtreme) rawType = "ENTRY_2";
  else if (beyondTL && confirming && (volUp || stochTurning)) rawType = "ADD";

  if ((rawType === "ENTRY_1" || rawType === "ENTRY_2") && candles1h.length >= 30) {
    const timingOk = t1d.direction === "LONG" ? stoch1h.k > stoch1h.d || stoch1h.k < 30 : stoch1h.k < stoch1h.d || stoch1h.k > 70;
    if (!timingOk) {
      debug.push("1H timing opposed");
      return { debug };
    }
  }

  const hyst = getHysteresis(pair, now);
  let finalType = rawType;
  if (hyst.lastSignalType === "ADD") finalType = "ADD";
  else if (hyst.lastSignalType === "ENTRY_2" && rawType === "ADD") finalType = "ADD";
  else if (hyst.lastSignalType === "ENTRY_2") finalType = "ENTRY_2";
  else if (hyst.lastSignalType === "ENTRY_1" && rawType === "ADD") finalType = "ADD";
  else if (hyst.lastSignalType === "ENTRY_1" && rawType === "ENTRY_2") finalType = "ENTRY_2";
  else if (hyst.lastSignalType === "ENTRY_1") finalType = "ENTRY_1";

  if (hyst.lastSignalType && finalType === hyst.lastSignalType) {
    if (Math.abs(price - hyst.lastSignalPrice) / hyst.lastSignalPrice < HYSTERESIS_BAND) {
      debug.push("Hysteresis lock");
      return { debug };
    }
  }

  const lastSignal = signalCooldowns.get(pair);
  if (lastSignal && now - lastSignal < SIGNAL_COOLDOWN_MS) {
    debug.push(`Cooldown ${((now - lastSignal) / 60000).toFixed(0)}min < 240min`);
    return { debug };
  }

  if (!finalType) {
    debug.push("No setup");
    return { debug };
  }

  setHysteresis(pair, finalType, price, now);

  const atrVal = atr(candles4h, 14);
  const swingLow = Math.min(...candles4h.slice(-20).map(c => c.low));
  const swingHigh = Math.max(...candles4h.slice(-20).map(c => c.high));

  let entry: number, sl: number, tp: number, type: "ACCUMULATE" | "BREAKOUT", confidence: number;

  if (finalType === "ENTRY_1" || finalType === "ENTRY_2") {
    type = "ACCUMULATE";
    entry = price;
    sl = t1d.direction === "LONG" ? Math.min(swingLow, entry - atrVal * 2) : Math.max(swingHigh, entry + atrVal * 2);
    tp = t1d.direction === "LONG" ? Math.max(entry + atrVal * 5, entry * 1.05) : Math.min(entry - atrVal * 5, entry * 0.95);
    confidence = finalType === "ENTRY_1" ? 65 : 75;
    if (emaAligned) confidence += 10;
  } else {
    type = "BREAKOUT";
    entry = price;
    sl = t1d.direction === "LONG" ? Math.min(tlPrice * 0.995, entry - atrVal * 1.5) : Math.max(tlPrice * 1.005, entry + atrVal * 1.5);
    const minTarget = t1d.direction === "LONG" ? entry + (entry - sl) * MIN_RR : entry - (sl - entry) * MIN_RR;
    const minMove = t1d.direction === "LONG" ? entry * 1.05 : entry * 0.95;
    tp = t1d.direction === "LONG" ? Math.max(swingHigh, minTarget, minMove) : Math.min(swingLow, minTarget, minMove);
    confidence = 85;
  }

  const rr = t1d.direction === "LONG" ? (tp - entry) / (entry - sl) : (entry - tp) / (sl - entry);
  if (rr < MIN_RR) {
    debug.push(`R:R ${rr.toFixed(2)} < ${MIN_RR}`);
    return { debug };
  }

  const signal: Signal = {
    id: `${pair}_${now}`,
    pair,
    direction: t1d.direction,
    type,
    scale: finalType,
    entry: Math.round(entry * 100) / 100,
    stop: Math.round(sl * 100) / 100,
    target: Math.round(tp * 100) / 100,
    confidence,
    rr: Math.round(rr * 100) / 100,
    adx: Math.round(adxVal * 10) / 10,
    rsi: Math.round((wilderRsi(candles4h.map(c => c.close)) ?? 50) * 10) / 10,
    stochK: stoch4h.k,
    stochD: stoch4h.d,
    expectedMove: Math.round(Math.abs(tp - entry) / entry * 1000) / 10,
    reason: `${t1d.direction} ${type} ${finalType} | 1D ${t1d.strength} | 4H K${stoch4h.k} D${stoch4h.d} | 1H K${stoch1h.k} D${stoch1h.d} | RR ${rr.toFixed(2)}`,
    timestamp: now,
    version: CURRENT_SIGNAL_VERSION,
    entryTier: finalType === "ADD" ? "CONFIRMED_ENTRY" : "EARLY_ENTRY",
    entryMode: finalType === "ADD" ? "BREAKOUT" : "PULLBACK",
    positionSizePct: finalType === "ADD" ? 0.05 : 0.03,
    regimeDirection: t1d.direction,
    exited: false,
    highestPrice: entry,
    lowestPrice: entry,
    tradeState: "OPEN",
  };

  signalCooldowns.set(pair, now);

  return {
    signal,
    market: { pair, price: Math.round(price * 100) / 100, timestamp: now, trend: `${t1d.direction} ${t1d.strength}`, adx: signal.adx, rsi: signal.rsi, stochK: signal.stochK, stochD: signal.stochD, trendlinePrice: Math.round(tlPrice * 100) / 100, distToTrendline: Math.round(dist * 10000) / 100 },
    debug,
  };
}

export async function generateSignalAsync(
  pair: string,
  candles1h: Candle[],
  candles4h: Candle[],
  candles15m: Candle[],
  activeSignals: Signal[],
  currentPrice?: number
): Promise<SignalResult> {
  return generateSignal(pair, candles1h, candles4h, aggregateTo1D(candles4h), activeSignals, currentPrice);
}

// ─── VALIDITY — SL AND TP ONLY ───

export function isSignalStillValid(signal: Signal, currentPrice: number): { valid: boolean; reason: string; exited: boolean } {
  if (signal.direction === "LONG" && currentPrice <= signal.stop) return { valid: false, reason: "sl_hit", exited: true };
  if (signal.direction === "SHORT" && currentPrice >= signal.stop) return { valid: false, reason: "sl_hit", exited: true };
  if (signal.direction === "LONG" && currentPrice >= signal.target) return { valid: false, reason: "tp_hit", exited: true };
  if (signal.direction === "SHORT" && currentPrice <= signal.target) return { valid: false, reason: "tp_hit", exited: true };
  return { valid: true, reason: "active", exited: false };
}

// ─── shouldHold — FIVE EXITS, FIXED ───

export function shouldHold(
  signal: Signal,
  candles4h: Candle[],
  candles1d: Candle[],
  currentPrice: number
): HoldResult {
  // 1. SL / TP
  const v = isSignalStillValid(signal, currentPrice);
  if (!v.valid) return { shouldHold: false, reason: v.reason };

  // 2. 4H STRUCTURE BREAK — TWO consecutive closes below EMA21 + EMA21 slope negative
  const closes = candles4h.map(c => c.close);
  const e21 = ema(closes, 21);
  const e50 = ema(closes, 50);

  if (e21.length >= 3 && e50.length >= 3) {
    const c0 = candles4h[candles4h.length - 1].close; // last
    const c1 = candles4h[candles4h.length - 2].close; // prev
    const c2 = candles4h[candles4h.length - 3].close; // before prev
    const e21_0 = e21[e21.length - 1];
    const e21_1 = e21[e21.length - 2];
    const e21_2 = e21[e21.length - 3];
    const e50_0 = e50[e50.length - 1];

    // EMA21 slope negative: current < previous
    const e21SlopingDown = e21_0 < e21_1;
    const e21SlopingUp = e21_0 > e21_1;

    if (signal.direction === "LONG") {
      // Two consecutive closes below EMA21 AND EMA21 sloping down
      if (c0 < e21_0 && c1 < e21_1 && e21SlopingDown) {
        // Additional: last close also below EMA50 for confirmation
        if (c0 < e50_0) {
          return { shouldHold: false, reason: "4h_structure_break" };
        }
      }
    } else {
      if (c0 > e21_0 && c1 > e21_1 && e21SlopingUp) {
        if (c0 > e50_0) {
          return { shouldHold: false, reason: "4h_structure_break" };
        }
      }
    }
  }

  // 3. 4H TRENDLINE BREACH — ATR-based, not fixed %
  const tl = getTrendline(signal.pair, candles4h, signal.direction);
  if (tl) {
    const atr4h = atr(candles4h, 14);
    const lastClose = candles4h[candles4h.length - 1].close;
    const breachThreshold = atr4h * 1.5;

    if (signal.direction === "LONG" && lastClose < tl.price - breachThreshold) {
      return { shouldHold: false, reason: "trendline_breach" };
    }
    if (signal.direction === "SHORT" && lastClose > tl.price + breachThreshold) {
      return { shouldHold: false, reason: "trendline_breach" };
    }
  }

  // 4. 1D REGIME FLIP — STRONG only, CLOSED candle only
  // v32.3 FIX: candles1d passed directly, not aggregated from 4H
  if (candles1d.length >= 25) {
    const regime = getPersistentRegime(signal.pair, candles1d, Date.now());
    if (regime.direction && regime.direction !== signal.direction && regime.strength === "STRONG") {
      return { shouldHold: false, reason: "regime_flip" };
    }
  }

  // 5. HOLD
  return { shouldHold: true, reason: "structure_intact" };
}

// ─── FILTER — ONLY CLEANS EXITED SIGNALS ───

export function filterExpiredSignals(signals: Signal[], currentPrices?: Record<string, number>) {
  const active: Signal[] = [];
  const exited: { signal: Signal; reason: string }[] = [];

  for (const signal of signals) {
    if (!signal.exited) {
      const price = currentPrices?.[signal.pair];
      if (price !== undefined) {
        const check = isSignalStillValid(signal, price);
        if (!check.valid) {
          exited.push({ signal, reason: check.reason });
          continue;
        }
      }
      active.push(signal);
      continue;
    }
    if (Date.now() - signal.timestamp < EXITED_TTL_MS) active.push(signal);
  }

  return { active, exited };
}

// ─── SNAPSHOT — v32.3: accepts candles1d directly ───

export function getMarketSnapshot(
  pair: string,
  candles1h: Candle[],
  candles4h: Candle[],
  candles15m: Candle[],
  candles1d: Candle[],
  currentPrice?: number,
  signalResult?: SignalResult
) {
  const t1h = detectTrend(candles1h);
  const t4h = detectTrend(candles4h);
  const t1d = detectTrend(candles1d);
  const price = currentPrice ?? candles4h[candles4h.length - 1].close;
  const trendline = t1d.direction ? getTrendline(pair, candles4h, t1d.direction) : null;
  const stoch4h = stochRsi(candles4h.map(c => c.close));
  const stoch1h = candles1h.length >= 30 ? stochRsi(candles1h.map(c => c.close)) : { k: 50, d: 50 };
  const regimePersist = regimeStore.get(pair);

  return {
    pair,
    price: Math.round(price * 100) / 100,
    timestamp: Date.now(),
    trend: t1d.direction ? `${t1d.direction} ${t1d.strength}` : "NONE",
    regime: {
      direction: t1d.direction,
      strength: t1d.strength,
      confidence: t1d.direction ? (t1d.strength === "STRONG" ? 75 : 50) : 0,
      score: t1d.direction ? (t1d.strength === "STRONG" ? 40 : 25) : 0,
      reason: t1d.direction ? ["ema8_21_alignment"] : ["no_trend"],
      detectedAt: Date.now(),
      lockedUntil: regimePersist?.lockedUntil || null,
    },
    adx: Math.round((adx(candles4h) ?? 0) * 10) / 10,
    rsi: Math.round((wilderRsi(candles4h.map(c => c.close)) ?? 50) * 10) / 10,
    stochK: stoch4h.k,
    stochD: stoch4h.d,
    stoch1hK: stoch1h.k,
    stoch1hD: stoch1h.d,
    trendlinePrice: trendline ? Math.round(trendline.price * 100) / 100 : 0,
    distToTrendline: trendline ? Math.round(Math.abs((price - trendline.price) / trendline.price) * 10000) / 100 : 0,
    trend1h: t1h.direction ? { direction: t1h.direction, strength: t1h.strength } : null,
    trend4h: t4h.direction ? { direction: t4h.direction, strength: t4h.strength } : null,
    trend1d: t1d.direction ? { direction: t1d.direction, strength: t1d.strength } : null,
    phase1h: "NEUTRAL",
    phaseWarning1h: null,
    phase4h: stoch4h.k > 80 ? "EXPANSION" : stoch4h.k < 20 ? "EXHAUSTION" : "NEUTRAL",
    phaseWarning4h: null,
    entryCandidates: {
      pullback: { eligible: signalResult?.signal?.scale === "ENTRY_1", confidence: signalResult?.signal?.scale === "ENTRY_1" ? 65 : 0, rejectionReason: null },
      rejection: { eligible: signalResult?.signal?.scale === "ENTRY_2", confidence: signalResult?.signal?.scale === "ENTRY_2" ? 75 : 0, rejectionReason: null },
      breakout: { eligible: signalResult?.signal?.scale === "ADD", confidence: signalResult?.signal?.scale === "ADD" ? 85 : 0, rejectionReason: null },
    },
    recommendedAction: signalResult?.signal ? `${signalResult.signal.direction} ${signalResult.signal.type}` : null,
    entryTier: signalResult?.signal ? (signalResult.signal.scale === "ADD" ? "CONFIRMED_ENTRY" : "EARLY_ENTRY") : null,
    positionSize: signalResult?.signal ? (signalResult.signal.scale === "ADD" ? "FULL" : "STARTER") : null,
    whyNoTrade: signalResult?.signal ? [] : ["No active signal"],
    signal: signalResult?.signal || null,
    ...signalResult?.market,
  };
}

// ─── TRADE MANAGER — v32.3: profit lock starts at 5% ───

export function updateTradeManagerCompat(signal: Signal, currentPrice: number) {
  const highest = Math.max(signal.highestPrice || signal.entry, currentPrice);
  const lowest = Math.min(signal.lowestPrice || signal.entry, currentPrice);
  const pnl = signal.direction === "LONG" ? (currentPrice - signal.entry) / signal.entry : (signal.entry - currentPrice) / signal.entry;

  let profitLockActive = false;
  let lockedStop: number | undefined;

  // v32.3: Swing-appropriate profit locking
  // +5% = move to breakeven + small buffer
  // +8% = lock 50% of gains
  // +12% = lock 75% of gains (trailing)
  if (pnl > 0.12) {
    profitLockActive = true;
    lockedStop = signal.direction === "LONG"
      ? Math.max(signal.stop, signal.entry + (currentPrice - signal.entry) * 0.75)
      : Math.min(signal.stop, signal.entry - (signal.entry - currentPrice) * 0.75);
  } else if (pnl > 0.08) {
    profitLockActive = true;
    lockedStop = signal.direction === "LONG"
      ? Math.max(signal.stop, signal.entry + (currentPrice - signal.entry) * 0.5)
      : Math.min(signal.stop, signal.entry - (signal.entry - currentPrice) * 0.5);
  } else if (pnl > 0.05) {
    profitLockActive = true;
    const buffer = signal.entry * 0.005; // 0.5% buffer above entry
    lockedStop = signal.direction === "LONG"
      ? Math.max(signal.stop, signal.entry + buffer)
      : Math.min(signal.stop, signal.entry - buffer);
  }

  let newState = "ENTRY";
  if (pnl > 0.05) newState = "PROFIT_ZONE";
  if (profitLockActive) newState = "LOCKED";
  if (pnl < -0.005) newState = "DRAWDOWN";

  return { highestPrice: highest, lowestPrice: lowest, newState, lockedStop, profitLockActive };
}

// ─── COOLDOWNS ───

export function recordExitCooldown(pair: string, now: number = Date.now()) {
  signalCooldowns.set(pair + "_exit", now);
}

export function setDirectionCooldown(pair: string, direction: "LONG" | "SHORT", now: number = Date.now()) {
  directionCooldowns.set(pair, { lastDirection: direction, lockUntil: now + DIRECTION_LOCK_MS });
}

// ─── COMPAT ───

export function isSignalStillValidBool(signal: Signal, currentPrice: number): boolean {
  return isSignalStillValid(signal, currentPrice).valid;
}

export async function generateSignalCompat(
  pair: string,
  candles1h: Candle[],
  candles4h: Candle[],
  candles15m: Candle[],
  activeSignals?: Signal[],
  currentPrice?: number
): Promise<SignalResult> {
  return generateSignalAsync(pair, candles1h, candles4h, candles15m, activeSignals || [], currentPrice);
}

export function shouldHoldCompat(
  signal: Signal,
  candles4h: Candle[],
  candles1h: Candle[],
  currentPrice: number
): HoldResult {
  // v32.3: shouldHold now requires candles1d. For compat, aggregate from 4H.
  // NOTE: Real callers should pass actual 1D candles.
  const candles1d = aggregateTo1D(candles4h);
  return shouldHold(signal, candles4h, candles1d, currentPrice);
}

export async function loadExits(): Promise<any[]> { return []; }
export function setRegimePersistence(): void {}
export function setExitPersistence(): void {}
export function setTelemetryPersistence(): void {}
export async function persistTelemetry(): Promise<void> {}
export function getPairConfig(pair: string) {
  return { minADX: 15, momentumThreshold: 50, volumeMultiplier: 1.2, stopLossPct: 0.025, takeProfitPct: 0.035, maxEntryDriftPct: 0.015 };
}
