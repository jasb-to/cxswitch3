// lib/strategy.ts — v25 "Momentum Lead: Fast Trend + Immediate Entry"
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
  type: "MOMENTUM" | "REVERSAL" | "CONTINUATION";
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

export const CURRENT_SIGNAL_VERSION = 25;
const MIN_RR = 1.3;

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

// --- MOMENTUM TREND: Last 3 candles net movement ---
function momentumTrend(candles: Candle[]): { direction: "LONG" | "SHORT" | null; strength: string; adx: number; momentum: number } {
  const last3 = candles.slice(-3);
  const netMove = last3.reduce((sum, c) => sum + (c.close - c.open), 0);
  const avgBody = avg(last3.map(c => Math.abs(c.close - c.open)));
  const adxVal = adx(candles);
  
  const direction = netMove > 0 ? "LONG" : netMove < 0 ? "SHORT" : null;
  const momentum = Math.abs(netMove) / avgBody; // How many avg candles worth of move
  
  // Strength: ADX + momentum magnitude
  const strength = adxVal > 40 && momentum > 1.5 ? "STRONG" : 
                   adxVal > 25 && momentum > 1 ? "MEDIUM" : "WEAK";
  
  return { direction, strength, adx: adxVal, momentum: Math.round(momentum * 100) / 100 };
}

// --- 1H CONFIRMATION: Momentum aligns + RSI not extreme ---
function confirm1H(candles: Candle[], direction4h: "LONG" | "SHORT"): { confirms: boolean; adx: number; rsi: number } {
  const m1h = momentumTrend(candles);
  const rsiVal = rsi(candles.map(c => c.close));
  
  const aligns = m1h.direction === direction4h;
  
  // Block if RSI is extreme against the trade
  const rsiBlocked = direction4h === "LONG" ? rsiVal > 75 : rsiVal < 25;
  
  return { confirms: aligns && !rsiBlocked && m1h.strength !== "WEAK", adx: m1h.adx, rsi: rsiVal };
}

// --- 15M TRIGGER: Stoch cross OR RSI extreme exit ---
function trigger15M(candles: Candle[], direction: "LONG" | "SHORT"): { 
  triggered: boolean; 
  type: string;
} {
  const len = candles.length;
  const last = candles[len - 1];
  const prev = candles[len - 2];
  const stoch15 = stoch(candles);
  const rsi15 = rsi(candles.map(c => c.close), 14);
  
  // Stoch cross in direction
  const stochCrossLong = stoch15.k > stoch15.d && (stoch(candles.slice(0, -1)).k <= stoch(candles.slice(0, -1)).d);
  const stochCrossShort = stoch15.k < stoch15.d && (stoch(candles.slice(0, -1)).k >= stoch(candles.slice(0, -1)).d);
  
  // RSI extreme exit (bounce signal)
  const rsiBounceLong = rsi15 < 35 && last.close > last.open;
  const rsiBounceShort = rsi15 > 65 && last.close < last.open;
  
  if (direction === "LONG") {
    if (stochCrossLong && stoch15.k < 60) {
      return { triggered: true, type: "stoch cross up" };
    }
    if (rsiBounceLong) {
      return { triggered: true, type: "rsi extreme bounce" };
    }
  }
  
  if (direction === "SHORT") {
    if (stochCrossShort && stoch15.k > 40) {
      return { triggered: true, type: "stoch cross down" };
    }
    if (rsiBounceShort) {
      return { triggered: true, type: "rsi extreme bounce" };
    }
  }
  
  return { triggered: false, type: "no setup" };
}

// --- ATR-based SL/TP (fast, no structure lag) ---
function getLevels(
  candles1h: Candle[],
  direction: "LONG" | "SHORT",
  entry: number
): { tp: number; sl: number; rr: number } | null {
  // ATR from last 14 1H candles
  const atrs: number[] = [];
  for (let i = candles1h.length - 14; i < candles1h.length; i++) {
    atrs.push(candles1h[i].high - candles1h[i].low);
  }
  const atr = avg(atrs);
  
  if (direction === "LONG") {
    const sl = entry - atr * 1.5;
    const tp = entry + atr * 2.5;
    const rr = (tp - entry) / (entry - sl);
    if (rr < MIN_RR) return null;
    return { tp: Math.round(tp * 100) / 100, sl: Math.round(sl * 100) / 100, rr: Math.round(rr * 100) / 100 };
  }
  
  if (direction === "SHORT") {
    const sl = entry + atr * 1.5;
    const tp = entry - atr * 2.5;
    const rr = (entry - tp) / (sl - entry);
    if (rr < MIN_RR) return null;
    return { tp: Math.round(tp * 100) / 100, sl: Math.round(sl * 100) / 100, rr: Math.round(rr * 100) / 100 };
  }
  
  return null;
}

