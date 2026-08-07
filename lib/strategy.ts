// lib/strategy.ts — v31.1 "Bias + Pullback to TL + StochRSI K/D Cross"
// ============================================================
// Wider SL for 10-20x leverage: uses 4H swing structure + 1x 4H ATR.
// Enters BEFORE the 4H break. 15m confirmation at 4H TL zone uses StochRSI K/D cross.
// ADX/RSI/StochRSI calculated for DISPLAY (not signal logic).
// Stateless. Compatible with v54 cron / v50.1 telegram / v54 dashboard.

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
  type: "ENTRY_1" | "ENTRY_2" | "ADD";
  scale: "ENTRY_1" | "ENTRY_2" | "ADD" | null;
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
  trend?: string;
  location?: string;
  trigger?: string;
  context?: any;
}

export interface SignalResult {
  signals?: Signal[];
  signal?: Signal;
  market?: any;
  debug: string[];
}

export const CURRENT_SIGNAL_VERSION = 31;
const MIN_RR = 1.5;
const TL_THRESHOLD = 0.012;
const MIN_R2 = 0.60;
const SL_ATR_MULT = 1.0; // 1x 4H ATR for wider stops on 10-20x leverage

function avg(arr: number[]): number {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function ema(closes: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const ema: number[] = [closes[0]];
  for (let i = 1; i < closes.length; i++) {
    ema.push(closes[i] * k + ema[i - 1] * (1 - k));
  }
  return ema;
}

function atr(candles: Candle[], period: number = 14): number {
  const start = Math.max(1, candles.length - period);
  const trs: number[] = [];
  for (let i = start; i < candles.length; i++) {
    const c = candles[i];
    const p = candles[i - 1];
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
  }
  return avg(trs);
}

// --- RSI ---
function rsi(closes: number[], period: number = 14): number {
  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period && i < closes.length; i++) {
    const change = closes[closes.length - i] - closes[closes.length - i - 1];
    if (change > 0) gains += change;
    else losses += Math.abs(change);
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  return 100 - (100 / (1 + avgGain / avgLoss));
}

// --- RSI SERIES ---
function rsiSeries(closes: number[], period: number = 14): number[] {
  const series: number[] = [];
  for (let i = period; i < closes.length; i++) {
    const window = closes.slice(i - period + 1, i + 1);
    series.push(rsi(window, period));
  }
  return series;
}

// --- STOCHRSI ---
function stochRsi(closes: number[], rsiPeriod: number = 14, stochPeriod: number = 14, kSmooth: number = 3, dSmooth: number = 3): { k: number; d: number } {
  const rsiValues = rsiSeries(closes, rsiPeriod);
  if (rsiValues.length < stochPeriod + kSmooth - 1) return { k: 50, d: 50 };

  const rawK: number[] = [];
  for (let i = stochPeriod - 1; i < rsiValues.length; i++) {
    const window = rsiValues.slice(i - stochPeriod + 1, i + 1);
    const lowest = Math.min(...window);
    const highest = Math.max(...window);
    if (highest === lowest) {
      rawK.push(50);
    } else {
      rawK.push(((rsiValues[i] - lowest) / (highest - lowest)) * 100);
    }
  }

  const kValues: number[] = [];
  for (let i = kSmooth - 1; i < rawK.length; i++) {
    kValues.push(avg(rawK.slice(i - kSmooth + 1, i + 1)));
  }

  if (kValues.length < dSmooth) return { k: 50, d: 50 };

  const currentK = kValues[kValues.length - 1];
  const currentD = avg(kValues.slice(-dSmooth));

  return { k: Math.round(currentK * 10) / 10, d: Math.round(currentD * 10) / 10 };
}

// --- WILDER SMOOTHING ---
function wilderSmooth(values: number[], period: number): number[] {
  const result: number[] = [avg(values.slice(0, period))];
  for (let i = period; i < values.length; i++) {
    result.push((result[result.length - 1] * (period - 1) + values[i]) / period);
  }
  return result;
}

// --- ADX ---
function adx(candles: Candle[], period: number = 14): number {
  if (candles.length < period + 1) return 0;

  const trs: number[] = [];
  const plusDMs: number[] = [];
  const minusDMs: number[] = [];

  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const p = candles[i - 1];
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
    plusDMs.push(c.high - p.high > p.low - c.low ? Math.max(c.high - p.high, 0) : 0);
    minusDMs.push(p.low - c.low > c.high - p.high ? Math.max(p.low - c.low, 0) : 0);
  }

  const atrSmooth = wilderSmooth(trs, period);
  const plusDISmooth = wilderSmooth(plusDMs, period);
  const minusDISmooth = wilderSmooth(minusDMs, period);

  const dxValues: number[] = [];
  for (let i = 0; i < atrSmooth.length; i++) {
    const pDI = (plusDISmooth[i] / atrSmooth[i]) * 100;
    const mDI = (minusDISmooth[i] / atrSmooth[i]) * 100;
    const dx = (pDI + mDI === 0) ? 0 : (Math.abs(pDI - mDI) / (pDI + mDI)) * 100;
    dxValues.push(dx);
  }

  const adxSmooth = wilderSmooth(dxValues, period);
  return Math.round(adxSmooth[adxSmooth.length - 1] * 10) / 10;
}

