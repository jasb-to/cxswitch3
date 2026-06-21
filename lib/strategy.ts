// lib/strategy.ts — v23.3 "FIXED: EARLY TTL + Signal Expiry + shouldHold API"
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
const TREND_LOOKBACK = 20;
const ADX_MIN = 20;

// --- TTL CONFIGURATION ---
const EARLY_TTL_MS = 60 * 60 * 1000;        // 1 hour
const DEFAULT_TTL_MS = 48 * 60 * 60 * 1000;  // 48 hours

function generateSignalId(pair: string): string {
  return `${pair}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
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

// --- TREND DETECTION ---
interface TrendResult {
  direction: "LONG" | "SHORT" | null;
  swing1: number;
  swing2: number;
  adx: number;
  health: string;
}

function findSwingHighs(candles: Candle[], lookback: number): number[] {
  const swings: number[] = [];
  for (let i = 2; i < candles.length - 2 && swings.length < lookback; i++) {
    const c = candles[candles.length - 1 - i];
    const p1 = candles[candles.length - i];
    const p2 = candles[candles.length - i + 1];
    const n1 = candles[candles.length - 2 - i];
    const n2 = candles[candles.length - 3 - i];
    if (c.high > p1.high && c.high > p2.high && c.high > n1.high && c.high > n2.high) swings.push(c.high);
  }
  return swings.reverse();
}

function findSwingLows(candles: Candle[], lookback: number): number[] {
  const swings: number[] = [];
  for (let i = 2; i < candles.length - 2 && swings.length < lookback; i++) {
    const c = candles[candles.length - 1 - i];
    const p1 = candles[candles.length - i];
    const p2 = candles[candles.length - i + 1];
    const n1 = candles[candles.length - 2 - i];
    const n2 = candles[candles.length - 3 - i];
    if (c.low < p1.low && c.low < p2.low && c.low < n1.low && c.low < n2.low) swings.push(c.low);
  }
  return swings.reverse();
}

function detectTrend(candles: Candle[]): TrendResult {
  const adxVal = adx(candles);
  const closes = candles.map(c => c.close);
  const lastClose = closes[closes.length - 1];
  const avgClose = avg(closes.slice(-20));

  const hh = findSwingHighs(candles, 4);
  const ll = findSwingLows(candles, 4);

  if (hh.length >= 2 && ll.length >= 2) {
    const higherHighs = hh[hh.length - 1] > hh[hh.length - 2];
    const higherLows = ll[ll.length - 1] > ll[ll.length - 2];
    const lowerHighs = hh[hh.length - 1] < hh[hh.length - 2];
    const lowerLows = ll[ll.length - 1] < ll[ll.length - 2];

    if (higherHighs && higherLows && lastClose > avgClose) {
      return { direction: "LONG", swing1: ll[ll.length - 2], swing2: ll[ll.length - 1], adx: adxVal, health: adxVal > 25 ? "STRONG" : "WEAK" };
    }
    if (lowerHighs && lowerLows && lastClose < avgClose) {
      return { direction: "SHORT", swing1: hh[hh.length - 2], swing2: hh[hh.length - 1], adx: adxVal, health: adxVal > 25 ? "STRONG" : "WEAK" };
    }
  }

  const recent20 = closes.slice(-20);
  const first10 = avg(recent20.slice(0, 10));
  const last10 = avg(recent20.slice(-10));
  const slope = (last10 - first10) / first10;

  if (Math.abs(slope) > 0.01 && adxVal > ADX_MIN) {
    if (slope > 0 && lastClose > avgClose) {
      return { direction: "LONG", swing1: Math.min(...recent20), swing2: Math.min(...recent20.slice(-10)), adx: adxVal, health: adxVal > 25 ? "STRONG" : "WEAK" };
    }
    if (slope < 0 && lastClose < avgClose) {
      return { direction: "SHORT", swing1: Math.max(...recent20), swing2: Math.max(...recent20.slice(-10)), adx: adxVal, health: adxVal > 25 ? "STRONG" : "WEAK" };
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
  const closes1h = candles1h.map(c => c.close);
  const rsi1h = rsi(closes1h);
  const stoch15 = stoch(candles15m);
  const currentPrice = candles1h[len1h - 1].close;

  const last1h = candles1h[len1h - 1];
  const prev1h = candles1h[len1h - 2];
  const prevLow = Math.min(...candles1h.slice(-6, -1).map(c => c.low));
  const prevHigh = Math.max(...candles1h.slice(-6, -1).map(c => c.high));

  let sweepDetected = false;
  let divergenceDetected = false;
  let volumeSpike = false;
  let momentumCandle = false;

  const recentVol = recent1h.map(c => c.volume);
  const avgVol = avg(recentVol.slice(0, -1));
  if (avgVol > 0 && recentVol[recentVol.length - 1] > avgVol * 1.3) volumeSpike = true;

  if (trend.direction === "LONG") {
    const wickLow = Math.min(last1h.low, prev1h.low);
    if (wickLow < prevLow * 1.001 && last1h.close > prevLow) sweepDetected = true;

    const recentLows = candles1h.slice(-10).map(c => c.low);
    const lowestPriceIdx = recentLows.indexOf(Math.min(...recentLows));
    const lowestRsi = rsi(closes1h.slice(0, -(10 - lowestPriceIdx)));
    if (lowestPriceIdx >= 0 && recentLows[lowestPriceIdx] < recentLows[recentLows.length - 1] && lowestRsi < rsi1h && rsi1h > 30) {
      divergenceDetected = true;
    }
    const body = last1h.close - last1h.open;
    const range = last1h.high - last1h.low;
    if (body > 0 && range > 0 && body / range > 0.5) momentumCandle = true;

    const score = (sweepDetected ? 30 : 0) + (divergenceDetected ? 25 : 0) + (volumeSpike ? 20 : 0) + (momentumCandle ? 15 : 0) + (stoch15.k < 35 ? 10 : 0) + (trend.adx > 25 ? 10 : 0);
    if (score >= 35) return { valid: true, type: `sweep${divergenceDetected ? "_div" : ""}${volumeSpike ? "_vol" : ""}`, confidence: Math.min(80, score) };
  }

  if (trend.direction === "SHORT") {
    const wickHigh = Math.max(last1h.high, prev1h.high);
    if (wickHigh > prevHigh * 0.999 && last1h.close < prevHigh) sweepDetected = true;

    const recentHighs = candles1h.slice(-10).map(c => c.high);
    const highestPriceIdx = recentHighs.indexOf(Math.max(...recentHighs));
    const highestRsi = rsi(closes1h.slice(0, -(10 - highestPriceIdx)));
    if (highestPriceIdx >= 0 && recentHighs[highestPriceIdx] > recentHighs[recentHighs.length - 1] && highestRsi > rsi1h && rsi1h < 70) {
      divergenceDetected = true;
    }
    const body = last1h.open - last1h.close;
    const range = last1h.high - last1h.low;
    if (body > 0 && range > 0 && body / range > 0.5) momentumCandle = true;

    const score = (sweepDetected ? 30 : 0) + (divergenceDetected ? 25 : 0) + (volumeSpike ? 20 : 0) + (momentumCandle ? 15 : 0) + (stoch15.k > 65 ? 10 : 0) + (trend.adx > 25 ? 10 : 0);
    if (score >= 35) return { valid: true, type: `sweep${divergenceDetected ? "_div" : ""}${volumeSpike ? "_vol" : ""}`, confidence: Math.min(80, score) };
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

  return { valid: false, type: "no_setup" };
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

  if (candles1h.length < 50 || candles4h.length < 20 || candles15m.length < 20) {
    debug.push("Insufficient candle data");
    return { debug };
  }

  const trend = detectTrend(candles4h);
  debug.push(`Trend: ${trend.direction || "NONE"} | ADX: ${trend.adx.toFixed(1)} | Health: ${trend.health}`);

  if (!trend.direction) {
    debug.push("No trend detected");
    return { debug };
  }

  if (trend.adx < ADX_MIN) {
    debug.push(`ADX too weak: ${trend.adx.toFixed(1)} < ${ADX_MIN}`);
    return { debug };
  }

  const early = detectEarlyEntry(candles1h, candles15m, trend);
  debug.push(`Early: ${early.valid ? "YES" : "NO"} | Type: ${early.type} | Conf: ${early.confidence}`);

  if (!early.valid) {
    debug.push("No early entry setup");
    return { debug };
  }

  const direction = trend.direction;
  const isLong = direction === "LONG";
  const swing1 = trend.swing1;
  const swing2 = trend.swing2;
  const price = currentPrice ?? candles1h[candles1h.length - 1].close;

  let entry: number;
  let stop: number;
  let target: number;

  if (isLong) {
    entry = Math.min(price, swing2 * 1.002);
    stop = Math.min(swing1 * 0.998, entry * (1 - SL_PCT));
    target = entry * (1 + TP_PCT);
  } else {
    entry = Math.max(price, swing2 * 0.998);
    stop = Math.max(swing1 * 1.002, entry * (1 + SL_PCT));
    target = entry * (1 - TP_PCT);
  }

  const rr = Math.abs((target - entry) / (entry - stop));
  const expectedMove = Math.abs((target - entry) / entry) * 100;
  const rsi1h = rsi(candles1h.map(c => c.close));
  const stoch15 = stoch(candles15m);

  const signal: Signal = {
    id: generateSignalId(pair),
    pair,
    direction,
    type: "EARLY",
    entry: Math.round(entry * 100) / 100,
    stop: Math.round(stop * 100) / 100,
    target: Math.round(target * 100) / 100,
    confidence: early.confidence,
    rr: Math.round(rr * 100) / 100,
    adx: Math.round(trend.adx * 10) / 10,
    rsi: Math.round(rsi1h * 10) / 10,
    stochK: stoch15.k,
    stochD: stoch15.d,
    expectedMove: Math.round(expectedMove * 10) / 10,
    reason: `${direction} EARLY | ${early.type} | 4H:${direction} ${trend.health} ADX ${trend.adx.toFixed(1)} | Conf:${early.confidence} | Add on retest`,
    timestamp: Date.now(),
    version: CURRENT_SIGNAL_VERSION,
  };

  const market = {
    pair,
    price: Math.round(price * 100) / 100,
    timestamp: Date.now(),
    trend: `${direction} ${trend.health}`,
    adx: signal.adx,
    rsi: signal.rsi,
    stochK: signal.stochK,
    stochD: signal.stochD,
  };

  debug.push(`Generated ${direction} EARLY | Entry: ${signal.entry} | Stop: ${signal.stop} | Target: ${signal.target} | RR: ${signal.rr}`);
  return { signal, market, debug };
}

// --- SIGNAL VALIDITY CHECK ---
export interface ValidityCheck {
  valid: boolean;
  reason: string;
  exited: boolean;
}

export function isSignalStillValid(signal: Signal, currentPrice: number, now: number = Date.now()): ValidityCheck {
  const ageMs = now - signal.timestamp;

  // EARLY signals expire after 1 hour
  if (signal.type === "EARLY") {
    if (ageMs > EARLY_TTL_MS) {
      return { valid: false, reason: "expired_early_ttl", exited: true };
    }
    if (signal.direction === "LONG" && currentPrice > signal.entry * 1.001) {
      return { valid: false, reason: "missed_long_entry", exited: true };
    }
    if (signal.direction === "SHORT" && currentPrice < signal.entry * 0.999) {
      return { valid: false, reason: "missed_short_entry", exited: true };
    }
  }

  if (ageMs > DEFAULT_TTL_MS) {
    return { valid: false, reason: "expired_default_ttl", exited: true };
  }

  if (signal.direction === "LONG" && currentPrice <= signal.stop) {
    return { valid: false, reason: "stop_loss_hit", exited: true };
  }
  if (signal.direction === "SHORT" && currentPrice >= signal.stop) {
    return { valid: false, reason: "stop_loss_hit", exited: true };
  }

  if (signal.direction === "LONG" && currentPrice >= signal.target) {
    return { valid: false, reason: "target_hit", exited: true };
  }
  if (signal.direction === "SHORT" && currentPrice <= signal.target) {
    return { valid: false, reason: "target_hit", exited: true };
  }

  return { valid: true, reason: "active", exited: false };
}

// --- shouldHold: used by cron + UI. Returns { shouldHold, reason } for backward compat ---
export interface HoldResult {
  shouldHold: boolean;
  reason: string;
}

export function shouldHold(signal: Signal, candles4h: Candle[], currentPrice: number, now?: number): HoldResult {
  // Trend health check: if trend reversed, don't hold
  const trend = detectTrend(candles4h);
  const trendReversed = (signal.direction === "LONG" && trend.direction === "SHORT") ||
                        (signal.direction === "SHORT" && trend.direction === "LONG");

  if (trendReversed) {
    return { shouldHold: false, reason: "trend_reversed" };
  }

  if (trend.health === "NONE" || trend.adx < 20) {
    return { shouldHold: false, reason: "trend_weak" };
  }

  // Delegate to main validity check
  const validity = isSignalStillValid(signal, currentPrice, now);
  return {
    shouldHold: validity.valid,
    reason: validity.reason,
  };
}

// --- CRON HELPERS ---
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
    if (check.valid) {
      active.push(signal);
    } else {
      exited.push({ signal, reason: check.reason });
    }
  }

  return { active, exited };
}
