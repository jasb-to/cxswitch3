// lib/strategy.ts — v27 "Trendline Break: Accumulate + Breakout + StochRSI Exit"
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
  type: "ACCUMULATE" | "BREAKOUT" | "EXIT";
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

export const CURRENT_SIGNAL_VERSION = 27;
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

// Stochastic RSI — more sensitive than regular stoch
function stochRsi(closes: number[], rsiPeriod: number = 14, stochPeriod: number = 14, kPeriod: number = 3, dPeriod: number = 3): { k: number; d: number } {
  const rsiValues: number[] = [];
  for (let i = rsiPeriod; i < closes.length; i++) {
    const window = closes.slice(i - rsiPeriod, i);
    rsiValues.push(rsi(window, rsiPeriod));
  }
  
  if (rsiValues.length < stochPeriod) return { k: 50, d: 50 };
  
  const kValues: number[] = [];
  for (let i = stochPeriod - 1; i < rsiValues.length; i++) {
    const window = rsiValues.slice(i - stochPeriod + 1, i + 1);
    const lowest = Math.min(...window);
    const highest = Math.max(...window);
    const current = rsiValues[i];
    kValues.push(highest === lowest ? 50 : ((current - lowest) / (highest - lowest)) * 100);
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

// --- TRENDLINE: Find best fit from recent swing points ---
function findTrendline(candles: Candle[], direction: "LONG" | "SHORT"): { slope: number; intercept: number; touches: number; r2: number } | null {
  const len = candles.length;
  if (len < 20) return null;
  
  // Find swing highs (for SHORT/breakdown) or swing lows (for LONG/breakout)
  const points: { x: number; y: number }[] = [];
  
  for (let i = 3; i < len - 3; i++) {
    const c = candles[i];
    const isSwingHigh = c.high > candles[i-1].high && c.high > candles[i-2].high && c.high > candles[i+1].high && c.high > candles[i+2].high;
    const isSwingLow = c.low < candles[i-1].low && c.low < candles[i-2].low && c.low < candles[i+1].low && c.low < candles[i+2].low;
    
    if (direction === "SHORT" && isSwingHigh) {
      points.push({ x: i, y: c.high });
    }
    if (direction === "LONG" && isSwingLow) {
      points.push({ x: i, y: c.low });
    }
  }
  
  if (points.length < 3) return null;
  
  // Use last 3 points for trendline
  const recent = points.slice(-3);
  const n = recent.length;
  const sumX = recent.reduce((s, p) => s + p.x, 0);
  const sumY = recent.reduce((s, p) => s + p.y, 0);
  const sumXY = recent.reduce((s, p) => s + p.x * p.y, 0);
  const sumX2 = recent.reduce((s, p) => s + p.x * p.x, 0);
  
  const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
  const intercept = (sumY - slope * sumX) / n;
  
  // R-squared for fit quality
  const yMean = sumY / n;
  const ssTotal = recent.reduce((s, p) => s + Math.pow(p.y - yMean, 2), 0);
  const ssResidual = recent.reduce((s, p) => s + Math.pow(p.y - (slope * p.x + intercept), 2), 0);
  const r2 = ssTotal === 0 ? 0 : 1 - (ssResidual / ssTotal);
  
  return { slope, intercept, touches: points.length, r2: Math.round(r2 * 100) / 100 };
}

function trendlinePrice(trendline: { slope: number; intercept: number }, candleIndex: number): number {
  return trendline.slope * candleIndex + trendline.intercept;
}

// --- 1D TREND ---
function trend1D(candles: Candle[]): { direction: "LONG" | "SHORT" | null; strength: string } {
  const closes = candles.map(c => c.close);
  const ema8 = ema(closes, 8);
  const ema21 = ema(closes, 21);
  const last8 = ema8[ema8.length - 1];
  const last21 = ema21[ema21.length - 1];
  
  const direction = last8 > last21 ? "LONG" : last8 < last21 ? "SHORT" : null;
  const strength = direction && Math.abs(last8 - last21) / last21 > 0.02 ? "STRONG" : "MEDIUM";
  
  return { direction, strength };
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
  
  // Build 1D from 4H (6 candles = 1 day)
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
  
  const trendline = findTrendline(candles4h, t1d.direction);
  if (!trendline) {
    debug.push("No trendline found");
    return { debug };
  }
  
  debug.push(`Trendline: ${trendline.touches} touches | R² ${trendline.r2}`);
  
  if (trendline.r2 < 0.7) {
    debug.push("Trendline too weak");
    return { debug };
  }
  
  const price = currentPrice ?? candles4h[candles4h.length - 1].close;
  const currentIndex = candles4h.length - 1;
  const tlPrice = trendlinePrice(trendline, currentIndex);
  const distToTrendline = Math.abs(price - tlPrice) / tlPrice;
  
  debug.push(`Price ${price.toFixed(1)} | Trendline ${tlPrice.toFixed(1)} | Dist ${(distToTrendline * 100).toFixed(2)}%`);
  
  const stochRsi4h = stochRsi(candles4h.map(c => c.close));
  debug.push(`StochRSI: K ${stochRsi4h.k} | D ${stochRsi4h.d}`);
  
  // ACCUMULATE: Near trendline + StochRSI extreme
  const nearTrendline = distToTrendline < 0.008; // Within 0.8%
  const stochOversold = stochRsi4h.k < 15;
  const stochOverbought = stochRsi4h.k > 85;
  
  const isAccumulate = nearTrendline && ((t1d.direction === "LONG" && stochOversold) || (t1d.direction === "SHORT" && stochOverbought));
  
  // BREAKOUT: Price beyond trendline + confirming candle
  const last = candles4h[candles4h.length - 1];
  const prev = candles4h[candles4h.length - 2];
  
  const beyondTrendline = t1d.direction === "LONG" ? price > tlPrice * 1.005 : price < tlPrice * 0.995;
  const confirmingCandle = t1d.direction === "LONG" ? last.close > last.open && last.close > prev.close : last.close < last.open && last.close < prev.close;
  const volumeIncrease = last.volume > avg(candles4h.slice(-5).map(c => c.volume)) * 1.2;
  
  const isBreakout = beyondTrendline && confirmingCandle && volumeIncrease;
  
  if (!isAccumulate && !isBreakout) {
    debug.push(`State: ${nearTrendline ? "near TL" : "far from TL"} | ${beyondTrendline ? "beyond TL" : "inside TL"} | No signal`);
    return { debug };
  }
  
  // Levels
  const atrs: number[] = [];
  for (let i = candles4h.length - 14; i < candles4h.length; i++) {
    atrs.push(candles4h[i].high - candles4h[i].low);
  }
  const atr = avg(atrs);
  
  const swingLows = candles4h.map(c => c.low).slice(-20);
  const swingHighs = candles4h.map(c => c.high).slice(-20);
  const swingLow = Math.min(...swingLows);
  const swingHigh = Math.max(...swingHighs);
  
  let entry = price;
  let sl: number;
  let tp: number;
  let type: "ACCUMULATE" | "BREAKOUT";
  let confidence: number;
  
  if (isAccumulate) {
    type = "ACCUMULATE";
    entry = price;
    sl = t1d.direction === "LONG" ? Math.min(swingLow * 0.998, entry - atr * 2) : Math.max(swingHigh * 1.002, entry + atr * 2);
    tp = t1d.direction === "LONG" ? entry + atr * 5 : entry - atr * 5;
    confidence = 55;
  } else {
    type = "BREAKOUT";
    entry = price;
    sl = t1d.direction === "LONG" ? Math.min(tlPrice * 0.995, entry - atr * 1.5) : Math.max(tlPrice * 1.005, entry + atr * 1.5);
    tp = t1d.direction === "LONG" ? swingHigh : swingLow;
    confidence = 80;
  }
  
  const rr = t1d.direction === "LONG" ? (tp - entry) / (entry - sl) : (entry - tp) / (sl - entry);
  if (rr < MIN_RR) {
    debug.push(`R:R ${rr.toFixed(2)} < ${MIN_RR}`);
    return { debug };
  }
  
  const rsi4h = rsi(candles4h.map(c => c.close));
  
  const signal: Signal = {
    id: `${pair}_${Date.now()}`,
    pair,
    direction: t1d.direction,
    type,
    entry: Math.round(entry * 100) / 100,
    stop: Math.round(sl * 100) / 100,
    target: Math.round(tp * 100) / 100,
    confidence,
    rr: Math.round(rr * 100) / 100,
    adx: Math.round(adx(candles4h) * 10) / 10,
    rsi: Math.round(rsi4h * 10) / 10,
    stochK: stochRsi4h.k,
    stochD: stochRsi4h.d,
    expectedMove: Math.round(((tp - entry) / entry) * 1000) / 10,
    reason: `${t1d.direction} ${type} | 1D ${t1d.strength} | Trendline R² ${trendline.r2} | StochRSI ${stochRsi4h.k} | ${isBreakout ? "Volume + break" : "TL approach"} | RR ${rr.toFixed(2)}`,
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
  
  debug.push(`SIGNAL: ${type} ${signal.direction} ${signal.entry} | TP ${signal.target} | SL ${signal.stop} | RR ${signal.rr}`);
  
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
  const stochRsi4h = stochRsi(candles4h.map(c => c.close));
  const price = candles4h[candles4h.length - 1].close;
  
  const trendline = t1d.direction ? findTrendline(candles4h, t1d.direction) : null;
  const tlPrice = trendline ? trendlinePrice(trendline, candles4h.length - 1) : 0;
  const dist = trendline ? Math.abs(price - tlPrice) / tlPrice : 1;

  return {
    pair,
    price: Math.round(price * 100) / 100,
    timestamp: Date.now(),
    trend: t1d.direction ? `${t1d.direction} ${t1d.strength}` : "NONE",
    adx: Math.round(adx(candles4h) * 10) / 10,
    rsi: Math.round(rsi(candles4h.map(c => c.close)) * 10) / 10,
    stochK: stochRsi4h.k,
    stochD: stochRsi4h.d,
    confirm1h: dist < 0.008,
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
  
  // ACCUMULATE: 24h to fill, BREAKOUT: 4h to enter
  const maxAge = signal.type === "ACCUMULATE" ? 24 * 60 * 60 * 1000 : 4 * 60 * 60 * 1000;
  
  if (ageMs > maxAge) {
    return { valid: false, reason: "expired_ttl", exited: true };
  }
  
  // ACCUMULATE: wide entry zone, BREAKOUT: tight
  const entryBuffer = signal.type === "ACCUMULATE" ? 1.02 : 1.005;
  if (signal.direction === "LONG" && currentPrice > signal.entry * entryBuffer) {
    return { valid: false, reason: "missed_entry", exited: true };
  }
  if (signal.direction === "SHORT" && currentPrice < signal.entry * (2 - entryBuffer)) {
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
  const candles1d = candles4h.length >= 42 ? candles4h.filter((_, i) => i % 6 === 0) : candles4h;
  const t1d = trend1D(candles1d);
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
