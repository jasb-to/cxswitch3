// lib/strategy.ts — v55 "v28 Entries + v34.5 Exit Fix + v32.37 Scale-Out"
// ============================================================
// ENTRY ARCHITECTURE (v28):
//   ENTRY_1 = near TL + stoch extreme          -> alerted (🟢)
//   ENTRY_2 = near TL + stoch turning          -> internal, silent
//   ADD     = beyond TL + momentum + EMA align -> add to position (🔵)
// LOCKS: 24h hysteresis for ENTRY_1/ENTRY_2, 4h for ADD (ride through chop)
// ANTI-HEDGE: blocks opposite-direction signals while position active
// STOPS:  ATR×2 for ENTRY_1/ENTRY_2, ATR×1.5 for ADD
// TARGETS: TP1 @ 2R (50%), TP2 @ structure/ATR×4 (25%), TP3 @ 6R (25%)
// EXIT:   Fixed stoch extreme opposite (LONG K>80, SHORT K<20)
// SCALE:  BE lock @ 1.5R, 50% scale-out @ 2R

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

export const CURRENT_SIGNAL_VERSION = 55;
const MIN_RR = 1.5;
const TL_THRESHOLD = 0.012;
const MIN_R2 = 0.60;
const SL_ATR_MULT_ENTRY = 2.0;
const SL_ATR_MULT_ADD = 1.5;
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
    if (highest === lowest) rawK.push(50);
    else rawK.push(((rsiValues[i] - lowest) / (highest - lowest)) * 100);
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

// ============================================================
// STATEFUL TRENDLINE (v28)
// ============================================================
interface TrendlineState {
  slope: number;
  intercept: number;
  pivots: { index: number; price: number; timestamp: number }[];
  lastUpdated: number;
  direction: "LONG" | "SHORT";
}

const trendlineStore: Map<string, TrendlineState> = new Map();

function getTrendline(pair: string, candles: Candle[], direction: "LONG" | "SHORT"): { price: number; r2: number; age: number } | null {
  const len = candles.length;
  if (len < 20) return null;

  const pivots = findPivots(candles, direction);
  if (pivots.length < 3) return null;

  const recentPivots = pivots.slice(-5);
  const now = candles[candles.length - 1].timestamp;
  const existing = trendlineStore.get(pair);
  const maxAge = 7 * 24 * 60 * 60 * 1000;

  if (existing && existing.direction === direction && (now - existing.lastUpdated) < maxAge) {
    const lastPivot = recentPivots[recentPivots.length - 1];
    const projectedPrice = existing.slope * lastPivot.index + existing.intercept;
    const deviation = Math.abs(lastPivot.price - projectedPrice) / projectedPrice;
    if (deviation < 0.02) {
      const currentIndex = len - 1;
      const price = existing.slope * currentIndex + existing.intercept;
      return { price, r2: 0.85, age: now - existing.lastUpdated };
    }
  }

  const tl = fitTrendline(recentPivots);
  if (!tl) return null;

  trendlineStore.set(pair, {
    slope: tl.slope,
    intercept: tl.intercept,
    pivots: recentPivots,
    lastUpdated: now,
    direction,
  });

  const currentIndex = len - 1;
  const price = tl.slope * currentIndex + tl.intercept;
  return { price, r2: tl.r2, age: 0 };
}

// ============================================================
// HYSTERESIS (v28) — 24h ENTRY lock, 4h ADD lock
// ============================================================
interface HysteresisState {
  direction: "LONG" | "SHORT";
  lastSignalType: "ENTRY_1" | "ENTRY_2" | "ADD" | null;
  lastSignalPrice: number;
  lockUntil: number;
}

const hysteresisStore: Map<string, HysteresisState> = new Map();
const HYSTERESIS_BAND = 0.005; // 0.5%

function getHysteresisKey(pair: string, direction: "LONG" | "SHORT"): string {
  return `${pair}_${direction}`;
}

function getHysteresis(pair: string, direction: "LONG" | "SHORT", now: number): HysteresisState | null {
  const key = getHysteresisKey(pair, direction);
  const state = hysteresisStore.get(key);
  if (!state) return null;
  if (now > state.lockUntil) {
    hysteresisStore.delete(key);
    return null;
  }
  return state;
}

