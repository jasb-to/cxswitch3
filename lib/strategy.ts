// ============================================================
// CXSwitch "Trend Rider v2" — Simple, Profitable, No Churn
// ============================================================
// Philosophy: Trade WITH the 1D trend, enter on 4H pullback, 
// ride until 1D trend flips or stop hits. No scalping.
//
// Bias:     1D EMA8 vs EMA21 (direction + strength)
// Entry:     4H StochRSI < 30 (LONG) or > 70 (SHORT) 
// Stop:      ATR(14) × 2, capped at 5% max
// Exit:      1D trend flip, stop hit, or trailing stop in profit
// Position:  Fixed 2% risk per trade
//
// What was removed from v38:
// - Profit locks (1R/2R/3R) — they chop winners
// - Stoch extreme opposite exit — exits too early
// - 4H EMA structure failure — exits on normal noise
// - 1D regime flip with profit distinction — overcomplicated
// - ENTRY_1/ENTRY_2/ADD scaling — one entry, one size
// - Hysteresis with Redis — in-memory only, simpler
// - Trendline R² gating — any 3+ pivots works
// - Cooldowns, phases, trade states — unnecessary complexity
//
// What was kept from v28:
// - Trendline for entry timing (price near TL = better entry)
// - StochRSI for pullback detection
// - ATR-based stops
// - Simple signal structure
//
// What was added:
// - 1D/4H/15m alignment check (higher confidence when aligned)
// - Trailing stop once in 2R profit
// - ADX filter (skip when 1D ADX < 20, market is ranging)
// - Counter-trend fade detection (optional, for experienced users)
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
  entryType?: "PULLBACK" | "BREAKOUT" | "FADE";
  trendlinePrice?: number;
  volumeConfirmed?: boolean;
  type?: "ACCUMULATE" | "BREAKOUT";
  scale?: "ENTRY" | "ADD" | null;
  entryTier?: string;
  entryMode?: string;
  positionSizePct?: number;
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
  tradeState?: TradeState;
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
  id: string;
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
  r2: number;
  ageMs: number;
  projectedPrice: number;
  distanceFromPrice: number;
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

export interface TrendResult {
  direction: "LONG" | "SHORT" | null;
  strength: number;
  strengthLabel: "STRONG" | "MEDIUM" | "WEAK";
  adx: number | null;
  ema8: number;
  ema21: number;
  ema50: number;
  price: number;
  debug: string[];
}

export interface EMAAlignmentResult {
  aligned: boolean;
  priceAboveEMA8: boolean;
  priceAboveEMA21: boolean;
  ema8AboveEMA21: boolean;
  price: number;
  ema8: number;
  ema21: number;
  debug: string[];
}

export interface TrendlineEvaluation {
  trendline: Trendline | null;
  isValid: boolean;
  reason: string;
  quality: "NOISE" | "WEAK" | "GOOD" | "EXCELLENT";
  debug: string[];
}

export interface EntryDiagnostics {
  rawType: "ENTRY" | "ADD" | "FADE" | null;
  entryType: "PULLBACK" | "BREAKOUT" | "FADE" | null;
  nearTrendline: boolean;
  beyondTrendline: boolean;
  stochExtreme: boolean;
  stochTurning: boolean;
  confirming: boolean;
  volUp: boolean;
  stochMomentum: boolean;
  adxStrong: boolean;
  emaAligned: boolean;
  trendline: TrendlineEvaluation;
  stoch4h: { k: number; d: number };
  debug: string[];
}

export interface RiskDiagnostics {
  entry: number;
  stop: number;
  target: number;
  risk: number;
  reward: number;
  rr: number;
  minRR: number;
  passes: boolean;
  debug: string[];
}

export type EntryTier = "NO_TRADE" | "WATCH" | "PULLBACK_ENTRY" | "BREAKOUT_ENTRY" | "FADE_ENTRY";
export type TradeLifecyclePhase = "WATCH" | "ENTRY" | "BUILDING" | "TREND" | "PROFIT_PROTECTION" | "EXIT" | "COOLDOWN";
export type PullbackTier = "DEEP" | "SHALLOW" | "MOMENTUM" | null;

export const CURRENT_SIGNAL_VERSION = 40;

function avg(arr: number[]): number {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
}

function isValid(v: any): boolean {
  return typeof v === "number" && Number.isFinite(v);
}

function sf(v: number, d: number): string {
  return isValid(v) ? v.toFixed(d) : "0";
}

// ============================================================
// CANONICAL EMA
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
// CANONICAL RSI
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
// CANONICAL STOCHRSI
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
// CANONICAL ADX
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
// ADX WITH +DI / -DI
// ============================================================
export function adxWithDI(candles: Candle[], period = 14): {
  adx: number | null;
  plusDI: number | null;
  minusDI: number | null;
} {
  if (candles.length < period * 2) return { adx: null, plusDI: null, minusDI: null };
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
  if (!atrS.length) return { adx: null, plusDI: null, minusDI: null };
  const pDI = atrS.map((_, i) => (pDIS[i] / atrS[i]) * 100);
  const mDI = atrS.map((_, i) => (mDIS[i] / atrS[i]) * 100);
  const dx = atrS.map((_, i) => {
    const sum = pDI[i] + mDI[i];
    return sum === 0 ? 0 : (Math.abs(pDI[i] - mDI[i]) / sum) * 100;
  });
  const adxS = wilderSmooth(dx, period);
  const v = adxS[adxS.length - 1];
  return {
    adx: isValid(v) ? Math.round(v * 10) / 10 : null,
    plusDI: isValid(pDI[pDI.length - 1]) ? Math.round(pDI[pDI.length - 1] * 10) / 10 : null,
    minusDI: isValid(mDI[mDI.length - 1]) ? Math.round(mDI[mDI.length - 1] * 10) / 10 : null,
  };
}

// ============================================================
// CANONICAL ATR
// ============================================================
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

