// ============================================================
// CXSwitch v38.4 — v28 Features Ported: EMA8/21 Trend, Stateful TL, Hysteresis, 4H Align
// Targets: Flat 3% | Stoch Extreme Exit: REMOVED | Profit Lock: KEPT
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
  status?: "ACTIVE" | "PENDING_EXIT" | "EXITED";
  exitReason?: string;
  exitRecommendedAt?: number;
  exitRecommendedPrice?: number;
  exitPrice?: number;
  exitTimestamp?: number;
  entryType?: "EARLY" | "BREAKOUT" | "RETEST";
  trendlinePrice?: number;
  volumeConfirmed?: boolean;
  type?: "ACCUMULATE" | "BREAKOUT";
  scale?: "ENTRY_1" | "ENTRY_2" | "ADD" | null;
  entryTier?: string;
  entryMode?: string;
  positionSizePct?: number;
  tradeState?: TradeState;
  regimeDirection?: string;
  conflictEntry?: boolean;
  entryTimeframe?: string;
  rr?: number;
  adx?: number;
  rsi?: number;
  stochK?: number;
  stochD?: number;
  highestPrice?: number;
  lowestPrice?: number;
  lockedStop?: number;
  profitLockActive?: boolean;
  version?: number;
}

export interface SignalResult {
  signal?: Signal;
  market?: any;
  debug: string[];
}

export interface HoldResult {
  shouldHold: boolean;
  reason: string;
  updatedTradeState?: TradeState;
}

export interface Trendline {
  startIndex: number;
  endIndex: number;
  startPrice: number;
  endPrice: number;
  slope: number;
  type: "SUPPORT" | "RESISTANCE";
  touches: number;
  isValid: boolean;
  isBroken: boolean;
  brokenAt?: number;
  brokenPrice?: number;
}

export interface TradeState {
  phase: TradeLifecyclePhase;
  phaseEnteredAt: number;
  highestPrice: number;
  lowestPrice: number;
  entryPrice: number;
  lockedStop: number | null;
  profitLockLevel: number;
  currentR: number;
  entryTimestamp: number;
  lastDecisionTimestamp: number;
}

export interface MarketRegime {
  direction: "LONG" | "SHORT" | null;
  strength: number;
  adx: number | null;
  timestamp: number;
}

export interface ExitRecord {
  id: string;
  pair: string;
  direction: "LONG" | "SHORT";
  entry: number;
  exitPrice: number;
  pnl: number;
  reason: string;
  timestamp: number;
}

export type EntryTier = "NO_TRADE" | "WATCH" | "EARLY_ENTRY" | "CONFIRMED_ENTRY";
export type TradeLifecyclePhase = "WATCH" | "ENTRY" | "BUILDING" | "TREND" | "PROFIT_PROTECTION" | "EXIT" | "COOLDOWN";
export type PullbackTier = "DEEP" | "SHALLOW" | "MOMENTUM" | null;

export const CURRENT_SIGNAL_VERSION = 38;

function avg(arr: number[]): number {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
}

function isValid(v: any): boolean {
  return typeof v === "number" && Number.isFinite(v);
}

// ============================================================
// EMA — v28 exact (Wilder smoothing)
// ============================================================
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

// ============================================================
// RSI (Wilder) — v28 exact
// ============================================================
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

// ============================================================
// StochRSI — v28 exact (TradingView exact)
// ============================================================
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

// ============================================================
// ADX — v28 exact (Wilder-smoothed)
// ============================================================
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

  const dx = atrS.map((_, i) => {
    const p = (pDIS[i] / atrS[i]) * 100, m = (mDIS[i] / atrS[i]) * 100;
    return p + m === 0 ? 0 : (Math.abs(p - m) / (p + m)) * 100;
  });

  const adxS = wilderSmooth(dx, period);
  const v = adxS[adxS.length - 1];
  return isValid(v) ? Math.round(v * 10) / 10 : null;
}

// ============================================================
// ATR
// ============================================================
function atr(candles: Candle[], period = 14): number {
  const trs: number[] = [];
  for (let i = Math.max(1, candles.length - period); i < candles.length; i++) {
    trs.push(Math.max(candles[i].high - candles[i].low, Math.abs(candles[i].high - candles[i - 1].close), Math.abs(candles[i].low - candles[i - 1].close)));
  }
  return avg(trs);
}

// ============================================================
// 4H → 1D — v28 exact
// ============================================================
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

// ============================================================
// v28: STATEFUL TRENDLINE STORE
// ============================================================

interface TrendlineState {
  slope: number;
  intercept: number;
  pivots: { index: number; price: number; timestamp: number }[];
  lastUpdated: number;
  direction: "LONG" | "SHORT";
}

const trendlineStore: Map<string, TrendlineState> = new Map();

function findPivotsV28(candles: Candle[], direction: "LONG" | "SHORT"): { index: number; price: number; timestamp: number }[] {
  const pivots: { index: number; price: number; timestamp: number }[] = [];
  for (let i = 3; i < candles.length - 3; i++) {
    const isSwingLow = candles[i].low < candles[i-1].low && candles[i].low < candles[i-2].low && 
                       candles[i].low < candles[i+1].low && candles[i].low < candles[i+2].low;
    const isSwingHigh = candles[i].high > candles[i-1].high && candles[i].high > candles[i-2].high && 
                        candles[i].high > candles[i+1].high && candles[i].high > candles[i+2].high;

    if (direction === "LONG" && isSwingLow) {
      pivots.push({ index: i, price: candles[i].low, timestamp: candles[i].timestamp });
    }
    if (direction === "SHORT" && isSwingHigh) {
      pivots.push({ index: i, price: candles[i].high, timestamp: candles[i].timestamp });
    }
  }
  return pivots;
}

function getTrendlineV28(pair: string, candles: Candle[], direction: "LONG" | "SHORT"): { price: number; r2: number; age: number } | null {
  const len = candles.length;
  if (len < 20) return null;

  const pivots = findPivotsV28(candles, direction);
  if (pivots.length < 3) return null;

  const recentPivots = pivots.slice(-5);
  const now = candles[candles.length - 1].timestamp;

  const existing = trendlineStore.get(pair);
  const maxAge = 7 * 24 * 60 * 60 * 1000; // 7 days

  // Check if existing trendline is still valid
  if (existing && existing.direction === direction && (now - existing.lastUpdated) < maxAge) {
    const lastPivot = recentPivots[recentPivots.length - 1];
    const projectedPrice = existing.slope * lastPivot.index + existing.intercept;
    const deviation = Math.abs(lastPivot.price - projectedPrice) / projectedPrice;

    if (deviation < 0.02) { // 2% deviation tolerance
      const currentIndex = len - 1;
      const price = existing.slope * currentIndex + existing.intercept;
      return { price, r2: 0.85, age: now - existing.lastUpdated };
    }
  }

  // Recalculate trendline
  const n = recentPivots.length;
  const sumX = recentPivots.reduce((s, p) => s + p.index, 0);
  const sumY = recentPivots.reduce((s, p) => s + p.price, 0);
  const sumXY = recentPivots.reduce((s, p) => s + p.index * p.price, 0);
  const sumX2 = recentPivots.reduce((s, p) => s + p.index * p.index, 0);

  const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
  const intercept = (sumY - slope * sumX) / n;

  const yMean = sumY / n;
  const ssTotal = recentPivots.reduce((s, p) => s + Math.pow(p.price - yMean, 2), 0);
  const ssResidual = recentPivots.reduce((s, p) => s + Math.pow(p.price - (slope * p.index + intercept), 2), 0);
  const r2 = ssTotal === 0 ? 0 : 1 - (ssResidual / ssTotal);

  trendlineStore.set(pair, {
    slope,
    intercept,
    pivots: recentPivots,
    lastUpdated: now,
    direction,
  });

  const currentIndex = len - 1;
  const price = slope * currentIndex + intercept;

  return { price, r2: Math.round(r2 * 100) / 100, age: 0 };
}

