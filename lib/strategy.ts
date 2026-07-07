// lib/strategy.ts — v28 "Early Momentum Entry + Fixed R:R"
// ============================================================
// PATCHED 2026-07-07:
// - 4H trend now gates entry (must agree with 1D)
// - Momentum override requires strength >= 70 AND 4H trend flip
// - Stoch exhaustion blocks entry (K>70 for LONG, K<30 for SHORT)
// - Exit cooldown tracks by signal ID (prevents spam)
// - shouldHold records exit per signal ID
// - No duplicate exit alerts: cron checks signal.exited before alerting
// - ADD logic removed (no position building)
// - Stoch profit-take only if actually in profit
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
  stage?: "WATCHING" | "ACCUMULATION" | "READY" | "CONFIRMED";
  zoneTop?: number;
  zoneBottom?: number;
  trail?: number;
  explanation?: string;
  exited?: boolean;
  exitReason?: string;
  exitPrice?: number;
  exitTimestamp?: number;
}

export interface ZoneQuality {
  age: number;
  widthATR: number;
  compression: number;
  volumeDecay: number;
  touches: number;
  breakAttempts: number;
  label: "EXCELLENT" | "GOOD" | "AVERAGE" | "WEAK";
}

export interface MarketData {
  pair: string;
  price: number;
  timestamp: number;
  phase: "NONE" | "WATCHING" | "ACCUMULATION" | "READY" | "CONFIRMED" | "EXPANSION" | "EXHAUSTION" | "EARLY_ENTRY";
  trend: string;
  htfBias?: "BULLISH" | "BEARISH" | "NEUTRAL";
  adx: number;
  rsi: number;
  stochK: number;
  stochD: number;
  zoneTop: number | null;
  zoneBottom: number | null;
  zoneScore: number;
  zoneQuality?: ZoneQuality;
  closes4h?: number[];
}

export interface SignalResult {
  signal?: Signal;
  market?: MarketData;
  debug: string[];
}

export const CURRENT_SIGNAL_VERSION = 28;

// ============================================================
// FIXED R:R CONFIG
// ============================================================
const LONG_TP_PCT = 0.035;
const LONG_SL_PCT = 0.025;
const SHORT_TP_PCT = 0.035;
const SHORT_SL_PCT = 0.025;
const MIN_RR = 1.2;

// ============================================================
// EXIT COOLDOWN: 8 hours
// ============================================================
const EXIT_COOLDOWN_MS = 8 * 60 * 60 * 1000;

// ============================================================
// PAIR-SPECIFIC PARAMETERS
// ============================================================
interface PairConfig {
  minADX: number;
  momentumThreshold: number;
  emaSpreadMin: number;
  volumeMultiplier: number;
}

const PAIR_CONFIGS: Record<string, PairConfig> = {
  default: { minADX: 20, momentumThreshold: 55, emaSpreadMin: 0.003, volumeMultiplier: 1.3 },
  BTC:     { minADX: 20, momentumThreshold: 55, emaSpreadMin: 0.003, volumeMultiplier: 1.3 },
  ETH:     { minADX: 20, momentumThreshold: 55, emaSpreadMin: 0.003, volumeMultiplier: 1.3 },
  SOL:     { minADX: 18, momentumThreshold: 50, emaSpreadMin: 0.004, volumeMultiplier: 1.4 },
  HYPE:    { minADX: 15, momentumThreshold: 50, emaSpreadMin: 0.005, volumeMultiplier: 1.5 },
};

function getPairConfig(pair: string): PairConfig {
  return PAIR_CONFIGS[pair] || PAIR_CONFIGS.default;
}

// ============================================================
// STATEFUL TRENDLINE STORE
// ============================================================
interface TrendlineState {
  slope: number;
  intercept: number;
  pivots: { index: number; price: number; timestamp: number }[];
  lastUpdated: number;
  direction: "LONG" | "SHORT";
}

const trendlineStore: Map<string, TrendlineState> = new Map();

function avg(arr: number[]): number {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
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

function rsiSeries(closes: number[], period: number = 14): number[] {
  const series: number[] = [];
  for (let i = period; i < closes.length; i++) {
    const window = closes.slice(i - period + 1, i + 1);
    series.push(rsi(window, period));
  }
  return series;
}

// --- STOCHRSI ---
function stochRsi(
  closes: number[],
  rsiPeriod: number = 14,
  stochPeriod: number = 14,
  kSmooth: number = 3,
  dSmooth: number = 3
): { k: number; d: number } {
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
    const dx = pDI + mDI === 0 ? 0 : (Math.abs(pDI - mDI) / (pDI + mDI)) * 100;
    dxValues.push(dx);
  }

  const adxSmooth = wilderSmooth(dxValues, period);
  return Math.round(adxSmooth[adxSmooth.length - 1] * 10) / 10;
}

