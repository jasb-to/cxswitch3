// ============================================================
// CXSwitch v38.7 — "Setup Detector" (v28 entry logic + v38.5 risk mgmt)
// Entry: v28 logic — near TL + stoch for ENTRY_1/2, momentum for ADD
// Exit: v38.5 full lifecycle (stop trail, profit locks, phases)
// Trendline: 3+ pivots, any R² (logged, not gated)
// ADX: 4H only >20 for ADD momentum. 1D ADX for strength label only.
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
  rawType: "ENTRY_1" | "ENTRY_2" | "ADD" | null;
  entryType: "EARLY" | "BREAKOUT" | "RETEST" | null;
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

function sf(v: number, d: number): string {
  return isValid(v) ? v.toFixed(d) : "0";
}

// ============================================================
// CANONICAL EMA CALCULATION
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
// CANONICAL 1D TREND — EMA8 vs EMA21 (v28: direction only, no ADX gating)
// ============================================================
export function calculateTrend1D(candles1d: Candle[]): TrendResult {
  const debug: string[] = [];

  if (candles1d.length < 50) {
    debug.push("[TREND] Insufficient 1D data (< 50 candles)");
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
    debug.push("[TREND] EMA calculation failed");
    return {
      direction: null, strength: 0, strengthLabel: "WEAK",
      adx: null, ema8: 0, ema21: 0, ema50: 0, price: 0, debug
    };
  }

  const ema8 = e8[e8.length - 1];
  const ema21 = e21[e21.length - 1];
  const ema50 = e50[e50.length - 1];

  const direction: "LONG" | "SHORT" | null = ema8 > ema21 ? "LONG" : "SHORT";

  let strength = 50;
  let strengthLabel: "STRONG" | "MEDIUM" | "WEAK" = "MEDIUM";

  const highs = candles1d.slice(-20).map(c => c.high);
  const lows = candles1d.slice(-20).map(c => c.low);
  const hh = highs[highs.length - 1] > Math.max(...highs.slice(0, -1));
  const ll = lows[lows.length - 1] < Math.min(...lows.slice(0, -1));

  if (direction === "LONG" && hh) {
    strength = 80; strengthLabel = "STRONG";
  } else if (direction === "SHORT" && ll) {
    strength = 80; strengthLabel = "STRONG";
  }

  debug.push(`[TREND] 1D ${direction} ${strengthLabel} | Price=${sf(price,2)} EMA8=${sf(ema8,2)} EMA21=${sf(ema21,2)} EMA50=${sf(ema50,2)}`);

  const adxVal = adx(candles1d);
  if (adxVal !== null) {
    debug.push(`[TREND] 1D ADX=${sf(adxVal,1)} (informational)`);
  }

  return { direction, strength, strengthLabel, adx: adxVal, ema8, ema21, ema50, price, debug };
}

// ============================================================
// CANONICAL 4H EMA ALIGNMENT (v28: used for ADD only, not ENTRY_1/2)
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
// CANONICAL 4H TREND (dashboard display only)
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

  const adxVal = adx(candles4h);
  if (adxVal !== null) {
    if (adxVal >= 30 && strengthLabel !== "WEAK") strengthLabel = "STRONG";
    else if (adxVal >= 20 && strengthLabel === "WEAK") strengthLabel = "MEDIUM";
    debug.push(`[TREND4H] ${direction} ${strengthLabel} | ADX=${sf(adxVal,1)} | Price=${sf(price,2)} EMA8=${sf(ema8,2)} EMA21=${sf(ema21,2)}`);
  } else {
    debug.push(`[TREND4H] ${direction} ${strengthLabel} | Price=${sf(price,2)} EMA8=${sf(ema8,2)} EMA21=${sf(ema21,2)}`);
  }

  return { direction, strengthLabel, adx: adxVal, debug };
}