// ============================================================
// v28: 1D TREND — EMA8 vs EMA21 (not price vs EMA21)
// ============================================================
function trend1DV28(candles1d: Candle[]): { direction: "LONG" | "SHORT" | null; strength: string } {
  const len = candles1d.length;
  if (len < 25) return { direction: null, strength: "WEAK" };

  const closes = candles1d.map(c => c.close);
  const ema8 = ema(closes, 8);
  const ema21 = ema(closes, 21);

  if (!ema8.length || !ema21.length) return { direction: null, strength: "WEAK" };

  const direction = ema8[ema8.length - 1] > ema21[ema21.length - 1] ? "LONG" : "SHORT";

  // Strength: check for HH/LL on 1D
  const highs = candles1d.slice(-20).map(c => c.high);
  const lows = candles1d.slice(-20).map(c => c.low);
  const hh = highs[highs.length - 1] > Math.max(...highs.slice(0, -1));
  const ll = lows[lows.length - 1] < Math.min(...lows.slice(0, -1));

  const strength = (direction === "LONG" && hh) || (direction === "SHORT" && ll) ? "STRONG" : "MEDIUM";

  return { direction, strength };
}

// ============================================================
// v28: HYSTERESIS STATE
// ============================================================

interface HysteresisState {
  lastSignalType: "ENTRY_1" | "ENTRY_2" | "ADD" | null;
  lastSignalPrice: number;
  lockUntil: number;
}

const hysteresisStore: Map<string, HysteresisState> = new Map();
const HYSTERESIS_BAND = 0.005; // 0.5%

function getHysteresis(pair: string, now: number): HysteresisState {
  const state = hysteresisStore.get(pair);
  if (!state) return { lastSignalType: null, lastSignalPrice: 0, lockUntil: 0 };
  if (now > state.lockUntil) return { lastSignalType: null, lastSignalPrice: 0, lockUntil: 0 };
  return state;
}

function setHysteresis(pair: string, type: "ENTRY_1" | "ENTRY_2" | "ADD", price: number, now: number): void {
  const lockDuration = type === "ADD" ? 4 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
  hysteresisStore.set(pair, {
    lastSignalType: type,
    lastSignalPrice: price,
    lockUntil: now + lockDuration,
  });
}

// ============================================================
// PIVOTS — for trendline break detection (v37 compat)
// ============================================================
function findPivots(candles: Candle[], leftBars = 3, rightBars = 2): {
  highs: { index: number; price: number }[];
  lows: { index: number; price: number }[];
} {
  const highs: { index: number; price: number }[] = [];
  const lows: { index: number; price: number }[] = [];
  for (let i = leftBars; i < candles.length - rightBars; i++) {
    const isHigh = candles.slice(i - leftBars, i).every(c => c.high <= candles[i].high) &&
                   candles.slice(i + 1, i + 1 + rightBars).every(c => c.high <= candles[i].high);
    if (isHigh) highs.push({ index: i, price: candles[i].high });
    const isLow = candles.slice(i - leftBars, i).every(c => c.low >= candles[i].low) &&
                  candles.slice(i + 1, i + 1 + rightBars).every(c => c.low >= candles[i].low);
    if (isLow) lows.push({ index: i, price: candles[i].low });
  }
  return { highs, lows };
}

function buildTrendlines(
  candles: Candle[],
  pivots: { index: number; price: number }[],
  type: "SUPPORT" | "RESISTANCE",
  minTouches = 2,
  atrTolerance = 0.3
): Trendline[] {
  const atrVal = atr(candles, 14);
  const tolerance = atrVal * atrTolerance;
  const lines: Trendline[] = [];
  for (let i = 0; i < pivots.length - 1; i++) {
    for (let j = i + 1; j < pivots.length; j++) {
      const p1 = pivots[i];
      const p2 = pivots[j];
      const slope = (p2.price - p1.price) / (p2.index - p1.index);
      if (type === "RESISTANCE" && slope > 0.001) continue;
      if (type === "SUPPORT" && slope < -0.001) continue;
      let touches = 0;
      let valid = true;
      for (let k = p1.index; k <= Math.min(p2.index + 5, candles.length - 1); k++) {
        const expectedPrice = p1.price + slope * (k - p1.index);
        const actualPrice = type === "RESISTANCE" ? candles[k].high : candles[k].low;
        const closePrice = candles[k].close;
        if (type === "RESISTANCE") {
          if (closePrice > expectedPrice + tolerance * 2) { valid = false; break; }
          if (Math.abs(actualPrice - expectedPrice) < tolerance) touches++;
        } else {
          if (closePrice < expectedPrice - tolerance * 2) { valid = false; break; }
          if (Math.abs(actualPrice - expectedPrice) < tolerance) touches++;
        }
      }
      if (valid && touches >= minTouches) {
        lines.push({
          startIndex: p1.index, endIndex: p2.index, startPrice: p1.price, endPrice: p2.price,
          slope, type, touches, isValid: true, isBroken: false,
        });
      }
    }
  }
  lines.sort((a, b) => {
    if (b.touches !== a.touches) return b.touches - a.touches;
    return b.endIndex - a.endIndex;
  });
  return lines.slice(0, 3);
}

function getTrendlinePrice(line: Trendline, index: number): number {
  return line.startPrice + line.slope * (index - line.startIndex);
}

function checkTrendlineBreak(
  candles: Candle[],
  trendlines: Trendline[],
  type: "SUPPORT" | "RESISTANCE"
): { broken: boolean; line?: Trendline; breakIndex?: number; breakPrice?: number } {
  if (candles.length < 3) return { broken: false };
  const currentIndex = candles.length - 1;
  const prevIndex = candles.length - 2;
  const current = candles[currentIndex];
  const prev = candles[prevIndex];
  for (const line of trendlines) {
    if (line.isBroken) continue;
    const lineCurrent = getTrendlinePrice(line, currentIndex);
    const linePrev = getTrendlinePrice(line, prevIndex);
    if (type === "RESISTANCE") {
      if (prev.close <= linePrev && current.close > lineCurrent) {
        line.isBroken = true; line.brokenAt = current.timestamp; line.brokenPrice = current.close;
        return { broken: true, line, breakIndex: currentIndex, breakPrice: current.close };
      }
    } else {
      if (prev.close >= linePrev && current.close < lineCurrent) {
        line.isBroken = true; line.brokenAt = current.timestamp; line.brokenPrice = current.close;
        return { broken: true, line, breakIndex: currentIndex, breakPrice: current.close };
      }
    }
  }
  return { broken: false };
}

