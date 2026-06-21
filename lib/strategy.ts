// lib/strategy.ts — v24.1 "Structure-Based 1H Scalp: Real TP/SL + Momentum + Trend"
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
  rr: number;
  confidence: number;
  trend4h: string;
  confirm1h: boolean;
  trigger5m: string;
  structure: string;    // "sweep_of_low" | "break_of_structure" etc
  timestamp: number;
}

export interface SignalResult {
  signal?: Signal;
  market?: any;
  debug: string[];
}

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

// --- 5M TRIGGER: Sweep + 8/21 cross ---
function trigger5M(candles: Candle[], direction: "LONG" | "SHORT"): { 
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
  
  // Recent 5M structure
  const recentLows = candles.slice(-20).map(c => c.low);
  const recentHighs = candles.slice(-20).map(c => c.high);
  const swingLows = findSwingLows(candles, 3);
  const swingHighs = findSwingHighs(candles, 3);
  
  if (direction === "LONG") {
    // Need: price swept a recent low, then 8/21 cross up
    const last5m = candles[candles.length - 1];
    const prevLow = Math.min(...recentLows.slice(0, -1));
    const swept = last5m.low < prevLow * 1.001 && last5m.close > prevLow;
    const crossed = prev8 <= prev21 && last8 > last21;
    
    if (swept && crossed) {
      return { triggered: true, type: "sweep + 8/21 cross up", sweepLow: last5m.low };
    }
  }
  
  if (direction === "SHORT") {
    const last5m = candles[candles.length - 1];
    const prevHigh = Math.max(...recentHighs.slice(0, -1));
    const swept = last5m.high > prevHigh * 0.999 && last5m.close < prevHigh;
    const crossed = prev8 >= prev21 && last8 < last21;
    
    if (swept && crossed) {
      return { triggered: true, type: "sweep + 8/21 cross down", sweepHigh: last5m.high };
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
    // TP = next 1H swing high (resistance)
    const nextResistance = highs.find(h => h > entry);
    if (!nextResistance) return null;
    
    // SL = below the sweep low, or below recent 1H low if no sweep
    const sl = sweepLow ? Math.min(sweepLow * 0.998, entry * 0.985) : lows[lows.length - 1] * 0.998;
    
    const rr = (nextResistance - entry) / (entry - sl);
    if (rr < MIN_RR) return null; // Skip if R:R too low
    
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
    
    const sl = sweepHigh ? Math.max(sweepHigh * 1.002, entry * 1.015) : highs[highs.length - 1] * 1.002;
    
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
  candles5m: Candle[],
  candles1h: Candle[],
  candles4h: Candle[],
  currentPrice?: number
): SignalResult {
  const debug: string[] = [];
  
  if (candles5m.length < 50 || candles1h.length < 50 || candles4h.length < 30) {
    debug.push("Insufficient candle data");
    return { debug };
  }
  
  // Step 1: 4H Trend
  const t4h = trend4H(candles4h);
  debug.push(`4H: ${t4h.direction || "NONE"} ${t4h.strength} | ADX: ${t4h.adx.toFixed(1)}`);
  
  if (!t4h.direction || t4h.strength === "WEAK") {
    debug.push("4H trend unclear or weak");
    return { debug };
  }
  
  // Step 2: 1H Confirmation
  const c1h = confirm1H(candles1h, t4h.direction);
  debug.push(`1H: ${c1h.confirms ? "CONFIRMS" : "REJECTS"} | ADX: ${c1h.adx.toFixed(1)}`);
  
  if (!c1h.confirms) {
    debug.push("1H does not confirm");
    return { debug };
  }
  
  // Step 3: 5M Trigger
  const t5m = trigger5M(candles5m, t4h.direction);
  debug.push(`5M: ${t5m.triggered ? t5m.type.toUpperCase() : "NO SETUP"}`);
  
  if (!t5m.triggered) {
    debug.push("No 5M trigger");
    return { debug };
  }
  
  // Step 4: Structure TP/SL
  const price = currentPrice ?? candles5m[candles5m.length - 1].close;
  const levels = getStructureLevels(
    candles1h,
    t4h.direction,
    price,
    t5m.sweepLow,
    t5m.sweepHigh
  );
  
  if (!levels) {
    debug.push("No valid structure levels (R:R < 1.5 or no swing high/low)");
    return { debug };
  }
  
  debug.push(`Structure: ${levels.structure} | TP: ${levels.tp} | SL: ${levels.sl} | RR: ${levels.rr}`);
  
  const signal: Signal = {
    id: `${pair}_${Date.now()}`,
    pair,
    direction: t4h.direction,
    entry: Math.round(price * 100) / 100,
    stop: levels.sl,
    target: levels.tp,
    rr: levels.rr,
    confidence: t4h.strength === "STRONG" && c1h.adx > 30 ? 75 : t4h.strength === "STRONG" ? 65 : 55,
    trend4h: `${t4h.direction} ${t4h.strength}`,
    confirm1h: c1h.confirms,
    trigger5m: t5m.type,
    structure: levels.structure,
    timestamp: Date.now(),
  };
  
  const market = {
    pair,
    price: Math.round(price * 100) / 100,
    timestamp: Date.now(),
    trend4h: signal.trend4h,
  };
  
  debug.push(`✅ SIGNAL: ${signal.direction} ${signal.entry} | TP ${signal.target} (+${((signal.target/signal.entry-1)*100).toFixed(1)}%) | SL ${signal.stop} (-${((1-signal.stop/signal.entry)*100).toFixed(1)}%) | RR ${signal.rr}`);
  
  return { signal, market, debug };
}

// --- SIMPLE VALIDITY: Between SL and TP? ---
export function isSignalStillValid(signal: Signal, currentPrice: number): boolean {
  if (signal.direction === "LONG") {
    return currentPrice > signal.stop && currentPrice < signal.target;
  }
  return currentPrice < signal.stop && currentPrice > signal.target;
}

// --- TRADE STATUS: Active, TP, SL, or Manual Close ---
export type TradeStatus = "ACTIVE" | "TP_HIT" | "SL_HIT" | "MANUAL_CLOSE";

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