// ============================================================
// CANONICAL 4H → 1D AGGREGATION
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
// 1D TREND — EMA-based (simple, reliable)
// Direction from EMA8 vs EMA21
// Strength from ADX + price vs EMA50
// ============================================================
export function calculateTrend1D(candles1d: Candle[]): TrendResult {
  const debug: string[] = [];

  if (candles1d.length < 50) {
    debug.push("[TREND1D] Insufficient 1D data (< 50 candles)");
    return {
      direction: null, strength: 0, strengthLabel: "WEAK",
      adx: null, ema8: 0, ema21: 0, ema50: 0, price: 0, debug
    };
  }

  const closes = candles1d.map(c => c.close);
  const price = closes[closes.length - 1];
  const e8 = ema(closes, 8);
  const e21 = ema(closes, 21);
  const e50 = ema(closes, 50);

  if (!e8.length || !e21.length || !e50.length) {
    debug.push("[TREND1D] EMA calculation failed");
    return {
      direction: null, strength: 0, strengthLabel: "WEAK",
      adx: null, ema8: 0, ema21: 0, ema50: 0, price: 0, debug
    };
  }

  const ema8 = e8[e8.length - 1];
  const ema21 = e21[e21.length - 1];
  const ema50 = e50[e50.length - 1];

  // Direction: simple EMA cross
  const direction = ema8 > ema21 ? "LONG" : "SHORT";

  // Strength from ADX
  const { adx: adxVal } = adxWithDI(candles1d);
  let strength = 40;
  let strengthLabel: "STRONG" | "MEDIUM" | "WEAK" = "WEAK";

  if (adxVal !== null) {
    if (adxVal >= 25) { strength = 80; strengthLabel = "STRONG"; }
    else if (adxVal >= 20) { strength = 60; strengthLabel = "MEDIUM"; }
    else { strength = 30; strengthLabel = "WEAK"; }
  }

  // Boost strength if price is aligned with trend
  const priceAligned = direction === "LONG" ? price > ema50 : price < ema50;
  if (priceAligned) strength += 10;

  debug.push(`[TREND1D] ${direction} ${strengthLabel} | ADX=${sf(adxVal ?? 0,1)} | Price=${sf(price,2)} EMA8=${sf(ema8,2)} EMA21=${sf(ema21,2)} EMA50=${sf(ema50,2)}`);

  return { direction, strength, strengthLabel, adx: adxVal, ema8, ema21, ema50, price, debug };
}

// ============================================================
// 4H TREND — EMA-based (simpler than +DI/-DI, less lag)
// ============================================================
export function calculateTrend4H(candles4h: Candle[]): {
  direction: "LONG" | "SHORT" | null;
  strengthLabel: "STRONG" | "MEDIUM" | "WEAK";
  adx: number | null;
  debug: string[];
} {
  const debug: string[] = [];

  if (candles4h.length < 50) {
    debug.push("[TREND4H] Insufficient 4H data");
    return { direction: null, strengthLabel: "WEAK", adx: null, debug };
  }

  const closes = candles4h.map(c => c.close);
  const price = closes[closes.length - 1];
  const e8 = ema(closes, 8);
  const e21 = ema(closes, 21);
  const e50 = ema(closes, 50);

  if (!e8.length || !e21.length || !e50.length) {
    debug.push("[TREND4H] EMA calculation failed");
    return { direction: null, strengthLabel: "WEAK", adx: null, debug };
  }

  const ema8 = e8[e8.length - 1];
  const ema21 = e21[e21.length - 1];
  const ema50 = e50[e50.length - 1];

  // Simple EMA direction
  let direction: "LONG" | "SHORT" | null = null;
  let strengthLabel: "STRONG" | "MEDIUM" | "WEAK" = "WEAK";

  if (price > ema8 && ema8 > ema21 && ema21 > ema50) {
    direction = "LONG"; strengthLabel = "STRONG";
  } else if (price < ema8 && ema8 < ema21 && ema21 < ema50) {
    direction = "SHORT"; strengthLabel = "STRONG";
  } else if (price > ema8 && ema8 > ema21) {
    direction = "LONG"; strengthLabel = "MEDIUM";
  } else if (price < ema8 && ema8 < ema21) {
    direction = "SHORT"; strengthLabel = "MEDIUM";
  } else if (price > ema21) {
    direction = "LONG"; strengthLabel = "WEAK";
  } else if (price < ema21) {
    direction = "SHORT"; strengthLabel = "WEAK";
  }

  const { adx: adxVal } = adxWithDI(candles4h);
  debug.push(`[TREND4H] ${direction} ${strengthLabel} | Price=${sf(price,2)} EMA8=${sf(ema8,2)} EMA21=${sf(ema21,2)} EMA50=${sf(ema50,2)} ADX=${sf(adxVal ?? 0,1)}`);

  return { direction, strengthLabel, adx: adxVal, debug };
}

// ============================================================
// EMA ALIGNMENT
// ============================================================
export function calculateEMAAlignment(
  candles4h: Candle[],
  biasDirection: "LONG" | "SHORT"
): EMAAlignmentResult {
  const debug: string[] = [];

  if (candles4h.length < 50) {
    debug.push("[ALIGN] Insufficient 4H data (< 50 candles)");
    return {
      aligned: false, priceAboveEMA8: false, priceAboveEMA21: false, ema8AboveEMA21: false,
      price: 0, ema8: 0, ema21: 0, debug
    };
  }

  const closes = candles4h.map(c => c.close);
  const price = closes[closes.length - 1];
  const e8 = ema(closes, 8);
  const e21 = ema(closes, 21);

  if (!e8.length || !e21.length) {
    debug.push("[ALIGN] EMA calculation failed on 4H");
    return {
      aligned: false, priceAboveEMA8: false, priceAboveEMA21: false, ema8AboveEMA21: false,
      price: 0, ema8: 0, ema21: 0, debug
    };
  }

  const ema8 = e8[e8.length - 1];
  const ema21 = e21[e21.length - 1];
  const priceAboveEMA8 = price > ema8;
  const priceAboveEMA21 = price > ema21;
  const ema8AboveEMA21 = ema8 > ema21;

  const aligned = biasDirection === "LONG"
    ? priceAboveEMA8 && priceAboveEMA21
    : !priceAboveEMA8 && !priceAboveEMA21;

  debug.push(`[ALIGN] Price=${sf(price,2)} EMA8=${sf(ema8,2)} EMA21=${sf(ema21,2)} | AboveEMA8=${priceAboveEMA8} AboveEMA21=${priceAboveEMA21} | Aligned=${aligned}`);

  return { aligned, priceAboveEMA8, priceAboveEMA21, ema8AboveEMA21, price, ema8, ema21, debug };
}