function isVolumeConfirmed(candles: Candle[], lookback = 10): boolean {
  if (candles.length < lookback + 2) return false;
  const volumes = candles.map(c => c.volume);
  const avgVol = avg(volumes.slice(-lookback - 1, -1));
  const currentVol = volumes[volumes.length - 1];
  return currentVol > avgVol * 1.2;
}

// ============================================================
// v38.4: EMA BIAS — v28 style (EMA8 vs EMA21 on 1D)
// ============================================================
function detectTrend(candles1d: Candle[]): {
  direction: "LONG" | "SHORT" | null;
  strength: number;
  adx: number | null;
  debug: string[];
} {
  const debug: string[] = [];

  const t1d = trend1DV28(candles1d);

  if (!t1d.direction) {
    debug.push("1D trend unclear");
    return { direction: null, strength: 0, adx: null, debug };
  }

  const strength = t1d.strength === "STRONG" ? 80 : 50;
  debug.push(`1D: ${t1d.direction} ${t1d.strength} (EMA8 vs EMA21)`);

  const adxVal = adx(candles1d);
  if (adxVal !== null) {
    debug.push(`1D ADX: ${adxVal.toFixed(1)}`);
    if (adxVal < 20) {
      debug.push(`ADX < 20 — weak trend confidence reduced`);
      return { direction: t1d.direction, strength: Math.max(10, strength - 30), adx: adxVal, debug };
    } else if (adxVal >= 25) {
      debug.push(`ADX >= 25 — strong trend`);
      return { direction: t1d.direction, strength: Math.min(100, strength + 10), adx: adxVal, debug };
    }
  }

  return { direction: t1d.direction, strength, adx: adxVal, debug };
}

// ============================================================
// PULLBACK CHECK — v37.5 EXACT (unchanged)
// ============================================================
function checkPullbackAdaptive(
  biasDirection: "LONG" | "SHORT" | null,
  stoch4h: { k: number; d: number },
  prevStoch4h: { k: number; d: number },
  adx: number | null,
  isStrongTrend: boolean
): { pullbackActive: boolean; tier: PullbackTier; reason: string; stochZone: "EXTREME" | "ZONE" | "NEUTRAL" | "EXTENDED" } {
  if (!biasDirection) {
    return { pullbackActive: false, tier: null, reason: "No bias — no pullback check", stochZone: "NEUTRAL" };
  }

  const crossUp = prevStoch4h.k <= prevStoch4h.d && stoch4h.k > stoch4h.d;
  const crossDown = prevStoch4h.k >= prevStoch4h.d && stoch4h.k < stoch4h.d;

  if (isStrongTrend) {
    if (biasDirection === "LONG") {
      if (stoch4h.k < 20) {
        return { pullbackActive: true, tier: "DEEP", reason: `STRONG TREND DEEP: 4H Stoch extreme oversold (${stoch4h.k})`, stochZone: "EXTREME" };
      }
      if (stoch4h.k < 35) {
        return { pullbackActive: true, tier: "SHALLOW", reason: `STRONG TREND SHALLOW: 4H Stoch oversold (${stoch4h.k})`, stochZone: "ZONE" };
      }
      if (stoch4h.k < 50) {
        return { pullbackActive: true, tier: "MOMENTUM", reason: `STRONG TREND MOMENTUM: 4H Stoch ${stoch4h.k}`, stochZone: "NEUTRAL" };
      }
      return { pullbackActive: false, tier: null, reason: `STRONG LONG: extended — 4H Stoch ${stoch4h.k} (need <50)`, stochZone: "EXTENDED" };
    }
    if (biasDirection === "SHORT") {
      if (stoch4h.k > 80) {
        return { pullbackActive: true, tier: "DEEP", reason: `STRONG TREND DEEP: 4H Stoch extreme overbought (${stoch4h.k})`, stochZone: "EXTREME" };
      }
      if (stoch4h.k > 65) {
        return { pullbackActive: true, tier: "SHALLOW", reason: `STRONG TREND SHALLOW: 4H Stoch overbought (${stoch4h.k})`, stochZone: "ZONE" };
      }
      if (stoch4h.k > 50) {
        return { pullbackActive: true, tier: "MOMENTUM", reason: `STRONG TREND MOMENTUM: 4H Stoch ${stoch4h.k}`, stochZone: "NEUTRAL" };
      }
      return { pullbackActive: false, tier: null, reason: `STRONG SHORT: extended — 4H Stoch ${stoch4h.k} (need >50)`, stochZone: "EXTENDED" };
    }
  }

  if (biasDirection === "LONG") {
    if (stoch4h.k < 20) {
      if (crossUp) return { pullbackActive: true, tier: "DEEP", reason: `DEEP pullback: 4H Stoch cross up from extreme oversold (${stoch4h.k})`, stochZone: "EXTREME" };
      return { pullbackActive: false, tier: null, reason: `LONG deep pullback forming: 4H Stoch extreme oversold (${stoch4h.k}), waiting for cross up`, stochZone: "EXTREME" };
    }
    if (stoch4h.k < 35) {
      if (crossUp) return { pullbackActive: true, tier: "SHALLOW", reason: `SHALLOW pullback: 4H Stoch cross up from oversold (${stoch4h.k})`, stochZone: "ZONE" };
      return { pullbackActive: false, tier: null, reason: `LONG shallow pullback forming: 4H Stoch oversold (${stoch4h.k}), waiting for cross up`, stochZone: "ZONE" };
    }
    if (stoch4h.k < 50) {
      return { pullbackActive: true, tier: "MOMENTUM", reason: `MOMENTUM zone: 4H Stoch ${stoch4h.k}`, stochZone: "NEUTRAL" };
    }
    return { pullbackActive: false, tier: null, reason: `LONG: extended — 4H Stoch ${stoch4h.k} (need <50)`, stochZone: "EXTENDED" };
  }

  if (biasDirection === "SHORT") {
    if (stoch4h.k > 80) {
      if (crossDown) return { pullbackActive: true, tier: "DEEP", reason: `DEEP pullback: 4H Stoch cross down from extreme overbought (${stoch4h.k})`, stochZone: "EXTREME" };
      return { pullbackActive: false, tier: null, reason: `SHORT deep pullback forming: 4H Stoch extreme overbought (${stoch4h.k}), waiting for cross down`, stochZone: "EXTENDED" };
    }
    if (stoch4h.k > 65) {
      if (crossDown) return { pullbackActive: true, tier: "SHALLOW", reason: `SHALLOW pullback: 4H Stoch cross down from overbought (${stoch4h.k})`, stochZone: "ZONE" };
      return { pullbackActive: false, tier: null, reason: `SHORT shallow pullback forming: 4H Stoch overbought (${stoch4h.k}), waiting for cross down`, stochZone: "ZONE" };
    }
    if (stoch4h.k > 50) {
      return { pullbackActive: true, tier: "MOMENTUM", reason: `MOMENTUM zone: 4H Stoch ${stoch4h.k}`, stochZone: "NEUTRAL" };
    }
    return { pullbackActive: false, tier: null, reason: `SHORT: extended — 4H Stoch ${stoch4h.k} (need >50)`, stochZone: "EXTENDED" };
  }

  return { pullbackActive: false, tier: null, reason: "Unknown bias direction", stochZone: "NEUTRAL" };
}