// --- MAIN SIGNAL GENERATION ---
export function generateSignal(
  pair: string,
  candles1h: Candle[],
  candles4h: Candle[],
  candles15m: Candle[],
  currentPrice?: number
): SignalResult {
  const debug: string[] = [];
  
  if (candles1h.length < 20 || candles4h.length < 10 || candles15m.length < 20) {
    debug.push("Insufficient candle data");
    return { debug };
  }
  
  const t4h = momentumTrend(candles4h);
  debug.push(`4H: ${t4h.direction || "NONE"} ${t4h.strength} | ADX: ${t4h.adx.toFixed(1)} | Mom: ${t4h.momentum}`);
  
  if (!t4h.direction || t4h.strength === "WEAK") {
    debug.push("4H momentum weak or unclear");
    return { debug };
  }
  
  const c1h = confirm1H(candles1h, t4h.direction);
  debug.push(`1H: ${c1h.confirms ? "CONFIRMS" : "REJECTS"} | ADX: ${c1h.adx.toFixed(1)} | RSI: ${c1h.rsi.toFixed(1)}`);
  
  // 4H OVERRIDE: If 4H STRONG + deep stoch, bypass 1H
  const t15m = trigger15M(candles15m, t4h.direction);
  const stoch15 = stoch(candles15m);
  const deepExtreme = t4h.direction === "LONG" ? stoch15.k < 15 : stoch15.k > 85;
  const isOverride = t4h.strength === "STRONG" && deepExtreme && t15m.triggered;
  
  if (!c1h.confirms && !isOverride) {
    debug.push("1H does not confirm");
    return { debug };
  }
  
  debug.push(`Entry TF: ${t15m.triggered ? t15m.type.toUpperCase() : "NO SETUP"}${isOverride ? " [4H OVERRIDE]" : ""}`);
  
  if (!t15m.triggered) {
    debug.push("No Entry TF trigger");
    return { debug };
  }
  
  const price = currentPrice ?? candles15m[candles15m.length - 1].close;
  const levels = getLevels(candles1h, t4h.direction, price);
  
  if (!levels) {
    debug.push("No valid levels (R:R < 1.3)");
    return { debug };
  }
  
  debug.push(`Levels: TP ${levels.tp} | SL ${levels.sl} | RR ${levels.rr}`);
  
  const rsi1h = rsi(candles1h.map(c => c.close));
  
  let confidence = 55;
  if (t4h.strength === "STRONG" && c1h.confirms) {
    confidence = 80;
  } else if (t4h.strength === "STRONG" && isOverride) {
    confidence = 65;
  } else if (c1h.confirms) {
    confidence = 70;
  }
  
  const signal: Signal = {
    id: `${pair}_${Date.now()}`,
    pair,
    direction: t4h.direction,
    type: isOverride ? "REVERSAL" : "MOMENTUM",
    entry: Math.round(price * 100) / 100,
    stop: levels.sl,
    target: levels.tp,
    confidence,
    rr: levels.rr,
    adx: Math.round(t4h.adx * 10) / 10,
    rsi: Math.round(rsi1h * 10) / 10,
    stochK: stoch15.k,
    stochD: stoch15.d,
    expectedMove: Math.round(((levels.tp - price) / price) * 1000) / 10,
    reason: `${t4h.direction} ${isOverride ? "REVERSAL" : "MOMENTUM"} | 4H:${t4h.direction} ${t4h.strength} Mom${t4h.momentum} | ${c1h.confirms ? "1H confirms" : "1H REJECTS — OVERRIDE"} | ${t15m.type} | RR ${levels.rr}`,
    timestamp: Date.now(),
    version: CURRENT_SIGNAL_VERSION,
  };
  
  const market = {
    pair,
    price: Math.round(price * 100) / 100,
    timestamp: Date.now(),
    trend: `${t4h.direction} ${t4h.strength}`,
    adx: signal.adx,
    rsi: signal.rsi,
    stochK: signal.stochK,
    stochD: signal.stochD,
  };
  
  debug.push(`SIGNAL: ${signal.direction} ${signal.entry} | TP ${signal.target} | SL ${signal.stop} | RR ${signal.rr} | CONF ${confidence}%`);
  
  return { signal, market, debug };
}

// --- MARKET SNAPSHOT ---
export function getMarketSnapshot(
  pair: string,
  candles1h: Candle[],
  candles4h: Candle[],
  candles15m: Candle[]
): any {
  const t4h = momentumTrend(candles4h);
  const c1h = t4h.direction ? confirm1H(candles1h, t4h.direction) : { confirms: false, adx: 0, rsi: 50 };
  const stoch15 = stoch(candles15m);
  const price = candles1h[candles1h.length - 1].close;

  return {
    pair,
    price: Math.round(price * 100) / 100,
    timestamp: Date.now(),
    trend: t4h.direction ? `${t4h.direction} ${t4h.strength}` : "NONE",
    adx: Math.round(t4h.adx * 10) / 10,
    rsi: Math.round(rsi(candles1h.map(c => c.close)) * 10) / 10,
    stochK: stoch15.k,
    stochD: stoch15.d,
    confirm1h: c1h.confirms,
  };
}

// --- VALIDITY CHECK ---
export interface ValidityCheck {
  valid: boolean;
  reason: string;
  exited: boolean;
}

export function isSignalStillValid(signal: Signal, currentPrice: number, now: number = Date.now()): ValidityCheck {
  const ageMs = now - signal.timestamp;
  const maxAge = signal.type === "REVERSAL" ? 2 * 60 * 60 * 1000 : 2.5 * 60 * 60 * 1000;
  
  if (ageMs > maxAge) {
    return { valid: false, reason: "expired_ttl", exited: true };
  }
  
  if (signal.direction === "LONG" && currentPrice > signal.entry * 1.005) {
    return { valid: false, reason: "missed_entry", exited: true };
  }
  if (signal.direction === "SHORT" && currentPrice < signal.entry * 0.995) {
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
  const t4h = momentumTrend(candles4h);
  const trendReversed = (signal.direction === "LONG" && t4h.direction === "SHORT") ||
                        (signal.direction === "SHORT" && t4h.direction === "LONG");
  
  if (trendReversed) return { shouldHold: false, reason: "momentum_reversed" };
  if (!t4h.direction || t4h.strength === "WEAK") return { shouldHold: false, reason: "momentum_weak" };
  
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