function setHysteresis(pair: string, direction: "LONG" | "SHORT", type: "ENTRY_1" | "ENTRY_2" | "ADD", price: number, now: number): void {
  const lockDuration = type === "ADD" ? 4 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
  hysteresisStore.set(getHysteresisKey(pair, direction), {
    direction,
    lastSignalType: type,
    lastSignalPrice: price,
    lockUntil: now + lockDuration,
  });
}

export function resetAlertProgression(pair: string, direction: "LONG" | "SHORT"): void {
  hysteresisStore.delete(getHysteresisKey(pair, direction));
}

export function clearDedupState(): void {
  hysteresisStore.clear();
}

// ============================================================
// ANTI-HEDGE
// ============================================================
function hasOppositePosition(pair: string, direction: "LONG" | "SHORT", activeTrades?: any[]): boolean {
  if (!activeTrades?.length) return false;
  const opposite = direction === "LONG" ? "SHORT" : "LONG";
  return activeTrades.some((t: any) => {
    const matchPair = t.pair === pair || t.symbol === pair;
    const matchDir = t.direction === opposite;
    return matchPair && matchDir;
  });
}

function hasSameDirectionPosition(pair: string, direction: "LONG" | "SHORT", activeTrades?: any[]): boolean {
  if (!activeTrades?.length) return false;
  return activeTrades.some((t: any) => {
    const matchPair = t.pair === pair || t.symbol === pair;
    const matchDir = t.direction === direction;
    return matchPair && matchDir;
  });
}