// ============================================================
// MAIN SIGNAL — v38.4: v28 trend + TL + hysteresis + 4H align + flat 3% target
// ============================================================
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

  if (!Array.isArray(activeSignals)) {
    console.warn(`[generateSignal] activeSignals is not an array for ${pair}, defaulting to empty`);
    activeSignals = [];
  }

  const active = activeSignals.find((s: any) => s && s.pair === pair && s.exited === false);
  if (active) {
    debug.push(`Already active: ${active.id}`);
    return { debug };
  }

  // v28: Check hysteresis lock
  const hyst = getHysteresis(pair, now);
  if (hyst.lastSignalType) {
    const minutesLeft = Math.round((hyst.lockUntil - now) / 60000);
    debug.push(`Hysteresis lock: ${hyst.lastSignalType} until ${new Date(hyst.lockUntil).toISOString()} (${minutesLeft}min left)`);
    return { debug };
  }

  // v37.5 cooldown after stoch extreme exit
  const recentExits = activeSignals.filter(s =>
    s.pair === pair &&
    s.exited &&
    s.exitReason === "stoch_extreme_opposite_exit" &&
    (now - (s.exitTimestamp || s.timestamp)) < 4 * 60 * 60 * 1000
  );

  if (recentExits.length > 0) {
    const lastExit = recentExits.sort((a, b) =>
      (b.exitTimestamp || b.timestamp) - (a.exitTimestamp || a.timestamp)
    )[0];
    const stoch4h_check = stochRsi(candles4h.map(c => c.close));
    const stochCycled = lastExit.direction === "LONG"
      ? stoch4h_check.k >= 50
      : stoch4h_check.k <= 50;
    if (!stochCycled) {
      debug.push(`Last exit was stoch extreme — waiting for stoch to cycle to neutral (current: ${stoch4h_check.k})`);
      return { debug };
    }
    debug.push(`Stoch cycled to neutral after last extreme exit — ready for re-entry`);
  }

  // v37.5 cooldown after ANY exit
  const recentAnyExit = activeSignals.filter(s =>
    s.pair === pair &&
    s.exited &&
    (now - (s.exitTimestamp || s.timestamp)) < 60 * 60 * 1000
  );
  if (recentAnyExit.length > 0) {
    const lastExitTime = Math.max(...recentAnyExit.map(s => s.exitTimestamp || s.timestamp));
    const minutesSince = Math.round((now - lastExitTime) / 60000);
    debug.push(`Cooldown: exited ${recentAnyExit.length}x in last hour, last ${minutesSince}min ago — blocked for ${60 - minutesSince}min`);
    return { debug };
  }

  if (candles4h.length < 50 || candles1h.length < 30 || candles1d.length < 50) {
    debug.push("Insufficient data");
    return { debug };
  }

  const price = currentPrice ?? candles4h[candles4h.length - 1].close;

  // === STEP 1: 1D BIAS — v28 style (EMA8 vs EMA21) ===
  const trend = detectTrend(candles1d);
  debug.push(...trend.debug);

  if (!trend.direction) {
    debug.push("No valid 1D bias");
    return { debug };
  }

  const biasDirection = trend.direction;
  const isStrongTrend = (trend.adx !== null && trend.adx >= 25) && trend.strength >= 80;

  // === STEP 2: v28 Stateful Trendline ===
  const trendline = getTrendlineV28(pair, candles4h, biasDirection);
  if (!trendline) {
    debug.push("No valid trendline");
    return { debug };
  }

  const tlPrice = trendline.price;
  const dist = (price - tlPrice) / tlPrice;
  debug.push(`TL: ${tlPrice.toFixed(1)} | R² ${trendline.r2} | Price: ${price.toFixed(1)} | Dist: ${(dist * 100).toFixed(2)}%`);

  // === STEP 3: 4H EMA Alignment (v28 feature) ===
  const closes4h = candles4h.map(c => c.close);
  const ema8_4h = ema(closes4h, 8);
  const ema21_4h = ema(closes4h, 21);

  const emaAligned = biasDirection === "LONG" 
    ? price > ema8_4h[ema8_4h.length - 1] && price > ema21_4h[ema21_4h.length - 1]
    : price < ema8_4h[ema8_4h.length - 1] && price < ema21_4h[ema21_4h.length - 1];

  debug.push(`4H EMA align: ${emaAligned ? "ALIGNED" : "MISALIGNED"} (price ${price.toFixed(1)} vs EMA8 ${ema8_4h[ema8_4h.length - 1]?.toFixed(1)} EMA21 ${ema21_4h[ema21_4h.length - 1]?.toFixed(1)})`);

  // === STEP 4: StochRSI ===
  const stoch4h = stochRsi(closes4h);
  const prevStoch4h = stochRsi(closes4h.slice(0, -1));
  debug.push(`4H Stoch: ${stoch4h.k}/${stoch4h.d}`);

  // === STEP 5: v28 Signal Type Detection ===
  const last = candles4h[candles4h.length - 1];
  const prev = candles4h[candles4h.length - 2];

  const nearTrendline = Math.abs(dist) < 0.012; // 1.2%
  const stochExtreme = biasDirection === "LONG" ? stoch4h.k < 20 : stoch4h.k > 80;
  const stochTurning = biasDirection === "LONG" ? stoch4h.k > stoch4h.d : stoch4h.k < stoch4h.d;
  const beyondTrendline = biasDirection === "LONG" ? price > tlPrice * 1.008 : price < tlPrice * 0.992;
  const confirming = biasDirection === "LONG" 
    ? last.close > last.open && last.close > prev.close 
    : last.close < last.open && last.close < prev.close;
  const volUp = last.volume > avg(candles4h.slice(-10).map(c => c.volume)) * 1.3;
  const stochMomentum = biasDirection === "LONG" ? stoch4h.k > stoch4h.d : stoch4h.k < stoch4h.d;
  const adxVal = adx(candles4h) ?? 0;
  const adxStrong = adxVal > 20;

  // v28: Determine raw signal type
  let rawType: "ENTRY_1" | "ENTRY_2" | "ADD" | null = null;

  if (nearTrendline && stochExtreme) {
    rawType = "ENTRY_1";
    debug.push(`RAW ENTRY_1: near TL + stoch extreme`);
  } else if (nearTrendline && stochTurning && !stochExtreme) {
    rawType = "ENTRY_2";
    debug.push(`RAW ENTRY_2: near TL + stoch turning`);
  } else if (beyondTrendline && confirming && emaAligned) {
    if (volUp || stochMomentum || adxStrong) {
      rawType = "ADD";
      debug.push(`RAW ADD: beyond TL + confirming + EMA aligned + (${volUp ? "vol" : ""}${stochMomentum ? "stoch" : ""}${adxStrong ? "adx" : ""})`);
    }
  }

  if (!rawType) {
    const stateParts: string[] = [];
    if (nearTrendline) stateParts.push("near TL");
    else if (beyondTrendline) stateParts.push("beyond TL");
    else stateParts.push("far from TL");
    stateParts.push(`Stoch K${stoch4h.k} D${stoch4h.d}`);
    stateParts.push(`EMA aligned: ${emaAligned}`);
    stateParts.push("No signal");
    debug.push(`State: ${stateParts.join(" | ")}`);
    return { debug };
  }

  // v28: Apply hysteresis for new signal
  setHysteresis(pair, rawType, price, now);

  // === STEP 6: Levels ===
  const atr4h = atr(candles4h, 14);
  const swingLows = candles4h.map(c => c.low).slice(-20);
  const swingHighs = candles4h.map(c => c.high).slice(-20);
  const swingLow = Math.min(...swingLows);
  const swingHigh = Math.max(...swingHighs);

  let entry: number;
  let stop: number;
  let target: number;
  let confidence: number;
  let entryType: "EARLY" | "BREAKOUT" | "RETEST";
  let positionSizePct: number;
  let type: "ACCUMULATE" | "BREAKOUT";

  if (rawType === "ENTRY_1") {
    entry = price;
    entryType = "RETEST";
    confidence = 85;
    positionSizePct = 0.06;
    type = "ACCUMULATE";
    if (biasDirection === "LONG") {
      stop = Math.min(swingLow * 0.998, entry - atr4h * 2.0);
    } else {
      stop = Math.max(swingHigh * 1.002, entry + atr4h * 2.0);
    }
  } else if (rawType === "ENTRY_2") {
    entry = price;
    entryType = "BREAKOUT";
    confidence = 75;
    positionSizePct = 0.05;
    type = "ACCUMULATE";
    if (biasDirection === "LONG") {
      stop = Math.min(swingLow * 0.998, entry - atr4h * 1.5);
    } else {
      stop = Math.max(swingHigh * 1.002, entry + atr4h * 1.5);
    }
  } else {
    // ADD
    entry = price;
    entryType = "EARLY";
    confidence = 70;
    positionSizePct = 0.03;
    type = "BREAKOUT";
    if (biasDirection === "LONG") {
      stop = Math.max(tlPrice * 0.99, entry - atr4h * 1.0);
    } else {
      stop = Math.min(tlPrice * 1.01, entry + atr4h * 1.0);
    }
    if (volUp) confidence += 5;
    if (stochMomentum) confidence += 5;
    if (adxStrong) confidence += 5;
  }

  // v38: Flat 3% target
  const targetPct = 0.03;
  target = biasDirection === "LONG" ? entry * (1 + targetPct) : entry * (1 - targetPct);
  target = Math.round(target * 100) / 100;

  const risk = Math.abs(entry - stop);
  const reward = Math.abs(target - entry);
  const rr = risk > 0 ? reward / risk : 0;

  debug.push(`ENTRY: ${entry.toFixed(2)} | STOP: ${stop.toFixed(2)} | TARGET: ${target.toFixed(2)} (flat 3%)`);
  debug.push(`RISK: ${risk.toFixed(2)} | REWARD: ${reward.toFixed(2)} | R:R ${rr.toFixed(2)}`);

  const minRR = rawType === "ADD" ? 1.0 : rawType === "ENTRY_1" ? 0.8 : 1.0;
  if (rr < minRR) {
    debug.push(`R:R ${rr.toFixed(2)} < ${minRR} (min for ${rawType}) — skip`);
    return { debug };
  }

  confidence += Math.min(10, trend.strength / 10);
  if (trend.adx !== null && trend.adx >= 25) confidence += 5;
  if (trend.adx !== null && trend.adx >= 30) confidence += 5;
  confidence = Math.min(95, Math.round(confidence));

  const signal: Signal = {
    id: `${pair}_${now}`,
    pair,
    direction: biasDirection,
    entry: Math.round(entry * 100) / 100,
    stop: Math.round(stop * 100) / 100,
    target: Math.round(target * 100) / 100,
    confidence: Math.round(confidence),
    timestamp: now,
    exited: false,
    entryType,
    trendlinePrice: Math.round(tlPrice * 100) / 100,
    volumeConfirmed: volUp,
    type,
    scale: rawType,
    entryTier: rawType === "ENTRY_1" ? "CONFIRMED_ENTRY" : rawType === "ENTRY_2" ? "CONFIRMED_ENTRY" : "EARLY_ENTRY",
    entryMode: rawType === "ENTRY_1" ? "RETEST" : rawType === "ENTRY_2" ? "RETEST" : "BREAKOUT",
    positionSizePct,
    regimeDirection: biasDirection,
    conflictEntry: false,
    entryTimeframe: "4H",
    rr: Math.round(rr * 100) / 100,
    adx: trend.adx !== null ? Math.round(trend.adx * 10) / 10 : undefined,
    rsi: wilderRsi(closes4h) ?? undefined,
    stochK: stoch4h.k,
    stochD: stoch4h.d,
    version: CURRENT_SIGNAL_VERSION,
    tradeState: {
      phase: "ENTRY",
      phaseEnteredAt: now,
      highestPrice: entry,
      lowestPrice: entry,
      entryPrice: entry,
      lockedStop: null,
      profitLockLevel: 0,
      currentR: 0,
      entryTimestamp: now,
      lastDecisionTimestamp: now,
    },
  };

  debug.push(`SIGNAL: ${rawType} ${entryType} ${biasDirection} ${pair} @ ${entry.toFixed(2)}, SL ${stop.toFixed(2)}, TP ${target.toFixed(2)} (flat 3%), RR ${rr.toFixed(2)}, Conf ${confidence}%, Size ${(positionSizePct*100).toFixed(0)}%, ADX ${trend.adx?.toFixed(1) || "N/A"}${volUp ? ", VOL+" : ""}`);

  return { signal, debug };
}