// ============================================================
// PULLBACK CHECK — Trend Rider with early entry (25/75 zones)
// LONG entry when K < 75 (was < 50) — gets in earlier
// SHORT entry when K > 25 (was > 50) — gets in earlier
// Still avoids true extremes (<20/>80) for best entries
// ============================================================
function checkPullback(
  biasDirection: "LONG" | "SHORT" | null,
  stoch4h: { k: number; d: number }
): {
  pullbackActive: boolean;
  tier: PullbackTier;
  reason: string;
  stochZone: "EXTREME" | "ZONE" | "NEUTRAL" | "EXTENDED";
  debug: string[];
} {
  const debug: string[] = [];

  if (!biasDirection) {
    debug.push("[PULLBACK] No bias — no pullback check");
    return { pullbackActive: false, tier: null, reason: "No bias", stochZone: "NEUTRAL", debug };
  }

  debug.push(`[PULLBACK] Stoch K=${stoch4h.k} D=${stoch4h.d}`);

  if (biasDirection === "LONG") {
    if (stoch4h.k < 20) {
      debug.push("[PULLBACK] LONG EXTREME: Stoch < 20 — deep pullback, best entry");
      return { pullbackActive: true, tier: "DEEP", reason: `LONG deep pullback: 4H Stoch extreme oversold (${stoch4h.k})`, stochZone: "EXTREME", debug };
    }
    if (stoch4h.k < 75) {
      debug.push("[PULLBACK] LONG PULLBACK: Stoch < 75 — early entry zone");
      return { pullbackActive: true, tier: "SHALLOW", reason: `LONG pullback: 4H Stoch ${stoch4h.k} (< 75)`, stochZone: "ZONE", debug };
    }
    debug.push("[PULLBACK] LONG EXTENDED: Stoch >= 75 — no entry, wait for pullback");
    return { pullbackActive: false, tier: null, reason: `LONG extended: 4H Stoch ${stoch4h.k} (need < 75)`, stochZone: "EXTENDED", debug };
  }

  if (biasDirection === "SHORT") {
    if (stoch4h.k > 80) {
      debug.push("[PULLBACK] SHORT EXTREME: Stoch > 80 — deep pullback, best entry");
      return { pullbackActive: true, tier: "DEEP", reason: `SHORT deep pullback: 4H Stoch extreme overbought (${stoch4h.k})`, stochZone: "EXTREME", debug };
    }
    if (stoch4h.k > 25) {
      debug.push("[PULLBACK] SHORT PULLBACK: Stoch > 25 — early entry zone");
      return { pullbackActive: true, tier: "SHALLOW", reason: `SHORT pullback: 4H Stoch ${stoch4h.k} (> 25)`, stochZone: "ZONE", debug };
    }
    debug.push("[PULLBACK] SHORT EXTENDED: Stoch <= 25 — no entry, wait for pullback");
    return { pullbackActive: false, tier: null, reason: `SHORT extended: 4H Stoch ${stoch4h.k} (need > 25)`, stochZone: "EXTENDED", debug };
  }

  return { pullbackActive: false, tier: null, reason: "Unknown bias", stochZone: "NEUTRAL", debug };
}

// ============================================================
// TRENDLINE SYSTEM — v28 style, simple, no R² gating
// ============================================================
interface TrendlineState {
  slope: number;
  intercept: number;
  pivots: { index: number; price: number; timestamp: number }[];
  lastUpdated: number;
  direction: "LONG" | "SHORT";
  r2: number;
}

const trendlineStore: Map<string, TrendlineState> = new Map();

