// lib/strategy.ts — v26 "Trend Pullback: 1D Trend + 4H EMA21 Entry"
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
  type: "PULLBACK";
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
}

export interface SignalResult {
  signal?: Signal;
  market?: any;
  debug: string[];
}

export const CURRENT_SIGNAL_VERSION = 26;
const MIN_RR = 2.0;

function ema(closes: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const ema: number[] = [closes[0]];
  for (let i = 1; i < closes.length; i++) {
    ema.push(closes[i] * k + ema[i - 1] * (1 - k));
  }
  return ema;
}

function avg(arr: number[]): number {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function rsi(closes: number[], period: number = 14): number {
  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period && i < closes.length; i++) {
    const change = closes[closes.length - i] - closes[closes.length - i - 1];
    if (change > 0) gains += change;
    else losses -= change;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  return 100 - (100 / (1 + avgGain / avgLoss));
}

function stoch(candles: Candle[], kPeriod: number = 14, dPeriod: number = 3): { k: number; d: number } {
  if (!candles.length) return { k: 50, d: 50 };
  const len = candles.length;
  const kValues: number[] = [];
  for (let i = kPeriod - 1; i < len; i++) {
    const window = candles.slice(i - kPeriod + 1, i + 1);
    const lowest = Math.min(...window.map(c => c.low));
    const highest = Math.max(...window.map(c => c.high));
    const close = candles[i].close;
    kValues.push(highest === lowest ? 50 : ((close - lowest) / (highest - lowest)) * 100);
  }
  const currentK = kValues[kValues.length - 1];
  const dWindow = kValues.slice(-dPeriod);
  const currentD = avg(dWindow);
  return { k: Math.round(currentK * 10) / 10, d: Math.round(currentD * 10) / 10 };
}

function adx(candles: Candle[], period: number = 14): number {
  const trs: number[] = [];
  const plusDMs: number[] = [];
  const minusDMs: number[] = [];
  for (let i = 1; i < candles.length && i <= period + 1; i++) {
    const c = candles[candles.length - i];
    const p = candles[candles.length - i - 1];
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
    plusDMs.push(c.high - p.high > p.low - c.low ? Math.max(c.high - p.high, 0) : 0);
    minusDMs.push(p.low - c.low > c.high - p.high ? Math.max(p.low - c.low, 0) : 0);
  }
  const atrVal = avg(trs);
  if (atrVal === 0) return 0;
  const plusDI = (avg(plusDMs) / atrVal) * 100;
  const minusDI = (avg(minusDMs) / atrVal) * 100;
  if (plusDI + minusDI === 0) return 0;
  return (Math.abs(plusDI - minusDI) / (plusDI + minusDI)) * 100;
}

// --- 1D TREND: Higher highs/lows or EMA 8/21 ---
function trend1D(candles: Candle[]): { direction: "LONG" | "SHORT" | null; strength: string } {
  const closes = candles.map(c => c.close);
  const ema8 = ema(closes, 8);
  const ema21 = ema(closes, 21);
  const last8 = ema8[ema8.length - 1];
  const last21 = ema21[ema21.length - 1];
  
  // Simple: EMA 8/21 + last 3 candles for confirmation
  const last3 = candles.slice(-3);
  const netMove = last3.reduce((sum, c) => sum + (c.close - c.open), 0);
  
  const direction = last8 > last21 ? "LONG" : last8 < last21 ? "SHORT" : null;
  const aligned = direction === "LONG" ? netMove > 0 : netMove < 0;
  
  const strength = aligned ? "STRONG" : "WEAK";
  
  return { direction, strength };
}

// --- 4H PULLBACK: Price near EMA21 in trend direction ---
function checkPullback(
  candles4h: Candle[],
  direction: "LONG" | "SHORT"
): { isPullback: boolean; ema21: number; distance: number; swingLow?: number; swingHigh?: number } {
  const closes = candles4h.map(c => c.close);
  const lows = candles4h.map(c => c.low);
  const highs = candles4h.map(c => c.high);
  const ema21 = ema(closes, 21);
  const lastEma = ema21[ema21.length - 1];
  const price = closes[closes.length - 1];
  
  // Find recent swing low (for LONG) or swing high (for SHORT)
  const recentLows = lows.slice(-20);
  const recentHighs = highs.slice(-20);
  const swingLow = Math.min(...recentLows);
  const swingHigh = Math.max(...recentHighs);
  
  const dist = Math.abs(price - lastEma) / lastEma;
  
  if (direction === "LONG") {
    // Price near or below EMA21 but above swing low
    const nearEma = price <= lastEma * 1.005; // Within 0.5% above or below
    const aboveStructure = price > swingLow * 1.01; // Above recent low
    return { isPullback: nearEma && aboveStructure, ema21: lastEma, distance: dist, swingLow };
  }
  
  if (direction === "SHORT") {
    const nearEma = price >= lastEma * 0.995;
    const belowStructure = price < swingHigh * 0.99;
    return { isPullback: nearEma && belowStructure, ema21: lastEma, distance: dist, swingHigh };
  }
  
  return { isPullback: false, ema21: lastEma, distance: dist };
}

// --- 4H TRIGGER: Candle confirming direction off EMA21 ---
function trigger4H(candles: Candle[], direction: "LONG" | "SHORT"): boolean {
  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  
  if (direction === "LONG") {
    // Bullish candle after touch/break of EMA21
    return last.close > last.open && last.close > prev.close;
  }
  
  if (direction === "SHORT") {
    // Bearish candle after touch/break of EMA21
    return last.close < last.open && last.close < prev.close;
  }
  
  return false;
}

// --- LEVELS: Swing-based TP, wide SL ---
function getLevels(
  candles4h: Candle[],
  direction: "LONG" | "SHORT",
  entry: number,
  swingLow?: number,
  swingHigh?: number
): { tp: number; sl: number; rr: number } | null {
  const highs = candles4h.map(c => c.high).slice(-20);
  const lows = candles4h.map(c => c.low).slice(-20);
  
  // ATR for SL width
  const atrs: number[] = [];
  for (let i = candles4h.length - 14; i < candles4h.length; i++) {
    atrs.push(candles4h[i].high - candles4h[i].low);
  }
  const atr = avg(atrs);
  
  if (direction === "LONG") {
    const sl = swingLow ? Math.min(swingLow * 0.998, entry - atr * 2) : entry - atr * 3;
    const nextHigh = Math.max(...highs);
    const tp = nextHigh > entry ? nextHigh : entry + atr * 4;
    const rr = (tp - entry) / (entry - sl);
    if (rr < MIN_RR) return null;
    return { tp: Math.round(tp * 100) / 100, sl: Math.round(sl * 100) / 100, rr: Math.round(rr * 100) / 100 };
  }
  
  if (direction === "SHORT") {
    const sl = swingHigh ? Math.max(swingHigh * 1.002, entry + atr * 2) : entry + atr * 3;
    const nextLow = Math.min(...lows);
    const tp = nextLow < entry ? nextLow : entry - atr * 4;
    const rr = (entry - tp) / (sl - entry);
    if (rr < MIN_RR) return null;
    return { tp: Math.round(tp * 100) / 100, sl: Math.round(sl * 100) / 100, rr: Math.round(rr * 100) / 100 };
  }
  
  return null;
}

// --- MAIN SIGNAL ---
export function generateSignal(
  pair: string,
  candles1h: Candle[],
  candles4h: Candle[],
  candles15m: Candle[],
  currentPrice?: number
): SignalResult {
  const debug: string[] = [];
  
  // Need 1D candles — use 4H aggregated or fetch separately
  // For now, use 4H as proxy if insufficient 1D
  const candles1d = candles4h.length >= 42 ? candles4h.filter((_, i) => i % 6 === 0) : candles4h;
  
  if (candles1d.length < 10 || candles4h.length < 30) {
    debug.push("Insufficient candle data");
    return { debug };
  }
  
  const t1d = trend1D(candles1d);
  debug.push(`1D: ${t1d.direction || "NONE"} ${t1d.strength}`);
  
  if (!t1d.direction) {
    debug.push("1D trend unclear");
    return { debug };
  }
  
  const pullback = checkPullback(candles4h, t1d.direction);
  debug.push(`4H: EMA21 ${pullback.ema21.toFixed(1)} | Price ${pullback.distance.toFixed(3)} from EMA | Pullback: ${pullback.isPullback}`);
  
  if (!pullback.isPullback) {
    debug.push("Not at pullback zone");
    return { debug };
  }
  
  const triggered = trigger4H(candles4h, t1d.direction);
  debug.push(`Trigger: ${triggered ? "CONFIRMED" : "WAITING"}`);
  
  if (!triggered) {
    debug.push("No confirming candle");
    return { debug };
  }
  
  const price = currentPrice ?? candles4h[candles4h.length - 1].close;
  const levels = getLevels(candles4h, t1d.direction, price, pullback.swingLow, pullback.swingHigh);
  
  if (!levels) {
    debug.push("No valid levels (R:R < 2.0)");
    return { debug };
  }
  
  debug.push(`Levels: TP ${levels.tp} | SL ${levels.sl} | RR ${levels.rr}`);
  
  const rsi4h = rsi(candles4h.map(c => c.close));
  const stoch4h = stoch(candles4h);
  const adx4h = adx(candles4h);
  
  const signal: Signal = {
    id: `${pair}_${Date.now()}`,
    pair,
    direction: t1d.direction,
    type: "PULLBACK",
    entry: Math.round(price * 100) / 100,
    stop: levels.sl,
    target: levels.tp,
    confidence: t1d.strength === "STRONG" ? 75 : 60,
    rr: levels.rr,
    adx: Math.round(adx4h * 10) / 10,
    rsi: Math.round(rsi4h * 10) / 10,
    stochK: stoch4h.k,
    stochD: stoch4h.d,
    expectedMove: Math.round(((levels.tp - price) / price) * 1000) / 10,
    reason: `${t1d.direction} PULLBACK | 1D ${t1d.strength} | 4H EMA21 touch | Swing ${t1d.direction === "LONG" ? "low" : "high"} | RR ${levels.rr}`,
    timestamp: Date.now(),
    version: CURRENT_SIGNAL_VERSION,
  };
  
  const market = {
    pair,
    price: Math.round(price * 100) / 100,
    timestamp: Date.now(),
    trend: `${t1d.direction} ${t1d.strength}`,
    adx: signal.adx,
    rsi: signal.rsi,
    stochK: signal.stochK,
    stochD: signal.stochD,
  };
  
  debug.push(`SIGNAL: ${signal.direction} ${signal.entry} | TP ${signal.target} | SL ${signal.stop} | RR ${signal.rr}`);
  
  return { signal, market, debug };
}

// --- MARKET SNAPSHOT ---
export function getMarketSnapshot(
  pair: string,
  candles1h: Candle[],
  candles4h: Candle[],
  candles15m: Candle[]
): any {
  const candles1d = candles4h.length >= 42 ? candles4h.filter((_, i) => i % 6 === 0) : candles4h;
  const t1d = trend1D(candles1d);
  const pullback = t1d.direction ? checkPullback(candles4h, t1d.direction) : { isPullback: false, ema21: 0, distance: 0 };
  const stoch4h = stoch(candles4h);
  const price = candles4h[candles4h.length - 1].close;

  return {
    pair,
    price: Math.round(price * 100) / 100,
    timestamp: Date.now(),
    trend: t1d.direction ? `${t1d.direction} ${t1d.strength}` : "NONE",
    adx: Math.round(adx(candles4h) * 10) / 10,
    rsi: Math.round(rsi(candles4h.map(c => c.close)) * 10) / 10,
    stochK: stoch4h.k,
    stochD: stoch4h.d,
    confirm1h: pullback.isPullback,
  };
}

// --- VALIDITY ---
export interface ValidityCheck {
  valid: boolean;
  reason: string;
  exited: boolean;
}

export function isSignalStillValid(signal: Signal, currentPrice: number, now: number = Date.now()): ValidityCheck {
  const ageMs = now - signal.timestamp;
  const maxAge = 12 * 60 * 60 * 1000; // 12 hours for pullbacks
  
  if (ageMs > maxAge) {
    return { valid: false, reason: "expired_ttl", exited: true };
  }
  
  // Wide missed entry: 1.5%
  if (signal.direction === "LONG" && currentPrice > signal.entry * 1.015) {
    return { valid: false, reason: "missed_entry", exited: true };
  }
  if (signal.direction === "SHORT" && currentPrice < signal.entry * 0.985) {
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

// --- shouldHold ---
export interface HoldResult {
  shouldHold: boolean;
  reason: string;
}

export function shouldHold(signal: Signal, candles4h: Candle[], currentPrice: number, now?: number): HoldResult {
  const t1d = trend1D(candles4h.length >= 42 ? candles4h.filter((_, i) => i % 6 === 0) : candles4h);
  const trendReversed = (signal.direction === "LONG" && t1d.direction === "SHORT") ||
                        (signal.direction === "SHORT" && t1d.direction === "LONG");
  
  if (trendReversed) return { shouldHold: false, reason: "trend_reversed" };
  
  const validity = isSignalStillValid(signal, currentPrice, now);
  return { shouldHold: validity.valid, reason: validity.reason };
}

// --- filterExpiredSignals ---
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

// --- checkTradeStatus ---
export type TradeStatus = "ACTIVE" | "TP_HIT" | "SL_HIT" | "EXPIRED";

export function checkTradeStatus(signal: Signal, currentPrice: number): TradeStatus {
  if (signal.direction === "LONG") {
    if (currentPrice >= signal.target) return "TP_HIT";
    if (currentPrice <= signal.stop) return "SL_HIT";
  } else {
    if (currentPrice <= signal.target) return "TP_HIT";
    if (currentPrice >= signal.stop) return "SL_HIT";
  }
  return "ACTIVE";
}
