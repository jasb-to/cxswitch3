// lib/strategy.ts — v46.1 "Three Rules" — Refined Early Entry System
// ============================================================
// UI/logging refinements only. Core trading logic unchanged from v46.
// Layer 1: 4H Bias (EMA8 vs EMA21 only)
// Layer 2: 1H Location (trendline OR swing S/R only)
// Layer 3: 15M Trigger (Stoch cross OR EMA cross) + 1 confirmation
// One ENTRY signal. No exits. No scoring. No daily. No ADX.

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
  timestamp: number;
  version: number;
  reason: string;
  primaryTrigger: string;
  confirmation: string;
  exited?: boolean;
  status?: "ACTIVE" | "EXITED";
  exitReason?: string;
  exitTimestamp?: number;
  exitPrice?: number;
}

export interface SignalResult {
  signal?: Signal;
  debug: string[];
}

export interface TriggerDiagnostics {
  stochCross: { passed: boolean; detail: string };
  emaCross: { passed: boolean; detail: string };
  reclaimEma21: { passed: boolean; detail: string };
  volumeSpike: { passed: boolean; detail: string };
  primaryPassed: string[];
  confirmationPassed: string[];
  fired: boolean;
  summary: string;
}

// ─── Compatibility types for state.ts ──────────────────────

export interface MarketRegime {
  pair: string;
  direction: "LONG" | "SHORT";
  timestamp: number;
}

export interface ExitRecord {
  id: string;
  pair: string;
  direction: "LONG" | "SHORT";
  entry: number;
  exitPrice: number;
  pnl: number;
  reason: string;
  timestamp: number;
}

export const CURRENT_SIGNAL_VERSION = 46.1;
const MIN_RR = 1.5;
const ATR_MULT = 2.0;
const TL_PROXIMITY = 0.012;
const SWING_PROXIMITY = 0.008;
const VOL_THRESHOLD = 1.2;
const STOCH_EXTREME_LONG = 30;
const STOCH_EXTREME_SHORT = 70;
const COOLDOWN_MS = 4 * 60 * 60 * 1000;
const TL_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// ─── HELPERS ───────────────────────────────────────────────

function avg(arr: number[]): number {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
}

function ema(values: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const out: number[] = [values[0]];
  for (let i = 1; i < values.length; i++) {
    out.push(values[i] * k + out[i - 1] * (1 - k));
  }
  return out;
}

// ─── WILDER RSI (TradingView exact) ────────────────────────

function wilderRsi(closes: number[], period = 14): number {
  if (closes.length < period + 1) return 50;
  const diffs: number[] = [];
  for (let i = 1; i < closes.length; i++) diffs.push(closes[i] - closes[i - 1]);
  let avgGain = 0, avgLoss = 0;
  for (let i = 0; i < period; i++) {
    avgGain += Math.max(0, diffs[i]);
    avgLoss += Math.max(0, -diffs[i]);
  }
  avgGain /= period;
  avgLoss /= period;
  for (let i = period; i < diffs.length; i++) {
    avgGain = (avgGain * (period - 1) + Math.max(0, diffs[i])) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(0, -diffs[i])) / period;
  }
  if (avgLoss === 0) return avgGain > 0 ? 100 : 50;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

function wilderRsiSeries(closes: number[], period = 14): number[] {
  const series: number[] = [];
  for (let i = period; i < closes.length; i++) {
    series.push(wilderRsi(closes.slice(0, i + 1), period));
  }
  return series;
}

// ─── StochRSI (TradingView exact, Wilder RSI) ──────────────

function stochRsi(closes: number[], rsiPeriod = 14, stochPeriod = 14, kSmooth = 3, dSmooth = 3): { k: number; d: number } {
  const rsiValues = wilderRsiSeries(closes, rsiPeriod);
  if (rsiValues.length < stochPeriod + kSmooth - 1) return { k: 50, d: 50 };

  const rawK: number[] = [];
  for (let i = stochPeriod - 1; i < rsiValues.length; i++) {
    const w = rsiValues.slice(i - stochPeriod + 1, i + 1);
    const lo = Math.min(...w), hi = Math.max(...w);
    rawK.push(hi === lo ? 50 : ((rsiValues[i] - lo) / (hi - lo)) * 100);
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

// ─── ATR ───────────────────────────────────────────────────

function atr(candles: Candle[], period = 14): number {
  const trs: number[] = [];
  for (let i = Math.max(1, candles.length - period); i < candles.length; i++) {
    trs.push(Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close)
    ));
  }
  return avg(trs);
}