// ============================================================
// MAIN SIGNAL GENERATOR
// ============================================================
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

  // Anti-hedge: block if opposite direction is active
  if (hasOppositePosition(pair, direction, _activeTrades)) {
    debug.push(`Anti-hedge: opposite direction active for ${pair}`);
    return { debug };
  }

  const trendline = getTrendline(pair, candles4h, direction);
  let tlNow = 0;
  let usingEmaFallback = false;

  if (trendline) {
    tlNow = trendline.price;
  } else {
    const closes4h = candles4h.map(c => c.close);
    const ema21_4h = ema(closes4h, 21);
    tlNow = ema21_4h[ema21_4h.length - 1];
    usingEmaFallback = true;
    debug.push(`No TL — EMA21 proxy @ ${tlNow.toFixed(2)}`);
  }

  const price = currentPrice ?? candles4h[candles4h.length - 1].close;
  const dist = (price - tlNow) / tlNow;
  const nearTL = Math.abs(dist) < TL_THRESHOLD;
  const beyondTL = direction === "LONG" ? price > tlNow * 1.008 : price < tlNow * 0.992;

  debug.push(`${usingEmaFallback ? "EMA21" : "TL"}: ${tlNow.toFixed(2)} | Price: ${price.toFixed(2)} | Dist: ${(dist * 100).toFixed(2)}%${!usingEmaFallback ? ` | R² ${trendline?.r2}` : ""}`);

  const closes4h = candles4h.map(c => c.close);
  const stoch = stochRsi(closes4h);
  debug.push(`StochRSI: K ${stoch.k} | D ${stoch.d}`);

  const last = candles4h[candles4h.length - 1];
  const prev = candles4h[candles4h.length - 2];

  const ema8_4h = ema(closes4h, 8);
  const ema21_4h = ema(closes4h, 21);

  const stochExtreme = direction === "LONG" ? stoch.k < 20 : stoch.k > 80;
  const stochTurning = direction === "LONG" ? stoch.k > stoch.d : stoch.k < stoch.d;

  const confirming = direction === "LONG"
    ? last.close > last.open && last.close > prev.close
    : last.close < last.open && last.close < prev.close;
  const volUp = last.volume > avg(candles4h.slice(-10).map(c => c.volume)) * 1.3;
  const emaAligned = direction === "LONG"
    ? price > ema8_4h[ema8_4h.length - 1] && price > ema21_4h[ema21_4h.length - 1]
    : price < ema8_4h[ema8_4h.length - 1] && price < ema21_4h[ema21_4h.length - 1];
  const stochMomentum = direction === "LONG" ? stoch.k > stoch.d : stoch.k < stoch.d;
  const adxVal = adx(candles4h);
  const adxStrong = adxVal > 20;

  // --- Determine raw type ---
  let rawType: "ENTRY_1" | "ENTRY_2" | "ADD" | null = null;

  if (nearTL && stochExtreme) {
    rawType = "ENTRY_1";
  } else if (nearTL && stochTurning && !stochExtreme) {
    rawType = "ENTRY_2";
  } else if (beyondTL && confirming && emaAligned) {
    if (volUp || stochMomentum || adxStrong) {
      rawType = "ADD";
    }
  }

  if (!rawType) {
    const stateParts: string[] = [];
    if (nearTL) stateParts.push("near TL");
    else if (beyondTL) stateParts.push("beyond TL");
    else stateParts.push("far from TL");
    stateParts.push(`Stoch K${stoch.k} D${stoch.d}`);
    stateParts.push("No signal");
    debug.push(`State: ${stateParts.join(" | ")}`);
    return { debug };
  }

  // --- ADD requires existing position ---
  if (rawType === "ADD" && !hasSameDirectionPosition(pair, direction, _activeTrades)) {
    debug.push(`ADD blocked: no active ${direction} position for ${pair}`);
    return { debug };
  }

  // --- Hysteresis state machine (v28) ---
  const hyst = getHysteresis(pair, direction, now);
  let finalType: "ENTRY_1" | "ENTRY_2" | "ADD" | null = rawType;

  if (hyst) {
    if (hyst.lastSignalType === "ADD") {
      finalType = "ADD";
    } else if (hyst.lastSignalType === "ENTRY_2") {
      if (rawType === "ADD") finalType = "ADD";
      else finalType = "ENTRY_2";
    } else if (hyst.lastSignalType === "ENTRY_1") {
      if (rawType === "ADD") finalType = "ADD";
      else if (rawType === "ENTRY_2") finalType = "ENTRY_2";
      else finalType = "ENTRY_1";
    }

    // Price hysteresis band
    if (finalType === hyst.lastSignalType) {
      const priceMove = Math.abs(price - hyst.lastSignalPrice) / hyst.lastSignalPrice;
      if (priceMove < HYSTERESIS_BAND) {
        debug.push(`Hysteresis lock: ${finalType} | move ${(priceMove * 100).toFixed(2)}% < ${(HYSTERESIS_BAND * 100).toFixed(2)}%`);
        return { debug };
      }
    }
  }

  // If hysteresis forces a type that requires a position we don't have, block
  if (finalType === "ADD" && !hasSameDirectionPosition(pair, direction, _activeTrades)) {
    debug.push(`ADD blocked (hyst): no active ${direction} position`);
    return { debug };
  }

  // Set hysteresis for new signal
  if (!hyst || finalType !== hyst.lastSignalType) {
    setHysteresis(pair, direction, finalType, price, now);
  }

  // --- Correlation cap ---
  const activeTrades = _activeTrades || [];
  const sameDirCount = activeTrades.filter((t: any) => t.direction === direction).length;
  if (sameDirCount >= MAX_SAME_DIR) {
    debug.push(`Correlation cap: ${sameDirCount} ${direction} active, max ${MAX_SAME_DIR}`);
    return { debug };
  }

  // --- Levels ---
  const atrVal = atr(candles4h, 14);
  const swingLows4h = candles4h.slice(-20).map(c => c.low);
  const swingHighs4h = candles4h.slice(-20).map(c => c.high);
  const swingLow4h = Math.min(...swingLows4h);
  const swingHigh4h = Math.max(...swingHighs4h);

  const entry = price;
  let sl: number;
  const isEntry = finalType === "ENTRY_1" || finalType === "ENTRY_2";
  const slMult = isEntry ? SL_ATR_MULT_ENTRY : SL_ATR_MULT_ADD;

  if (direction === "LONG") {
    if (isEntry) {
      sl = Math.min(swingLow4h, entry - atrVal * slMult);
    } else {
      sl = Math.min(tlNow * 0.995, entry - atrVal * slMult);
    }
  } else {
    if (isEntry) {
      sl = Math.max(swingHigh4h, entry + atrVal * slMult);
    } else {
      sl = Math.max(tlNow * 1.005, entry + atrVal * slMult);
    }
  }

  const risk = Math.abs(entry - sl);

  // TP structure (v32.37 scale-out)
  const tp1 = direction === "LONG" ? entry + risk * 2 : entry - risk * 2;
  const tp3 = direction === "LONG" ? entry + risk * 6 : entry - risk * 6;

  let tp2: number;
  if (isEntry) {
    const atrTarget = direction === "LONG" ? entry + atrVal * 5 : entry - atrVal * 5;
    const structureTarget = direction === "LONG" ? swingHigh4h : swingLow4h;
    tp2 = direction === "LONG" ? Math.min(structureTarget, atrTarget) : Math.max(structureTarget, atrTarget);
  } else {
    const minTarget = direction === "LONG" ? entry + risk * MIN_RR : entry - risk * MIN_RR;
    const structureTarget = direction === "LONG" ? swingHigh4h : swingLow4h;
    tp2 = direction === "LONG" ? Math.max(structureTarget, minTarget) : Math.min(structureTarget, minTarget);
  }

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
  const expectedMove = Math.round((Math.abs(finalTp2 - entry) / entry * 100) * 10) / 10;

  const ema50_4h = ema(closes4h, 50);

  const signal: Signal = {
    id: `${pair}_${now}`,
    pair,
    direction,
    type: finalType,
    scale: finalType,
    entry: Math.round(entry * 100) / 100,
    stop: Math.round(sl * 100) / 100,
    target: Math.round(finalTp2 * 100) / 100,
    tp1: Math.round(tp1 * 100) / 100,
    tp3: Math.round(tp3 * 100) / 100,
    confidence: finalType === "ENTRY_1" ? 50 : finalType === "ENTRY_2" ? 60 : 85,
    rr: Math.round(rr * 100) / 100,
    adx: Math.round(adxVal * 10) / 10,
    rsi: Math.round(rsiVal * 10) / 10,
    stochK: stoch.k,
    stochD: stoch.d,
    expectedMove,
    reason: `${direction} ${finalType} | 1D ${strength} | Stoch K${stoch.k} D${stoch.d} | 4H ${usingEmaFallback ? "EMA21" : "TL"} ${tlNow.toFixed(1)} | RR ${rr.toFixed(2)}`,
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
      suggestedLeverage: suggestLeverage(atrVal, entry),
    },
  };

  const debugPrefix = finalType === "ENTRY_2" ? "INTERNAL" : "SIGNAL";
  debug.push(`${debugPrefix}: ${finalType} ${direction} @ ${signal.entry} | SL ${signal.stop} | TP1 ${signal.tp1} | TP2 ${signal.target} | TP3 ${signal.tp3} | RR ${signal.rr}`);

  const market = {
    pair,
    price: Math.round((currentPrice ?? entry) * 100) / 100,
    timestamp: now,
    trend: `${direction} ${strength}`,
    location: nearTL ? "NEAR_TL" : "BEYOND_TL",
    trigger: "READY",
    adx: signal.adx,
    rsi: signal.rsi,
    stochK: signal.stochK,
    stochD: signal.stochD,
    trendlinePrice: Math.round(tlNow * 100) / 100,
    distToTrendline: Math.round(Math.abs(dist) * 10000) / 100,
    locationType: trendline ? "STRUCTURE" : "NONE",
    ema8_4h: Math.round(ema8_4h[ema8_4h.length - 1] * 100) / 100,
    ema21_4h: Math.round(ema21_4h[ema21_4h.length - 1] * 100) / 100,
    ema50_4h: Math.round(ema50_4h[ema50_4h.length - 1] * 100) / 100,
  };

  return {
    signals: [signal],
    signal,
    market,
    debug,
  };
}