// ============================================================
// EXIT LOGIC — v38.4: Stoch extreme exit REMOVED, profit lock trail KEPT
// ============================================================
export function shouldHold(
  signal: Signal,
  candles4h: Candle[],
  candles1d: Candle[],
  candles1h: Candle[],
  currentPrice: number
): HoldResult {
  const now = Date.now();
  const ts = signal.tradeState || {
    phase: "TREND", phaseEnteredAt: signal.timestamp,
    highestPrice: signal.entry, lowestPrice: signal.entry,
    entryPrice: signal.entry, lockedStop: null,
    profitLockLevel: 0, currentR: 0,
    entryTimestamp: signal.timestamp, lastDecisionTimestamp: signal.timestamp,
  };

  const newHighest = Math.max(ts.highestPrice, currentPrice);
  const newLowest = Math.min(ts.lowestPrice, currentPrice);
  const currentR = signal.direction === "LONG"
    ? (currentPrice - signal.entry) / (signal.entry - signal.stop)
    : (signal.entry - currentPrice) / (signal.stop - signal.entry);

  const updatedState: TradeState = {
    ...ts, highestPrice: newHighest, lowestPrice: newLowest,
    currentR, lastDecisionTimestamp: now,
  };

  // 1. HARD STOPS
  if (signal.direction === "LONG" && currentPrice <= signal.stop) {
    return { shouldHold: false, reason: "stop_loss", updatedTradeState: { ...updatedState, phase: "EXIT" } };
  }
  if (signal.direction === "SHORT" && currentPrice >= signal.stop) {
    return { shouldHold: false, reason: "stop_loss", updatedTradeState: { ...updatedState, phase: "EXIT" } };
  }

  // 2. TARGET HIT — flat 3%
  if (signal.direction === "LONG" && currentPrice >= signal.target) {
    return { shouldHold: false, reason: "target_hit", updatedTradeState: { ...updatedState, phase: "EXIT" } };
  }
  if (signal.direction === "SHORT" && currentPrice <= signal.target) {
    return { shouldHold: false, reason: "target_hit", updatedTradeState: { ...updatedState, phase: "EXIT" } };
  }

  // 3. EMA REGIME FLIP — v28 style (EMA8 vs EMA21 on 1D)
  if (candles1d && candles1d.length >= 25) {
    const t1d = trend1DV28(candles1d);
    if (t1d.direction && t1d.direction !== signal.direction) {
      const hoursInTrade = (now - signal.timestamp) / (60 * 60 * 1000);
      if (currentR < 2 || hoursInTrade < 24) {
        return { shouldHold: false, reason: "1d_regime_flip", updatedTradeState: { ...updatedState, phase: "EXIT" } };
      }
      return { shouldHold: false, reason: "1d_regime_flip_profit", updatedTradeState: { ...updatedState, phase: "EXIT" } };
    }
  }

  // 4. 4H EMA8/21 STRUCTURE FAILURE (v28 enhancement)
  if (candles4h && candles4h.length >= 50) {
    const closes = candles4h.map(c => c.close);
    const e8 = ema(closes, 8);
    const e21 = ema(closes, 21);
    if (e8.length > 0 && e21.length > 0) {
      const ema8Price = e8[e8.length - 1];
      const ema21Price = e21[e21.length - 1];
      const hoursInTrade = (now - signal.timestamp) / (60 * 60 * 1000);
      if (hoursInTrade > 4) {
        if (signal.direction === "LONG" && currentPrice < ema8Price && currentPrice < ema21Price) {
          return { shouldHold: false, reason: "4h_structure_failure", updatedTradeState: { ...updatedState, phase: "EXIT" } };
        }
        if (signal.direction === "SHORT" && currentPrice > ema8Price && currentPrice > ema21Price) {
          return { shouldHold: false, reason: "4h_structure_failure", updatedTradeState: { ...updatedState, phase: "EXIT" } };
        }
      }
    }
  }

  // v38.4: STOCH EXTREME EXIT REMOVED

  // 5. PROFIT PROTECTION — KEPT EXACTLY
  let newLockedStop = ts.lockedStop;
  let newProfitLockLevel = ts.profitLockLevel;
  let newPhase: TradeLifecyclePhase = ts.phase;

  if (currentR >= 3 && newProfitLockLevel < 3) {
    const gain = Math.abs(currentPrice - signal.entry);
    const lockPrice = signal.direction === "LONG" ? signal.entry + gain * 0.3 : signal.entry - gain * 0.3;
    newLockedStop = Math.max(ts.lockedStop || 0, lockPrice);
    newProfitLockLevel = 3; newPhase = "PROFIT_PROTECTION";
  } else if (currentR >= 2 && newProfitLockLevel < 2) {
    const gain = Math.abs(currentPrice - signal.entry);
    const lockPrice = signal.direction === "LONG" ? signal.entry + gain * 0.5 : signal.entry - gain * 0.5;
    newLockedStop = Math.max(ts.lockedStop || 0, lockPrice);
    newProfitLockLevel = 2; newPhase = "PROFIT_PROTECTION";
  } else if (currentR >= 1 && newProfitLockLevel < 1) {
    newLockedStop = signal.entry; newProfitLockLevel = 1; newPhase = "BUILDING";
  }

  if (newLockedStop) {
    if (signal.direction === "LONG" && currentPrice <= newLockedStop) {
      return { shouldHold: false, reason: `profit_protection_${newProfitLockLevel}R`, updatedTradeState: { ...updatedState, phase: "EXIT", lockedStop: newLockedStop, profitLockLevel: newProfitLockLevel } };
    }
    if (signal.direction === "SHORT" && currentPrice >= newLockedStop) {
      return { shouldHold: false, reason: `profit_protection_${newProfitLockLevel}R`, updatedTradeState: { ...updatedState, phase: "EXIT", lockedStop: newLockedStop, profitLockLevel: newProfitLockLevel } };
    }
  }

  if (currentR >= 2 && newPhase === "BUILDING") newPhase = "TREND";
  if (currentR >= 1 && newPhase === "ENTRY") newPhase = "BUILDING";

  const finalState: TradeState = {
    ...updatedState, phase: newPhase,
    lockedStop: newLockedStop, profitLockLevel: newProfitLockLevel,
  };

  return { shouldHold: true, reason: `holding_${newPhase.toLowerCase()}_R${currentR.toFixed(1)}`, updatedTradeState: finalState };
}