// ─── TRENDLINE (stateful, from v28) ────────────────────────

interface TrendlineState {
  slope: number;
  intercept: number;
  lastUpdated: number;
  direction: "LONG" | "SHORT";
  r2: number;
}

const trendlineStore: Map<string, TrendlineState> = new Map();

interface Pivot { index: number; price: number; timestamp: number; }

function findPivots(candles: Candle[], direction: "LONG" | "SHORT"): Pivot[] {
  const pivots: Pivot[] = [];
  for (let i = 3; i < candles.length - 3; i++) {
    const isSwingLow = candles[i].low < candles[i-1].low && candles[i].low < candles[i-2].low &&
                       candles[i].low < candles[i+1].low && candles[i].low < candles[i+2].low;
    const isSwingHigh = candles[i].high > candles[i-1].high && candles[i].high > candles[i-2].high &&
                        candles[i].high > candles[i+1].high && candles[i].high > candles[i+2].high;
    if (direction === "LONG" && isSwingLow) pivots.push({ index: i, price: candles[i].low, timestamp: candles[i].timestamp });
    if (direction === "SHORT" && isSwingHigh) pivots.push({ index: i, price: candles[i].high, timestamp: candles[i].timestamp });
  }
  return pivots;
}

function fitTrendline(pivots: Pivot[]): { slope: number; intercept: number; r2: number } | null {
  const n = pivots.length;
  if (n < 3) return null;
  const sumX = pivots.reduce((s, p) => s + p.index, 0);
  const sumY = pivots.reduce((s, p) => s + p.price, 0);
  const sumXY = pivots.reduce((s, p) => s + p.index * p.price, 0);
  const sumX2 = pivots.reduce((s, p) => s + p.index * p.index, 0);
  const denom = n * sumX2 - sumX * sumX;
  if (denom === 0) return null;
  const slope = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;
  const yMean = sumY / n;
  const ssTot = pivots.reduce((s, p) => s + Math.pow(p.price - yMean, 2), 0);
  const ssRes = pivots.reduce((s, p) => s + Math.pow(p.price - (slope * p.index + intercept), 2), 0);
  return { slope, intercept, r2: ssTot === 0 ? 0 : 1 - ssRes / ssTot };
}

function getTrendline(pair: string, candles: Candle[], direction: "LONG" | "SHORT"): { price: number; r2: number } | null {
  if (candles.length < 30) return null;
  const pivots = findPivots(candles, direction);
  if (pivots.length < 3) return null;

  const recentPivots = pivots.slice(-5);
  const now = candles[candles.length - 1].timestamp;
  const existing = trendlineStore.get(pair);

  if (existing && existing.direction === direction && (now - existing.lastUpdated) < TL_MAX_AGE_MS) {
    const lastPivot = recentPivots[recentPivots.length - 1];
    const projected = existing.slope * lastPivot.index + existing.intercept;
    const deviation = Math.abs(lastPivot.price - projected) / projected;
    if (deviation < 0.02) {
      const currentIndex = candles.length - 1;
      return { price: existing.slope * currentIndex + existing.intercept, r2: existing.r2 };
    }
  }

  const fit = fitTrendline(recentPivots);
  if (!fit || fit.r2 < 0.50) return null;

  trendlineStore.set(pair, {
    slope: fit.slope,
    intercept: fit.intercept,
    lastUpdated: now,
    direction,
    r2: Math.round(fit.r2 * 100) / 100,
  });

  const currentIndex = candles.length - 1;
  return { price: fit.slope * currentIndex + fit.intercept, r2: Math.round(fit.r2 * 100) / 100 };
}

// ─── LAYER 1: 4H BIAS ──────────────────────────────────────

function bias4H(candles4h: Candle[]): "LONG" | "SHORT" | null {
  if (candles4h.length < 30) return null;
  const closes = candles4h.map(c => c.close);
  const e8 = ema(closes, 8);
  const e21 = ema(closes, 21);
  if (!e8.length || !e21.length) return null;
  return e8[e8.length - 1] > e21[e21.length - 1] ? "LONG" : "SHORT";
}