function findPivots(candles: Candle[], direction: "LONG" | "SHORT"): { index: number; price: number; timestamp: number }[] {
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

function fitTrendline(pivots: { index: number; price: number }[]): { slope: number; intercept: number; r2: number } | null {
  const n = pivots.length;
  if (n < 3) return null;

  const sumX = pivots.reduce((s, p) => s + p.index, 0);
  const sumY = pivots.reduce((s, p) => s + p.price, 0);
  const sumXY = pivots.reduce((s, p) => s + p.index * p.price, 0);
  const sumX2 = pivots.reduce((s, p) => s + p.index * p.index, 0);

  const denominator = n * sumX2 - sumX * sumX;
  if (denominator === 0) return null;

  const slope = (n * sumXY - sumX * sumY) / denominator;
  const intercept = (sumY - slope * sumX) / n;

  const yMean = sumY / n;
  const ssTotal = pivots.reduce((s, p) => s + Math.pow(p.price - yMean, 2), 0);
  const ssResidual = pivots.reduce((s, p) => s + Math.pow(p.price - (slope * p.index + intercept), 2), 0);
  const r2 = ssTotal === 0 ? 0 : 1 - (ssResidual / ssTotal);

  return { slope, intercept, r2 };
}

export function evaluateTrendline(
  pair: string,
  candles: Candle[],
  direction: "LONG" | "SHORT",
  now: number
): TrendlineEvaluation {
  const debug: string[] = [];
  const len = candles.length;

  if (len < 20) {
    debug.push("[TL] Insufficient candles (< 20)");
    return { trendline: null, isValid: false, reason: "Insufficient data", quality: "NOISE", debug };
  }

  const pivots = findPivots(candles, direction);
  debug.push(`[TL] Found ${pivots.length} pivots (${direction})`);

  if (pivots.length < 3) {
    debug.push("[TL] Need >= 3 pivots");
    return { trendline: null, isValid: false, reason: "Need >= 3 pivots", quality: "NOISE", debug };
  }

  const recentPivots = pivots.slice(-5);
  const currentPrice = candles[len - 1].close;
  const currentIndex = len - 1;

  const existing = trendlineStore.get(pair);
  const maxAge = 7 * 24 * 60 * 60 * 1000;

  let fit: { slope: number; intercept: number; r2: number } | null = null;
  let isRecalculated = false;

  if (existing && existing.direction === direction && (now - existing.lastUpdated) < maxAge) {
    const lastPivot = recentPivots[recentPivots.length - 1];
    const projectedPrice = existing.slope * lastPivot.index + existing.intercept;
    const deviation = Math.abs(lastPivot.price - projectedPrice) / projectedPrice;

    debug.push(`[TL] Existing TL | Age=${Math.round((now - existing.lastUpdated)/3600000)}h | R²=${sf(existing.r2,2)} | Deviation=${sf(deviation*100,2)}%`);

    if (deviation < 0.02) {
      fit = { slope: existing.slope, intercept: existing.intercept, r2: existing.r2 };
      debug.push("[TL] Reusing existing trendline (deviation < 2%)");
    } else {
      debug.push("[TL] Existing trendline deviated > 2%, recalculating");
      fit = fitTrendline(recentPivots);
      isRecalculated = true;
    }
  } else {
    debug.push("[TL] No valid existing trendline, calculating new");
    fit = fitTrendline(recentPivots);
    isRecalculated = true;
  }

  if (!fit) {
    debug.push("[TL] Trendline fit failed");
    return { trendline: null, isValid: false, reason: "Fit failed", quality: "NOISE", debug };
  }

  if (isRecalculated) {
    trendlineStore.set(pair, {
      slope: fit.slope,
      intercept: fit.intercept,
      pivots: recentPivots,
      lastUpdated: now,
      direction,
      r2: fit.r2,
    });
  }

  const projectedPrice = fit.slope * currentIndex + fit.intercept;
  const distanceFromPrice = (currentPrice - projectedPrice) / projectedPrice;
  const ageMs = isRecalculated ? 0 : (now - (existing?.lastUpdated ?? now));

  const trendline: Trendline = {
    id: `${pair}_${direction}_${now}`,
    startIndex: recentPivots[0].index,
    endIndex: recentPivots[recentPivots.length - 1].index,
    startPrice: recentPivots[0].price,
    endPrice: recentPivots[recentPivots.length - 1].price,
    slope: fit.slope,
    type: direction === "LONG" ? "SUPPORT" : "RESISTANCE",
    touches: recentPivots.length,
    isValid: true,
    isBroken: false,
    r2: Math.round(fit.r2 * 100) / 100,
    ageMs,
    projectedPrice: Math.round(projectedPrice * 100) / 100,
    distanceFromPrice: Math.round(distanceFromPrice * 10000) / 100,
  };

  debug.push(`[TL] Trendline | Price=${sf(projectedPrice,2)} | R²=${sf(trendline.r2,2)} | Touches=${trendline.touches} | Age=${Math.round(ageMs/3600000)}h | DistFromPrice=${sf(distanceFromPrice*100,2)}%`);

  let quality: "NOISE" | "WEAK" | "GOOD" | "EXCELLENT";

  if (trendline.r2 < 0.30) {
    quality = "NOISE";
    debug.push(`[TL] Trendline is noise: R² ${sf(trendline.r2,2)} < 0.30 — still valid for entry`);
  } else if (trendline.r2 < 0.50) {
    quality = "WEAK";
    debug.push(`[TL] WEAK TRENDLINE: R² ${sf(trendline.r2,2)} (0.30–0.50)`);
  } else if (trendline.r2 < 0.70) {
    quality = "GOOD";
    debug.push(`[TL] GOOD TRENDLINE: R² ${sf(trendline.r2,2)} (0.50–0.70)`);
  } else {
    quality = "EXCELLENT";
    debug.push(`[TL] EXCELLENT TRENDLINE: R² ${sf(trendline.r2,2)} ≥ 0.70 — strong structure`);
  }

  const maxDist = 0.05;
  if (Math.abs(distanceFromPrice) > maxDist) {
    debug.push(`[TL] REJECTED: Distance ${sf(Math.abs(distanceFromPrice)*100,2)}% > ${sf(maxDist*100,0)}% — trendline is stale`);
    debug.push(`[TL] Will recalculate fresh trendline on next cycle`);
    trendlineStore.delete(pair);
    return { trendline, isValid: false, reason: `Stale: ${sf(Math.abs(distanceFromPrice)*100,2)}% from price (max ${sf(maxDist*100,0)}%)`, quality: "NOISE", debug };
  }

  return { trendline, isValid: true, reason: `Valid | R²=${sf(trendline.r2,2)} | Touches=${trendline.touches} | Quality=${quality} | Dist=${sf(Math.abs(distanceFromPrice)*100,2)}%`, quality, debug };
}

// ============================================================
// RISK CALCULATION
// ============================================================
function calculateRisk(
  entry: number,
  stop: number,
  target: number,
  rawType: "ENTRY" | "ADD" | "FADE"
): RiskDiagnostics {
  const risk = Math.abs(entry - stop);
  const reward = Math.abs(target - entry);
  const rr = risk > 0 ? reward / risk : 0;
  const minRR = 1.5;
  const passes = rr >= minRR;

  const debug: string[] = [];
  debug.push(`[RISK] Entry=${sf(entry,2)} | Stop=${sf(stop,2)} | Target=${sf(target,2)}`);
  debug.push(`[RISK] Risk=${sf(risk,2)} | Reward=${sf(reward,2)} | RR=${sf(rr,2)} | MinRR=${minRR} | Passes=${passes}`);

  return { entry, stop, target, risk, reward, rr, minRR, passes, debug };
}

// ============================================================
// VOLUME CHECK
// ============================================================
function checkVolume(candles: Candle[], lookback = 10): { confirmed: boolean; ratio: number; debug: string[] } {
  const debug: string[] = [];
  if (candles.length < lookback + 2) {
    debug.push("[VOL] Insufficient data");
    return { confirmed: false, ratio: 0, debug };
  }
  const volumes = candles.map(c => c.volume);
  const avgVol = avg(volumes.slice(-lookback - 1, -1));
  const currentVol = volumes[volumes.length - 1];
  const ratio = avgVol > 0 ? currentVol / avgVol : 0;
  const confirmed = currentVol > avgVol * 1.3;
  debug.push(`[VOL] Current=${Math.round(currentVol)} | Avg${lookback}=${Math.round(avgVol)} | Ratio=${sf(ratio,2)} | Threshold=1.30 | Confirmed=${confirmed}`);
  return { confirmed, ratio, debug };
}

// ============================================================
// HYSTERESIS — Simple in-memory only (v28 style)
// ============================================================
interface HysteresisState {
  lastSignalType: "ENTRY" | "ADD" | "FADE" | null;
  lastSignalPrice: number;
  lockUntil: number;
}

const hysteresisStore: Map<string, HysteresisState> = new Map();

function getHysteresisSync(pair: string, now: number): HysteresisState {
  const state = hysteresisStore.get(pair);
  if (state && now <= state.lockUntil) {
    return state;
  }
  return { lastSignalType: null, lastSignalPrice: 0, lockUntil: 0 };
}

function setHysteresis(pair: string, type: "ENTRY" | "ADD" | "FADE", price: number, now: number): void {
  const lockDuration = type === "ADD" ? 4 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
  const state: HysteresisState = {
    lastSignalType: type,
    lastSignalPrice: price,
    lockUntil: now + lockDuration,
  };
  hysteresisStore.set(pair, state);
}

// ============================================================
// ENTRY DIAGNOSTICS — Trend Rider simplified
// ============================================================
function diagnoseEntry(
  pair: string,
  candles4h: Candle[],
  trend1d: TrendResult,
  trendlineEval: TrendlineEvaluation,
  stoch4h: { k: number; d: number },
  now: number
): EntryDiagnostics {
  const debug: string[] = [];

  const price = candles4h[candles4h.length - 1].close;
  const prev = candles4h[candles4h.length - 2];
  const last = candles4h[candles4h.length - 1];

  const tlPrice = trendlineEval.trendline?.projectedPrice ?? price;
  const dist = (price - tlPrice) / tlPrice;

  const alignment = calculateEMAAlignment(candles4h, trend1d.direction || "LONG");
  debug.push(...alignment.debug);

  const nearTrendline = Math.abs(dist) < 0.012;
  const stochExtreme = trend1d.direction === "LONG" ? stoch4h.k < 20 : stoch4h.k > 80;
  const stochTurning = trend1d.direction === "LONG" ? stoch4h.k > stoch4h.d : stoch4h.k < stoch4h.d;

  const beyondTrendline = trend1d.direction === "LONG" ? price > tlPrice * 1.008 : price < tlPrice * 0.992;
  const confirming = trend1d.direction === "LONG"
    ? last.close > last.open && last.close > prev.close
    : last.close < last.open && last.close < prev.close;

  const volCheck = checkVolume(candles4h);
  const volUp = volCheck.confirmed && volCheck.ratio > 1.3;
  debug.push(...volCheck.debug);

  const stochMomentum = trend1d.direction === "LONG" ? stoch4h.k > stoch4h.d : stoch4h.k < stoch4h.d;

  const adx4h = adx(candles4h) ?? 0;
  const adxStrong = adx4h > 20;
  debug.push(`[ADX] 4H ADX=${sf(adx4h,1)}`);

  debug.push(`[ENTRY] Conditions: nearTL=${nearTrendline} beyondTL=${beyondTrendline} stochExtreme=${stochExtreme} stochTurning=${stochTurning} confirming=${confirming} emaAligned=${alignment.aligned} volUp=${volUp} stochMomentum=${stochMomentum} adxStrong=${adxStrong}`);

  let rawType: "ENTRY" | "ADD" | "FADE" | null = null;
  let entryType: "PULLBACK" | "BREAKOUT" | "FADE" | null = null;

  // PULLBACK ENTRY: near trendline + stoch extreme
  if (nearTrendline && stochExtreme) {
    rawType = "ENTRY";
    entryType = "PULLBACK";
    debug.push("[ENTRY] PULLBACK: near TL + stoch extreme — best entry");
  }
  // BREAKOUT ENTRY: beyond TL + confirming + aligned + momentum
  else if (beyondTrendline && confirming && alignment.aligned) {
    const momentumCount = (volUp ? 1 : 0) + (stochMomentum ? 1 : 0) + (adxStrong ? 1 : 0);
    if (momentumCount >= 2) {
      rawType = "ADD";
      entryType = "BREAKOUT";
      debug.push(`[ENTRY] BREAKOUT: beyond TL + confirming + aligned + momentum [${momentumCount}/3]`);
    } else {
      debug.push(`[ENTRY] Beyond TL + confirming + aligned, but only ${momentumCount}/3 momentum`);
    }
  }
  // FADE ENTRY: stoch extreme opposite (counter-trend, only when 1D weak)
  else if (stochExtreme && !stochTurning && trend1d.strengthLabel === "WEAK") {
    rawType = "FADE";
    entryType = "FADE";
    debug.push("[ENTRY] FADE: stoch extreme + weak 1D trend — counter-trend fade");
  }
  else {
    const reasons: string[] = [];
    if (!nearTrendline && !beyondTrendline) reasons.push("far from TL");
    else if (nearTrendline) reasons.push("near TL");
    else reasons.push("beyond TL");
    if (!confirming) reasons.push("not confirming");
    if (!alignment.aligned) reasons.push("EMA misaligned");
    debug.push(`[ENTRY] No signal: ${reasons.join(", ")}`);
  }

  return {
    rawType,
    entryType,
    nearTrendline,
    beyondTrendline,
    stochExtreme,
    stochTurning,
    confirming,
    volUp,
    stochMomentum,
    adxStrong,
    emaAligned: alignment.aligned,
    trendline: trendlineEval,
    stoch4h,
    debug,
  };
}

// ============================================================
// SIGNAL GENERATION — Trend Rider v2
// One entry, one size, ride the trend
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
    debug.push(`[SIGNAL] Already active: ${active.id}`);
    return { debug };
  }

  // Simple hysteresis
  const hyst = getHysteresisSync(pair, now);
  if (hyst.lastSignalType) {
    const minutesLeft = Math.round((hyst.lockUntil - now) / 60000);
    debug.push(`[SIGNAL] Hysteresis lock: ${hyst.lastSignalType} | ${minutesLeft}min remaining`);
    return { debug };
  }

  // Cooldown after any exit
  const recentAnyExit = activeSignals.filter(s =>
    s.pair === pair && s.exited && (now - (s.exitTimestamp || s.timestamp)) < 60 * 60 * 1000
  );
  if (recentAnyExit.length > 0) {
    const lastExitTime = Math.max(...recentAnyExit.map(s => s.exitTimestamp || s.timestamp));
    const minutesSince = Math.round((now - lastExitTime) / 60000);
    debug.push(`[SIGNAL] Cooldown: ${minutesSince}min since last exit, ${60 - minutesSince}min remaining`);
    return { debug };
  }

  if (candles4h.length < 50 || candles1h.length < 30 || candles1d.length < 50) {
    debug.push(`[SIGNAL] Insufficient data: 4H=${candles4h.length} 1H=${candles1h.length} 1D=${candles1d.length}`);
    return { debug };
  }

  const price = currentPrice ?? candles4h[candles4h.length - 1].close;

  // 1D trend = our bias. Only trade in this direction.
  const trend1d = calculateTrend1D(candles1d);
  debug.push(...trend1d.debug);

  if (!trend1d.direction) {
    debug.push("[SIGNAL] No valid 1D trend — ranging market, no trade");
    return { debug };
  }

  // Skip if 1D ADX too low (ranging market)
  if (trend1d.adx !== null && trend1d.adx < 20) {
    debug.push(`[SIGNAL] 1D ADX ${trend1d.adx} < 20 — ranging market, no trade`);
    return { debug };
  }

  // 4H trend should align with 1D
  const trend4h = calculateTrend4H(candles4h);
  debug.push(...trend4h.debug);

  const timeframesAligned = trend1d.direction === trend4h.direction;
  if (timeframesAligned) {
    debug.push(`[SIGNAL] 1D/4H aligned: ${trend1d.direction} | Full confidence`);
  } else {
    debug.push(`[SIGNAL] 1D/4H conflict: 1D=${trend1d.direction} 4H=${trend4h.direction} | Reduced confidence, still trading 1D`);
  }

  const entryDirection = trend1d.direction;

  // Trendline for entry timing
  const trendlineEval = evaluateTrendline(pair, candles4h, entryDirection, now);
  debug.push(...trendlineEval.debug);

  // StochRSI for pullback detection
  const closes4h = candles4h.map(c => c.close);
  const stoch4h = stochRsi(closes4h);
  debug.push(`[SIGNAL] 4H Stoch K=${stoch4h.k} D=${stoch4h.d}`);

  const pullback = checkPullback(entryDirection, stoch4h);
  debug.push(...pullback.debug);

  if (!pullback.pullbackActive) {
    debug.push("[SIGNAL] No pullback active — waiting for 4H stoch to enter zone");
    return { debug };
  }

  // Entry diagnostics
  const entryDiag = diagnoseEntry(pair, candles4h, trend1d, trendlineEval, stoch4h, now);
  debug.push(...entryDiag.debug);

  if (!entryDiag.rawType || !entryDiag.entryType) {
    debug.push("[SIGNAL] No entry type determined");
    return { debug };
  }

  setHysteresis(pair, entryDiag.rawType, price, now);

  // Levels
  const atr4h = atr(candles4h, 14);
  const swingLows = candles4h.map(c => c.low).slice(-20);
  const swingHighs = candles4h.map(c => c.high).slice(-20);
  const swingLow = Math.min(...swingLows);
  const swingHigh = Math.max(...swingHighs);
  const tlPrice = trendlineEval.trendline?.projectedPrice ?? price;

  let entry = price;
  let stop: number;
  let target: number;
  let confidence = 50;
  let positionSizePct = 0.02; // 2% risk fixed

  // Stop: ATR × 2, capped at 5%
  const maxStopPct = 0.05;
  if (entryDirection === "LONG") {
    const atrStop = entry - atr4h * 2;
    const pctStop = entry * (1 - maxStopPct);
    stop = Math.max(atrStop, pctStop, swingLow);
    target = entry + (entry - stop) * 3; // 3R minimum target
  } else {
    const atrStop = entry + atr4h * 2;
    const pctStop = entry * (1 + maxStopPct);
    stop = Math.min(atrStop, pctStop, swingHigh);
    target = entry - (stop - entry) * 3;
  }

  // Confidence boosters
  if (entryDiag.entryType === "PULLBACK") confidence = 70;
  if (entryDiag.entryType === "BREAKOUT") confidence = 60;
  if (entryDiag.entryType === "FADE") confidence = 45;
  if (timeframesAligned) confidence += 15;
  if (trend1d.strengthLabel === "STRONG") confidence += 10;
  if (entryDiag.volUp) confidence += 5;
  confidence = Math.min(95, Math.max(30, Math.round(confidence)));

  const riskDiag = calculateRisk(entry, stop, target, entryDiag.rawType);
  debug.push(...riskDiag.debug);

  if (!riskDiag.passes) {
    debug.push(`[SIGNAL] REJECTED: RR ${sf(riskDiag.rr,2)} < ${riskDiag.minRR}`);
    return { debug };
  }

  const signal: Signal = {
    id: `${pair}_${now}`,
    pair,
    direction: entryDirection,
    entry: Math.round(entry * 100) / 100,
    stop: Math.round(stop * 100) / 100,
    target: Math.round(target * 100) / 100,
    confidence: Math.round(confidence),
    timestamp: now,
    exited: false,
    entryType: entryDiag.entryType,
    trendlinePrice: Math.round(tlPrice * 100) / 100,
    volumeConfirmed: entryDiag.volUp,
    type: entryDiag.rawType === "ADD" ? "BREAKOUT" : "ACCUMULATE",
    scale: entryDiag.rawType === "ENTRY" ? "ENTRY" : entryDiag.rawType,
    entryTier: entryDiag.entryType === "PULLBACK" ? "PULLBACK_ENTRY" : entryDiag.entryType === "BREAKOUT" ? "BREAKOUT_ENTRY" : "FADE_ENTRY",
    entryMode: entryDiag.entryType,
    positionSizePct,
    regimeDirection: entryDirection,
    conflictEntry: !timeframesAligned,
    entryTimeframe: "4H",
    rr: Math.round(riskDiag.rr * 100) / 100,
    adx: trend1d.adx !== null ? Math.round(trend1d.adx * 10) / 10 : undefined,
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

  debug.push(`[SIGNAL] ═══════════════════════════════════════`);
  debug.push(`[SIGNAL] ENTRY ACCEPTED: ${entryDiag.entryType} ${entryDirection} ${pair}`);
  debug.push(`[SIGNAL] Entry=$${sf(entry,2)} | Stop=$${sf(stop,2)} | Target=$${sf(target,2)}`);
  debug.push(`[SIGNAL] Risk=$${sf(riskDiag.risk,2)} | Reward=$${sf(riskDiag.reward,2)} | RR=${sf(riskDiag.rr,2)}`);
  debug.push(`[SIGNAL] Conf=${confidence}% | Size=${(positionSizePct*100).toFixed(0)}% | 1D ADX=${trend1d.adx?.toFixed(1) || "N/A"}`);
  debug.push(`[SIGNAL] Trendline: R²=${trendlineEval.trendline?.r2} | Quality=${trendlineEval.quality} | Dist=${trendlineEval.trendline?.distanceFromPrice}%`);
  debug.push(`[SIGNAL] ═══════════════════════════════════════`);

  return { signal, debug };
}

