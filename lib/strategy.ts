// lib/strategy.ts — v34 "Back to v28"
// ============================================================
// ENTRY: Only near-trendline + stoch. No detectStopRun. No beyond-TL entries.
// EXIT: Stoch extreme opposite (v28) + SL/TP/TTL.
// RISK: v32.37 scale-out structure.
//
// CHANGES FROM v33:
// - REMOVED: detectStopRun (was creating bad entries away from TL)
// - REMOVED: beyondTrendline ADD entries (only ADX>25 breakout now)
// - REMOVED: late-trend filter (was blocking valid pullbacks)
// - REMOVED: 15m requirement
// - REMOVED: 4H bias gate
// - KEPT: v32.37 SL/TP/scale-out/breakeven
// - KEPT: dedup + progression lock

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
  tp1?: number;
  tp3?: number;
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

export const CURRENT_SIGNAL_VERSION = 34;
const MIN_RR = 1.5;
const TL_THRESHOLD = 0.012;
const MIN_R2 = 0.60;
const SL_ATR_MULT = 1.0;
const MAX_SAME_DIR = 3;

const DAILY_FAST_EMA = 5;
const DAILY_SLOW_EMA = 13;
const HOURLY_FAST_EMA = 8;
const HOURLY_SLOW_EMA = 21;

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

function rsiSeries(closes: number[], period: number = 14): number[] {
  const series: number[] = [];
  for (let i = period; i < closes.length; i++) {
    const window = closes.slice(i - period + 1, i + 1);
    series.push(rsi(window, period));
  }
  return series;
}

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

function wilderSmooth(values: number[], period: number): number[] {
  const result: number[] = [avg(values.slice(0, period))];
  for (let i = period; i < values.length; i++) {
    result.push((result[result.length - 1] * (period - 1) + values[i]) / period);
  }
  return result;
}

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

function getBias(candles: Candle[], isDaily: boolean = false): "LONG" | "SHORT" | null {
  const minLen = isDaily ? 20 : 30;
  if (candles.length < minLen) return null;

  const closes = candles.map(c => c.close);
  const fastPeriod = isDaily ? DAILY_FAST_EMA : HOURLY_FAST_EMA;
  const slowPeriod = isDaily ? DAILY_SLOW_EMA : HOURLY_SLOW_EMA;

  const emaFast = ema(closes, fastPeriod);
  const emaSlow = ema(closes, slowPeriod);
  const eFast = emaFast[emaFast.length - 1];
  const eSlow = emaSlow[emaSlow.length - 1];

  if (eFast > eSlow) return "LONG";
  if (eFast < eSlow) return "SHORT";
  return null;
}

