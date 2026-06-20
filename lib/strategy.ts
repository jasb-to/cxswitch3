// lib/strategy.ts — v23.1 "Early Entry + Breakout + Position Building"
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

export const CURRENT_SIGNAL_VERSION = 3;
const SL_PCT = 0.015;
const TP_PCT = 0.04;
const RETEST_BUFFER = 0.003;
const MAX_RETEST_HOURS = 3;
const TREND_LOOKBACK = 8;
const ADX_MIN = 20;

function generateSignalId(pair: string): string {
  return `${pair}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function avg(arr: number[]): number {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function rsi(closes: number[], period = 14): number {
  let gains = 0, losses = 0;
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

function stoch(candles: Candle[], kPeriod = 14, dPeriod = 3): { k: number; d: number } {
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

function adx(candles: Candle[], period = 14): number {
  const trs: number[] = [], plusDMs: number[] = [], minusDMs: number[] = [];
  for (let i = 1; i < candles.length && i <= period + 1; i++) {
    const c = candles[candles.length - i], p = candles[candles.length - i - 1];
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

// --- TREND DETECTION ---
interface TrendResult {
  direction: "LONG" | "SHORT" | null;
  swing1: number;
  swing2: number;
  adx: number;
  health: string;
}

function detectTrend(candles: Candle[]): TrendResult {
  const len = candles.length;
  const recent = candles.slice(-TREND_LOOKBACK);
  const highs = recent.map(c => c.high);
  const lows = recent.map(c => c.low);
  const closes = recent.map(c => c.close);
  
  const hh: number[] = [];
  const ll: number[] = [];
  for (let i = 1; i < recent.length - 1; i++) {
    if (recent[i].high > recent[i-1].high && recent[i].high > recent[i+1].high) hh.push(recent[i].high);
    if (recent[i].low < recent[i-1].low && recent[i].low < recent[i+1].low) ll.push(recent[i].low);
  }
  
  const adxVal = adx(candles);
  const lastClose = closes[closes.length - 1];
  
  if (hh.length >= 2 && ll.length >= 2) {
    const higherHighs = hh[hh.length-1] > hh[hh.length-2];
    const higherLows = ll[ll.length-1] > ll[ll.length-2];
    const lowerHighs = hh[hh.length-1] < hh[hh.length-2];
    const lowerLows = ll[ll.length-1] < ll[ll.length-2];
    
    if (higherHighs && higherLows && lastClose > avg(closes)) {
      return { direction: "LONG", swing1: ll[ll.length-2], swing2: ll[ll.length-1], adx: adxVal, health: adxVal > 25 ? "STRONG" : "WEAK" };
    }
    if (lowerHighs && lowerLows && lastClose < avg(closes)) {
      return { direction: "SHORT", swing1: hh[hh.length-2], swing2: hh[hh.length-1], adx: adxVal, health: adxVal > 25 ? "STRONG" : "WEAK" };
    }
  }
  
  return { direction: null, swing1: 0, swing2: 0, adx: adxVal, health: "NONE" };
}

// --- EARLY ENTRY DETECTION ---
interface EarlySignal {
  valid: boolean;
  type: string;
  confidence: number;
}

function detectEarlyEntry(candles1h: Candle[], candles15m: Candle[], trend: TrendResult): EarlySignal {
  const len1h = candles1h.length;
  const len15m = candles15m.length;
  if (len1h < 20 || len15m < 20) return { valid: false, type: "insufficient_data", confidence: 0 };

  const recent1h = candles1h.slice(-6);
  const recent15m = candles15m.slice(-8);
  const closes1h = candles1h.map(c => c.close);
  const rsi1h = rsi(closes1h);
  const stoch15 = stoch(candles15m);
  const currentPrice = candles1h[len1h - 1].close;

  const last1h = candles1h[len1h - 1];
  const prev1h = candles1h[len1h - 2];
  const prevLow = Math.min(...candles1h.slice(-4, -1).map(c => c.low));
  const prevHigh = Math.max(...candles1h.slice(-4, -1).map(c => c.high));

  let sweepDetected = false;
  let divergenceDetected = false;
  let volumeSpike = false;
  let momentumCandle = false;

  const recentVol = recent1h.map(c => c.volume);
  const avgVol = avg(recentVol.slice(0, -1));
  if (avgVol > 0 && recentVol[recentVol.length - 1] > avgVol * 1.5) volumeSpike = true;

  if (trend.direction === "LONG") {
    const wickLow = Math.min(last1h.low, prev1h.low);
    if (wickLow < prevLow * 1.002 && last1h.close > prevLow) {
      sweepDetected = true;
    }
    const priceLL = last1h.low < prev1h.low;
    const rsiHL = rsi1h > 30 && rsi1h > rsi(candles1h.slice(0, -1).map(c => c.close));
    if (priceLL && rsiHL) divergenceDetected = true;
    const body = last1h.close - last1h.open;
    const range = last1h.high - last1h.low;
    if (body > 0 && body / range > 0.6) momentumCandle = true;

    const score = (sweepDetected ? 30 : 0) + (divergenceDetected ? 25 : 0) + 
                  (volumeSpike ? 20 : 0) + (momentumCandle ? 15 : 0) +
                  (stoch15.k < 30 ? 10 : 0);

    if (score >= 40) {
      return { valid: true, type: `sweep${divergenceDetected ? "_div" : ""}${volumeSpike ? "_vol" : ""}`, confidence: Math.min(75, score) };
    }
  }

  if (trend.direction === "SHORT") {
    const wickHigh = Math.max(last1h.high, prev1h.high);
    if (wickHigh > prevHigh * 0.998 && last1h.close < prevHigh) {
      sweepDetected = true;
    }
    const priceHH = last1h.high > prev1h.high;
    const rsiLH = rsi1h < 70 && rsi1h < rsi(candles1h.slice(0, -1).map(c => c.close));
    if (priceHH && rsiLH) divergenceDetected = true;
    const body = last1h.open - last1h.close;
    const range = last1h.high - last1h.low;
    if (body > 0 && body / range > 0.6) momentumCandle = true;

    const score = (sweepDetected ? 30 : 0) + (divergenceDetected ? 25 : 0) + 
                  (volumeSpike ? 20 : 0) + (momentumCandle ? 15 : 0) +
                  (stoch15.k > 70 ? 10 : 0);

    if (score >= 40) {
      return { valid: true, type: `sweep${divergenceDetected ? "_div" : ""}${volumeSpike ? "_vol" : ""}`, confidence: Math.min(75, score) };
    }
  }

  return { valid: false, type: "no_early_setup", confidence: 0 };
}

// --- PRICE ACTION ---
interface PriceAction {
  valid: boolean;
  type: string;
}

function checkPriceAction(candles: Candle[], direction: "LONG" | "SHORT", trendlinePrice: number): PriceAction {
  const c = candles[candles.length - 1];
  const p = candles[candles.length - 2];
  
  const body = Math.abs(c.close - c.open);
  const upperWick = c.high - Math.max(c.open, c.close);
  const lowerWick = Math.min(c.open, c.close) - c.low;
  
  if (direction === "LONG") {
    const touchedLine = c.low <= trendlinePrice * (1 + RETEST_BUFFER) && c.low >= trendlinePrice * (1 - RETEST_BUFFER);
    const pinBar = lowerWick > body * 1.5 && c.close > c.open;
    const engulfing = c.close > p.high && c.open < p.close && c.close > c.open;
    if (touchedLine && pinBar) return { valid: true, type: "pin_bar_rejection" };
    if (touchedLine && engulfing) return { valid: true, type: "bullish_engulfing" };
    if (c.close < trendlinePrice * (1 - RETEST_BUFFER)) return { valid: false, type: "close_below_line" };
  }
  
  if (direction === "SHORT") {
    const touchedLine = c.high >= trendlinePrice * (1 - RETEST_BUFFER) && c.high <= trendlinePrice * (1 + RETEST_BUFFER);
    const pinBar = upperWick > body * 1.5 && c.close < c.open;
    const engulfing = c.close < p.low && c.open > p.close && c.close < c.open;
    if (touchedLine && pinBar) return { valid: true, type: "pin_bar_rejection" };
    if (touchedLine && engulfing) return { valid: true, type: "bearish_engulfing" };
    if (c.close > trendlinePrice * (1 + RETEST_BUFFER)) return { valid: false, type: "close_above_line" };
  }
  
  return { valid: false, type: "no_rejection" };
}

// --- SIGNAL GENERATION ---
export async function generateSignal(
  pair: string,
  candles1h: Candle[],
  candles4h: Candle[],
  candles15m: Candle[]
): Promise<SignalResult> {
  const debug: string[] = [];
  const currentPrice = candles1h[candles1h.length - 1].close;
  
  const trend = detectTrend(candles4h);
  debug.push(`4H_trend:${trend.direction || "NONE"}_adx:${trend.adx.toFixed(1)}_health:${trend.health}`);
  
  const market = {
    pair, price: currentPrice, structure: trend.direction || "RANGE", health: trend.health,
    adx: trend.adx, rsi: rsi(candles1h.map(c => c.close)),
    stochK: stoch(candles15m, 14, 3).k, stochD: stoch(candles15m, 14, 3).d,
    timestamp: Date.now(),
  };
  
  // === EARLY ENTRY CHECK ===
  if (trend.direction && trend.adx >= ADX_MIN) {
    const early = detectEarlyEntry(candles1h, candles15m, trend);
    if (early.valid) {
      debug.push(`EARLY:${early.type}_conf:${early.confidence}`);
      
      const entryPrice = candles1h[candles1h.length - 1].close;
      let stop: number, target: number, rr: number;
      
      if (trend.direction === "LONG") {
        stop = entryPrice * (1 - SL_PCT);
        target = entryPrice * (1 + TP_PCT);
        rr = (target - entryPrice) / (entryPrice - stop);
      } else {
        stop = entryPrice * (1 + SL_PCT);
        target = entryPrice * (1 - TP_PCT);
        rr = (entryPrice - target) / (stop - entryPrice);
      }
      
      if (rr >= 1.5) {
        const rsiVal = rsi(candles1h.map(c => c.close));
        const stoch15 = stoch(candles15m, 14, 3);
        
        const signal: Signal = {
          id: generateSignalId(pair),
          pair, direction: trend.direction, type: "EARLY",
          entry: Math.round(entryPrice * 100) / 100,
          stop: Math.round(stop * 100) / 100,
          target: Math.round(target * 100) / 100,
          confidence: early.confidence,
          rr: Math.round(rr * 100) / 100,
          adx: Math.round(trend.adx * 10) / 10,
          rsi: Math.round(rsiVal * 10) / 10,
          stochK: stoch15.k,
          stochD: stoch15.d,
          expectedMove: TP_PCT * 100,
          reason: `${trend.direction} EARLY | ${early.type} | 4H:${trend.direction} ${trend.health} ADX ${trend.adx.toFixed(1)} | Conf:${early.confidence} | Add on retest`,
          timestamp: Date.now(),
          version: CURRENT_SIGNAL_VERSION,
        };
        
        debug.push(`SIGNAL:EARLY_${trend.direction}_entry:${signal.entry}_rr:${signal.rr}`);
        return { signal, market, debug };
      }
    }
  }
  
  // === STANDARD BREAKOUT/RETEST LOGIC ===
  if (!trend.direction) {
    debug.push("no_trend:range_or_choppy");
    return { market, debug };
  }
  if (trend.adx < ADX_MIN) {
    debug.push(`weak_trend:adx_${trend.adx.toFixed(1)}`);
    return { market, debug };
  }
  
  const last4h = candles4h[candles4h.length - 1];
  const trendlineNow = trend.swing2;
  let breakConfirmed = false;
  let breakTime = 0;
  
  if (trend.direction === "LONG") {
    if (last4h.close < trendlineNow) {
      breakConfirmed = true;
      breakTime = last4h.timestamp;
      debug.push(`BREAK:4H_close_${last4h.close}_below_line_${trendlineNow.toFixed(2)}`);
    }
  } else {
    if (last4h.close > trendlineNow) {
      breakConfirmed = true;
      breakTime = last4h.timestamp;
      debug.push(`BREAK:4H_close_${last4h.close}_above_line_${trendlineNow.toFixed(2)}`);
    }
  }
  
  if (!breakConfirmed) {
    debug.push("no_break:price_not_through_trendline");
    return { market, debug };
  }
  
  const hoursSinceBreak = (Date.now() - breakTime) / (1000 * 60 * 60);
  if (hoursSinceBreak > MAX_RETEST_HOURS) {
    debug.push(`retest_expired:${hoursSinceBreak.toFixed(1)}h`);
    return { market, debug };
  }
  
  const pa = checkPriceAction(candles15m, trend.direction, trendlineNow);
  debug.push(`15m_retest:${pa.type}`);
  
  if (!pa.valid) {
    debug.push("retest_invalid:" + pa.type);
    return { market, debug };
  }
  
  const entryPrice = candles15m[candles15m.length - 1].close;
  
  let stop: number, target: number, rr: number;
  if (trend.direction === "LONG") {
    stop = entryPrice * (1 - SL_PCT);
    target = entryPrice * (1 + TP_PCT);
    rr = (target - entryPrice) / (entryPrice - stop);
  } else {
    stop = entryPrice * (1 + SL_PCT);
    target = entryPrice * (1 - TP_PCT);
    rr = (entryPrice - target) / (stop - entryPrice);
  }
  
  if (rr < 1.5) {
    debug.push(`rr_too_low:${rr.toFixed(2)}`);
    return { market, debug };
  }
  
  const rsiVal = rsi(candles1h.map(c => c.close));
  const stoch15 = stoch(candles15m, 14, 3);
  
  let confidence = 70;
  confidence += trend.adx > 30 ? 15 : trend.adx > 25 ? 10 : 5;
  confidence += pa.type.includes("engulfing") ? 5 : 0;
  confidence = Math.min(95, confidence);
  
  const signal: Signal = {
    id: generateSignalId(pair),
    pair, direction: trend.direction, type: pa.type.includes("engulfing") ? "BREAKOUT" : "PULLBACK",
    entry: Math.round(entryPrice * 100) / 100,
    stop: Math.round(stop * 100) / 100,
    target: Math.round(target * 100) / 100,
    confidence,
    rr: Math.round(rr * 100) / 100,
    adx: Math.round(trend.adx * 10) / 10,
    rsi: Math.round(rsiVal * 10) / 10,
    stochK: stoch15.k,
    stochD: stoch15.d,
    expectedMove: TP_PCT * 100,
    reason: `${trend.direction} | 4H:${trend.direction} ${trend.health} ADX ${trend.adx.toFixed(1)} | Break:${breakConfirmed} | Retest:${pa.type} | Conf:${confidence}`,
    timestamp: Date.now(),
    version: CURRENT_SIGNAL_VERSION,
  };
  
  debug.push(`SIGNAL:${signal.type}_${trend.direction}_entry:${signal.entry}_rr:${signal.rr}`);
  return { signal, market, debug };
}

export function isSignalStillValid(signal: Signal, currentPrice: number): boolean {
  if (!signal || signal.version !== CURRENT_SIGNAL_VERSION) return false;
  const ageHours = (Date.now() - signal.timestamp) / (1000 * 60 * 60);
  if (ageHours > 48) return false;
  if (signal.direction === "LONG") {
    if (currentPrice <= signal.stop) return false;
    if (currentPrice >= signal.target) return false;
  } else {
    if (currentPrice >= signal.stop) return false;
    if (currentPrice <= signal.target) return false;
  }
  return true;
}

export function shouldHold(signal: Signal, candles4h: Candle[], currentPrice: number): { shouldHold: boolean; reason: string } {
  const trend = detectTrend(candles4h);
  if (signal.direction === "LONG" && trend.direction === "SHORT") {
    return { shouldHold: false, reason: "TREND FLIP: 4H now DOWNTREND. Exit LONG." };
  }
  if (signal.direction === "SHORT" && trend.direction === "LONG") {
    return { shouldHold: false, reason: "TREND FLIP: 4H now UPTREND. Exit SHORT." };
  }
  const ageHours = (Date.now() - signal.timestamp) / (1000 * 60 * 60);
  if (ageHours > 48) {
    return { shouldHold: false, reason: `TIME STOP: Signal ${ageHours.toFixed(1)}h old. Exit.` };
  }
  return { shouldHold: true, reason: `4H ${trend.direction || "RANGE"} ${trend.health}. Hold for ${signal.target.toFixed(2)}.` };
}