// ============================================================
// EXIT LOGIC — Trend Rider: Only 3 exits
// 1. Stop loss hit
// 2. 1D trend reversed (EMA8 crosses EMA21)
// 3. Trailing stop once in 2R profit
// NO stoch exits, NO profit locks, NO 4H structure exits
// ============================================================
export function shouldHold(
  signal: Signal,
  candles4h: Candle[],
  candles1d: Candle[],
  candles1h: Candle[],
  currentPrice: number
): HoldResult {
  const now = Date.now();
  const debug: string[] = [];

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

  debug.push(`[HOLD] ${signal.pair} ${signal.direction} | Price=${sf(currentPrice,2)} | R=${sf(currentR,2)}`);
  debug.push(`[HOLD] Highest=${sf(newHighest,2)} | Lowest=${sf(newLowest,2)}`);

  // 1. HARD STOP
  if (signal.direction === "LONG" && currentPrice <= signal.stop) {
    debug.push(`[HOLD] EXIT: Stop loss hit | Price=${sf(currentPrice,2)} <= Stop=${sf(signal.stop,2)}`);
    return { shouldHold: false, reason: "stop_loss", updatedTradeState: { ...updatedState, phase: "EXIT" } };
  }
  if (signal.direction === "SHORT" && currentPrice >= signal.stop) {
    debug.push(`[HOLD] EXIT: Stop loss hit | Price=${sf(currentPrice,2)} >= Stop=${sf(signal.stop,2)}`);
    return { shouldHold: false, reason: "stop_loss", updatedTradeState: { ...updatedState, phase: "EXIT" } };
  }

  // 2. TARGET HIT (optional - can remove if you want to ride forever)
  if (signal.direction === "LONG" && currentPrice >= signal.target) {
    debug.push(`[HOLD] EXIT: Target hit | Price=${sf(currentPrice,2)} >= Target=${sf(signal.target,2)}`);
    return { shouldHold: false, reason: "target_hit", updatedTradeState: { ...updatedState, phase: "EXIT" } };
  }
  if (signal.direction === "SHORT" && currentPrice <= signal.target) {
    debug.push(`[HOLD] EXIT: Target hit | Price=${sf(currentPrice,2)} <= Target=${sf(signal.target,2)}`);
    return { shouldHold: false, reason: "target_hit", updatedTradeState: { ...updatedState, phase: "EXIT" } };
  }

  // 3. 1D TREND REVERSAL (the big one)
  if (candles1d && candles1d.length >= 50) {
    const trend = calculateTrend1D(candles1d);
    if (trend.direction && trend.direction !== signal.direction) {
      debug.push(`[HOLD] 1D trend reversed: ${signal.direction} -> ${trend.direction} | ADX=${trend.adx?.toFixed(1) || "N/A"}`);
      return { shouldHold: false, reason: "1d_trend_reversed", updatedTradeState: { ...updatedState, phase: "EXIT" } };
    }
  }

  // 4. TRAILING STOP (only once in 2R profit)
  let newLockedStop = ts.lockedStop;
  if (currentR >= 2 && !ts.lockedStop) {
    // Set trailing stop at 1.5x ATR behind highest/lowest price
    const atr4h = atr(candles4h, 14);
    if (signal.direction === "LONG") {
      newLockedStop = newHighest - atr4h * 1.5;
    } else {
      newLockedStop = newLowest + atr4h * 1.5;
    }
    debug.push(`[HOLD] Trailing stop activated at ${sf(newLockedStop,2)} (2R reached)`);
  }

  if (newLockedStop) {
    if (signal.direction === "LONG" && currentPrice <= newLockedStop) {
      debug.push(`[HOLD] EXIT: Trailing stop hit | Price=${sf(currentPrice,2)} <= Trail=${sf(newLockedStop,2)}`);
      return { shouldHold: false, reason: "trailing_stop", updatedTradeState: { ...updatedState, phase: "EXIT", lockedStop: newLockedStop } };
    }
    if (signal.direction === "SHORT" && currentPrice >= newLockedStop) {
      debug.push(`[HOLD] EXIT: Trailing stop hit | Price=${sf(currentPrice,2)} >= Trail=${sf(newLockedStop,2)}`);
      return { shouldHold: false, reason: "trailing_stop", updatedTradeState: { ...updatedState, phase: "EXIT", lockedStop: newLockedStop } };
    }
  }

  // Update phase
  let newPhase: TradeLifecyclePhase = ts.phase;
  if (currentR >= 2 && newPhase === "BUILDING") newPhase = "TREND";
  if (currentR >= 1 && newPhase === "ENTRY") newPhase = "BUILDING";

  const finalState: TradeState = {
    ...updatedState, phase: newPhase,
    lockedStop: newLockedStop,
  };

  debug.push(`[HOLD] HOLDING: phase=${newPhase} | R=${sf(currentR,2)} | Trail=${newLockedStop ? sf(newLockedStop,2) : "none"}`);

  return { shouldHold: true, reason: `holding_${newPhase.toLowerCase()}_R${currentR.toFixed(1)}`, updatedTradeState: finalState };
}

