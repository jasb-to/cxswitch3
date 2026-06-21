// lib/strategy.ts — v24.4 "Structure-Based 1H Scalp: 4H Override + Reversal Candles"
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
  type: "EARLY" | "BREAKOUT" | "PULLBACK" | "CONTINUATION" | "REVERSAL";
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

export const CURRENT_SIGNAL_VERSION = 5;
const MIN_RR = 1.5;

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

// --- CANDLE PATTERN DETECTION ---
function isHammer(c: Candle, direction: "LONG" | "SHORT"): boolean {
  const body = Math.abs(c.close - c.open);
  const range = c.high - c.low;
  if (range === 0) return false;
  const lowerWick = Math.min(c.open, c.close) - c.low;
  const upperWick = c.high - Math.max(c.open, c.close);
  
  if (direction === "LONG") {
    return lowerWick > body * 2 && upperWick < body * 0.5 && c.close > c.open;
  } else {
    return upperWick > body * 2 && lowerWick < body * 0.5 && c.close < c.open;
  }
}

function isEngulfing(prev: Candle, curr: Candle, direction: "LONG" | "SHORT"): boolean {
  const prevBody = Math.abs(prev.close - prev.open);
  const currBody = Math.abs(curr.close - curr.open);
  
  if (direction === "LONG") {
    return prev.close < prev.open && curr.close > curr.open && 
           curr.close > prev.open && curr.open < prev.close &&
           currBody > prevBody * 0.8;
  } else {
    return prev.close > prev.open && curr.close < curr.open &&
           curr.close < prev.open && curr.open > prev.close &&
           currBody > prevBody * 0.8;
  }
}

// --- FIND SWING HIGHS/LOWS (structure) ---
function findSwingLows(candles: Candle[], lookback: number): number[] {
  const lows: number[] = [];
  for (let i = 2; i < candles.length - 2 && lows.length < lookback; i++) {
    const c = candles[candles.length - 1 - i];
    const p1 = candles[candles.length - i];
    const p2 = candles[candles.length - i + 1];
    const n1 = candles[candles.length - 2 - i];
    const n2 = candles[candles.length - 3 - i];
    if (c.low < p1.low && c.low < p2.low && c.low < n1.low && c.low < n2.low) {
      lows.push(c.low);
    }
  }
  return lows.reverse();
}

function findSwingHighs(candles: Candle[], lookback: number): number[] {
  const highs: number[] = [];
  for (let i = 2; i < candles.length - 2 && highs.length < lookback; i++) {
    const c = candles[candles.length - 1 - i];
    const p1 = candles[candles.length - i];
    const p2 = candles[candles.length - i + 1];
    const n1 = candles[candles.length - 2 - i];
    const n2 = candles[candles.length - 3 - i];
    if (c.high > p1.high && c.high > p2.high && c.high > n1.high && c.high > n2.high) {
      highs.push(c.high);
    }
  }
  return highs.reverse();
}

// --- 4H TREND: EMA 8/21 + ADX strength ---
function trend4H(candles: Candle[]): { direction: "LONG" | "SHORT" | null; strength: string; adx: number } {
  const closes = candles.map(c => c.close);
  const ema8 = ema(closes, 8);
  const ema21 = ema(closes, 21);
  const last8 = ema8[ema8.length - 1];
  const last21 = ema21[ema21.length - 1];
  
  const adxVal = adx(candles);
  const direction = last8 > last21 ? "LONG" : last8 < last21 ? "SHORT" : null;
  const strength = adxVal > 40 ? "STRONG" : adxVal > 25 ? "MEDIUM" : "WEAK";
  
  return { direction, strength, adx: adxVal };
}

// --- 1H CONFIRMATION: Same EMA alignment + momentum ---
function confirm1H(candles: Candle[], direction4h: "LONG" | "SHORT"): { confirms: boolean; adx: number } {
  const closes = candles.map(c => c.close);
  const ema8 = ema(closes, 8);
  const ema21 = ema(closes, 21);
  const last8 = ema8[ema8.length - 1];
  const last21 = ema21[ema21.length - 1];
  
  const adxVal = adx(candles);
  const aligns = direction4h === "LONG" ? last8 > last21 : last8 < last21;
  
  return { confirms: aligns && adxVal > 20, adx: adxVal };
}