// ─── LAYER 2: 1H LOCATION ──────────────────────────────────

function location1H(
  pair: string,
  candles1h: Candle[],
  direction: "LONG" | "SHORT"
): { valid: boolean; detail: string; locationType: "trendline" | "swing" | null } {
  if (candles1h.length < 30) {
    return { valid: false, detail: "Insufficient 1H data", locationType: null };
  }

  const price = candles1h[candles1h.length - 1].close;

  // Check 1: Trendline proximity (highest confidence)
  const tl = getTrendline(pair, candles1h, direction);
  if (tl) {
    const dist = Math.abs(price - tl.price) / tl.price;
    if (dist < TL_PROXIMITY) {
      return { valid: true, detail: `Trendline ${(dist * 100).toFixed(2)}% (R² ${tl.r2.toFixed(2)})`, locationType: "trendline" };
    }
  }

  // Check 2: Swing S/R proximity
  const recent = candles1h.slice(-20);
  if (direction === "LONG") {
    const swingLow = Math.min(...recent.map(c => c.low));
    const dist = (price - swingLow) / swingLow;
    if (dist >= 0 && dist < SWING_PROXIMITY) {
      return { valid: true, detail: `Swing low ${(dist * 100).toFixed(2)}%`, locationType: "swing" };
    }
  } else {
    const swingHigh = Math.max(...recent.map(c => c.high));
    const dist = (swingHigh - price) / swingHigh;
    if (dist >= 0 && dist < SWING_PROXIMITY) {
      return { valid: true, detail: `Swing high ${(dist * 100).toFixed(2)}%`, locationType: "swing" };
    }
  }

  return { valid: false, detail: "No valid location", locationType: null };
}

// ─── LAYER 3: 15M TRIGGER ──────────────────────────────────