// ============================================================
// MARKET SNAPSHOT
// ============================================================
export function getMarketSnapshot(
  pair: string,
  candles1h: Candle[],
  candles4h: Candle[],
  candles15m: Candle[]
): any {
  const candles1d = aggregateTo1D(candles4h);
  const bias1d = getBias(candles1d, true);
  const price = candles4h[candles4h.length - 1].close;

  const trendline = bias1d ? getTrendline(pair, candles4h, bias1d) : null;
  let tlNow = 0;
  let usingEmaFallback = false;

  if (!trendline && bias1d) {
    const closes4h = candles4h.map(c => c.close);
    const ema21 = ema(closes4h, 21);
    tlNow = ema21[ema21.length - 1];
    usingEmaFallback = true;
  } else if (trendline) {
    tlNow = trendline.price;
  }

  const dist = tlNow ? (price - tlNow) / tlNow : 1;
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
    location: trendline || usingEmaFallback ? (nearTL ? "NEAR_TL" : "BEYOND_TL") : "NONE",
    trigger,
    adx: adxVal,
    rsi: Math.round(rsiVal * 10) / 10,
    stochK: stoch.k,
    stochD: stoch.d,
    trendlinePrice: Math.round(tlNow * 100) / 100,
    distToTrendline: tlNow ? Math.round(Math.abs(dist) * 10000) / 100 : 0,
    locationType: trendline ? "STRUCTURE" : usingEmaFallback ? "EMA21" : "NONE",
    ema8_4h: Math.round(ema8[ema8.length - 1] * 100) / 100,
    ema21_4h: Math.round(ema21[ema21.length - 1] * 100) / 100,
    ema50_4h: Math.round(ema50[ema50.length - 1] * 100) / 100,
  };
}