// ============================================================
// CANONICAL PULLBACK CHECK (v28 thresholds preserved)
// ============================================================
function checkPullbackAdaptive(
  biasDirection: "LONG" | "SHORT" | null,
  stoch4h: { k: number; d: number },
  prevStoch4h: { k: number; d: number },
  adxVal: number | null,
  isStrongTrend: boolean
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

  const crossUp = prevStoch4h.k <= prevStoch4h.d && stoch4h.k > stoch4h.d;
  const crossDown = prevStoch4h.k >= prevStoch4h.d && stoch4h.k < stoch4h.d;

  debug.push(`[PULLBACK] Stoch K=${stoch4h.k} D=${stoch4h.d} | CrossUp=${crossUp} CrossDown=${crossDown} | StrongTrend=${isStrongTrend}`);

  if (isStrongTrend) {
    if (biasDirection === "LONG") {
      if (stoch4h.k < 20) {
        debug.push("[PULLBACK] STRONG LONG DEEP: Stoch < 20 (extreme oversold)");
        return { pullbackActive: true, tier: "DEEP", reason: `STRONG TREND DEEP: 4H Stoch extreme oversold (${stoch4h.k})`, stochZone: "EXTREME", debug };
      }
      if (stoch4h.k < 35) {
        debug.push("[PULLBACK] STRONG LONG SHALLOW: Stoch < 35 (oversold)");
        return { pullbackActive: true, tier: "SHALLOW", reason: `STRONG TREND SHALLOW: 4H Stoch oversold (${stoch4h.k})`, stochZone: "ZONE", debug };
      }
      if (stoch4h.k < 50) {
        debug.push("[PULLBACK] STRONG LONG MOMENTUM: Stoch < 50 (neutral)");
        return { pullbackActive: true, tier: "MOMENTUM", reason: `STRONG TREND MOMENTUM: 4H Stoch ${stoch4h.k}`, stochZone: "NEUTRAL", debug };
      }
      debug.push("[PULLBACK] STRONG LONG EXTENDED: Stoch >= 50");
      return { pullbackActive: false, tier: null, reason: `STRONG LONG: extended — 4H Stoch ${stoch4h.k} (need <50)`, stochZone: "EXTENDED", debug };
    }
    if (biasDirection === "SHORT") {
      if (stoch4h.k > 80) {
        debug.push("[PULLBACK] STRONG SHORT DEEP: Stoch > 80 (extreme overbought)");
        return { pullbackActive: true, tier: "DEEP", reason: `STRONG TREND DEEP: 4H Stoch extreme overbought (${stoch4h.k})`, stochZone: "EXTREME", debug };
      }
      if (stoch4h.k > 65) {
        debug.push("[PULLBACK] STRONG SHORT SHALLOW: Stoch > 65 (overbought)");
        return { pullbackActive: true, tier: "SHALLOW", reason: `STRONG TREND SHALLOW: 4H Stoch overbought (${stoch4h.k})`, stochZone: "ZONE", debug };
      }
      if (stoch4h.k > 50) {
        debug.push("[PULLBACK] STRONG SHORT MOMENTUM: Stoch > 50 (neutral)");
        return { pullbackActive: true, tier: "MOMENTUM", reason: `STRONG TREND MOMENTUM: 4H Stoch ${stoch4h.k}`, stochZone: "NEUTRAL", debug };
      }
      debug.push("[PULLBACK] STRONG SHORT EXTENDED: Stoch <= 50");
      return { pullbackActive: false, tier: null, reason: `STRONG SHORT: extended — 4H Stoch ${stoch4h.k} (need >50)`, stochZone: "EXTENDED", debug };
    }
  }

  if (biasDirection === "LONG") {
    if (stoch4h.k < 20) {
      if (crossUp) {
        debug.push("[PULLBACK] LONG DEEP: Stoch < 20 + cross up");
        return { pullbackActive: true, tier: "DEEP", reason: `DEEP pullback: 4H Stoch cross up from extreme oversold (${stoch4h.k})`, stochZone: "EXTREME", debug };
      }
      debug.push("[PULLBACK] LONG DEEP forming: Stoch < 20, waiting for cross up");
      return { pullbackActive: false, tier: null, reason: `LONG deep pullback forming: 4H Stoch extreme oversold (${stoch4h.k}), waiting for cross up`, stochZone: "EXTREME", debug };
    }
    if (stoch4h.k < 35) {
      if (crossUp) {
        debug.push("[PULLBACK] LONG SHALLOW: Stoch < 35 + cross up");
        return { pullbackActive: true, tier: "SHALLOW", reason: `SHALLOW pullback: 4H Stoch cross up from oversold (${stoch4h.k})`, stochZone: "ZONE", debug };
      }
      debug.push("[PULLBACK] LONG SHALLOW forming: Stoch < 35, waiting for cross up");
      return { pullbackActive: false, tier: null, reason: `LONG shallow pullback forming: 4H Stoch oversold (${stoch4h.k}), waiting for cross up`, stochZone: "ZONE", debug };
    }
    if (stoch4h.k < 50) {
      debug.push("[PULLBACK] LONG MOMENTUM: Stoch < 50");
      return { pullbackActive: true, tier: "MOMENTUM", reason: `MOMENTUM zone: 4H Stoch ${stoch4h.k}`, stochZone: "NEUTRAL", debug };
    }
    debug.push("[PULLBACK] LONG EXTENDED: Stoch >= 50");
    return { pullbackActive: false, tier: null, reason: `LONG: extended — 4H Stoch ${stoch4h.k} (need <50)`, stochZone: "EXTENDED", debug };
  }

  if (biasDirection === "SHORT") {
    if (stoch4h.k > 80) {
      if (crossDown) {
        debug.push("[PULLBACK] SHORT DEEP: Stoch > 80 + cross down");
        return { pullbackActive: true, tier: "DEEP", reason: `DEEP pullback: 4H Stoch cross down from extreme overbought (${stoch4h.k})`, stochZone: "EXTREME", debug };
      }
      debug.push("[PULLBACK] SHORT DEEP forming: Stoch > 80, waiting for cross down");
      return { pullbackActive: false, tier: null, reason: `SHORT deep pullback forming: 4H Stoch extreme overbought (${stoch4h.k}), waiting for cross down`, stochZone: "EXTREME", debug };
    }
    if (stoch4h.k > 65) {
      if (crossDown) {
        debug.push("[PULLBACK] SHORT SHALLOW: Stoch > 65 + cross down");
        return { pullbackActive: true, tier: "SHALLOW", reason: `SHALLOW pullback: 4H Stoch cross down from overbought (${stoch4h.k})`, stochZone: "ZONE", debug };
      }
      debug.push("[PULLBACK] SHORT SHALLOW forming: Stoch > 65, waiting for cross down");
      return { pullbackActive: false, tier: null, reason: `SHORT shallow pullback forming: 4H Stoch overbought (${stoch4h.k}), waiting for cross down`, stochZone: "ZONE", debug };
    }
    if (stoch4h.k > 50) {
      debug.push("[PULLBACK] SHORT MOMENTUM: Stoch > 50");
      return { pullbackActive: true, tier: "MOMENTUM", reason: `MOMENTUM zone: 4H Stoch ${stoch4h.k}`, stochZone: "NEUTRAL", debug };
    }
    debug.push("[PULLBACK] SHORT EXTENDED: Stoch <= 50");
    return { pullbackActive: false, tier: null, reason: `SHORT: extended — 4H Stoch ${stoch4h.k} (need >50)`, stochZone: "EXTENDED", debug };
  }

  return { pullbackActive: false, tier: null, reason: "Unknown bias", stochZone: "NEUTRAL", debug };
}