function trigger15M(candles15m: Candle[], direction: "LONG" | "SHORT"): TriggerDiagnostics {
  const defaultFail: TriggerDiagnostics = {
    stochCross: { passed: false, detail: "Insufficient data" },
    emaCross: { passed: false, detail: "Insufficient data" },
    reclaimEma21: { passed: false, detail: "Insufficient data" },
    volumeSpike: { passed: false, detail: "Insufficient data" },
    primaryPassed: [],
    confirmationPassed: [],
    fired: false,
    summary: "Insufficient 15M data",
  };

  if (candles15m.length < 10) return defaultFail;

  const closes = candles15m.map(c => c.close);
  const prevCloses = closes.slice(0, -1);
  const stoch = stochRsi(closes);
  const prevStoch = stochRsi(prevCloses);
  const e8 = ema(closes, 8);
  const e21 = ema(closes, 21);

  const diag: TriggerDiagnostics = {
    stochCross: { passed: false, detail: "" },
    emaCross: { passed: false, detail: "" },
    reclaimEma21: { passed: false, detail: "" },
    volumeSpike: { passed: false, detail: "" },
    primaryPassed: [],
    confirmationPassed: [],
    fired: false,
    summary: "",
  };

  // Stoch cross evaluation
  if (direction === "LONG") {
    if (prevStoch.k < prevStoch.d && stoch.k >= stoch.d && stoch.k < STOCH_EXTREME_LONG) {
      diag.stochCross = { passed: true, detail: `K crossed above D from oversold (K=${stoch.k}, D=${stoch.d})` };
      diag.primaryPassed.push("stoch_cross");
    } else if (stoch.k >= STOCH_EXTREME_LONG) {
      diag.stochCross = { passed: false, detail: `K=${stoch.k} not in oversold zone (<${STOCH_EXTREME_LONG})` };
    } else if (prevStoch.k >= prevStoch.d) {
      diag.stochCross = { passed: false, detail: `Already above D (K=${prevStoch.k}, D=${prevStoch.d}), no cross` };
    } else {
      diag.stochCross = { passed: false, detail: `K below D but no cross yet (K=${stoch.k}, D=${stoch.d})` };
    }
  } else {
    if (prevStoch.k > prevStoch.d && stoch.k <= stoch.d && stoch.k > STOCH_EXTREME_SHORT) {
      diag.stochCross = { passed: true, detail: `K crossed below D from overbought (K=${stoch.k}, D=${stoch.d})` };
      diag.primaryPassed.push("stoch_cross");
    } else if (stoch.k <= STOCH_EXTREME_SHORT) {
      diag.stochCross = { passed: false, detail: `K=${stoch.k} not in overbought zone (>${STOCH_EXTREME_SHORT})` };
    } else if (prevStoch.k <= prevStoch.d) {
      diag.stochCross = { passed: false, detail: `Already below D (K=${prevStoch.k}, D=${prevStoch.d}), no cross` };
    } else {
      diag.stochCross = { passed: false, detail: `K above D but no cross yet (K=${stoch.k}, D=${stoch.d})` };
    }
  }

  // EMA cross evaluation
  if (e8.length >= 2 && e21.length >= 2) {
    const prevE8 = e8[e8.length - 2], prevE21 = e21[e21.length - 2];
    const lastE8 = e8[e8.length - 1], lastE21 = e21[e21.length - 1];
    if (direction === "LONG") {
      if (prevE8 <= prevE21 && lastE8 > lastE21) {
        diag.emaCross = { passed: true, detail: `EMA8 crossed above EMA21` };
        diag.primaryPassed.push("ema_cross");
      } else if (lastE8 > lastE21) {
        diag.emaCross = { passed: false, detail: `Already above EMA21, no cross` };
      } else {
        diag.emaCross = { passed: false, detail: `EMA8 ${lastE8.toFixed(2)} below EMA21 ${lastE21.toFixed(2)}` };
      }
    } else {
      if (prevE8 >= prevE21 && lastE8 < lastE21) {
        diag.emaCross = { passed: true, detail: `EMA8 crossed below EMA21` };
        diag.primaryPassed.push("ema_cross");
      } else if (lastE8 < lastE21) {
        diag.emaCross = { passed: false, detail: `Already below EMA21, no cross` };
      } else {
        diag.emaCross = { passed: false, detail: `EMA8 ${lastE8.toFixed(2)} above EMA21 ${lastE21.toFixed(2)}` };
      }
    }
  } else {
    diag.emaCross = { passed: false, detail: "Insufficient EMA data" };
  }

  // Reclaim EMA21 evaluation
  if (e21.length >= 2) {
    const prevClose = closes[closes.length - 2];
    const lastClose = closes[closes.length - 1];
    const prevE21 = e21[e21.length - 2];
    const lastE21 = e21[e21.length - 1];
    if (direction === "LONG") {
      if (prevClose <= prevE21 && lastClose > lastE21) {
        diag.reclaimEma21 = { passed: true, detail: `Price reclaimed EMA21` };
        diag.confirmationPassed.push("reclaim_ema21");
      } else if (lastClose > lastE21) {
        diag.reclaimEma21 = { passed: false, detail: `Already above EMA21` };
      } else {
        diag.reclaimEma21 = { passed: false, detail: `Price ${lastClose.toFixed(2)} below EMA21 ${lastE21.toFixed(2)}` };
      }
    } else {
      if (prevClose >= prevE21 && lastClose < lastE21) {
        diag.reclaimEma21 = { passed: true, detail: `Price dropped below EMA21` };
        diag.confirmationPassed.push("reclaim_ema21");
      } else if (lastClose < lastE21) {
        diag.reclaimEma21 = { passed: false, detail: `Already below EMA21` };
      } else {
        diag.reclaimEma21 = { passed: false, detail: `Price ${lastClose.toFixed(2)} above EMA21 ${lastE21.toFixed(2)}` };
      }
    }
  } else {
    diag.reclaimEma21 = { passed: false, detail: "Insufficient EMA data" };
  }

  // Volume evaluation
  if (candles15m.length >= 10) {
    const vols = candles15m.slice(-10).map(c => c.volume);
    const avgVol = avg(vols.slice(0, -1));
    const currentVol = vols[vols.length - 1];
    const ratio = avgVol > 0 ? currentVol / avgVol : 0;
    if (ratio >= VOL_THRESHOLD) {
      diag.volumeSpike = { passed: true, detail: `Volume ${ratio.toFixed(1)}x avg` };
      diag.confirmationPassed.push("volume_spike");
    } else {
      diag.volumeSpike = { passed: false, detail: `Volume ${ratio.toFixed(1)}x avg (need ${VOL_THRESHOLD}x)` };
    }
  } else {
    diag.volumeSpike = { passed: false, detail: "Insufficient volume data" };
  }

  const hasPrimary = diag.primaryPassed.length > 0;
  const hasConfirmation = diag.confirmationPassed.length > 0;
  diag.fired = hasPrimary && hasConfirmation;

  if (diag.fired) {
    diag.summary = `${diag.primaryPassed[0]} + ${diag.confirmationPassed[0]}`;
  } else if (hasPrimary) {
    diag.summary = `Primary trigger detected (${diag.primaryPassed[0]}). Waiting for confirmation (EMA reclaim or volume expansion).`;
  } else if (hasConfirmation) {
    diag.summary = `Confirmation ready (${diag.confirmationPassed[0]}) but no primary trigger. Waiting for Stoch cross or EMA cross.`;
  } else {
    diag.summary = `No primary trigger. Stoch K=${stoch.k} D=${stoch.d}. Waiting for cross from extreme.`;
  }

  return diag;
}