function getTrendStrength(candles: Candle[], direction: "LONG" | "SHORT"): string {
  const highs = candles.slice(-20).map(c => c.high);
  const lows = candles.slice(-20).map(c => c.low);
  const hh = highs[highs.length - 1] > Math.max(...highs.slice(0, -1));
  const ll = lows[lows.length - 1] < Math.min(...lows.slice(0, -1));
  if (direction === "LONG" && hh) return "STRONG";
  if (direction === "SHORT" && ll) return "STRONG";
  return "MEDIUM";
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

function suggestLeverage(atr4h: number, price: number): number {
  const atrPct = atr4h / price;
  if (atrPct > 0.025) return 10;
  if (atrPct > 0.015) return 15;
  return 20;
}

// --- DEDUP + PROGRESSION ---
const signalDedup: Map<string, number> = new Map();
const DEDUP_MS = 4 * 60 * 60 * 1000;
const scaleRank: Record<string, number> = { ENTRY_1: 1, ENTRY_2: 2, ADD: 3 };
const alertedScale: Map<string, number> = new Map();

function isDup(pair: string, direction: "LONG" | "SHORT", type: string): boolean {
  const key = `${pair}_${direction}_${type}`;
  const last = signalDedup.get(key);
  if (last && Date.now() - last < DEDUP_MS) return true;
  signalDedup.set(key, Date.now());
  return false;
}

function shouldSkipScale(pair: string, direction: "LONG" | "SHORT", type: string): boolean {
  const key = `${pair}_${direction}`;
  const currentRank = scaleRank[type] || 0;
  const highest = alertedScale.get(key) || 0;
  if (currentRank <= highest) return true;
  alertedScale.set(key, currentRank);
  return false;
}

export function resetAlertProgression(pair: string, direction: "LONG" | "SHORT"): void {
  alertedScale.delete(`${pair}_${direction}`);
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

  if (candles4h.length < 30) {
    debug.push("Insufficient data");
    return { debug };
  }

  const candles1d = aggregateTo1D(candles4h);
  const bias1d = getBias(candles1d, true);
  debug.push(`1D: ${bias1d || "NONE"}`);

  if (!bias1d) {
    debug.push("1D trend unclear");
    return { debug };
  }
  const direction = bias1d;
  const strength = getTrendStrength(candles1d, direction);

  // --- TRENDLINE OR EMA FALLBACK ---
  const pivots = findPivots(candles4h, direction);
  let tl = fitTrendline(pivots);
  let usingEmaFallback = false;

  if (!tl) {
    const closes4h = candles4h.map(c => c.close);
    const ema21_4h = ema(closes4h, 21);
    tl = { slope: 0, intercept: ema21_4h[ema21_4h.length - 1], r2: 0.99 };
    usingEmaFallback = true;
    debug.push(`No TL — using EMA 21 proxy @ ${ema21_4h[ema21_4h.length - 1].toFixed(2)}`);
  }

  const last4h = candles4h[candles4h.length - 1];
  const price = currentPrice ?? last4h.close;
  const tlNow = tl.slope * (candles4h.length - 1) + tl.intercept;
  const dist = (price - tlNow) / tlNow;
  const nearTL = Math.abs(dist) < TL_THRESHOLD;

  debug.push(`${usingEmaFallback ? "EMA21" : "TL"}: ${tlNow.toFixed(2)} | Price: ${price.toFixed(2)} | Dist: ${(dist * 100).toFixed(2)}%${!usingEmaFallback ? ` | R² ${tl.r2}` : ""}`);

  // --- 4H STOCHRSI ---
  const closes4h = candles4h.map(c => c.close);
  const stoch = stochRsi(closes4h);
  debug.push(`StochRSI: K ${stoch.k} | D ${stoch.d}`);

  const stochExtreme = direction === "LONG" ? stoch.k < 20 : stoch.k > 80;
  const stochTurning = direction === "LONG" ? stoch.k > stoch.d : stoch.k < stoch.d;

  // --- ENTRY LOGIC (v28 exact) ---
  let rawType: "ENTRY_1" | "ENTRY_2" | "ADD" | null = null;

  if (nearTL && stochExtreme) {
    rawType = "ENTRY_1";
  } else if (nearTL && stochTurning && !stochExtreme) {
    rawType = "ENTRY_2";
  }
  // NO detectStopRun. NO beyond-trendline entries unless ADD with ADX>25.

  // --- ADD: Only on genuine breakout with strong ADX ---
  if (!rawType) {
    const adxVal = adx(candles4h);
    const beyondTrendline = direction === "LONG" ? price > tlNow * 1.008 : price < tlNow * 0.992;
    const confirming = direction === "LONG"
      ? last4h.close > last4h.open && last4h.close > candles4h[candles4h.length - 2].close
      : last4h.close < last4h.open && last4h.close < candles4h[candles4h.length - 2].close;
    const volUp = last4h.volume > avg(candles4h.slice(-10).map(c => c.volume)) * 1.3;

    if (beyondTrendline && confirming && adxVal > 25 && volUp) {
      rawType = "ADD";
      debug.push(`ADD: breakout + ADX ${adxVal} + vol`);
    }
  }

  if (!rawType) {
    const stateParts: string[] = [];
    if (nearTL) stateParts.push("near TL");
    else stateParts.push("far from TL");
    stateParts.push(`Stoch K${stoch.k} D${stoch.d}`);
    stateParts.push("No signal");
    debug.push(`State: ${stateParts.join(" | ")}`);
    return { debug };
  }

  // --- CORRELATION CAP ---
  const activeTrades = _activeTrades || [];
  const sameDirCount = activeTrades.filter((t: any) => t.direction === direction).length;
  if (sameDirCount >= MAX_SAME_DIR) {
    debug.push(`Correlation cap: ${sameDirCount} ${direction} active, max ${MAX_SAME_DIR}`);
    return { debug };
  }

  // --- DEDUP + PROGRESSION ---
  if (isDup(pair, direction, rawType)) {
    debug.push(`Dedup: ${rawType} ${direction} already alerted within 4h`);
    return { debug };
  }
  if (shouldSkipScale(pair, direction, rawType)) {
    debug.push(`Progression lock: ${rawType} skipped`);
    return { debug };
  }

  // --- SL / TP / RISK (v32.37 structure) ---
  const atr4h = atr(candles4h, 14);
  const swingLows4h = candles4h.slice(-20).map(c => c.low);
  const swingHighs4h = candles4h.slice(-20).map(c => c.high);
  const swingLow4h = Math.min(...swingLows4h);
  const swingHigh4h = Math.max(...swingHighs4h);

  const entry = price;
  let sl: number;
  if (direction === "LONG") {
    sl = Math.min(swingLow4h, entry - atr4h * SL_ATR_MULT);
  } else {
    sl = Math.max(swingHigh4h, entry + atr4h * SL_ATR_MULT);
  }

  const risk = Math.abs(entry - sl);
  const tp1 = direction === "LONG" ? entry + risk * 2 : entry - risk * 2;
  const tp3 = direction === "LONG" ? entry + risk * 6 : entry - risk * 6;

  const structureTarget = direction === "LONG" ? swingHigh4h : swingLow4h;
  const atrTarget = direction === "LONG" ? entry + atr4h * 4 : entry - atr4h * 4;
  const tp2 = direction === "LONG"
    ? Math.min(structureTarget, atrTarget)
    : Math.max(structureTarget, atrTarget);

  const minTp2 = direction === "LONG" ? entry + risk * 2 : entry - risk * 2;
  const finalTp2 = direction === "LONG" ? Math.max(tp2, minTp2) : Math.min(tp2, minTp2);

  const rr = direction === "LONG"
    ? (finalTp2 - entry) / (entry - sl)
    : (entry - finalTp2) / (sl - entry);

  if (!isFinite(rr) || rr < MIN_RR) {
    debug.push(`R:R ${rr?.toFixed(2) || "inf"} < ${MIN_RR}`);
    return { debug };
  }

  const rsiVal = rsi(closes4h);
  const adxVal = adx(candles4h);
  const expectedMove = Math.round((Math.abs(finalTp2 - entry) / entry * 100) * 10) / 10;

  const ema8_4h = ema(closes4h, 8);
  const ema21_4h = ema(closes4h, 21);
  const ema50_4h = ema(closes4h, 50);

  const signal: Signal = {
    id: `${pair}_${now}`,
    pair,
    direction,
    type: rawType,
    scale: rawType,
    entry: Math.round(entry * 100) / 100,
    stop: Math.round(sl * 100) / 100,
    target: Math.round(finalTp2 * 100) / 100,
    tp1: Math.round(tp1 * 100) / 100,
    tp3: Math.round(tp3 * 100) / 100,
    confidence: rawType === "ENTRY_1" ? 50 : rawType === "ENTRY_2" ? 60 : 85,
    rr: Math.round(rr * 100) / 100,
    adx: adxVal,
    rsi: Math.round(rsiVal * 10) / 10,
    stochK: stoch.k,
    stochD: stoch.d,
    expectedMove,
    reason: `${direction} ${rawType} | 1D ${strength} | Stoch K${stoch.k} D${stoch.d} | 4H ${usingEmaFallback ? "EMA21" : "TL"} ${tlNow.toFixed(1)} | RR ${rr.toFixed(2)}`,
    timestamp: now,
    version: CURRENT_SIGNAL_VERSION,
    trend: direction,
    location: nearTL ? "NEAR_TL" : "BEYOND_TL",
    trigger: "READY",
    context: {
      marketPhase: `${direction} ${strength}`,
      structure: usingEmaFallback ? "ema21_pullback" : "trendline_pullback",
      momentum: `Stoch K${stoch.k}/D${stoch.d}`,
      pullback: nearTL ? "active" : "breakout",
      crossAge: 0,
      stoch4h: { k: stoch.k, d: stoch.d },
      scaleOutPlan: {
        tp1: { price: Math.round(tp1 * 100) / 100, size: 0.50, r: 2 },
        tp2: { price: Math.round(finalTp2 * 100) / 100, size: 0.25, r: Math.round(rr * 10) / 10 },
        tp3: { price: Math.round(tp3 * 100) / 100, size: 0.25, r: 6 },
      },
      suggestedLeverage: suggestLeverage(atr4h, entry),
    },
  };

  debug.push(`${rawType}: ${direction} @ ${signal.entry} | SL ${signal.stop} | TP1 ${signal.tp1} | TP2 ${signal.target} | TP3 ${signal.tp3} | RR ${signal.rr} | ADX ${adxVal} | RSI ${signal.rsi}`);

  return {
    signals: [signal],
    signal,
    market: {
      pair,
      price: Math.round((currentPrice ?? entry) * 100) / 100,
      timestamp: now,
      trend: `${direction} ${strength}`,
      location: nearTL ? "NEAR_TL" : "BEYOND_TL",
      trigger: "READY",
      adx: adxVal,
      rsi: Math.round(rsiVal * 10) / 10,
      stochK: stoch.k,
      stochD: stoch.d,
      trendlinePrice: Math.round(tlNow * 100) / 100,
      distToTrendline: Math.round(Math.abs(dist) * 10000) / 100,
      locationType: tl ? "STRUCTURE" : "NONE",
      ema8_4h: Math.round(ema8_4h[ema8_4h.length - 1] * 100) / 100,
      ema21_4h: Math.round(ema21_4h[ema21_4h.length - 1] * 100) / 100,
      ema50_4h: Math.round(ema50_4h[ema50_4h.length - 1] * 100) / 100,
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
  const bias1d = getBias(candles1d, true);
  const price = candles4h[candles4h.length - 1].close;

  const pivots = bias1d ? findPivots(candles4h, bias1d) : [];
  let tl = bias1d ? fitTrendline(pivots) : null;
  let usingEmaFallback = false;

  if (!tl && bias1d) {
    const closes4h = candles4h.map(c => c.close);
    const ema21 = ema(closes4h, 21);
    tl = { slope: 0, intercept: ema21[ema21.length - 1], r2: 0.99 };
    usingEmaFallback = true;
  }

  const tlPrice = tl ? tl.slope * (candles4h.length - 1) + tl.intercept : 0;
  const dist = tlPrice ? (price - tlPrice) / tlPrice : 1;
  const nearTL = Math.abs(dist) < TL_THRESHOLD;

  let trigger = "WAITING";
  if (!bias1d) {
    trigger = "NO_BIAS";
  } else if (nearTL) {
    trigger = "READY";
  }

  const closes4h = candles4h.map(c => c.close);
  const adxVal = candles4h.length >= 30 ? adx(candles4h) : 0;
  const rsiVal = candles4h.length >= 30 ? rsi(closes4h) : 0;
  const stoch = candles4h.length >= 30 ? stochRsi(closes4h) : { k: 0, d: 0 };

  const ema8 = candles4h.length >= 30 ? ema(closes4h, 8) : [0];
  const ema21 = candles4h.length >= 30 ? ema(closes4h, 21) : [0];
  const ema50 = candles4h.length >= 30 ? ema(closes4h, 50) : [0];

  return {
    pair,
    price: Math.round(price * 100) / 100,
    timestamp: Date.now(),
    trend: bias1d ? `${bias1d} ${getTrendStrength(candles1d, bias1d)}` : "FLAT",
    location: tl ? (nearTL ? "NEAR_TL" : "BEYOND_TL") : "NONE",
    trigger,
    adx: adxVal,
    rsi: Math.round(rsiVal * 10) / 10,
    stochK: stoch.k,
    stochD: stoch.d,
    trendlinePrice: Math.round(tlPrice * 100) / 100,
    distToTrendline: tlPrice ? Math.round(Math.abs(dist) * 10000) / 100 : 0,
    locationType: tl ? "STRUCTURE" : "NONE",
    ema8_4h: Math.round(ema8[ema8.length - 1] * 100) / 100,
    ema21_4h: Math.round(ema21[ema21.length - 1] * 100) / 100,
    ema50_4h: Math.round(ema50[ema50.length - 1] * 100) / 100,
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
  newStop?: number;
  scaleOut?: { level: number; size: number; label: string };
}

export function shouldHold(signal: Signal, candles4h: Candle[], currentPrice: number, _now?: number): HoldResult {
  // v34: v28 stoch extreme opposite exit + v32.37 position management

  const closes4h = candles4h.map(c => c.close);
  const stoch = stochRsi(closes4h);

  // v28: Exit when Stoch hits extreme opposite
  const stochExtremeOpposite = signal.direction === "LONG"
    ? stoch.k < 20
    : stoch.k > 80;
  if (stochExtremeOpposite) {
    return { shouldHold: false, reason: "stoch_extreme_opposite_exit" };
  }

  const risk = Math.abs(signal.entry - signal.stop);
  if (risk === 0) {
    const validity = isSignalStillValid(signal, currentPrice);
    return { shouldHold: validity.valid, reason: validity.reason };
  }

  let currentR = 0;
  if (signal.direction === "LONG") {
    currentR = (currentPrice - signal.entry) / risk;
  } else {
    currentR = (signal.entry - currentPrice) / risk;
  }

  if (signal.tp1 && currentR >= 2) {
    return {
      shouldHold: true,
      reason: "tp1_hit_scale_out_50",
      newStop: signal.entry,
      scaleOut: { level: signal.tp1, size: 0.50, label: "TP1" },
    };
  }

  if (currentR >= 1.5) {
    return {
      shouldHold: true,
      reason: "be_lock_1_5r",
      newStop: signal.entry,
    };
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