// ============================================================
// VALIDITY
// ============================================================
export function isSignalStillValid(signal: Signal, currentPrice: number): { valid: boolean; reason: string; exited: boolean } {
  if (signal.direction === "LONG" && currentPrice <= signal.stop) return { valid: false, reason: "sl_hit", exited: true };
  if (signal.direction === "SHORT" && currentPrice >= signal.stop) return { valid: false, reason: "sl_hit", exited: true };
  if (signal.direction === "LONG" && currentPrice >= signal.target) return { valid: false, reason: "tp_hit", exited: true };
  if (signal.direction === "SHORT" && currentPrice <= signal.target) return { valid: false, reason: "tp_hit", exited: true };
  return { valid: true, reason: "active", exited: false };
}

export function filterExpiredSignals(signals: Signal[], currentPrices?: Record<string, number>) {
  const active: Signal[] = [];
  const exited: { signal: Signal; reason: string }[] = [];
  const now = Date.now();
  const EXITED_TTL_MS = 7 * 24 * 60 * 60 * 1000;
  for (const signal of signals) {
    if (!signal.exited) {
      const price = currentPrices?.[signal.pair];
      if (price !== undefined) {
        const check = isSignalStillValid(signal, price);
        if (!check.valid) { exited.push({ signal, reason: check.reason }); continue; }
      }
      active.push(signal); continue;
    }
    if (now - signal.timestamp < EXITED_TTL_MS) active.push(signal);
  }
  return { active, exited };
}