// --- 15M TRIGGER: Sweep + reversal pattern OR 8/21 cross ---
function trigger15M(candles: Candle[], direction: "LONG" | "SHORT"): { 
  triggered: boolean; 
  type: string; 
  sweepLow?: number; 
  sweepHigh?: number;
} {
  const closes = candles.map(c => c.close);
  const len = closes.length;
  const ema8 = ema(closes, 8);
  const ema21 = ema(closes, 21);
  
  const last8 = ema8[len - 1];
  const last21 = ema21[len - 1];
  const prev8 = ema8[len - 2];
  const prev21 = ema21[len - 2];
  
  const recentLows = candles.slice(-20).map(c => c.low);
  const recentHighs = candles.slice(-20).map(c => c.high);
  
  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  const stoch15 = stoch(candles);
  
  if (direction === "LONG") {
    const prevLow = Math.min(...recentLows.slice(0, -1));
    const swept = last.low < prevLow * 1.001 && last.close > prevLow;
    const crossed = prev8 <= prev21 && last8 > last21;
    
    // Pattern 1: Classic sweep + 8/21 cross
    if (swept && crossed) {
      return { triggered: true, type: "sweep + 8/21 cross up", sweepLow: last.low };
    }
    
    // Pattern 2: Deep oversold reversal (hammer or engulfing)
    const deepOversold = stoch15.k < 20 && stoch15.d < 25;
    const reversalCandle = isHammer(last, "LONG") || isEngulfing(prev, last, "LONG");
    const priceBounce = last.close > last.open && last.close > prev.close;
    
    if (swept && deepOversold && (reversalCandle || priceBounce)) {
      return { triggered: true, type: "deep oversold reversal", sweepLow: last.low };
    }
    
    // Pattern 3: Stoch bounce from extreme (K was < 20, now curling up with D following)
    const stochBounce = stoch15.k < 20 && stoch15.k > stoch15.d && prev.close < last.close;
    if (swept && stochBounce && last.close > last.open) {
      return { triggered: true, type: "stoch oversold bounce", sweepLow: last.low };
    }
  }
  
  if (direction === "SHORT") {
    const prevHigh = Math.max(...recentHighs.slice(0, -1));
    const swept = last.high > prevHigh * 0.999 && last.close < prevHigh;
    const crossed = prev8 >= prev21 && last8 < last21;
    
    if (swept && crossed) {
      return { triggered: true, type: "sweep + 8/21 cross down", sweepHigh: last.high };
    }
    
    const deepOverbought = stoch15.k > 80 && stoch15.d > 75;
    const reversalCandle = isHammer(last, "SHORT") || isEngulfing(prev, last, "SHORT");
    const priceDrop = last.close < last.open && last.close < prev.close;
    
    if (swept && deepOverbought && (reversalCandle || priceDrop)) {
      return { triggered: true, type: "deep overbought reversal", sweepHigh: last.high };
    }
    
    const stochBounce = stoch15.k > 80 && stoch15.k < stoch15.d && prev.close > last.close;
    if (swept && stochBounce && last.close < last.open) {
      return { triggered: true, type: "stoch overbought bounce", sweepHigh: last.high };
    }
  }
  
  return { triggered: false, type: "no setup" };
}