// ============================================================
// VALIDITY
// ============================================================
export interface ValidityCheck {
  valid: boolean;
  reason: string;
  exited: boolean;
}

export function isSignalStillValid(signal: Signal, currentPrice: number, now: number = Date.now()): ValidityCheck {
  // v28 TTL: 24h for ENTRY_1/ENTRY_2, 4h for ADD
  const isAdd = signal.type === "ADD";
  const maxAge = isAdd ? 4 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
  if (now - signal.timestamp > maxAge) {
    return { valid: false, reason: "expired_ttl", exited: true };
  }

  const entryBuffer = isAdd ? 1.005 : 1.02;
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

// ============================================================
// shouldHold — v34.5 fixed stoch exit + v32.37 scale-out
// ============================================================
export interface HoldResult {
  shouldHold: boolean;
  reason: string;
  newStop?: number;
  scaleOut?: { level: number; size: number; label: string };
}

export function shouldHold(signal: Signal, candles4h: Candle[], currentPrice: number, _now?: number): HoldResult {
  const candles1d = aggregateTo1D(candles4h);
  const t1d = trend1D(candles1d);
  const trendReversed = (signal.direction === "LONG" && t1d.direction === "SHORT") ||
                        (signal.direction === "SHORT" && t1d.direction === "LONG");

  if (trendReversed) {
    const inProfit = signal.direction === "LONG"
      ? currentPrice > signal.entry
      : currentPrice < signal.entry;
    if (!inProfit) {
      return { shouldHold: false, reason: "trend_reversed_unprofitable" };
    }
  }

  // v34.5 FIX: LONG exits when overbought (K>80), SHORT exits when oversold (K<20)
  const closes4h = candles4h.map(c => c.close);
  const stoch = stochRsi(closes4h);

  const stochExtremeOpposite = signal.direction === "LONG"
    ? stoch.k > 80
    : stoch.k < 20;
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

  // Scale-out @ 2R (v32.37)
  if (signal.tp1 && currentR >= 2) {
    return {
      shouldHold: true,
      reason: "tp1_hit_scale_out_50",
      newStop: signal.entry,
      scaleOut: { level: signal.tp1, size: 0.50, label: "TP1" },
    };
  }

  // BE lock @ 1.5R (v32.37)
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

function trend1D(candles1d: Candle[]): { direction: "LONG" | "SHORT" | null; strength: string } {
  const len = candles1d.length;
  if (len < 25) return { direction: null, strength: "WEAK" };
  const closes = candles1d.map(c => c.close);
  const ema8 = ema(closes, 8);
  const ema21 = ema(closes, 21);
  const direction = ema8[ema8.length - 1] > ema21[ema21.length - 1] ? "LONG" : "SHORT";
  const highs = candles1d.slice(-20).map(c => c.high);
  const lows = candles1d.slice(-20).map(c => c.low);
  const hh = highs[highs.length - 1] > Math.max(...highs.slice(0, -1));
  const ll = lows[lows.length - 1] < Math.min(...lows.slice(0, -1));
  const strength = (direction === "LONG" && hh) || (direction === "SHORT" && ll) ? "STRONG" : "MEDIUM";
  return { direction, strength };
}

export function shouldHoldCompat(
  signal: Signal,
  candles4h: Candle[],
  _candles1h: Candle[],
  currentPrice: number
): HoldResult {
  return shouldHold(signal, candles4h, currentPrice);
}

// ============================================================
// FILTER + STATUS
// ============================================================
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

// ============================================================
// STUBS / COMPATIBILITY
// ============================================================
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

// v55: All signals returned. Cron route suppresses ENTRY_2 alerts.
export async function generateSignalCompat(
  pair: string,
  candles1h: Candle[],
  candles4h: Candle[],
  candles15m: Candle[],
  activeTrades?: any[],
  currentPrice?: number
): Promise<SignalResult> {
  return generateSignal(pair, candles1h, candles4h, candles15m, activeTrades, currentPrice);
}

export function isSignalStillValidBool(signal: Signal, currentPrice: number): boolean {
  return isSignalStillValid(signal, currentPrice).valid;
}