// ============================================================
// 4H ALIGNMENT CHECK
// ============================================================
function check4HAlignment(
  candles4h: Candle[],
  biasDirection: "LONG" | "SHORT"
): { aligned: boolean; priceAboveEMA21: boolean; ema21Direction: "LONG" | "SHORT" | null; debug: string[] } {
  const debug: string[] = [];
  if (candles4h.length < 50) {
    debug.push("Insufficient 4H data for alignment check");
    return { aligned: false, priceAboveEMA21: false, ema21Direction: null, debug };
  }
  const closes = candles4h.map(c => c.close);
  const e8 = ema(closes, 8);
  const e21 = ema(closes, 21);
  if (!e8.length || !e21.length) {
    debug.push("EMA calculation failed on 4H");
    return { aligned: false, priceAboveEMA21: false, ema21Direction: null, debug };
  }
  const price = closes[closes.length - 1];
  const ema8Price = e8[e8.length - 1];
  const ema21Price = e21[e21.length - 1];
  const priceAboveEMA8 = price > ema8Price;
  const priceAboveEMA21 = price > ema21Price;
  const ema21Direction = priceAboveEMA21 ? "LONG" : "SHORT";
  const aligned = biasDirection === "LONG" ? priceAboveEMA8 && priceAboveEMA21 : !priceAboveEMA8 && !priceAboveEMA21;
  debug.push(`4H alignment: price ${price.toFixed(2)} vs EMA8 ${ema8Price.toFixed(2)} EMA21 ${ema21Price.toFixed(2)} — ${aligned ? "ALIGNED" : "MISALIGNED"}`);
  return { aligned, priceAboveEMA21, ema21Direction, debug };
}

// ============================================================
// MARKET SNAPSHOT
// ============================================================
export function getMarketSnapshot(
  pair: string,
  candles1h: Candle[],
  candles4h: Candle[],
  candles15m: Candle[],
  candles1d: Candle[],
  currentPrice?: number,
  signalResult?: SignalResult
) {
  const price = currentPrice ?? candles4h[candles4h.length - 1]?.close ?? 0;
  const trend = detectTrend(candles1d);
  const alignment = trend.direction ? check4HAlignment(candles4h, trend.direction) : { aligned: false, priceAboveEMA21: false, ema21Direction: null as "LONG" | "SHORT" | null, debug: [] };
  const stoch4h = candles4h.length >= 50 ? stochRsi(candles4h.map(c => c.close)) : { k: 50, d: 50 };
  const stoch1h = candles1h.length >= 30 ? stochRsi(candles1h.map(c => c.close)) : { k: 50, d: 50 };
  const stoch15m = candles15m.length >= 20 ? stochRsi(candles15m.map(c => c.close)) : { k: 50, d: 50 };
  const volConfirmed = isVolumeConfirmed(candles4h);
  const pivots4h = findPivots(candles4h, 3, 2);
  const resistanceLines = buildTrendlines(candles4h, pivots4h.highs, "RESISTANCE", 2, 0.3);
  const supportLines = buildTrendlines(candles4h, pivots4h.lows, "SUPPORT", 2, 0.3);
  const activeTrendlines = [...resistanceLines, ...supportLines]
    .filter(l => l.isValid && !l.isBroken)
    .map(l => ({ type: l.type, startPrice: l.startPrice, endPrice: l.endPrice, touches: l.touches, currentPrice: getTrendlinePrice(l, candles4h.length - 1) }));

  const closes4h = candles4h.map(c => c.close);
  const prevStoch4h = stochRsi(closes4h.slice(0, -1));
  const isStrongTrend = (trend.adx !== null && trend.adx >= 25) && trend.strength >= 80;
  const pullback = trend.direction ? checkPullbackAdaptive(trend.direction, stoch4h, prevStoch4h, trend.adx, isStrongTrend) : { pullbackActive: false, reason: "No bias", tier: null, stochZone: "NEUTRAL" };

  const e21_4h = ema(closes4h, 21);
  const ema21Price = e21_4h.length > 0 ? e21_4h[e21_4h.length - 1] : 0;
  const distToEMA21 = ema21Price > 0 ? (price - ema21Price) / ema21Price : 0;
  const adxVal = adx(candles4h) ?? 0;
  const rsiVal = wilderRsi(closes4h);

  let trendStrengthLabel = "WEAK";
  if (adxVal >= 30) trendStrengthLabel = "STRONG";
  else if (adxVal >= 20) trendStrengthLabel = "MEDIUM";

  let phase4h: "EXPANSION" | "PULLBACK" | "BUILDING" | "NEUTRAL" = "NEUTRAL";
  if (trend.direction === "LONG") {
    if (stoch4h.k > 65) phase4h = "EXPANSION";
    else if (stoch4h.k < 35) phase4h = "PULLBACK";
    else phase4h = "BUILDING";
  } else if (trend.direction === "SHORT") {
    if (stoch4h.k < 35) phase4h = "EXPANSION";
    else if (stoch4h.k > 65) phase4h = "PULLBACK";
    else phase4h = "BUILDING";
  }

  let structure15m = "Neutral";
  if (candles15m.length >= 20) {
    const stoch15mCheck = stochRsi(candles15m.map(c => c.close));
    if (trend.direction === "LONG") {
      if (stoch15mCheck.k > 50) structure15m = "Building";
      else structure15m = "Pullback";
    } else if (trend.direction === "SHORT") {
      if (stoch15mCheck.k < 50) structure15m = "Building";
      else structure15m = "Pullback";
    }
  }

  let trend4hObj: { direction: "LONG" | "SHORT"; strength: "STRONG" | "MEDIUM" | "WEAK" } | null = null;
  if (candles4h.length >= 50) {
    const closes4h_trend = candles4h.map(c => c.close);
    const e8_4h = ema(closes4h_trend, 8);
    const e21_4h = ema(closes4h_trend, 21);
    if (e8_4h.length && e21_4h.length) {
      const price4h = closes4h_trend[closes4h_trend.length - 1];
      const e8_val = e8_4h[e8_4h.length - 1];
      const e21_val = e21_4h[e21_4h.length - 1];
      const adx4h = adx(candles4h);

      let dir4h: "LONG" | "SHORT" | null = null;
      if (price4h > e8_val && e8_val > e21_val) dir4h = "LONG";
      else if (price4h < e8_val && e8_val < e21_val) dir4h = "SHORT";
      else if (price4h > e8_val) dir4h = "LONG";
      else if (price4h < e8_val) dir4h = "SHORT";

      if (dir4h) {
        let strength4h: "STRONG" | "MEDIUM" | "WEAK" = "WEAK";
        if (adx4h !== null && adx4h >= 30) strength4h = "STRONG";
        else if (adx4h !== null && adx4h >= 20) strength4h = "MEDIUM";
        trend4hObj = { direction: dir4h, strength: strength4h };
      }
    }
  }

  let readiness = 0;
  if (trend.direction) readiness += 25;
  if (trend.strength >= 50) readiness += 15;
  if (pullback.pullbackActive) {
    if (pullback.tier === "DEEP") readiness += 30;
    else if (pullback.tier === "SHALLOW") readiness += 20;
    else if (pullback.tier === "MOMENTUM") readiness += 10;
  }
  const longBreak = trend.direction === "LONG" ? checkTrendlineBreak(candles4h, resistanceLines, "RESISTANCE") : { broken: false };
  const shortBreak = trend.direction === "SHORT" ? checkTrendlineBreak(candles4h, supportLines, "SUPPORT") : { broken: false };
  if (longBreak.broken || shortBreak.broken) readiness += 20;
  if (adxVal >= 25) readiness += 10;
  if (volConfirmed) readiness += 5;
  if (signalResult?.signal) readiness += 15;
  readiness = Math.min(100, readiness);

  let readinessLabel = "NO_TRADE";
  let readinessColor = "text-gray-400";
  if (readiness >= 80) { readinessLabel = "READY"; readinessColor = "text-green-400"; }
  else if (readiness >= 60) { readinessLabel = "WARM"; readinessColor = "text-amber-400"; }
  else if (readiness >= 40) { readinessLabel = "WATCH"; readinessColor = "text-blue-400"; }

  const trend1dObj = trend.direction ? { direction: trend.direction, strength: trend.strength > 50 ? "STRONG" : "MEDIUM" } : null;

  return {
    pair, price: Math.round(price * 100) / 100, timestamp: Date.now(),
    bias: trend.direction ? { direction: trend.direction, strength: trend.strength } : null,
    trend1d: trend1dObj,
    trend4h: trend4hObj,
    trend1h: trend1dObj,
    stoch4h, stoch1h, stoch15m,
    volumeConfirmed: volConfirmed,
    trendlines: activeTrendlines,
    trendDirection: trend.direction,
    trendStrength: trend.strength,
    isPullback: pullback.pullbackActive,
    pullbackTier: pullback.tier,
    pullbackReason: pullback.reason,
    stochZone: pullback.stochZone,
    readiness, readinessLabel, readinessColor,
    adx: Math.round(adxVal * 10) / 10,
    trendStrengthLabel,
    trend: trend.direction ? `${trend.direction} ${trend.strength > 50 ? "STRONG" : "MEDIUM"}` : "NONE",
    regime: { direction: trend.direction, strength: trend.strength > 50 ? "STRONG" : "MEDIUM", confidence: trend.direction ? (trend.strength > 50 ? 75 : 50) : 0 },
    rsi: Math.round((rsiVal ?? 50) * 10) / 10,
    stochK: stoch4h.k, stochD: stoch4h.d,
    stoch1hK: stoch1h.k, stoch1hD: stoch1h.d,
    ema21: Math.round(ema21Price * 100) / 100,
    distToEMA21: Math.round(distToEMA21 * 10000) / 100,
    trendStrengthCompat: { adx: adxVal, isStrong: adxVal >= 25 },
    phase4h, phase1h: phase4h, structure15m,
    recommendedAction: signalResult?.signal ? `${signalResult.signal.direction} ${signalResult.signal.entryType}` : null,
    entryTier: signalResult?.signal ? (signalResult.signal.entryType === "RETEST" ? "CONFIRMED_ENTRY" : "EARLY_ENTRY") : null,
    entryMode: signalResult?.signal ? (signalResult.signal.entryType === "EARLY" ? "PULLBACK" : "BREAKOUT") : null,
    positionSize: signalResult?.signal ? (signalResult.signal.positionSizePct ? (signalResult.signal.positionSizePct * 100).toFixed(0) + "%" : null) : null,
    signal: signalResult?.signal || null,
    summary: { status: signalResult?.signal ? "READY" : "WATCH", debug: signalResult?.debug || trend.debug || [] },
    activeTrade: null,
    debug: signalResult?.debug || trend.debug || [],
  };
}