// --- STRUCTURE TP/SL ---
function getStructureLevels(
  candles1h: Candle[],
  direction: "LONG" | "SHORT",
  entry: number,
  sweepLow?: number,
  sweepHigh?: number
): { tp: number; sl: number; rr: number; structure: string } | null {
  const highs = findSwingHighs(candles1h, 5);
  const lows = findSwingLows(candles1h, 5);
  
  if (direction === "LONG") {
    const nextResistance = highs.find(h => h > entry);
    if (!nextResistance) return null;
    
    const deepSweep = sweepLow && sweepLow < entry * 0.99;
    const sl = sweepLow 
      ? Math.min(sweepLow * 0.998, deepSweep ? entry * 0.97 : entry * 0.985)
      : lows[lows.length - 1] * 0.998;
    
    const rr = (nextResistance - entry) / (entry - sl);
    if (rr < MIN_RR) return null;
    
    return {
      tp: Math.round(nextResistance * 100) / 100,
      sl: Math.round(sl * 100) / 100,
      rr: Math.round(rr * 100) / 100,
      structure: nextResistance === highs[highs.length - 1] ? "break_of_structure" : "swing_high"
    };
  }
  
  if (direction === "SHORT") {
    const nextSupport = lows.find(l => l < entry);
    if (!nextSupport) return null;
    
    const deepSweep = sweepHigh && sweepHigh > entry * 1.01;
    const sl = sweepHigh
      ? Math.max(sweepHigh * 1.002, deepSweep ? entry * 1.03 : entry * 1.015)
      : highs[highs.length - 1] * 1.002;
    
    const rr = (entry - nextSupport) / (sl - entry);
    if (rr < MIN_RR) return null;
    
    return {
      tp: Math.round(nextSupport * 100) / 100,
      sl: Math.round(sl * 100) / 100,
      rr: Math.round(rr * 100) / 100,
      structure: nextSupport === lows[lows.length - 1] ? "break_of_structure" : "swing_low"
    };
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
  
  if (candles1h.length < 50 || candles4h.length < 30 || candles15m.length < 50) {
    debug.push("Insufficient candle data");
    return { debug };
  }
  
  const t4h = trend4H(candles4h);
  debug.push(`4H: ${t4h.direction || "NONE"} ${t4h.strength} | ADX: ${t4h.adx.toFixed(1)}`);
  
  if (!t4h.direction || t4h.strength === "WEAK") {
    debug.push("4H trend unclear or weak");
    return { debug };
  }
  
  const c1h = confirm1H(candles1h, t4h.direction);
  debug.push(`1H: ${c1h.confirms ? "CONFIRMS" : "REJECTS"} | ADX: ${c1h.adx.toFixed(1)}`);
  
  // Check 15M trigger FIRST, then decide if 1H override applies
  const t15m = trigger15M(candles15m, t4h.direction);
  
  // 4H OVERRIDE: If 4H is STRONG and 15M shows deep reversal, bypass 1H filter
  // RELAXED: ADX > 40 (not 60) for STRONG, or ADX > 25 for MEDIUM with very deep oversold
  const isDeepOversold = t4h.direction === "LONG" 
    ? t15m.type.includes("oversold") 
    : t15m.type.includes("overbought");
  const isOverride = t4h.strength === "STRONG" && t4h.adx > 40 && t15m.triggered && isDeepOversold;
  
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
  const levels = getStructureLevels(candles1h, t4h.direction, price, t15m.sweepLow, t15m.sweepHigh);
  
  if (!levels) {
    debug.push("No valid structure levels (R:R < 1.5 or no swing high/low)");
    return { debug };
  }
  
  debug.push(`Structure: ${levels.structure} | TP: ${levels.tp} | SL: ${levels.sl} | RR: ${levels.rr}`);
  
  const rsi1h = rsi(candles1h.map(c => c.close));
  const stoch15 = stoch(candles15m);
  
  // Confidence: full alignment = 75, 4H override = 55, partial = 50
  let confidence = 50;
  if (t4h.strength === "STRONG" && c1h.confirms && c1h.adx > 30) {
    confidence = 75;
  } else if (t4h.strength === "STRONG" && c1h.confirms) {
    confidence = 65;
  } else if (isOverride) {
    confidence = 55;
  }
  
  const signal: Signal = {
    id: `${pair}_${Date.now()}`,
    pair,
    direction: t4h.direction,
    type: isOverride ? "PULLBACK" : "EARLY",
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
    reason: `${t4h.direction} ${isOverride ? "PULLBACK" : "EARLY"} | ${levels.structure} | 4H:${t4h.direction} ${t4h.strength} ADX ${t4h.adx.toFixed(1)} | ${c1h.confirms ? "1H confirms" : "1H REJECTS — 4H OVERRIDE"} | Entry TF ${t15m.type} | RR ${levels.rr}`,
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

// --- MARKET SNAPSHOT (for when no signal) ---
export function getMarketSnapshot(
  pair: string,
  candles1h: Candle[],
  candles4h: Candle[],
  candles15m: Candle[]
): any {
  const t4h = trend4H(candles4h);
  const c1h = t4h.direction ? confirm1H(candles1h, t4h.direction) : { confirms: false, adx: 0 };
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

// --- VALIDITY CHECK (for cron + UI) ---
export interface ValidityCheck {
  valid: boolean;
  reason: string;
  exited: boolean;
}

export function isSignalStillValid(signal: Signal, currentPrice: number, now: number = Date.now()): ValidityCheck {
  const ageMs = now - signal.timestamp;
  
  // 3 hour soft max for EARLY, 4 hours for PULLBACK
  const maxAge = signal.type === "PULLBACK" ? 4 * 60 * 60 * 1000 : 3 * 60 * 60 * 1000;
  if (ageMs > maxAge) {
    return { valid: false, reason: "expired_ttl", exited: true };
  }
  
  // Missed entry: price ran past by 0.8%
  if (signal.direction === "LONG" && currentPrice > signal.entry * 1.008) {
    return { valid: false, reason: "missed_entry", exited: true };
  }
  if (signal.direction === "SHORT" && currentPrice < signal.entry * 0.992) {
    return { valid: false, reason: "missed_entry", exited: true };
  }
  
  // SL hit
  if (signal.direction === "LONG" && currentPrice <= signal.stop) {
    return { valid: false, reason: "sl_hit", exited: true };
  }
  if (signal.direction === "SHORT" && currentPrice >= signal.stop) {
    return { valid: false, reason: "sl_hit", exited: true };
  }
  
  // TP hit
  if (signal.direction === "LONG" && currentPrice >= signal.target) {
    return { valid: false, reason: "tp_hit", exited: true };
  }
  if (signal.direction === "SHORT" && currentPrice <= signal.target) {
    return { valid: false, reason: "tp_hit", exited: true };
  }
  
  return { valid: true, reason: "active", exited: false };
}

// --- shouldHold: backward compat for routes ---
export interface HoldResult {
  shouldHold: boolean;
  reason: string;
}

export function shouldHold(signal: Signal, candles4h: Candle[], currentPrice: number, now?: number): HoldResult {
  const t4h = trend4H(candles4h);
  const trendReversed = (signal.direction === "LONG" && t4h.direction === "SHORT") ||
                        (signal.direction === "SHORT" && t4h.direction === "LONG");
  
  if (trendReversed) return { shouldHold: false, reason: "trend_reversed" };
  if (!t4h.direction || t4h.strength === "WEAK") return { shouldHold: false, reason: "trend_weak" };
  
  const validity = isSignalStillValid(signal, currentPrice, now);
  return { shouldHold: validity.valid, reason: validity.reason };
}

// --- filterExpiredSignals: backward compat for cron ---
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

// --- checkTradeStatus: simple ACTIVE / TP / SL ---
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