// ─── COOLDOWN ──────────────────────────────────────────────

const cooldownStore: Map<string, number> = new Map();

function isOnCooldown(pair: string, now: number): boolean {
  const until = cooldownStore.get(pair);
  return until !== undefined && now < until;
}

function setCooldown(pair: string, now: number): void {
  cooldownStore.set(pair, now + COOLDOWN_MS);
}

// ─── MAIN SIGNAL ─────────────────────────────────────────

export function generateSignal(
  pair: string,
  candles1h: Candle[],
  candles4h: Candle[],
  candles15m: Candle[],
  activeSignals: Signal[],
  currentPrice?: number
): SignalResult {
  const debug: string[] = [];
  const now = Date.now();
  const price = currentPrice ?? candles4h[candles4h.length - 1]?.close ?? 0;

  // Duplicate protection
  const hasActive = activeSignals.some(s => s.pair === pair && !s.exited);
  if (hasActive) {
    debug.push("Rejected: active trade");
    return { debug };
  }

  // Cooldown
  if (isOnCooldown(pair, now)) {
    const mins = Math.round((cooldownStore.get(pair)! - now) / 60000);
    debug.push(`Rejected: cooldown (${mins}min)`);
    return { debug };
  }

  // Layer 1: Bias
  const bias = bias4H(candles4h);
  if (!bias) {
    debug.push("Bias: NONE ✗");
    debug.push("Rejected: bias");
    return { debug };
  }
  debug.push(`Bias: ${bias} ✓`);

  // Layer 2: Location
  const location = location1H(pair, candles1h, bias);
  if (!location.valid) {
    debug.push(`Location: ${location.detail} ✗`);
    debug.push("Rejected: location");
    return { debug };
  }
  debug.push(`Location: ${location.detail} ✓`);

  // Layer 3: Trigger
  const trigger = trigger15M(candles15m, bias);

  // Structured trigger log
  debug.push("Trigger:");
  debug.push(`  ${trigger.stochCross.passed ? "✓" : "✗"} Stoch Cross — ${trigger.stochCross.detail}`);
  debug.push(`  ${trigger.emaCross.passed ? "✓" : "✗"} EMA Cross — ${trigger.emaCross.detail}`);
  debug.push(`  ${trigger.reclaimEma21.passed ? "✓" : "✗"} EMA21 Reclaim — ${trigger.reclaimEma21.detail}`);
  debug.push(`  ${trigger.volumeSpike.passed ? "✓" : "✗"} Volume — ${trigger.volumeSpike.detail}`);
  debug.push(`  Primary: ${trigger.primaryPassed.length}/1 | Confirmation: ${trigger.confirmationPassed.length}/1`);

  if (!trigger.fired) {
    debug.push(`Result: ${trigger.summary}`);
    debug.push("Rejected: trigger");
    return { debug };
  }
  debug.push(`Result: ${trigger.summary} ✓`);

  // Risk levels
  const atrVal = atr(candles1h, 14);
  const recent = candles1h.slice(-20);
  const swingLow = Math.min(...recent.map(c => c.low));
  const swingHigh = Math.max(...recent.map(c => c.high));

  let stop: number;
  let target: number;

  if (bias === "LONG") {
    const atrStop = price - atrVal * ATR_MULT;
    stop = Math.max(atrStop, swingLow);
    const target3R = price + (price - stop) * 3;
    target = Math.min(swingHigh, target3R);
  } else {
    const atrStop = price + atrVal * ATR_MULT;
    stop = Math.min(atrStop, swingHigh);
    const target3R = price - (stop - price) * 3;
    target = Math.max(swingLow, target3R);
  }

  const risk = Math.abs(price - stop);
  const reward = Math.abs(target - price);
  const rr = risk > 0 ? reward / risk : 0;

  if (rr < MIN_RR) {
    debug.push(`Risk: RR ${rr.toFixed(2)} < ${MIN_RR} ✗`);
    debug.push("Rejected: RR");
    return { debug };
  }
  debug.push(`Risk: RR ${rr.toFixed(2)} ✓`);

  // Accept
  setCooldown(pair, now);

  const signal: Signal = {
    id: `${pair}_${now}`,
    pair,
    direction: bias,
    entry: Math.round(price * 100) / 100,
    stop: Math.round(stop * 100) / 100,
    target: Math.round(target * 100) / 100,
    rr: Math.round(rr * 100) / 100,
    timestamp: now,
    version: CURRENT_SIGNAL_VERSION,
    reason: `${bias} | ${location.detail} | ${trigger.summary}`,
    primaryTrigger: trigger.primaryPassed[0],
    confirmation: trigger.confirmationPassed[0],
  };

  debug.push(`SIGNAL: ${bias} ${pair} | Entry $${signal.entry} | SL $${signal.stop} | TP $${signal.target} | RR ${signal.rr} | ${trigger.primaryPassed[0]} + ${trigger.confirmationPassed[0]}`);

  return { signal, debug };
}