// ============================================================
// COMPATIBILITY EXPORTS (all preserved)
// ============================================================
export function shouldHoldCompat(
  signal: Signal,
  candles4h: Candle[],
  candles1h: Candle[],
  currentPrice: number
): HoldResult {
  return shouldHold(signal, candles4h, aggregateTo1D(candles4h), candles1h, currentPrice);
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

export function migrateV36ToV37(signal: Signal): TradeState {
  return {
    phase: "ENTRY", phaseEnteredAt: signal.timestamp,
    highestPrice: signal.entry, lowestPrice: signal.entry,
    entryPrice: signal.entry, lockedStop: null,
    profitLockLevel: 0, currentR: 0,
    entryTimestamp: signal.timestamp, lastDecisionTimestamp: Date.now(),
  };
}

export function updateTradeManagerCompat(signal: Signal, currentPrice: number): TradeState {
  const currentR = signal.direction === "LONG"
    ? (currentPrice - signal.entry) / (signal.entry - signal.stop)
    : (signal.entry - currentPrice) / (signal.stop - signal.entry);
  return {
    phase: currentR >= 2 ? "TREND" : currentR >= 1 ? "BUILDING" : "ENTRY",
    phaseEnteredAt: signal.timestamp,
    highestPrice: Math.max(signal.entry, currentPrice),
    lowestPrice: Math.min(signal.entry, currentPrice),
    entryPrice: signal.entry, lockedStop: null,
    profitLockLevel: 0, currentR,
    entryTimestamp: signal.timestamp, lastDecisionTimestamp: Date.now(),
  };
}

export function calculateTradeState(signal: Signal, currentPrice: number): TradeState {
  return updateTradeManagerCompat(signal, currentPrice);
}

export async function loadExits(): Promise<any[]> { return []; }
export function setRegimePersistence(): void {}
export function setExitPersistence(): void {}
export function setTelemetryPersistence(): void {}
export async function persistTelemetry(): Promise<void> {}

let _loadLastExit: ((pair: string) => Promise<{ direction: "LONG" | "SHORT"; reason: string; timestamp: number } | null>) | null = null;
let _persistLastExit: ((pair: string, record: { direction: "LONG" | "SHORT"; reason: string; timestamp: number }) => Promise<void>) | null = null;

export function setLastExitFunctions(
  loadFn: (pair: string) => Promise<{ direction: "LONG" | "SHORT"; reason: string; timestamp: number } | null>,
  persistFn: (pair: string, record: { direction: "LONG" | "SHORT"; reason: string; timestamp: number }) => Promise<void>
): void {
  _loadLastExit = loadFn;
  _persistLastExit = persistFn;
}