// ============================================================
// CANONICAL TRENDLINE SYSTEM (v28: 3+ pivots, any R², R² never gates)
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

  const pivots = findPivotsV28(candles, direction);
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
// CANONICAL RISK CALCULATION (v28: no RR gate for ENTRY_1/2)
// ============================================================
function calculateRisk(
  entry: number,
  stop: number,
  target: number,
  rawType: "ENTRY_1" | "ENTRY_2" | "ADD"
): RiskDiagnostics {
  const risk = Math.abs(entry - stop);
  const reward = Math.abs(target - entry);
  const rr = risk > 0 ? reward / risk : 0;
  const minRR = rawType === "ADD" ? 1.5 : 0;
  const passes = rawType === "ADD" ? rr >= minRR : true;

  const debug: string[] = [];
  debug.push(`[RISK] Entry=${sf(entry,2)} | Stop=${sf(stop,2)} | Target=${sf(target,2)}`);
  debug.push(`[RISK] Risk=${sf(risk,2)} | Reward=${sf(reward,2)} | RR=${sf(rr,2)} | MinRR=${minRR} | Passes=${passes}`);

  return { entry, stop, target, risk, reward, rr, minRR, passes, debug };
}

// ============================================================
// CANONICAL VOLUME CHECK (v28: only for ADD)
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
// HYSTERESIS (v28 feature — v38.7: Redis-backed with cold-start fallback)
// ============================================================

interface HysteresisState {
  lastSignalType: "ENTRY_1" | "ENTRY_2" | "ADD" | null;
  lastSignalPrice: number;
  lockUntil: number;
}

const hysteresisStore: Map<string, HysteresisState> = new Map();

// v38.7: Redis helpers for cross-instance hysteresis persistence
let _redisGet: (<T>(key: string) => Promise<T | null>) | null = null;
let _redisSet: ((key: string, value: any) => Promise<void>) | null = null;

/**
 * Set Redis helpers for cross-instance hysteresis persistence.
 * Call this once in your cron handler before processing pairs.
 * If you don't have Redis, the activeSignals fallback still prevents double entries.
 */
export function setRedisHelpers(
  getFn: <T>(key: string) => Promise<T | null>,
  setFn: (key: string, value: any) => Promise<void>
): void {
  _redisGet = getFn;
  _redisSet = setFn;
}

const HYSTERESIS_REDIS_PREFIX = "hysteresis:";

async function getHysteresisFromRedis(pair: string, now: number): Promise<HysteresisState | null> {
  if (!_redisGet) return null;
  try {
    const key = `${HYSTERESIS_REDIS_PREFIX}${pair}`;
    const data = await _redisGet<string>(key);
    if (!data) return null;
    const parsed = JSON.parse(data) as HysteresisState;
    if (parsed.lockUntil > now) {
      hysteresisStore.set(pair, parsed);
      return parsed;
    }
    return null;
  } catch (e) {
    console.warn(`[HYSTERESIS] Redis read failed for ${pair}:`, e);
    return null;
  }
}

async function setHysteresisToRedis(pair: string, state: HysteresisState): Promise<void> {
  if (!_redisSet) return;
  try {
    const key = `${HYSTERESIS_REDIS_PREFIX}${pair}`;
    await _redisSet(key, JSON.stringify(state));
  } catch (e) {
    console.warn(`[HYSTERESIS] Redis write failed for ${pair}:`, e);
  }
}

/**
 * v38.7: Check hysteresis with cold-start fallback.
 * 
 * In serverless environments (Vercel), the in-memory hysteresisStore
 * is lost on cold starts. We fall back to:
 * 1. Redis (if configured via setRedisHelpers)
 * 2. Active signals array (always available)
 */
function getHysteresisSync(
  pair: string,
  now: number,
  activeSignals: Signal[] = []
): HysteresisState {
  // 1. Check in-memory store first (fast path)
  const state = hysteresisStore.get(pair);
  if (state && now <= state.lockUntil) {
    return state;
  }

  // 2. Cold-start fallback: check active signals for recent ENTRY_1/2
  const recentEntry = activeSignals.find(s =>
    s.pair === pair &&
    !s.exited &&
    (s.scale === "ENTRY_1" || s.scale === "ENTRY_2") &&
    (now - s.timestamp) < 24 * 60 * 60 * 1000
  );
  if (recentEntry) {
    const lockUntil = recentEntry.timestamp + 24 * 60 * 60 * 1000;
    const rehydrated: HysteresisState = {
      lastSignalType: recentEntry.scale as "ENTRY_1" | "ENTRY_2",
      lastSignalPrice: recentEntry.entry,
      lockUntil,
    };
    hysteresisStore.set(pair, rehydrated);
    return rehydrated;
  }

  return { lastSignalType: null, lastSignalPrice: 0, lockUntil: 0 };
}