// ─── MARKET SNAPSHOT ───────────────────────────────────────

export function getMarketSnapshot(
  pair: string,
  candles1h: Candle[],
  candles4h: Candle[],
  candles15m: Candle[]
) {
  const bias = bias4H(candles4h);
  const location = bias ? location1H(pair, candles1h, bias) : { valid: false, detail: "No bias", locationType: null as "trendline" | "swing" | null };
  const trigger = bias ? trigger15M(candles15m, bias) : {
    stochCross: { passed: false, detail: "No bias" },
    emaCross: { passed: false, detail: "No bias" },
    reclaimEma21: { passed: false, detail: "No bias" },
    volumeSpike: { passed: false, detail: "No bias" },
    primaryPassed: [],
    confirmationPassed: [],
    fired: false,
    summary: "No bias",
  };
  const price = candles4h[candles4h.length - 1]?.close ?? 0;

  return {
    pair,
    price: Math.round(price * 100) / 100,
    timestamp: Date.now(),
    bias: bias || "NONE",
    location: location.detail,
    locationType: location.locationType,
    trigger: trigger.summary,
    triggerDiagnostics: trigger,
    ready: bias !== null && location.valid && trigger.fired,
  };
}

// ─── STUBS (no automated exits) ──────────────────────────

export function shouldHold(): { shouldHold: boolean; reason: string } {
  return { shouldHold: true, reason: "v46 has no automated exits" };
}

export function isSignalStillValid(): { valid: boolean; reason: string; exited: boolean } {
  return { valid: true, reason: "v46 has no validity checks", exited: false };
}

export function filterExpiredSignals(signals: Signal[]) {
  return { active: signals, exited: [] };
}

// ─── COMPATIBILITY ───────────────────────────────────────

export async function generateSignalCompat(
  pair: string,
  candles1h: Candle[],
  candles4h: Candle[],
  candles1d: Candle[],
  candles15m: Candle[],
  activeSignals?: Signal[],
  currentPrice?: number
): Promise<SignalResult> {
  return generateSignal(pair, candles1h, candles4h, candles15m, activeSignals || [], currentPrice);
}

export function shouldHoldCompat(
  signal: Signal,
  candles4h: Candle[],
  candles1h: Candle[],
  candles15m: Candle[],
  currentPrice: number
): { shouldHold: boolean; reason: string } {
  return shouldHold();
}

export function aggregateTo1D(candles4h: Candle[]): Candle[] {
  if (!candles4h?.length) return [];
  const sorted = [...candles4h].sort((a, b) => a.timestamp - b.timestamp);
  const groups = new Map<string, Candle[]>();
  for (const c of sorted) {
    const key = new Date(c.timestamp).toISOString().split("T")[0];
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