// --- AGGREGATE 4H TO 1D ---
function aggregateTo1D(candles4h: Candle[]): Candle[] {
  const sorted = [...candles4h].sort((a, b) => a.timestamp - b.timestamp);
  const groups: Map<string, Candle[]> = new Map();

  for (const c of sorted) {
    const date = new Date(c.timestamp);
    const key = `${date.getUTCFullYear()}-${date.getUTCMonth()}-${date.getUTCDate()}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(c);
  }

  const daily: Candle[] = [];
  for (const [, bars] of groups) {
    if (bars.length === 0) continue;
    daily.push({
      timestamp: bars[0].timestamp,
      open: bars[0].open,
      high: Math.max(...bars.map((b) => b.high)),
      low: Math.min(...bars.map((b) => b.low)),
      close: bars[bars.length - 1].close,
      volume: bars.reduce((sum, b) => sum + b.volume, 0),
    });
  }

  return daily.sort((a, b) => a.timestamp - b.timestamp);
}

// --- FIND PIVOTS ---
function findPivots(candles: Candle[], direction: "LONG" | "SHORT"): { index: number; price: number; timestamp: number }[] {
  const pivots: { index: number; price: number; timestamp: number }[] = [];

  for (let i = 3; i < candles.length - 3; i++) {
    const c = candles[i];
    const isSwingLow = c.low < candles[i-1].low && c.low < candles[i-2].low && c.low < candles[i+1].low && c.low < candles[i+2].low;
    const isSwingHigh = c.high > candles[i-1].high && c.high > candles[i-2].high && c.high > candles[i+1].high && c.high > candles[i+2].high;

    if (direction === "LONG" && isSwingLow) pivots.push({ index: i, price: c.low, timestamp: c.timestamp });
    if (direction === "SHORT" && isSwingHigh) pivots.push({ index: i, price: c.high, timestamp: c.timestamp });
  }

  return pivots;
}

// --- STATEFUL TRENDLINE ---
function getTrendline(pair: string, candles: Candle[], direction: "LONG" | "SHORT"): { price: number; r2: number; age: number } | null {
  const len = candles.length;
  if (len < 20) return null;

  const pivots = findPivots(candles, direction);
  if (pivots.length < 3) return null;

  const recentPivots = pivots.slice(-5);
  const now = candles[candles.length - 1].timestamp;

  const existing = trendlineStore.get(pair);
  const maxAge = 7 * 24 * 60 * 60 * 1000;

  if (existing && existing.direction === direction && now - existing.lastUpdated < maxAge) {
    const lastPivot = recentPivots[recentPivots.length - 1];
    const projectedPrice = existing.slope * lastPivot.index + existing.intercept;
    const deviation = Math.abs(lastPivot.price - projectedPrice) / projectedPrice;

    if (deviation < 0.02) {
      const currentIndex = len - 1;
      const price = existing.slope * currentIndex + existing.intercept;
      return { price, r2: 0.85, age: now - existing.lastUpdated };
    }
  }

  const n = recentPivots.length;
  const sumX = recentPivots.reduce((s, p) => s + p.index, 0);
  const sumY = recentPivots.reduce((s, p) => s + p.price, 0);
  const sumXY = recentPivots.reduce((s, p) => s + p.index * p.price, 0);
  const sumX2 = recentPivots.reduce((s, p) => s + p.index * p.index, 0);

  const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
  const intercept = (sumY - slope * sumX) / n;

  const yMean = sumY / n;
  const ssTotal = recentPivots.reduce((s, p) => s + Math.pow(p.price - yMean, 2), 0);
  const ssResidual = recentPivots.reduce((s, p) => s + Math.pow(p.price - (slope * p.index + intercept), 2), 0);
  const r2 = ssTotal === 0 ? 0 : 1 - ssResidual / ssTotal;

  trendlineStore.set(pair, { slope, intercept, pivots: recentPivots, lastUpdated: now, direction });

  const currentIndex = len - 1;
  const price = slope * currentIndex + intercept;

  return { price, r2: Math.round(r2 * 100) / 100, age: 0 };
}

// --- EMA ---
function ema(closes: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const ema: number[] = [closes[0]];
  for (let i = 1; i < closes.length; i++) {
    ema.push(closes[i] * k + ema[i - 1] * (1 - k));
  }
  return ema;
}

// --- 1D TREND ---
function trend1D(candles1d: Candle[]): { direction: "LONG" | "SHORT" | null; strength: string; ema21Slope: number } {
  const len = candles1d.length;
  if (len < 25) return { direction: null, strength: "WEAK", ema21Slope: 0 };

  const closes = candles1d.map((c) => c.close);
  const ema8 = ema(closes, 8);
  const ema21 = ema(closes, 21);

  const direction = ema8[ema8.length - 1] > ema21[ema21.length - 1] ? "LONG" : "SHORT";

  const ema21Slope = ema21.length >= 3 ? (ema21[ema21.length - 1] - ema21[ema21.length - 3]) / 2 : 0;

  const highs = candles1d.slice(-20).map((c) => c.high);
  const lows = candles1d.slice(-20).map((c) => c.low);
  const hh = highs[highs.length - 1] > Math.max(...highs.slice(0, -1));
  const ll = lows[lows.length - 1] < Math.min(...lows.slice(0, -1));

  const strength = (direction === "LONG" && hh) || (direction === "SHORT" && ll) ? "STRONG" : "MEDIUM";

  return { direction, strength, ema21Slope };
}

// --- 4H TREND (NEW) ---
function trend4H(candles4h: Candle[]): { direction: "LONG" | "SHORT" | null; strength: string } {
  const len = candles4h.length;
  if (len < 25) return { direction: null, strength: "WEAK" };

  const closes = candles4h.map((c) => c.close);
  const ema8 = ema(closes, 8);
  const ema21 = ema(closes, 21);

  const direction = ema8[ema8.length - 1] > ema21[ema21.length - 1] ? "LONG" : "SHORT";

  const highs = candles4h.slice(-20).map((c) => c.high);
  const lows = candles4h.slice(-20).map((c) => c.low);
  const hh = highs[highs.length - 1] > Math.max(...highs.slice(0, -1));
  const ll = lows[lows.length - 1] < Math.min(...lows.slice(0, -1));

  const strength = (direction === "LONG" && hh) || (direction === "SHORT" && ll) ? "STRONG" : "MEDIUM";

  return { direction, strength };
}

// --- ATR ---
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

// ============================================================
// EXIT TRACKING — BY SIGNAL ID (prevents spam)
// ============================================================
interface ExitRecord {
  signalId: string;
  pair: string;
  direction: "LONG" | "SHORT";
  exitTimestamp: number;
  exitReason: string;
  exitPrice: number;
}

// Track exits by signal ID
const exitStoreById: Map<string, ExitRecord> = new Map();
// Track last exit per pair for cooldown
const exitStoreByPair: Map<string, ExitRecord> = new Map();

function recordExit(signalId: string, pair: string, direction: "LONG" | "SHORT", exitPrice: number, exitReason: string, now: number): void {
  const record: ExitRecord = { signalId, pair, direction, exitTimestamp: now, exitReason, exitPrice };
  exitStoreById.set(signalId, record);
  exitStoreByPair.set(pair, record);
}

function hasExited(signalId: string): boolean {
  return exitStoreById.has(signalId);
}

function getLastExitByPair(pair: string): ExitRecord | undefined {
  return exitStoreByPair.get(pair);
}

function isInCooldown(pair: string, now: number, direction?: "LONG" | "SHORT"): { inCooldown: boolean; remainingMs: number; lastExit?: ExitRecord } {
  const lastExit = exitStoreByPair.get(pair);
  if (!lastExit) return { inCooldown: false, remainingMs: 0 };

  if (direction && lastExit.direction !== direction) {
    return { inCooldown: false, remainingMs: 0, lastExit };
  }

  const elapsed = now - lastExit.exitTimestamp;
  if (elapsed < EXIT_COOLDOWN_MS) {
    return { inCooldown: true, remainingMs: EXIT_COOLDOWN_MS - elapsed, lastExit };
  }
  return { inCooldown: false, remainingMs: 0, lastExit };
}

// ============================================================
// EARLY MOMENTUM DETECTION (PATCHED)
// ============================================================
interface MomentumResult {
  hasMomentum: boolean;
  direction: "LONG" | "SHORT" | null;
  strength: number;
  reasons: string[];
}

function detectEarlyMomentum(candles4h: Candle[], currentPrice: number, config: PairConfig): MomentumResult {
  const reasons: string[] = [];
  const closes4h = candles4h.map((c) => c.close);
  const volumes4h = candles4h.map((c) => c.volume);

  if (closes4h.length < 30) {
    return { hasMomentum: false, direction: null, strength: 0, reasons: ["insufficient_data"] };
  }

  const ema8_4h = ema(closes4h, 8);
  const ema21_4h = ema(closes4h, 21);
  const ema8Prev = ema8_4h[ema8_4h.length - 2];
  const ema21Prev = ema21_4h[ema21_4h.length - 2];
  const ema8Now = ema8_4h[ema8_4h.length - 1];
  const ema21Now = ema21_4h[ema21_4h.length - 1];

  const wasBearish = ema8Prev <= ema21Prev;
  const isBullish = ema8Now > ema21Now;
  const wasBullish = ema8Prev >= ema21Prev;
  const isBearish = ema8Now < ema21Now;

  const emaCrossUp = wasBearish && isBullish;
  const emaCrossDown = wasBullish && isBearish;

  const emaSpread = Math.abs(ema8Now - ema21Now) / ema21Now;
  const spreadWide = emaSpread >= config.emaSpreadMin;

  const avgVol = avg(volumes4h.slice(-10));
  const lastVol = volumes4h[volumes4h.length - 1];
  const volSurge = lastVol > avgVol * config.volumeMultiplier;

  const stoch = stochRsi(closes4h);
  const adxVal = adx(candles4h);
  const adxOk = adxVal > config.minADX;

  const roc = ((closes4h[closes4h.length - 1] - closes4h[closes4h.length - 4]) / closes4h[closes4h.length - 4]) * 100;
  const strongVelocity = Math.abs(roc) > 1.5;

  let direction: "LONG" | "SHORT" | null = null;
  let strength = 0;

  // === PRIMARY: EMA CROSS ===
  if (emaCrossUp) {
    direction = "LONG";
    reasons.push("ema_cross_up");
    strength += 40;
  } else if (emaCrossDown) {
    direction = "SHORT";
    reasons.push("ema_cross_down");
    strength += 40;
  }

  // === SECONDARY: Price aligned with EMAs ===
  if (!direction) {
    const priceAboveBoth = currentPrice > ema8Now && currentPrice > ema21Now;
    const priceBelowBoth = currentPrice < ema8Now && currentPrice < ema21Now;

    if (priceAboveBoth && spreadWide && ema8Now > ema21Now) {
      direction = "LONG";
      reasons.push("price_above_emas");
      strength += 25;
    } else if (priceBelowBoth && spreadWide && ema8Now < ema21Now) {
      direction = "SHORT";
      reasons.push("price_below_emas");
      strength += 25;
    }
  }

  // === BOOSTERS ===
  if (volSurge) { reasons.push("volume_surge"); strength += 15; }
  if (adxOk) { reasons.push("adx_ok"); strength += 10; }
  if (strongVelocity) { reasons.push("velocity"); strength += 10; }

  // Stoch alignment (must agree with direction)
  if (direction === "LONG" && stoch.k > stoch.d && stoch.k < 70) {
    reasons.push("stoch_aligned");
    strength += 10;
  } else if (direction === "SHORT" && stoch.k < stoch.d && stoch.k > 30) {
    reasons.push("stoch_aligned");
    strength += 10;
  }

  // Stoch exhaustion BLOCK
  if (direction === "LONG" && stoch.k > 70) {
    reasons.push("stoch_overbought_block");
    strength = 0;
    direction = null;
  }
  if (direction === "SHORT" && stoch.k < 30) {
    reasons.push("stoch_oversold_block");
    strength = 0;
    direction = null;
  }

  strength = Math.min(100, strength);
  const hasMomentum = strength >= config.momentumThreshold && direction !== null;

  return { hasMomentum, direction, strength, reasons };
}

// ============================================================
// ZONE CALCULATION (UI only)
// ============================================================
function calculateZone(candles4h: Candle[], trendlinePrice: number, atrVal: number, direction: "LONG" | "SHORT" | null): {
  zoneTop: number | null;
  zoneBottom: number | null;
  zoneScore: number;
  zoneQuality?: ZoneQuality;
} {
  if (!direction || candles4h.length < 30) {
    return { zoneTop: null, zoneBottom: null, zoneScore: 0 };
  }

  const recent = candles4h.slice(-20);
  const highs = recent.map((c) => c.high);
  const lows = recent.map((c) => c.low);
  const volumes = recent.map((c) => c.volume);

  const rangeHigh = Math.max(...highs);
  const rangeLow = Math.min(...lows);
  const rangeWidth = rangeHigh - rangeLow;

  const zoneTop = Math.min(trendlinePrice + atrVal * 1.5, rangeHigh);
  const zoneBottom = Math.max(trendlinePrice - atrVal * 1.5, rangeLow);

  const widthATR = rangeWidth / atrVal;
  const compression = Math.max(0, Math.min(100, (1 - widthATR / 4) * 100));
  const avgVol = avg(volumes);
  const recentVol = avg(volumes.slice(-5));
  const volumeDecay = avgVol > 0 ? Math.max(0, (1 - recentVol / avgVol) * 100) : 0;

  let touches = 0;
  let breakAttempts = 0;
  for (const c of recent) {
    const nearTop = Math.abs(c.high - zoneTop) < atrVal * 0.3;
    const nearBottom = Math.abs(c.low - zoneBottom) < atrVal * 0.3;
    if (nearTop || nearBottom) touches++;
    if (c.high > zoneTop || c.low < zoneBottom) breakAttempts++;
  }

  let score = 50;
  score += Math.min(compression, 30);
  score += Math.min(touches * 3, 15);
  score -= breakAttempts * 2;
  score += volumeDecay * 0.2;
  score = Math.round(Math.min(100, Math.max(0, score)));

  let label: ZoneQuality["label"] = "AVERAGE";
  if (score >= 80 && touches >= 3 && compression > 40) label = "EXCELLENT";
  else if (score >= 65 && touches >= 2 && compression > 25) label = "GOOD";
  else if (score < 40 || breakAttempts > 5) label = "WEAK";

  const quality: ZoneQuality = {
    age: recent.length,
    widthATR: Math.round(widthATR * 10) / 10,
    compression: Math.round(compression * 10) / 10,
    volumeDecay: Math.round(volumeDecay * 10) / 10,
    touches,
    breakAttempts,
    label,
  };

  return {
    zoneTop: Math.round(zoneTop * 100) / 100,
    zoneBottom: Math.round(zoneBottom * 100) / 100,
    zoneScore: score,
    zoneQuality: quality,
  };
}

// ============================================================
// PHASE DETECTION
// ============================================================
function detectPhase(
  direction: "LONG" | "SHORT" | null,
  adxVal: number,
  stochK: number,
  stochD: number,
  hasSignal: boolean,
  momentumResult?: MomentumResult
): MarketData["phase"] {
  if (!direction || adxVal < 15) return "NONE";

  const stochExhausted = direction === "LONG" ? stochK > 80 : stochK < 20;
  if (stochExhausted && adxVal > 30) return "EXHAUSTION";

  if (hasSignal) return "EARLY_ENTRY";

  if (momentumResult?.hasMomentum) {
    return momentumResult.strength >= 70 ? "READY" : "ACCUMULATION";
  }

  return "WATCHING";
}

// ============================================================
// MAIN SIGNAL GENERATOR — PATCHED
// ============================================================
export function generateSignal(
  pair: string,
  candles1h: Candle[],
  candles4h: Candle[],
  candles15m: Candle[],
  currentPrice?: number
): SignalResult {
  const debug: string[] = [];
  const config = getPairConfig(pair);

  for (let i = 1; i < candles4h.length; i++) {
    if (candles4h[i].timestamp < candles4h[i - 1].timestamp) {
      debug.push("Candles not sorted");
      return { debug };
    }
  }

  const candles1d = aggregateTo1D(candles4h);

  if (candles1d.length < 25 || candles4h.length < 30) {
    debug.push("Insufficient candle data");
    return { debug };
  }

  const t1d = trend1D(candles1d);
  debug.push(`1D: ${t1d.direction || "NONE"} ${t1d.strength} slope=${t1d.ema21Slope.toFixed(2)}`);

  const t4h = trend4H(candles4h);
  debug.push(`4H: ${t4h.direction || "NONE"} ${t4h.strength}`);

  const price = currentPrice ?? candles4h[candles4h.length - 1].close;
  const atrVal = atr(candles4h, 14);
  const stoch = stochRsi(candles4h.map((c) => c.close));
  const adxVal = adx(candles4h);
  const closes4h = candles4h.map((c) => c.close);

  // --- EARLY MOMENTUM DETECTION ---
  const momentumResult = detectEarlyMomentum(candles4h, price, config);

  if (momentumResult.hasMomentum) {
    debug.push(`MOMENTUM: ${momentumResult.direction} strength=${momentumResult.strength} | ${momentumResult.reasons.join(", ")}`);
  }

  // === DETERMINE TRADE DIRECTION ===
  // Default: follow 1D trend
  let tradeDirection: "LONG" | "SHORT" | null = t1d.direction;

  // 4H must agree with 1D for entry
  if (t4h.direction !== t1d.direction) {
    // 4H disagrees — check if momentum is strong enough to override
    if (momentumResult.hasMomentum && momentumResult.direction === t4h.direction && momentumResult.strength >= 70) {
      // Strong momentum in 4H direction overrides weak 1D
      if (t1d.strength !== "STRONG") {
        debug.push(`4H override: momentum=${momentumResult.strength} >= 70, 1D=${t1d.strength}, following 4H ${t4h.direction}`);
        tradeDirection = t4h.direction;
      } else {
        debug.push(`4H/1D mismatch blocked: 1D STRONG, no override`);
        tradeDirection = null;
      }
    } else {
      debug.push(`4H/1D mismatch: 4H=${t4h.direction} vs 1D=${t1d.direction}, momentum=${momentumResult.strength} — no entry`);
      tradeDirection = null;
    }
  }

  if (!tradeDirection) {
    debug.push("No trade direction (4H/1D mismatch or 1D unclear)");
    const phase = detectPhase(t1d.direction, adxVal, stoch.k, stoch.d, false, momentumResult);
    const trendline = getTrendline(pair, candles4h, t1d.direction || "LONG");
    const tlPrice = trendline ? trendline.price : price;
    const zone = calculateZone(candles4h, tlPrice, atrVal, t1d.direction);

    const market: MarketData = {
      pair,
      price: Math.round(price * 100) / 100,
      timestamp: Date.now(),
      phase,
      trend: `${t1d.direction || "NONE"} ${t1d.strength}`,
      htfBias: t1d.direction === "LONG" ? "BULLISH" : t1d.direction === "SHORT" ? "BEARISH" : "NEUTRAL",
      adx: Math.round(adxVal * 10) / 10,
      rsi: Math.round(rsi(candles4h.map((c) => c.close)) * 10) / 10,
      stochK: stoch.k,
      stochD: stoch.d,
      zoneTop: zone.zoneTop,
      zoneBottom: zone.zoneBottom,
      zoneScore: zone.zoneScore,
      zoneQuality: zone.zoneQuality,
      closes4h: closes4h.slice(-50),
    };
    return { market, debug };
  }

  debug.push(`StochRSI: K ${stoch.k} | D ${stoch.d}`);
  debug.push(`ADX: ${adxVal.toFixed(1)}`);

  const now = Date.now();

  // === EXIT COOLDOWN CHECK ===
  const cooldown = isInCooldown(pair, now, tradeDirection);
  if (cooldown.inCooldown) {
    const remainingH = (cooldown.remainingMs / 3600000).toFixed(1);
    debug.push(`EXIT COOLDOWN: ${remainingH}h remaining since last ${cooldown.lastExit?.direction} exit (${cooldown.lastExit?.exitReason})`);

    const phase = detectPhase(tradeDirection, adxVal, stoch.k, stoch.d, false, momentumResult);
    const trendline = getTrendline(pair, candles4h, tradeDirection);
    const tlPrice = trendline ? trendline.price : price;
    const zone = calculateZone(candles4h, tlPrice, atrVal, tradeDirection);

    const market: MarketData = {
      pair,
      price: Math.round(price * 100) / 100,
      timestamp: now,
      phase,
      trend: `${tradeDirection} ${t1d.strength}`,
      htfBias: tradeDirection === "LONG" ? "BULLISH" : "BEARISH",
      adx: Math.round(adxVal * 10) / 10,
      rsi: Math.round(rsi(candles4h.map((c) => c.close)) * 10) / 10,
      stochK: stoch.k,
      stochD: stoch.d,
      zoneTop: zone.zoneTop,
      zoneBottom: zone.zoneBottom,
      zoneScore: zone.zoneScore,
      zoneQuality: zone.zoneQuality,
      closes4h: closes4h.slice(-50),
    };
    return { market, debug };
  }

  // === ENTRY: Momentum must agree with tradeDirection ===
  let shouldEnter = false;
  let entryDirection: "LONG" | "SHORT" | null = null;

  if (momentumResult.hasMomentum && momentumResult.direction === tradeDirection) {
    shouldEnter = true;
    entryDirection = momentumResult.direction;
  }

  if (!shouldEnter || !entryDirection) {
    debug.push(`State: Stoch K${stoch.k} D${stoch.d} | No early momentum signal`);

    const phase = detectPhase(tradeDirection, adxVal, stoch.k, stoch.d, false, momentumResult);
    const trendline = getTrendline(pair, candles4h, tradeDirection);
    const tlPrice = trendline ? trendline.price : price;
    const zone = calculateZone(candles4h, tlPrice, atrVal, tradeDirection);

    const market: MarketData = {
      pair,
      price: Math.round(price * 100) / 100,
      timestamp: now,
      phase,
      trend: `${tradeDirection} ${t1d.strength}`,
      htfBias: tradeDirection === "LONG" ? "BULLISH" : "BEARISH",
      adx: Math.round(adxVal * 10) / 10,
      rsi: Math.round(rsi(candles4h.map((c) => c.close)) * 10) / 10,
      stochK: stoch.k,
      stochD: stoch.d,
      zoneTop: zone.zoneTop,
      zoneBottom: zone.zoneBottom,
      zoneScore: zone.zoneScore,
      zoneQuality: zone.zoneQuality,
      closes4h: closes4h.slice(-50),
    };
    return { market, debug };
  }

  // === FIXED % LEVELS ===
  const entry = price;
  let sl: number;
  let tp: number;

  if (entryDirection === "LONG") {
    sl = entry * (1 - LONG_SL_PCT);
    tp = entry * (1 + LONG_TP_PCT);
  } else {
    sl = entry * (1 + SHORT_SL_PCT);
    tp = entry * (1 - SHORT_TP_PCT);
  }

  const rr = Math.abs(tp - entry) / Math.abs(entry - sl);
  if (rr < MIN_RR) {
    debug.push(`R:R ${rr.toFixed(2)} < ${MIN_RR} — skipping`);

    const phase = detectPhase(tradeDirection, adxVal, stoch.k, stoch.d, false, momentumResult);
    const trendline = getTrendline(pair, candles4h, tradeDirection);
    const tlPrice = trendline ? trendline.price : price;
    const zone = calculateZone(candles4h, tlPrice, atrVal, tradeDirection);

    const market: MarketData = {
      pair,
      price: Math.round(price * 100) / 100,
      timestamp: now,
      phase,
      trend: `${tradeDirection} ${t1d.strength}`,
      htfBias: tradeDirection === "LONG" ? "BULLISH" : "BEARISH",
      adx: Math.round(adxVal * 10) / 10,
      rsi: Math.round(rsi(candles4h.map((c) => c.close)) * 10) / 10,
      stochK: stoch.k,
      stochD: stoch.d,
      zoneTop: zone.zoneTop,
      zoneBottom: zone.zoneBottom,
      zoneScore: zone.zoneScore,
      zoneQuality: zone.zoneQuality,
      closes4h: closes4h.slice(-50),
    };
    return { market, debug };
  }

  const rsi4h = rsi(candles4h.map((c) => c.close));
  const expectedMove = (Math.abs(tp - entry) / entry) * 100;

  const entryReason = `${entryDirection} EARLY MOMENTUM | 1D ${t1d.strength} | 4H ${t4h.strength} | Stoch K${stoch.k} D${stoch.d} | ${momentumResult.reasons.join(", ")} | RR ${rr.toFixed(2)}`;

  const signal: Signal = {
    id: `${pair}_${Date.now()}`,
    pair,
    direction: entryDirection,
    type: "ACCUMULATE",
    scale: "ENTRY_1",
    entry: Math.round(entry * 100) / 100,
    stop: Math.round(sl * 100) / 100,
    target: Math.round(tp * 100) / 100,
    confidence: momentumResult.strength,
    rr: Math.round(rr * 100) / 100,
    adx: Math.round(adxVal * 10) / 10,
    rsi: Math.round(rsi4h * 10) / 10,
    stochK: stoch.k,
    stochD: stoch.d,
    expectedMove: Math.round(expectedMove * 10) / 10,
    reason: entryReason,
    timestamp: now,
    version: CURRENT_SIGNAL_VERSION,
    stage: "CONFIRMED",
    explanation: entryReason,
  };

  const phase = detectPhase(tradeDirection, adxVal, stoch.k, stoch.d, true, momentumResult);
  const trendline = getTrendline(pair, candles4h, tradeDirection);
  const tlPrice = trendline ? trendline.price : price;
  const zone = calculateZone(candles4h, tlPrice, atrVal, tradeDirection);

  signal.zoneTop = zone.zoneTop ?? undefined;
  signal.zoneBottom = zone.zoneBottom ?? undefined;
  signal.trail = entryDirection === "LONG"
    ? Math.round((entry - atrVal) * 100) / 100
    : Math.round((entry + atrVal) * 100) / 100;

  const market: MarketData = {
    pair,
    price: Math.round(price * 100) / 100,
    timestamp: now,
    phase,
    trend: `${tradeDirection} ${t1d.strength}`,
    htfBias: entryDirection === "LONG" ? "BULLISH" : "BEARISH",
    adx: signal.adx,
    rsi: signal.rsi,
    stochK: signal.stochK,
    stochD: signal.stochD,
    zoneTop: zone.zoneTop,
    zoneBottom: zone.zoneBottom,
    zoneScore: zone.zoneScore,
    zoneQuality: zone.zoneQuality,
    closes4h: closes4h.slice(-50),
  };

  debug.push(`SIGNAL: EARLY MOMENTUM ${signal.direction} entry=${signal.entry} | TP ${signal.target} (+${expectedMove.toFixed(1)}%) | SL ${signal.stop} (-${(Math.abs((signal.stop - signal.entry) / signal.entry * 100)).toFixed(1)}%) | RR ${signal.rr}`);

  return { signal, market, debug };
}

// ============================================================
// MARKET SNAPSHOT
// ============================================================
export function getMarketSnapshot(
  pair: string,
  candles1h: Candle[],
  candles4h: Candle[],
  candles15m: Candle[]
): MarketData {
  const candles1d = aggregateTo1D(candles4h);
  const t1d = trend1D(candles1d);
  const t4h = trend4H(candles4h);
  const stochRsi4h = stochRsi(candles4h.map((c) => c.close));
  const price = candles4h[candles4h.length - 1].close;
  const config = getPairConfig(pair);

  const trendline = t1d.direction ? getTrendline(pair, candles4h, t1d.direction) : null;
  const tlPrice = trendline ? trendline.price : price;
  const atrVal = atr(candles4h, 14);
  const adxVal = adx(candles4h);

  const closes4h = candles4h.map((c) => c.close);
  const momentumResult = detectEarlyMomentum(candles4h, price, config);

  const phase = detectPhase(t1d.direction, adxVal, stochRsi4h.k, stochRsi4h.d, false, momentumResult);
  const zone = calculateZone(candles4h, tlPrice, atrVal, t1d.direction);

  return {
    pair,
    price: Math.round(price * 100) / 100,
    timestamp: Date.now(),
    phase,
    trend: t1d.direction ? `${t1d.direction} ${t1d.strength}` : "NONE",
    htfBias: t1d.direction === "LONG" ? "BULLISH" : t1d.direction === "SHORT" ? "BEARISH" : "NEUTRAL",
    adx: Math.round(adxVal * 10) / 10,
    rsi: Math.round(rsi(candles4h.map((c) => c.close)) * 10) / 10,
    stochK: stochRsi4h.k,
    stochD: stochRsi4h.d,
    zoneTop: zone.zoneTop,
    zoneBottom: zone.zoneBottom,
    zoneScore: zone.zoneScore,
    zoneQuality: zone.zoneQuality,
    closes4h: closes4h.slice(-50),
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

export function isSignalStillValid(
  signal: Signal,
  currentPrice: number,
  now: number = Date.now()
): ValidityCheck {
  const ageMs = now - signal.timestamp;

  const maxAge = signal.type === "ACCUMULATE" ? 24 * 60 * 60 * 1000 : 4 * 60 * 60 * 1000;

  if (ageMs > maxAge) {
    return { valid: false, reason: "expired_ttl", exited: true };
  }

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

// --- shouldHold (PATCHED) ---
export interface HoldResult {
  shouldHold: boolean;
  reason: string;
}

export function shouldHold(
  signal: Signal,
  candles4h: Candle[],
  currentPrice: number,
  now?: number
): HoldResult {
  // PATCH: Don't re-evaluate already exited signals
  if (signal.exited || hasExited(signal.id)) {
    return { shouldHold: false, reason: "already_exited" };
  }

  const candles1d = aggregateTo1D(candles4h);
  const t1d = trend1D(candles1d);
  const trendReversed = (signal.direction === "LONG" && t1d.direction === "SHORT") ||
                        (signal.direction === "SHORT" && t1d.direction === "LONG");

  if (trendReversed) {
    const inProfit = signal.direction === "LONG"
      ? currentPrice > signal.entry
      : currentPrice < signal.entry;
    if (!inProfit) {
      if (now) recordExit(signal.id, signal.pair, signal.direction, currentPrice, "trend_reversed_unprofitable", now);
      return { shouldHold: false, reason: "trend_reversed_unprofitable" };
    }
  }

  const closes4h = candles4h.map((c) => c.close);
  const stoch = stochRsi(closes4h);

  // PATCH: Only profit-take at Stoch extremes if actually in profit
  const isInProfit = signal.direction === "LONG"
    ? currentPrice > signal.entry
    : currentPrice < signal.entry;

  if (isInProfit) {
    const stochExtremeProfit = signal.direction === "LONG"
      ? stoch.k > 80
      : stoch.k < 20;

    if (stochExtremeProfit) {
      if (now) recordExit(signal.id, signal.pair, signal.direction, currentPrice, "stoch_profit_take", now);
      return { shouldHold: false, reason: "stoch_profit_take" };
    }
  }

  const validity = isSignalStillValid(signal, currentPrice, now);
  if (!validity.valid && now) {
    recordExit(signal.id, signal.pair, signal.direction, currentPrice, validity.reason, now);
  }
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
    // PATCH: Skip already exited signals
    if (signal.exited || hasExited(signal.id)) {
      continue;
    }

    const price = currentPrices[signal.pair];
    if (price === undefined) {
      active.push(signal);
      continue;
    }
    const check = isSignalStillValid(signal, price, now);
    if (check.valid) active.push(signal);
    else {
      exited.push({ signal, reason: check.reason });
      if (now) recordExit(signal.id, signal.pair, signal.direction, price, check.reason, now);
    }
  }

  return { active, exited };
}

// --- checkTradeStatus ---
export type TradeStatus = "ACTIVE" | "TP_HIT" | "SL_HIT" | "EXPIRED";

export function checkTradeStatus(
  signal: Signal,
  currentPrice: number,
  now: number = Date.now()
): TradeStatus {
  // PATCH: Already exited
  if (signal.exited || hasExited(signal.id)) {
    return "EXPIRED";
  }

  const validity = isSignalStillValid(signal, currentPrice, now);

  if (!validity.valid && validity.reason === "expired_ttl") {
    recordExit(signal.id, signal.pair, signal.direction, currentPrice, "expired_ttl", now);
    return "EXPIRED";
  }

  if (signal.direction === "LONG") {
    if (currentPrice >= signal.target) {
      recordExit(signal.id, signal.pair, signal.direction, currentPrice, "tp_hit", now);
      return "TP_HIT";
    }
    if (currentPrice <= signal.stop) {
      recordExit(signal.id, signal.pair, signal.direction, currentPrice, "sl_hit", now);
      return "SL_HIT";
    }
  } else {
    if (currentPrice <= signal.target) {
      recordExit(signal.id, signal.pair, signal.direction, currentPrice, "tp_hit", now);
      return "TP_HIT";
    }
    if (currentPrice >= signal.stop) {
      recordExit(signal.id, signal.pair, signal.direction, currentPrice, "sl_hit", now);
      return "SL_HIT";
    }
  }

  return "ACTIVE";
}

// ============================================================
// v28 COMPATIBILITY LAYER
// ============================================================
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

// PATCH: Export hasExited for cron deduplication
export { hasExited };

export async function generateSignalCompat(
  pair: string,
  candles1h: Candle[],
  candles4h: Candle[],
  candles15m: Candle[],
  activeTrades?: Record<string, any>,
  currentPrice?: number
): Promise<SignalResult> {
  const result = generateSignal(pair, candles1h, candles4h, candles15m, currentPrice);

  if (result.signal?.scale === "ENTRY_2") {
    return { ...result, signal: undefined };
  }

  return result;
}

export function isSignalStillValidBool(
  signal: Signal,
  currentPrice: number
): boolean {
  return isSignalStillValid(signal, currentPrice).valid;
}

export function shouldHoldCompat(
  signal: Signal,
  candles4h: Candle[],
  candles1h: Candle[],
  currentPrice: number
): HoldResult {
  return shouldHold(signal, candles4h, currentPrice);
}

// ============================================================
// STUB EXPORTS
// ============================================================
export const FEATURES = {
  TRADE_MANAGER_ENABLED: false,
  PROFIT_LOCK_ENABLED: false,
  TRAIL_STOP_ENABLED: false,
  BREAK_EVEN_ENABLED: false,
  EXHAUSTION_FILTER_ENABLED: true,
};

export type TradeState = "OPEN" | "BREAK_EVEN" | "LOCKED" | "RUNNER" | "EXITED";

export interface TradeManagerState {
  tradeState: TradeState;
  highestPrice: number;
  lowestPrice: number;
  lockedStop: number;
  entryPrice: number;
  direction: "LONG" | "SHORT";
  initialStop: number;
}

export function updateTradeManagerState(
  _signal: Signal,
  _currentPrice: number,
  _candles4h: Candle[]
): { state: TradeManagerState; shouldExit: boolean; exitReason?: string } {
  return {
    state: {
      tradeState: "OPEN",
      highestPrice: 0,
      lowestPrice: 0,
      lockedStop: 0,
      entryPrice: 0,
      direction: "LONG",
      initialStop: 0,
    },
    shouldExit: false,
  };
}

export function removeTradeManagerState(_signalId: string): void {
  return;
}

export function setTradeManagerPersistence(
  _getFn: (signalId: string) => Promise<TradeManagerState | null>,
  _setFn: (signalId: string, state: TradeManagerState) => Promise<void>,
  _delFn: (signalId: string) => Promise<void>
): void {
  return;
}

export function clearAllTradeManagerState(): void {
  return;
}