async function getHysteresisAsync(
  pair: string,
  now: number,
  activeSignals: Signal[] = []
): Promise<HysteresisState> {
  const mem = hysteresisStore.get(pair);
  if (mem && now <= mem.lockUntil) return mem;

  const fromRedis = await getHysteresisFromRedis(pair, now);
  if (fromRedis) return fromRedis;

  return getHysteresisSync(pair, now, activeSignals);
}

function setHysteresis(pair: string, type: "ENTRY_1" | "ENTRY_2" | "ADD", price: number, now: number): void {
  const lockDuration = type === "ADD" ? 4 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
  const state: HysteresisState = {
    lastSignalType: type,
    lastSignalPrice: price,
    lockUntil: now + lockDuration,
  };
  hysteresisStore.set(pair, state);
  setHysteresisToRedis(pair, state);
}

// ============================================================
// CANONICAL ENTRY DIAGNOSTICS (v28: setup detector logic)
// ENTRY_1/2: near TL + stoch only. ADD: momentum filters.
// ============================================================
function diagnoseEntry(
  pair: string,
  candles4h: Candle[],
  trend: TrendResult,
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

  const alignment = calculateEMAAlignment(candles4h, trend.direction || "LONG");
  debug.push(...alignment.debug);

  const nearTrendline = Math.abs(dist) < 0.012;
  const stochExtreme = trend.direction === "LONG" ? stoch4h.k < 20 : stoch4h.k > 80;
  const stochTurning = trend.direction === "LONG" ? stoch4h.k > stoch4h.d : stoch4h.k < stoch4h.d;

  const beyondTrendline = trend.direction === "LONG" ? price > tlPrice * 1.008 : price < tlPrice * 0.992;
  const confirming = trend.direction === "LONG"
    ? last.close > last.open && last.close > prev.close
    : last.close < last.open && last.close < prev.close;

  const volCheck = checkVolume(candles4h);
  const volUp = volCheck.confirmed && volCheck.ratio > 1.3;
  debug.push(...volCheck.debug);

  const stochMomentum = trend.direction === "LONG" ? stoch4h.k > stoch4h.d : stoch4h.k < stoch4h.d;

  const adx4h = adx(candles4h) ?? 0;
  const adxStrong = adx4h > 20;
  debug.push(`[ADX] 4H ADX=${sf(adx4h,1)} (threshold=20 for ADD momentum)`);

  debug.push(`[ENTRY] Conditions: nearTL=${nearTrendline} beyondTL=${beyondTrendline} stochExtreme=${stochExtreme} stochTurning=${stochTurning} confirming=${confirming} emaAligned=${alignment.aligned} volUp=${volUp} stochMomentum=${stochMomentum} adxStrong=${adxStrong}`);

  let rawType: "ENTRY_1" | "ENTRY_2" | "ADD" | null = null;
  let entryType: "EARLY" | "BREAKOUT" | "RETEST" | null = null;

  if (nearTrendline && stochExtreme) {
    rawType = "ENTRY_1";
    entryType = "RETEST";
    debug.push("[ENTRY] RAW ENTRY_1: near TL + stoch extreme (no volume/ADX/EMA required)");
  } else if (nearTrendline && stochTurning && !stochExtreme) {
    rawType = "ENTRY_2";
    entryType = "BREAKOUT";
    debug.push("[ENTRY] RAW ENTRY_2: near TL + stoch turning (no volume/ADX/EMA required)");
  } else if (beyondTrendline && confirming && alignment.aligned) {
    const momentumCount = (volUp ? 1 : 0) + (stochMomentum ? 1 : 0) + (adxStrong ? 1 : 0);
    if (momentumCount >= 2) {
      rawType = "ADD";
      entryType = "EARLY";
      const momentumParts: string[] = [];
      if (volUp) momentumParts.push("vol");
      if (stochMomentum) momentumParts.push("stoch");
      if (adxStrong) momentumParts.push("adx");
      debug.push(`[ENTRY] RAW ADD: beyond TL + confirming + EMA aligned + momentum(${momentumParts.join("+")}) [${momentumCount}/3]`);
    } else {
      debug.push(`[ENTRY] Beyond TL + confirming + aligned, but only ${momentumCount}/3 momentum (need 2+: vol/stoch/adx)`);
    }
  } else {
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
// CANONICAL SIGNAL GENERATION (v28 entry + v38.5 risk mgmt)
// v38.7: Hysteresis checks activeSignals for cold-start safety
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

  // v38.7: Hysteresis with cold-start fallback via activeSignals
  const hyst = getHysteresisSync(pair, now, activeSignals);
  if (hyst.lastSignalType) {
    const minutesLeft = Math.round((hyst.lockUntil - now) / 60000);
    debug.push(`[SIGNAL] Hysteresis lock: ${hyst.lastSignalType} | ${minutesLeft}min remaining`);
    return { debug };
  }

  const recentExits = activeSignals.filter(s =>
    s.pair === pair && s.exited && s.exitReason === "stoch_extreme_opposite_exit" &&
    (now - (s.exitTimestamp || s.timestamp)) < 4 * 60 * 60 * 1000
  );
  if (recentExits.length > 0) {
    const lastExit = recentExits.sort((a, b) => (b.exitTimestamp || b.timestamp) - (a.exitTimestamp || a.timestamp))[0];
    const stoch4h_check = stochRsi(candles4h.map(c => c.close));
    const stochCycled = lastExit.direction === "LONG" ? stoch4h_check.k >= 50 : stoch4h_check.k <= 50;
    if (!stochCycled) {
      debug.push(`[SIGNAL] Stoch extreme cooldown: waiting for neutral (current=${stoch4h_check.k})`);
      return { debug };
    }
  }

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

  const trend = calculateTrend1D(candles1d);
  debug.push(...trend.debug);

  if (!trend.direction) {
    debug.push("[SIGNAL] No valid 1D bias");
    return { debug };
  }

  const isStrongTrend = (trend.adx !== null && trend.adx >= 25) && trend.strength >= 80;
  debug.push(`[SIGNAL] StrongTrend=${isStrongTrend} (informational)`);

  const trendlineEval = evaluateTrendline(pair, candles4h, trend.direction, now);
  debug.push(...trendlineEval.debug);

  if (!trendlineEval.trendline) {
    debug.push("[SIGNAL] No trendline — need 3+ pivots");
    return { debug };
  }

  const closes4h = candles4h.map(c => c.close);
  const stoch4h = stochRsi(closes4h);
  const prevStoch4h = stochRsi(closes4h.slice(0, -1));
  debug.push(`[SIGNAL] 4H Stoch K=${stoch4h.k} D=${stoch4h.d}`);

  const pullback = checkPullbackAdaptive(trend.direction, stoch4h, prevStoch4h, trend.adx, isStrongTrend);
  debug.push(...pullback.debug);

  const entryDiag = diagnoseEntry(pair, candles4h, trend, trendlineEval, stoch4h, now);
  debug.push(...entryDiag.debug);

  if (!entryDiag.rawType || !entryDiag.entryType) {
    debug.push("[SIGNAL] No entry type determined");
    return { debug };
  }

  setHysteresis(pair, entryDiag.rawType, price, now);

  const atr4h = atr(candles4h, 14);
  const swingLows = candles4h.map(c => c.low).slice(-20);
  const swingHighs = candles4h.map(c => c.high).slice(-20);
  const swingLow = Math.min(...swingLows);
  const swingHigh = Math.max(...swingHighs);
  const tlPrice = trendlineEval.trendline!.projectedPrice;

  let entry = price;
  let stop: number;
  let target: number;
  let confidence = 50;
  let positionSizePct: number;

  if (entryDiag.rawType === "ENTRY_1") {
    confidence = 50;
    positionSizePct = 0.06;
    if (trend.direction === "LONG") {
      stop = Math.min(swingLow, entry - atr4h * 2);
      target = entry + atr4h * 5;
    } else {
      stop = Math.max(swingHigh, entry + atr4h * 2);
      target = entry - atr4h * 5;
    }
  } else if (entryDiag.rawType === "ENTRY_2") {
    confidence = 60;
    positionSizePct = 0.05;
    if (trend.direction === "LONG") {
      stop = Math.min(swingLow, entry - atr4h * 1.5);
      target = entry + atr4h * 5;
    } else {
      stop = Math.max(swingHigh, entry + atr4h * 1.5);
      target = entry - atr4h * 5;
    }
  } else {
    confidence = 85;
    positionSizePct = 0.03;
    const tlValid = trendlineEval.isValid && trendlineEval.trendline !== null;
    const distPct = tlValid ? Math.abs((entry - tlPrice) / tlPrice) : 1;
    const useTL = tlValid && distPct < 0.03;

    if (trend.direction === "LONG") {
      const atrStop = entry - atr4h * 1.5;
      const tlStop = useTL ? tlPrice * 0.995 : 0;
      stop = tlStop > 0 && tlStop > atrStop ? Math.max(tlStop, atrStop) : atrStop;
      const minTarget = entry + (entry - stop) * 1.5;
      target = Math.max(swingHigh, minTarget);
      if (!useTL) debug.push(`[RISK] ADD: TL too far (${sf(distPct*100,2)}%), using ATR stop=${sf(atrStop,2)}`);
    } else {
      const atrStop = entry + atr4h * 1.5;
      const tlStop = useTL ? tlPrice * 1.005 : 999999;
      stop = useTL && tlStop < atrStop ? Math.min(tlStop, atrStop) : atrStop;
      const minTarget = entry - (stop - entry) * 1.5;
      target = Math.min(swingLow, minTarget);
      if (!useTL) debug.push(`[RISK] ADD: TL too far (${sf(distPct*100,2)}%), using ATR stop=${sf(atrStop,2)}`);
    }
    if (entryDiag.volUp) confidence += 5;
    if (entryDiag.stochMomentum) confidence += 5;
    if (entryDiag.adxStrong) confidence += 5;
  }

  const riskDiag = calculateRisk(entry, stop, target, entryDiag.rawType);
  debug.push(...riskDiag.debug);

  if (!riskDiag.passes) {
    debug.push(`[SIGNAL] REJECTED: RR ${sf(riskDiag.rr,2)} < ${riskDiag.minRR} (ADD only)`);
    return { debug };
  }

  const tlQuality = trendlineEval.quality;
  if (tlQuality === "NOISE") {
    confidence -= 5;
    debug.push(`[SIGNAL] Confidence reduced by 5 for NOISE trendline (R²=${trendlineEval.trendline?.r2})`);
  } else if (tlQuality === "WEAK") {
    confidence -= 0;
    debug.push(`[SIGNAL] Weak trendline accepted (R²=${trendlineEval.trendline?.r2})`);
  } else if (tlQuality === "EXCELLENT") {
    confidence += 5;
    debug.push(`[SIGNAL] Confidence boosted by 5 for EXCELLENT trendline (R²=${trendlineEval.trendline?.r2})`);
  }

  confidence += Math.min(10, trend.strength / 10);
  if (trend.adx !== null && trend.adx >= 25) confidence += 5;
  if (trend.adx !== null && trend.adx >= 30) confidence += 5;
  confidence = Math.min(95, Math.round(confidence));

  const signal: Signal = {
    id: `${pair}_${now}`,
    pair,
    direction: trend.direction,
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
    scale: entryDiag.rawType,
    entryTier: entryDiag.rawType === "ENTRY_1" ? "CONFIRMED_ENTRY" : entryDiag.rawType === "ENTRY_2" ? "CONFIRMED_ENTRY" : "EARLY_ENTRY",
    entryMode: entryDiag.rawType === "ENTRY_1" ? "RETEST" : entryDiag.rawType === "ENTRY_2" ? "RETEST" : "BREAKOUT",
    positionSizePct,
    regimeDirection: trend.direction,
    conflictEntry: false,
    entryTimeframe: "4H",
    rr: Math.round(riskDiag.rr * 100) / 100,
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

  debug.push(`[SIGNAL] ═══════════════════════════════════════`);
  debug.push(`[SIGNAL] ENTRY ACCEPTED: ${entryDiag.rawType} ${entryDiag.entryType} ${trend.direction} ${pair}`);
  debug.push(`[SIGNAL] Entry=$${sf(entry,2)} | Stop=$${sf(stop,2)} | Target=$${sf(target,2)}`);
  debug.push(`[SIGNAL] Risk=$${sf(riskDiag.risk,2)} | Reward=$${sf(riskDiag.reward,2)} | RR=${sf(riskDiag.rr,2)}`);
  debug.push(`[SIGNAL] Conf=${confidence}% | Size=${(positionSizePct*100).toFixed(0)}% | ADX=${trend.adx?.toFixed(1) || "N/A"}`);
  debug.push(`[SIGNAL] Trendline: R²=${trendlineEval.trendline?.r2} | Quality=${trendlineEval.quality} | Touches=${trendlineEval.trendline?.touches} | Dist=${trendlineEval.trendline?.distanceFromPrice}%`);
  debug.push(`[SIGNAL] ═══════════════════════════════════════`);

  return { signal, debug };
}

// ============================================================
// CANONICAL EXIT LOGIC — shouldHold (v38.7)
// FIX: Stoch extreme opposite now correctly checks for OPPOSITE extreme
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

  const hoursInTrade = (now - signal.timestamp) / (60 * 60 * 1000);
  const risk = Math.abs(signal.entry - signal.stop);
  const distToBE = signal.direction === "LONG" ? currentPrice - signal.entry : signal.entry - currentPrice;
  const distToTP = signal.direction === "LONG" ? signal.target - currentPrice : currentPrice - signal.target;
  const nextMilestone = currentR < 1 ? "Breakeven (1R)" : currentR < 2 ? "50% Lock (2R)" : currentR < 3 ? "70% Lock (3R)" : "Target";

  debug.push(`[HOLD] ${signal.pair} ${signal.direction} | Price=${sf(currentPrice,2)} | R=${sf(currentR,2)} | Hours=${sf(hoursInTrade,2)}`);
  debug.push(`[HOLD] Phase=${ts.phase} | Highest=${sf(newHighest,2)} | Lowest=${sf(newLowest,2)} | LockedStop=${ts.lockedStop ? sf(ts.lockedStop,2) : "none"}`);
  debug.push(`[HOLD] DistToBE=${sf(distToBE,2)} | DistToTP=${sf(distToTP,2)} | Next=${nextMilestone}`);

  // 1. HARD STOPS
  if (signal.direction === "LONG" && currentPrice <= signal.stop) {
    debug.push(`[HOLD] EXIT: Stop loss hit | Price=${sf(currentPrice,2)} <= Stop=${sf(signal.stop,2)}`);
    return { shouldHold: false, reason: "stop_loss", updatedTradeState: { ...updatedState, phase: "EXIT" } };
  }
  if (signal.direction === "SHORT" && currentPrice >= signal.stop) {
    debug.push(`[HOLD] EXIT: Stop loss hit | Price=${sf(currentPrice,2)} >= Stop=${sf(signal.stop,2)}`);
    return { shouldHold: false, reason: "stop_loss", updatedTradeState: { ...updatedState, phase: "EXIT" } };
  }

  // 2. TARGET HIT
  if (signal.direction === "LONG" && currentPrice >= signal.target) {
    debug.push(`[HOLD] EXIT: Target hit | Price=${sf(currentPrice,2)} >= Target=${sf(signal.target,2)}`);
    return { shouldHold: false, reason: "target_hit", updatedTradeState: { ...updatedState, phase: "EXIT" } };
  }
  if (signal.direction === "SHORT" && currentPrice <= signal.target) {
    debug.push(`[HOLD] EXIT: Target hit | Price=${sf(currentPrice,2)} <= Target=${sf(signal.target,2)}`);
    return { shouldHold: false, reason: "target_hit", updatedTradeState: { ...updatedState, phase: "EXIT" } };
  }

  // 3. EMA REGIME FLIP
  if (candles1d && candles1d.length >= 50) {
    const trend = calculateTrend1D(candles1d);
    if (trend.direction && trend.direction !== signal.direction) {
      debug.push(`[HOLD] 1D trend flipped: ${signal.direction} -> ${trend.direction} | ADX=${trend.adx?.toFixed(1) || "N/A"}`);
      if (currentR < 2 || hoursInTrade < 24) {
        debug.push(`[HOLD] EXIT: Regime flip (unprofitable or early) | R=${sf(currentR,2)} | Hours=${sf(hoursInTrade,2)}`);
        return { shouldHold: false, reason: "1d_regime_flip", updatedTradeState: { ...updatedState, phase: "EXIT" } };
      }
      debug.push(`[HOLD] EXIT: Regime flip (in profit) | R=${sf(currentR,2)} | Hours=${sf(hoursInTrade,2)}`);
      return { shouldHold: false, reason: "1d_regime_flip_profit", updatedTradeState: { ...updatedState, phase: "EXIT" } };
    }
  }

  // 4. 4H EMA STRUCTURE FAILURE
  if (candles4h && candles4h.length >= 50) {
    const alignment = calculateEMAAlignment(candles4h, signal.direction);
    if (hoursInTrade > 6) {
      if (!alignment.aligned) {
        debug.push(`[HOLD] EXIT: 4H EMA structure failure | Aligned=false | Price=${sf(alignment.price,2)} EMA8=${sf(alignment.ema8,2)} EMA21=${sf(alignment.ema21,2)}`);
        return { shouldHold: false, reason: "4h_structure_failure", updatedTradeState: { ...updatedState, phase: "EXIT" } };
      }
    }
  }

  // 5. STOCH EXTREME OPPOSITE (v38.7 FIX)
  // OLD BUG: For LONG, checked K<20 (same as entry). For SHORT, checked K>80 (same as entry).
  // FIXED: Exit when stoch reaches the OPPOSITE extreme from entry.
  //   LONG entry at oversold (K<20) → exit when overbought (K>80)
  //   SHORT entry at overbought (K>80) → exit when oversold (K<20)
  const closes4h = candles4h.map(c => c.close);
  const stoch = stochRsi(closes4h);
  
  // v38.7: Opposite extreme check — was checking SAME extreme as entry (bug)
  const stochExtremeOpposite = signal.direction === "LONG"
    ? stoch.k > 80   // LONG: exit when overbought (opposite of oversold entry)
    : stoch.k < 20;  // SHORT: exit when oversold (opposite of overbought entry)
    
  if (stochExtremeOpposite) {
    debug.push(`[HOLD] EXIT: Stoch extreme opposite | K=${stoch.k} | Direction=${signal.direction} → exit at ${signal.direction === "LONG" ? "K>80" : "K<20"}`);
    return { shouldHold: false, reason: "stoch_extreme_opposite_exit", updatedTradeState: { ...updatedState, phase: "EXIT" } };
  }

  // 6. PROFIT PROTECTION
  let newLockedStop = ts.lockedStop;
  let newProfitLockLevel = ts.profitLockLevel;
  let newPhase: TradeLifecyclePhase = ts.phase;

  if (currentR >= 3 && newProfitLockLevel < 3) {
    const gain = Math.abs(currentPrice - signal.entry);
    const lockPrice = signal.direction === "LONG" ? signal.entry + gain * 0.3 : signal.entry - gain * 0.3;
    newLockedStop = Math.max(ts.lockedStop || 0, lockPrice);
    newProfitLockLevel = 3;
    newPhase = "PROFIT_PROTECTION";
    debug.push(`[HOLD] Profit lock 3R: LockedStop=${sf(newLockedStop,2)}`);
  } else if (currentR >= 2 && newProfitLockLevel < 2) {
    const gain = Math.abs(currentPrice - signal.entry);
    const lockPrice = signal.direction === "LONG" ? signal.entry + gain * 0.5 : signal.entry - gain * 0.5;
    newLockedStop = Math.max(ts.lockedStop || 0, lockPrice);
    newProfitLockLevel = 2;
    newPhase = "PROFIT_PROTECTION";
    debug.push(`[HOLD] Profit lock 2R: LockedStop=${sf(newLockedStop,2)}`);
  } else if (currentR >= 1 && newProfitLockLevel < 1) {
    newLockedStop = signal.entry;
    newProfitLockLevel = 1;
    newPhase = "BUILDING";
    debug.push(`[HOLD] Breakeven lock 1R: LockedStop=${sf(newLockedStop,2)}`);
  }

  if (newLockedStop) {
    if (signal.direction === "LONG" && currentPrice <= newLockedStop) {
      debug.push(`[HOLD] EXIT: Profit protection ${newProfitLockLevel}R | Price=${sf(currentPrice,2)} <= LockedStop=${sf(newLockedStop,2)}`);
      return { shouldHold: false, reason: `profit_protection_${newProfitLockLevel}R`, updatedTradeState: { ...updatedState, phase: "EXIT", lockedStop: newLockedStop, profitLockLevel: newProfitLockLevel } };
    }
    if (signal.direction === "SHORT" && currentPrice >= newLockedStop) {
      debug.push(`[HOLD] EXIT: Profit protection ${newProfitLockLevel}R | Price=${sf(currentPrice,2)} >= LockedStop=${sf(newLockedStop,2)}`);
      return { shouldHold: false, reason: `profit_protection_${newProfitLockLevel}R`, updatedTradeState: { ...updatedState, phase: "EXIT", lockedStop: newLockedStop, profitLockLevel: newProfitLockLevel } };
    }
  }

  if (currentR >= 2 && newPhase === "BUILDING") newPhase = "TREND";
  if (currentR >= 1 && newPhase === "ENTRY") newPhase = "BUILDING";

  const finalState: TradeState = {
    ...updatedState, phase: newPhase,
    lockedStop: newLockedStop, profitLockLevel: newProfitLockLevel,
  };

  debug.push(`[HOLD] HOLDING: phase=${newPhase} | R=${sf(currentR,2)} | NextMilestone=${nextMilestone}`);

  return { shouldHold: true, reason: `holding_${newPhase.toLowerCase()}_R${currentR.toFixed(1)}`, updatedTradeState: finalState };
}

// ============================================================
// CANONICAL VALIDITY CHECKS
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
// CANONICAL MARKET SNAPSHOT
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

  const trend = calculateTrend1D(candles1d);
  const trend4h = calculateTrend4H(candles4h);
  const alignment = trend.direction ? calculateEMAAlignment(candles4h, trend.direction) : { aligned: false, priceAboveEMA8: false, priceAboveEMA21: false, ema8AboveEMA21: false, price: 0, ema8: 0, ema21: 0, debug: [] };

  const stoch4h = candles4h.length >= 50 ? stochRsi(candles4h.map(c => c.close)) : { k: 50, d: 50 };
  const stoch1h = candles1h.length >= 30 ? stochRsi(candles1h.map(c => c.close)) : { k: 50, d: 50 };
  const stoch15m = candles15m.length >= 20 ? stochRsi(candles15m.map(c => c.close)) : { k: 50, d: 50 };

  const volCheck = candles4h.length >= 12 ? checkVolume(candles4h) : { confirmed: false, ratio: 0, debug: [] };

  const closes4h = candles4h.map(c => c.close);
  const prevStoch4h = stochRsi(closes4h.slice(0, -1));
  const isStrongTrend = (trend.adx !== null && trend.adx >= 25) && trend.strength >= 80;
  const pullback = trend.direction ? checkPullbackAdaptive(trend.direction, stoch4h, prevStoch4h, trend.adx, isStrongTrend) : { pullbackActive: false, reason: "No bias", tier: null, stochZone: "NEUTRAL", debug: [] };

  const adxVal = adx(candles4h) ?? 0;
  const rsiVal = wilderRsi(closes4h);

  let readiness = 0;
  if (trend.direction) readiness += 25;
  if (trend.strength >= 50) readiness += 15;
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
    ...trend.debug,
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
    bias: trend.direction ? { direction: trend.direction, strength: trend.strength } : null,
    trend1d: trend.direction ? { direction: trend.direction, strength: trend.strengthLabel } : null,
    trend4h: trend4h.direction ? { direction: trend4h.direction, strength: trend4h.strengthLabel } : null,
    trend1h: trend.direction ? { direction: trend.direction, strength: trend.strengthLabel } : null,
    stoch4h,
    stoch1h,
    stoch15m,
    volumeConfirmed: volCheck.confirmed,
    trendDirection: trend.direction,
    trendStrength: trend.strength,
    trendStrengthLabel: trend.strengthLabel,
    isPullback: pullback.pullbackActive,
    pullbackTier: pullback.tier,
    pullbackReason: pullback.reason,
    stochZone: pullback.stochZone,
    readiness,
    readinessLabel,
    adx: Math.round(adxVal * 10) / 10,
    trend: trend.direction ? `${trend.direction} ${trend.strengthLabel}` : "NONE",
    regime: {
      direction: trend.direction,
      strength: trend.strengthLabel,
      confidence: trend.direction ? (trend.strength > 50 ? 75 : 50) : 0
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
    entryTier: signalResult?.signal ? (signalResult.signal.entryType === "RETEST" ? "CONFIRMED_ENTRY" : "EARLY_ENTRY") : null,
    entryMode: signalResult?.signal ? (signalResult.signal.entryType === "EARLY" ? "PULLBACK" : "BREAKOUT") : null,
    positionSize: signalResult?.signal ? (signalResult.signal.positionSizePct ? (signalResult.signal.positionSizePct * 100).toFixed(0) + "%" : null) : null,
    signal: signalResult?.signal || null,
    summary: { status: signalResult?.signal ? "READY" : "WATCH", debug: allDebug },
    activeTrade: null,
    debug: allDebug,
  };
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