function aggregateTo1D(candles4h: Candle[]): Candle[] {
  const sorted = [...candles4h].sort((a, b) => a.timestamp - b.timestamp);
  const groups = new Map<string, Candle[]>();
  for (const c of sorted) {
    const d = new Date(c.timestamp);
    const key = `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
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

function getBias(candles: Candle[]): "LONG" | "SHORT" | null {
  if (candles.length < 30) return null;
  const closes = candles.map(c => c.close);
  const ema8 = ema(closes, 8);
  const ema21 = ema(closes, 21);
  const e8 = ema8[ema8.length - 1];
  const e21 = ema21[ema21.length - 1];

  const recent = candles.slice(-5);
  const lows = recent.map(c => c.low);
  const highs = recent.map(c => c.high);
  const ll = lows[lows.length - 1] < Math.min(...lows.slice(0, -1));
  const hh = highs[highs.length - 1] > Math.max(...highs.slice(0, -1));

  if (e8 > e21 && !ll) return "LONG";
  if (e8 < e21 && !hh) return "SHORT";
  return null;
}

function findPivots(candles: Candle[], direction: "LONG" | "SHORT") {
  const pivots: { index: number; price: number; timestamp: number }[] = [];
  for (let i = 3; i < candles.length - 3; i++) {
    const isSwingLow =
      candles[i].low < candles[i - 1].low &&
      candles[i].low < candles[i - 2].low &&
      candles[i].low < candles[i + 1].low &&
      candles[i].low < candles[i + 2].low;
    const isSwingHigh =
      candles[i].high > candles[i - 1].high &&
      candles[i].high > candles[i - 2].high &&
      candles[i].high > candles[i + 1].high &&
      candles[i].high > candles[i + 2].high;

    if (direction === "LONG" && isSwingLow) {
      pivots.push({ index: i, price: candles[i].low, timestamp: candles[i].timestamp });
    }
    if (direction === "SHORT" && isSwingHigh) {
      pivots.push({ index: i, price: candles[i].high, timestamp: candles[i].timestamp });
    }
  }
  return pivots;
}

function fitTrendline(pivots: { index: number; price: number }[]) {
  if (pivots.length < 3) return null;
  const pts = pivots.slice(-5);
  const n = pts.length;
  const sumX = pts.reduce((s, p) => s + p.index, 0);
  const sumY = pts.reduce((s, p) => s + p.price, 0);
  const sumXY = pts.reduce((s, p) => s + p.index * p.price, 0);
  const sumX2 = pts.reduce((s, p) => s + p.index * p.index, 0);
  const denom = n * sumX2 - sumX * sumX;
  if (denom === 0) return null;
  const slope = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;

  const yMean = sumY / n;
  const ssTotal = pts.reduce((s, p) => s + Math.pow(p.price - yMean, 2), 0);
  const ssResidual = pts.reduce((s, p) => s + Math.pow(p.price - (slope * p.index + intercept), 2), 0);
  const r2 = ssTotal === 0 ? 0 : 1 - (ssResidual / ssTotal);
  if (r2 < MIN_R2) return null;

  return { slope, intercept, r2: Math.round(r2 * 100) / 100 };
}

// --- 15m PULLBACK WITH STOCHRSI K/D CROSS ---
function findPullbackEntry(
  candles15m: Candle[],
  direction: "LONG" | "SHORT",
  tlPrice: number
): { entry: number; reason: string; stochK: number; stochD: number } | null {
  if (candles15m.length < 40) return null;

  const last = candles15m[candles15m.length - 1];
  const closes15m = candles15m.map(c => c.close);
  const stoch = stochRsi(closes15m, 14, 14, 3, 3);

  const nearTL = Math.abs(last.close - tlPrice) / tlPrice < TL_THRESHOLD;

  if (direction === "LONG") {
    const stochBull = stoch.k > stoch.d && stoch.k < 50;
    const atSupport = nearTL || last.low <= tlPrice * 1.005;
    const confirming = last.close > last.open;

    if (atSupport && (stochBull || confirming)) {
      return {
        entry: last.close,
        reason: stochBull ? "15m TL + Stoch K>D" : "15m TL retest + bull candle",
        stochK: stoch.k,
        stochD: stoch.d,
      };
    }
  } else {
    const stochBear = stoch.k < stoch.d && stoch.k > 50;
    const atResistance = nearTL || last.high >= tlPrice * 0.995;
    const confirming = last.close < last.open;

    if (atResistance && (stochBear || confirming)) {
      return {
        entry: last.close,
        reason: stochBear ? "15m TL + Stoch K<D" : "15m TL retest + bear candle",
        stochK: stoch.k,
        stochD: stoch.d,
      };
    }
  }
  return null;
}

export function generateSignal(
  pair: string,
  candles1h: Candle[],
  candles4h: Candle[],
  candles15m: Candle[],
  _activeTrades?: any[],
  currentPrice?: number
): SignalResult {
  const debug: string[] = [];
  const now = Date.now();

  for (let i = 1; i < candles4h.length; i++) {
    if (candles4h[i].timestamp < candles4h[i - 1].timestamp) {
      debug.push("Candles not sorted");
      return { debug };
    }
  }

  if (candles4h.length < 30 || !candles15m.length) {
    debug.push("Insufficient data");
    return { debug };
  }

  const candles1d = aggregateTo1D(candles4h);
  const bias1d = getBias(candles1d);
  const bias4h = getBias(candles4h);
  debug.push(`1D: ${bias1d || "NONE"} | 4H: ${bias4h || "NONE"}`);

  if (!bias1d || !bias4h || bias1d !== bias4h) {
    debug.push("Bias mismatch");
    return { debug };
  }
  const direction = bias1d;

  const pivots = findPivots(candles4h, direction);
  const tl = fitTrendline(pivots);
  if (!tl) {
    debug.push("No trendline (R² < ${MIN_R2} or < 3 pivots)");
    return { debug };
  }

  const last4h = candles4h[candles4h.length - 1];
  const tlNow = tl.slope * (candles4h.length - 1) + tl.intercept;
  const dist = (last4h.close - tlNow) / tlNow;
  debug.push(`TL: ${tlNow.toFixed(2)} | Price: ${last4h.close.toFixed(2)} | Dist: ${(dist * 100).toFixed(2)}% | R² ${tl.r2}`);

  const nearTL = Math.abs(dist) < TL_THRESHOLD;
  if (!nearTL) {
    debug.push(`Price ${(dist * 100).toFixed(2)}% from TL — outside ${(TL_THRESHOLD * 100).toFixed(2)}% zone`);
    return { debug };
  }

  const pullback = findPullbackEntry(candles15m, direction, tlNow);
  if (!pullback) {
    debug.push("Waiting for 15m StochRSI confirmation at TL...");
    return { debug };
  }

  // WIDER SL for 10-20x leverage: 4H swing structure + 1x 4H ATR
  const atr4h = atr(candles4h, 14);
  const swingLows4h = candles4h.slice(-20).map(c => c.low);
  const swingHighs4h = candles4h.slice(-20).map(c => c.high);
  const swingLow4h = Math.min(...swingLows4h);
  const swingHigh4h = Math.max(...swingHighs4h);

  const entry = pullback.entry;
  let sl: number;
  if (direction === "LONG") {
    sl = Math.min(swingLow4h, entry - atr4h * SL_ATR_MULT);
  } else {
    sl = Math.max(swingHigh4h, entry + atr4h * SL_ATR_MULT);
  }

  const tp = direction === "LONG" ? entry + atr4h * 4 : entry - atr4h * 4;

  const rr = direction === "LONG"
    ? (tp - entry) / (entry - sl)
    : (entry - tp) / (sl - entry);

  if (!isFinite(rr) || rr < MIN_RR) {
    debug.push(`R:R ${rr?.toFixed(2) || "inf"} < ${MIN_RR}`);
    return { debug };
  }

  // 4H indicators for display
  const closes4h = candles4h.map(c => c.close);
  const adxVal = adx(candles4h);
  const rsiVal = rsi(closes4h);
  const stoch4h = stochRsi(closes4h);
  const expectedMove = Math.round((Math.abs(tp - entry) / entry * 100) * 10) / 10;

  const signal: Signal = {
    id: `${pair}_${now}`,
    pair,
    direction,
    type: "ENTRY_1",
    scale: "ENTRY_1",
    entry: Math.round(entry * 100) / 100,
    stop: Math.round(sl * 100) / 100,
    target: Math.round(tp * 100) / 100,
    confidence: 75,
    rr: Math.round(rr * 100) / 100,
    adx: adxVal,
    rsi: Math.round(rsiVal * 10) / 10,
    stochK: stoch4h.k,
    stochD: stoch4h.d,
    expectedMove,
    reason: `${direction} | ${pullback.reason} (15m K${pullback.stochK}/D${pullback.stochD}) | 4H TL ${tlNow.toFixed(1)} (R² ${tl.r2}) | RR ${rr.toFixed(2)}`,
    timestamp: now,
    version: CURRENT_SIGNAL_VERSION,
    trend: direction,
    location: "NEAR_TL",
    trigger: "READY",
    context: {
      marketPhase: `${direction} aligned`,
      structure: "trendline_pullback",
      momentum: pullback.reason,
      pullback: "active",
      crossAge: 0,
      stoch15m: { k: pullback.stochK, d: pullback.stochD },
    },
  };

  debug.push(`ENTRY: ${direction} @ ${signal.entry} | SL ${signal.stop} | TP ${signal.target} | RR ${signal.rr} | ADX ${adxVal} | RSI ${signal.rsi} | Stoch ${stoch4h.k}/${stoch4h.d}`);

  return {
    signals: [signal],
    signal,
    market: {
      pair,
      price: Math.round((currentPrice ?? entry) * 100) / 100,
      timestamp: now,
      trend: direction,
      location: "NEAR_TL",
      trigger: "READY",
      adx: adxVal,
      rsi: Math.round(rsiVal * 10) / 10,
      stochK: stoch4h.k,
      stochD: stoch4h.d,
      trendlinePrice: Math.round(tlNow * 100) / 100,
      distToTrendline: Math.round(Math.abs(dist) * 10000) / 100,
      locationType: "PRE_BREAK",
      ema8_4h: 0,
      ema21_4h: 0,
      ema50_4h: 0,
    },
    debug,
  };
}

export function getMarketSnapshot(
  pair: string,
  candles1h: Candle[],
  candles4h: Candle[],
  candles15m: Candle[]
): any {
  const candles1d = aggregateTo1D(candles4h);
  const bias1d = getBias(candles1d);
  const bias4h = getBias(candles4h);
  const price = candles4h[candles4h.length - 1].close;

  const pivots = bias4h ? findPivots(candles4h, bias4h) : [];
  const tl = bias4h ? fitTrendline(pivots) : null;
  const tlPrice = tl ? tl.slope * (candles4h.length - 1) + tl.intercept : 0;
  const dist = tlPrice ? (price - tlPrice) / tlPrice : 1;
  const nearTL = Math.abs(dist) < TL_THRESHOLD;

  let trigger = "WAITING";
  if (!bias1d || bias1d !== bias4h) {
    trigger = "BIAS_MISMATCH";
  } else if (nearTL) {
    trigger = "READY";
  }

  const closes4h = candles4h.map(c => c.close);
  const adxVal = candles4h.length >= 30 ? adx(candles4h) : 0;
  const rsiVal = candles4h.length >= 30 ? rsi(closes4h) : 0;
  const stoch = candles4h.length >= 30 ? stochRsi(closes4h) : { k: 0, d: 0 };

  return {
    pair,
    price: Math.round(price * 100) / 100,
    timestamp: Date.now(),
    trend: bias1d && bias1d === bias4h ? bias1d : "FLAT",
    location: tl ? (nearTL ? "NEAR_TL" : "BEYOND_TL") : "NONE",
    trigger,
    adx: adxVal,
    rsi: Math.round(rsiVal * 10) / 10,
    stochK: stoch.k,
    stochD: stoch.d,
    trendlinePrice: Math.round(tlPrice * 100) / 100,
    distToTrendline: tlPrice ? Math.round(Math.abs(dist) * 10000) / 100 : 0,
    locationType: tl ? "STRUCTURE" : "NONE",
    ema8_4h: 0,
    ema21_4h: 0,
    ema50_4h: 0,
  };
}

export interface ValidityCheck {
  valid: boolean;
  reason: string;
  exited: boolean;
}

export function isSignalStillValid(signal: Signal, currentPrice: number, now: number = Date.now()): ValidityCheck {
  const maxAge = 72 * 60 * 60 * 1000;
  if (now - signal.timestamp > maxAge) {
    return { valid: false, reason: "expired_ttl", exited: true };
  }

  const entryBuffer = 1.02;
  if (signal.direction === "LONG" && currentPrice > signal.entry * entryBuffer) {
    return { valid: false, reason: "missed_entry", exited: true };
  }
  if (signal.direction === "SHORT" && currentPrice < signal.entry * (2 - entryBuffer)) {
    return { valid: false, reason: "missed_entry", exited: true };
  }

  if (signal.direction === "LONG") {
    if (currentPrice <= signal.stop) return { valid: false, reason: "sl_hit", exited: true };
    if (currentPrice >= signal.target) return { valid: false, reason: "tp_hit", exited: true };
  } else {
    if (currentPrice >= signal.stop) return { valid: false, reason: "sl_hit", exited: true };
    if (currentPrice <= signal.target) return { valid: false, reason: "tp_hit", exited: true };
  }

  return { valid: true, reason: "active", exited: false };
}

export interface HoldResult {
  shouldHold: boolean;
  reason: string;
}

export function shouldHold(signal: Signal, candles4h: Candle[], currentPrice: number, _now?: number): HoldResult {
  const candles1d = aggregateTo1D(candles4h);
  const bias1d = getBias(candles1d);
  const bias4h = getBias(candles4h);

  if (signal.direction === "LONG" && bias4h === "SHORT") {
    return { shouldHold: false, reason: "4H_bias_flipped" };
  }
  if (signal.direction === "SHORT" && bias4h === "LONG") {
    return { shouldHold: false, reason: "4H_bias_flipped" };
  }

  const pivots = findPivots(candles4h, signal.direction);
  const tl = fitTrendline(pivots);
  if (tl) {
    const idx = candles4h.length - 1;
    const tlPrice = tl.slope * idx + tl.intercept;
    const last = candles4h[candles4h.length - 1];
    if (signal.direction === "LONG" && last.close < tlPrice) {
      return { shouldHold: false, reason: "trendline_reclaim" };
    }
    if (signal.direction === "SHORT" && last.close > tlPrice) {
      return { shouldHold: false, reason: "trendline_reclaim" };
    }
  }

  const validity = isSignalStillValid(signal, currentPrice);
  return { shouldHold: validity.valid, reason: validity.reason };
}

export function shouldHoldCompat(
  signal: Signal,
  candles4h: Candle[],
  _candles1h: Candle[],
  currentPrice: number
): HoldResult {
  return shouldHold(signal, candles4h, currentPrice);
}

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

export type TradeStatus = "ACTIVE" | "TP_HIT" | "SL_HIT" | "EXPIRED";

export function checkTradeStatus(signal: Signal, currentPrice: number, now: number = Date.now()): TradeStatus {
  const v = isSignalStillValid(signal, currentPrice, now);
  if (!v.valid && v.reason === "expired_ttl") return "EXPIRED";
  if (signal.direction === "LONG") {
    if (currentPrice >= signal.target) return "TP_HIT";
    if (currentPrice <= signal.stop) return "SL_HIT";
  } else {
    if (currentPrice <= signal.target) return "TP_HIT";
    if (currentPrice >= signal.stop) return "SL_HIT";
  }
  return "ACTIVE";
}

export function rebuildStateFromTrades(_trades: Record<string, any>): void {
  return;
}

export function recordTradeExit(
  _pair: string,
  _direction: "LONG" | "SHORT",
  _reason: string,
  _exitPrice: number,
  _candles4h?: Candle[]
): void {
  return;
}

export async function getMonitorState(pair: string): Promise<any | undefined> {
  return undefined;
}
export async function clearMonitorState(pair: string): Promise<void> {
  return;
}
export async function setMonitorState(pair: string, state: any): Promise<void> {
  return;
}
export function setRedisClient(_: any): void {
  return;
}

export async function generateSignalCompat(
  pair: string,
  candles1h: Candle[],
  candles4h: Candle[],
  candles15m: Candle[],
  _activeTrades?: Record<string, any>,
  currentPrice?: number
): Promise<SignalResult> {
  return generateSignal(pair, candles1h, candles4h, candles15m, [], currentPrice);
}

export function isSignalStillValidBool(signal: Signal, currentPrice: number): boolean {
  return isSignalStillValid(signal, currentPrice).valid;
}