// ============================================================
// VALIDITY CHECKS
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
// MARKET SNAPSHOT — Fixed and simplified
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

  const trend1d = calculateTrend1D(candles1d);
  const trend4h = calculateTrend4H(candles4h);
  const entryDirection = trend1d.direction;
  const alignment = trend1d.direction ? calculateEMAAlignment(candles4h, trend1d.direction) : { aligned: false, priceAboveEMA8: false, priceAboveEMA21: false, ema8AboveEMA21: false, price: 0, ema8: 0, ema21: 0, debug: [] };

  const stoch4h = candles4h.length >= 50 ? stochRsi(candles4h.map(c => c.close)) : { k: 50, d: 50 };
  const stoch1h = candles1h.length >= 30 ? stochRsi(candles1h.map(c => c.close)) : { k: 50, d: 50 };
  const stoch15m = candles15m.length >= 20 ? stochRsi(candles15m.map(c => c.close)) : { k: 50, d: 50 };

  const volCheck = candles4h.length >= 12 ? checkVolume(candles4h) : { confirmed: false, ratio: 0, debug: [] };

  const pullback = trend1d.direction ? checkPullback(trend1d.direction, stoch4h) : { pullbackActive: false, reason: "No bias", tier: null, stochZone: "NEUTRAL", debug: [] };

  const adxVal = adx(candles4h) ?? 0;
  const rsiVal = wilderRsi(candles4h.map(c => c.close));

  let readiness = 0;
  if (trend1d.direction) readiness += 25;
  if (trend1d.strength >= 50) readiness += 15;
  if (pullback.pullbackActive) {
    if (pullback.tier === "DEEP") readiness += 30;
    else if (pullback.tier === "SHALLOW") readiness += 20;
    else if (pullback.tier === "MOMENTUM") readiness += 10;
  }
  if (alignment.aligned) readiness += 15;
  if (adxVal >= 25) readiness += 10;
  if (volCheck.confirmed) readiness += 5;
  if (signalResult?.signal) readiness += 15;
  readiness = Math.min(100, readiness);

  let readinessLabel = "NO_TRADE";
  if (readiness >= 80) readinessLabel = "READY";
  else if (readiness >= 60) readinessLabel = "WARM";
  else if (readiness >= 40) readinessLabel = "WATCH";

  const allDebug: string[] = [
    ...trend1d.debug,
    ...trend4h.debug,
    ...alignment.debug,
    ...pullback.debug,
    ...volCheck.debug,
  ];
  if (signalResult?.debug) allDebug.push(...signalResult.debug);

  return {
    pair,
    price: Math.round(price * 100) / 100,
    timestamp: Date.now(),
    bias: trend1d.direction ? { direction: entryDirection, strength: trend1d.strength } : null,
    trend1d: trend1d.direction ? { direction: entryDirection, strength: trend1d.strengthLabel } : null,
    trend4h: trend4h.direction ? { direction: trend4h.direction, strength: trend4h.strengthLabel } : null,
    trend1h: trend1d.direction ? { direction: entryDirection, strength: trend1d.strengthLabel } : null,
    stoch4h,
    stoch1h,
    stoch15m,
    volumeConfirmed: volCheck.confirmed,
    trendDirection: trend1d.direction,
    trendStrength: trend1d.strength,
    trendStrengthLabel: trend1d.strengthLabel,
    isPullback: pullback.pullbackActive,
    pullbackTier: pullback.tier,
    pullbackReason: pullback.reason,
    stochZone: pullback.stochZone,
    readiness,
    readinessLabel,
    adx: Math.round(adxVal * 10) / 10,
    trend: trend1d.direction ? `${trend1d.direction} ${trend1d.strengthLabel}` : "NONE",
    regime: {
      direction: entryDirection,
      strength: trend1d.strengthLabel,
      confidence: trend1d.direction ? (trend1d.strength > 50 ? 75 : 50) : 0
    },
    rsi: Math.round((rsiVal ?? 50) * 10) / 10,
    stochK: stoch4h.k,
    stochD: stoch4h.d,
    stoch1hK: stoch1h.k,
    stoch1hD: stoch1h.d,
    ema21: Math.round(alignment.ema21 * 100) / 100,
    distToEMA21: alignment.ema21 > 0 ? Math.round((price - alignment.ema21) / alignment.ema21 * 10000) / 100 : 0,
    emaAligned: alignment.aligned,
    recommendedAction: signalResult?.signal ? `${signalResult.signal.direction} ${signalResult.signal.entryType}` : null,
    entryTier: signalResult?.signal ? (signalResult.signal.entryType === "PULLBACK" ? "PULLBACK_ENTRY" : signalResult.signal.entryType === "BREAKOUT" ? "BREAKOUT_ENTRY" : "FADE_ENTRY") : null,
    entryMode: signalResult?.signal ? (signalResult.signal.entryType === "PULLBACK" ? "PULLBACK" : signalResult.signal.entryType === "BREAKOUT" ? "BREAKOUT" : "FADE") : null,
    positionSize: signalResult?.signal ? (signalResult.signal.positionSizePct ? (signalResult.signal.positionSizePct * 100).toFixed(0) + "%" : null) : null,
    signal: signalResult?.signal || null,
    summary: { status: signalResult?.signal ? "READY" : "WATCH", debug: allDebug },
    activeTrade: null,
    debug: allDebug,
  };
}


// ============================================================
// REDIS HELPERS — No-op for compatibility (v38 feature removed)
// ============================================================
export function setRedisHelpers(
  _getFn?: <T>(key: string) => Promise<T | null>,
  _setFn?: (key: string, value: any) => Promise<void>
): void {
  // Trend Rider v2 uses in-memory hysteresis only
  // Redis persistence removed for simplicity
}

// ============================================================
// COMPATIBILITY EXPORTS (all preserved for existing connections)
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
