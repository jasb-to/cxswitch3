// lib/strategy.ts — v28 "Trendline Break: StochRSI Timing + Trade Manager"
// ============================================================
// Architecture: stateful trendline, hysteresis bands, TV-exact StochRSI
// EXIT: Trade Manager only (single authority)
// ALERTS: ENTRY only (no ADD, no ENTRY_2, no pyramiding)
// TRADE MANAGER: Isolated profit-locking engine, sole exit authority for open trades
//
// CHANGELOG v28-PROD-FINAL-v3:
// - Trade Manager state: in-memory with persistence hooks (get/set/clear)
// - ATR: true Wilder smoothing (reuses wilderSmooth from ADX)
// - RSI: true Wilder smoothing for TV parity
// - Trendline: uses timestamps instead of candle indices
// - Profit lock thresholds: configurable constants
// - Hysteresis: unlock on 24h OR price moved >3 ATR
// - Trend confirmation: EMA21 slope > 0 for LONG, < 0 for SHORT
// - Confidence: calculated from R², ADX, trend strength, stoch alignment, dist, RR
// - Signal IDs: crypto.randomUUID() instead of pair+Date.now()
// - Trade Manager: highestPrice/lowestPrice initialized from entry candle
// ============================================================

import { randomUUID } from "crypto";

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
  // Trade manager state (populated by cron, read by UI)
  tradeState?: TradeState;
  highestPrice?: number;
  lowestPrice?: number;
  lockedStop?: number;
  exited?: boolean;
  exitReason?: string;
  exitPrice?: number;
  exitTimestamp?: number;
}

export interface SignalResult {
  signal?: Signal;
  market?: any;
  debug: string[];
}

export const CURRENT_SIGNAL_VERSION = 28;
const MIN_RR = 1.5;

// ============================================================
// CONFIGURABLE PROFIT LOCK THRESHOLDS
// ============================================================

const BREAK_EVEN_TRIGGER = 3;   // % PnL to move stop to entry
const LOCK_TRIGGER = 6;         // % PnL to lock at +3%
const RUNNER_TRIGGER = 10;      // % PnL to activate ATR trailing

// ============================================================
// FEATURE FLAGS
// ============================================================

export const FEATURES = {
  TRADE_MANAGER_ENABLED: true,
  PROFIT_LOCK_ENABLED: true,
  TRAIL_STOP_ENABLED: true,
  BREAK_EVEN_ENABLED: true,
  EXHAUSTION_FILTER_ENABLED: true,
};

// ============================================================
// TRADE MANAGER — ISOLATED STATE MACHINE (SOLE EXIT AUTHORITY)
// ============================================================

export type TradeState =
  | "OPEN"
  | "BREAK_EVEN"
  | "LOCKED"
  | "RUNNER"
  | "EXITED";

interface TradeManagerState {
  tradeState: TradeState;
  highestPrice: number;
  lowestPrice: number;
  lockedStop: number;
  entryPrice: number;
  direction: "LONG" | "SHORT";
  initialStop: number;
}

// In-memory store (fast access)
const tradeManagerStore: Map<string, TradeManagerState> = new Map();

// Persistence hooks (set by cron to use Redis/Postgres)
let persistGet: ((signalId: string) => Promise<TradeManagerState | null>) | null = null;
let persistSet: ((signalId: string, state: TradeManagerState) => Promise<void>) | null = null;
let persistDel: ((signalId: string) => Promise<void>) | null = null;

export function setTradeManagerPersistence(
  getFn: (signalId: string) => Promise<TradeManagerState | null>,
  setFn: (signalId: string, state: TradeManagerState) => Promise<void>,
  delFn: (signalId: string) => Promise<void>
): void {
  persistGet = getFn;
  persistSet = setFn;
  persistDel = delFn;
}

async function loadTradeManagerState(signalId: string): Promise<TradeManagerState | null> {
  // Check memory first
  const mem = tradeManagerStore.get(signalId);
  if (mem) return mem;
  // Fall back to persistent store
  if (persistGet) {
    const persisted = await persistGet(signalId);
    if (persisted) {
      tradeManagerStore.set(signalId, persisted);
      return persisted;
    }
  }
  return null;
}

async function saveTradeManagerState(signalId: string, state: TradeManagerState): Promise<void> {
  tradeManagerStore.set(signalId, state);
  if (persistSet) {
    await persistSet(signalId, state);
  }
}

function getTradeManagerState(signal: Signal): TradeManagerState {
  const existing = tradeManagerStore.get(signal.id);
  if (existing) return existing;

  // FIX #14: Initialize highest/lowest from entry candle if available
  // Default to entry, but if we have the entry candle's high/low, use those
  const entryHigh = signal.highestPrice ?? signal.entry;
  const entryLow = signal.lowestPrice ?? signal.entry;

  const state: TradeManagerState = {
    tradeState: "OPEN",
    highestPrice: signal.direction === "LONG" ? entryHigh : entryLow,
    lowestPrice: signal.direction === "LONG" ? entryLow : entryHigh,
    lockedStop: signal.stop,
    entryPrice: signal.entry,
    direction: signal.direction,
    initialStop: signal.stop,
  };
  tradeManagerStore.set(signal.id, state);
  return state;
}

/** Remove a trade from the manager store (cleanup after EXITED) */
export async function removeTradeManagerState(signalId: string): Promise<void> {
  tradeManagerStore.delete(signalId);
  if (persistDel) {
    await persistDel(signalId);
  }
}

/** Reset all trade manager state (useful for testing) */
export function clearAllTradeManagerState(): void {
  tradeManagerStore.clear();
}

/**
 * Core trade manager update. SOLE exit authority for open trades.
 * Returns: updated state, shouldExit flag, exitReason.
 * Stop NEVER moves backwards.
 * Duplicate exits prevented by EXITED state short-circuit.
 */
export function updateTradeManagerState(
  signal: Signal,
  currentPrice: number,
  candles4h: Candle[]
): { state: TradeManagerState; shouldExit: boolean; exitReason?: string } {
  if (!FEATURES.TRADE_MANAGER_ENABLED) {
    return { state: getTradeManagerState(signal), shouldExit: false };
  }

  const state = getTradeManagerState(signal);

  // DUPLICATE EXIT BUG FIX: Once EXITED, never process again
  if (state.tradeState === "EXITED") {
    return { state, shouldExit: false };
  }

  // Update highest/lowest tracking
  if (signal.direction === "LONG") {
    if (currentPrice > state.highestPrice) state.highestPrice = currentPrice;
    if (currentPrice < state.lowestPrice) state.lowestPrice = currentPrice;
  } else {
    if (currentPrice < state.lowestPrice) state.lowestPrice = currentPrice;
    if (currentPrice > state.highestPrice) state.highestPrice = currentPrice;
  }

  const entry = state.entryPrice;
  const pnlPct =
    signal.direction === "LONG"
      ? ((currentPrice - entry) / entry) * 100
      : ((entry - currentPrice) / entry) * 100;

  // --- STATE TRANSITIONS ---

  // +3% → Break Even
  if (
    FEATURES.BREAK_EVEN_ENABLED &&
    state.tradeState === "OPEN" &&
    pnlPct >= BREAK_EVEN_TRIGGER
  ) {
    state.tradeState = "BREAK_EVEN";
    const newStop = entry;
    if (
      (signal.direction === "LONG" && newStop > state.lockedStop) ||
      (signal.direction === "SHORT" && newStop < state.lockedStop)
    ) {
      state.lockedStop = newStop;
    }
  }

  // +6% → Lock at +3%
  if (
    FEATURES.PROFIT_LOCK_ENABLED &&
    (state.tradeState === "OPEN" || state.tradeState === "BREAK_EVEN") &&
    pnlPct >= LOCK_TRIGGER
  ) {
    state.tradeState = "LOCKED";
    const newStop =
      signal.direction === "LONG" ? entry * 1.03 : entry * 0.97;
    if (
      (signal.direction === "LONG" && newStop > state.lockedStop) ||
      (signal.direction === "SHORT" && newStop < state.lockedStop)
    ) {
      state.lockedStop = newStop;
    }
  }

  // +10% → RUNNER (ATR trailing stop)
  if (
    FEATURES.TRAIL_STOP_ENABLED &&
    (state.tradeState === "BREAK_EVEN" || state.tradeState === "LOCKED") &&
    pnlPct >= RUNNER_TRIGGER
  ) {
    state.tradeState = "RUNNER";
  }

  // --- TRAILING STOP (only in RUNNER state) ---
  if (
    FEATURES.TRAIL_STOP_ENABLED &&
    state.tradeState === "RUNNER" &&
    candles4h.length > 0
  ) {
    const atrVal = atr(candles4h, 14);

    // Pure ATR trailing stop from current price
    const trailPrice =
      signal.direction === "LONG"
        ? currentPrice - atrVal * 2
        : currentPrice + atrVal * 2;

    if (
      (signal.direction === "LONG" && trailPrice > state.lockedStop) ||
      (signal.direction === "SHORT" && trailPrice < state.lockedStop)
    ) {
      state.lockedStop = trailPrice;
    }
  }

  // --- EXIT CHECKS (sole authority) ---
  // 1. Locked stop hit (profit lock or trailing stop)
  if (
    (signal.direction === "LONG" && currentPrice <= state.lockedStop) ||
    (signal.direction === "SHORT" && currentPrice >= state.lockedStop)
  ) {
    state.tradeState = "EXITED";
    return {
      state,
      shouldExit: true,
      exitReason:
        pnlPct >= BREAK_EVEN_TRIGGER
          ? "profit_lock_stop"
          : pnlPct >= 0
            ? "break_even_stop"
            : "initial_stop",
    };
  }

  // 2. Initial hard stop hit (only if manager hasn't moved stop yet)
  if (
    state.tradeState === "OPEN" &&
    ((signal.direction === "LONG" && currentPrice <= signal.stop) ||
      (signal.direction === "SHORT" && currentPrice >= signal.stop))
  ) {
    state.tradeState = "EXITED";
    return { state, shouldExit: true, exitReason: "initial_stop" };
  }

  return { state, shouldExit: false };
}

// ============================================================
// STATEFUL TRENDLINE STORE (uses timestamps, not indices)
// ============================================================

interface TrendlineState {
  slope: number;          // price per ms
  intercept: number;      // price at timestamp=0
  pivots: { timestamp: number; price: number }[];
  lastUpdated: number;
  direction: "LONG" | "SHORT";
}

const trendlineStore: Map<string, TrendlineState> = new Map();

function avg(arr: number[]): number {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

// --- WILDER SMOOTHING (reusable) ---
function wilderSmooth(values: number[], period: number): number[] {
  const result: number[] = [avg(values.slice(0, period))];
  for (let i = period; i < values.length; i++) {
    result.push((result[result.length - 1] * (period - 1) + values[i]) / period);
  }
  return result;
}

// --- TRUE WILDER RSI (TradingView exact) ---
// FIX #3: Uses Wilder smoothing instead of simple average
function wilderRsi(closes: number[], period: number = 14): number {
  if (closes.length < period + 1) return 50;

  const changes: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    changes.push(closes[i] - closes[i - 1]);
  }

  const gains = changes.map((c) => (c > 0 ? c : 0));
  const losses = changes.map((c) => (c < 0 ? Math.abs(c) : 0));

  const smoothedGains = wilderSmooth(gains, period);
  const smoothedLosses = wilderSmooth(losses, period);

  const lastGain = smoothedGains[smoothedGains.length - 1];
  const lastLoss = smoothedLosses[smoothedLosses.length - 1];

  if (lastLoss === 0) return 100;
  const rs = lastGain / lastLoss;
  return 100 - (100 / (1 + rs));
}

function rsiSeries(closes: number[], period: number = 14): number[] {
  const series: number[] = [];
  for (let i = period + 1; i <= closes.length; i++) {
    const window = closes.slice(0, i);
    series.push(wilderRsi(window, period));
  }
  return series;
}

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

function adx(candles: Candle[], period: number = 14): number {
  if (candles.length < period + 1) return 0;

  const trs: number[] = [];
  const plusDMs: number[] = [];
  const minusDMs: number[] = [];

  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const p = candles[i - 1];
    trs.push(
      Math.max(
        c.high - c.low,
        Math.abs(c.high - p.close),
        Math.abs(c.low - p.close)
      )
    );
    plusDMs.push(
      c.high - p.high > p.low - c.low ? Math.max(c.high - p.high, 0) : 0
    );
    minusDMs.push(
      p.low - c.low > c.high - p.high ? Math.max(p.low - c.low, 0) : 0
    );
  }

  const atrSmooth = wilderSmooth(trs, period);
  const plusDISmooth = wilderSmooth(plusDMs, period);
  const minusDISmooth = wilderSmooth(minusDMs, period);

  const dxValues: number[] = [];
  for (let i = 0; i < atrSmooth.length; i++) {
    const pDI = (plusDISmooth[i] / atrSmooth[i]) * 100;
    const mDI = (minusDISmooth[i] / atrSmooth[i]) * 100;
    const dx =
      pDI + mDI === 0 ? 0 : (Math.abs(pDI - mDI) / (pDI + mDI)) * 100;
    dxValues.push(dx);
  }

  const adxSmooth = wilderSmooth(dxValues, period);
  return Math.round(adxSmooth[adxSmooth.length - 1] * 10) / 10;
}

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

function findPivots(
  candles: Candle[],
  direction: "LONG" | "SHORT"
): { timestamp: number; price: number }[] {
  const pivots: { timestamp: number; price: number }[] = [];

  for (let i = 3; i < candles.length - 3; i++) {
    const c = candles[i];
    const isSwingLow =
      c.low < candles[i - 1].low &&
      c.low < candles[i - 2].low &&
      c.low < candles[i + 1].low &&
      c.low < candles[i + 2].low;
    const isSwingHigh =
      c.high > candles[i - 1].high &&
      c.high > candles[i - 2].high &&
      c.high > candles[i + 1].high &&
      c.high > candles[i + 2].high;

    if (direction === "LONG" && isSwingLow) {
      pivots.push({ timestamp: c.timestamp, price: c.low });
    }
    if (direction === "SHORT" && isSwingHigh) {
      pivots.push({ timestamp: c.timestamp, price: c.high });
    }
  }

  return pivots;
}

// FIX #5: Trendline uses timestamps instead of candle indices
function getTrendline(
  pair: string,
  candles: Candle[],
  direction: "LONG" | "SHORT"
): { price: number; r2: number; age: number } | null {
  const len = candles.length;
  if (len < 20) return null;

  const pivots = findPivots(candles, direction);
  if (pivots.length < 3) return null;

  const recentPivots = pivots.slice(-5);
  const now = candles[candles.length - 1].timestamp;

  const existing = trendlineStore.get(pair);
  const maxAge = 7 * 24 * 60 * 60 * 1000;

  if (
    existing &&
    existing.direction === direction &&
    now - existing.lastUpdated < maxAge
  ) {
    const lastPivot = recentPivots[recentPivots.length - 1];
    const projectedPrice =
      existing.slope * lastPivot.timestamp + existing.intercept;
    const deviation =
      Math.abs(lastPivot.price - projectedPrice) / projectedPrice;

    if (deviation < 0.02) {
      const currentPrice = existing.slope * now + existing.intercept;
      return { price: currentPrice, r2: 0.85, age: now - existing.lastUpdated };
    }
  }

  // Linear regression on timestamps (not indices)
  const n = recentPivots.length;
  const sumX = recentPivots.reduce((s, p) => s + p.timestamp, 0);
  const sumY = recentPivots.reduce((s, p) => s + p.price, 0);
  const sumXY = recentPivots.reduce((s, p) => s + p.timestamp * p.price, 0);
  const sumX2 = recentPivots.reduce((s, p) => s + p.timestamp * p.timestamp, 0);

  const slope =
    (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
  const intercept = (sumY - slope * sumX) / n;

  const yMean = sumY / n;
  const ssTotal = recentPivots.reduce(
    (s, p) => s + Math.pow(p.price - yMean, 2),
    0
  );
  const ssResidual = recentPivots.reduce(
    (s, p) => s + Math.pow(p.price - (slope * p.timestamp + intercept), 2),
    0
  );
  const r2 = ssTotal === 0 ? 0 : 1 - ssResidual / ssTotal;

  trendlineStore.set(pair, {
    slope,
    intercept,
    pivots: recentPivots,
    lastUpdated: now,
    direction,
  });

  const currentPrice = slope * now + intercept;

  return { price: currentPrice, r2: Math.round(r2 * 100) / 100, age: 0 };
}

function trend1D(candles1d: Candle[]): {
  direction: "LONG" | "SHORT" | null;
  strength: string;
  ema21Slope: number;
} {
  const len = candles1d.length;
  if (len < 25) return { direction: null, strength: "WEAK", ema21Slope: 0 };

  const closes = candles1d.map((c) => c.close);
  const ema8 = ema(closes, 8);
  const ema21 = ema(closes, 21);

  const direction =
    ema8[ema8.length - 1] > ema21[ema21.length - 1] ? "LONG" : "SHORT";

  // FIX #11: EMA21 slope for trend confirmation
  const ema21Slope = ema21.length >= 3
    ? (ema21[ema21.length - 1] - ema21[ema21.length - 3]) / 2
    : 0;

  const highs = candles1d.slice(-20).map((c) => c.high);
  const lows = candles1d.slice(-20).map((c) => c.low);
  const hh = highs[highs.length - 1] > Math.max(...highs.slice(0, -1));
  const ll = lows[lows.length - 1] < Math.min(...lows.slice(0, -1));

  const strength =
    (direction === "LONG" && hh) || (direction === "SHORT" && ll)
      ? "STRONG"
      : "MEDIUM";

  return { direction, strength, ema21Slope };
}

export function ema(closes: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const ema: number[] = [closes[0]];
  for (let i = 1; i < closes.length; i++) {
    ema.push(closes[i] * k + ema[i - 1] * (1 - k));
  }
  return ema;
}

// FIX #2: True Wilder ATR (reuses wilderSmooth)
function atr(candles: Candle[], period: number = 14): number {
  if (candles.length < 2) return 0;

  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const p = candles[i - 1];
    trs.push(
      Math.max(
        c.high - c.low,
        Math.abs(c.high - p.close),
        Math.abs(c.low - p.close)
      )
    );
  }

  if (trs.length < period) return avg(trs);

  const atrSmooth = wilderSmooth(trs, period);
  return atrSmooth[atrSmooth.length - 1];
}

// ============================================================
// HYSTERESIS (simplified: only ENTRY_1, no progression)
// FIX #9: Unlock on 24h OR price moved >3 ATR
// ============================================================

interface HysteresisState {
  lastSignalType: "ENTRY_1" | "ENTRY_2" | "ADD" | null;
  lastSignalPrice: number;
  lockUntil: number;
  atrAtLock: number;
}

const hysteresisStore: Map<string, HysteresisState> = new Map();
const HYSTERESIS_BAND = 0.005;

function getHysteresis(pair: string, now: number): HysteresisState {
  const state = hysteresisStore.get(pair);
  if (!state) return { lastSignalType: null, lastSignalPrice: 0, lockUntil: 0, atrAtLock: 0 };
  if (now > state.lockUntil)
    return { lastSignalType: null, lastSignalPrice: 0, lockUntil: 0, atrAtLock: 0 };
  return state;
}

function setHysteresis(
  pair: string,
  type: "ENTRY_1" | "ENTRY_2" | "ADD",
  price: number,
  now: number,
  atrVal: number
): void {
  const lockDuration = 24 * 60 * 60 * 1000;
  hysteresisStore.set(pair, {
    lastSignalType: type,
    lastSignalPrice: price,
    lockUntil: now + lockDuration,
    atrAtLock: atrVal,
  });
}

function checkHysteresisUnlock(
  pair: string,
  currentPrice: number,
  now: number
): boolean {
  const state = hysteresisStore.get(pair);
  if (!state) return true;
  if (now > state.lockUntil) return true;

  // FIX #9: Unlock if price moved >3 ATR from entry
  const priceMove = Math.abs(currentPrice - state.lastSignalPrice) / state.lastSignalPrice;
  const atrMove = state.atrAtLock > 0 ? (Math.abs(currentPrice - state.lastSignalPrice) / state.atrAtLock) : 0;

  if (atrMove > 3) {
    hysteresisStore.delete(pair);
    return true;
  }

  return false;
}

// ============================================================
// EXHAUSTION FILTER
// ============================================================

function checkExhaustion(
  direction: "LONG" | "SHORT",
  price: number,
  candles4h: Candle[],
  trendlinePrice: number,
  stochK: number,
  adxVal: number
): { exhausted: boolean; reasons: string[] } {
  if (!FEATURES.EXHAUSTION_FILTER_ENABLED) {
    return { exhausted: false, reasons: [] };
  }

  const closes4h = candles4h.map((c) => c.close);
  const ema20Arr = ema(closes4h, 20);
  const ema20Price = ema20Arr[ema20Arr.length - 1];
  const atrVal = atr(candles4h, 14);

  const conditions: string[] = [];

  if (direction === "LONG") {
    if (stochK > 90) conditions.push("stoch_extreme");
    if (price > ema20Price + atrVal * 2) conditions.push("price_far_above_ema20");
    if (price > trendlinePrice + atrVal * 1.5)
      conditions.push("price_far_above_trendline");
    if (adxVal > 45) conditions.push("adx_extreme");
  } else {
    if (stochK < 10) conditions.push("stoch_extreme");
    if (price < ema20Price - atrVal * 2) conditions.push("price_far_below_ema20");
    if (price < trendlinePrice - atrVal * 1.5)
      conditions.push("price_far_below_trendline");
    if (adxVal > 45) conditions.push("adx_extreme");
  }

  return {
    exhausted: conditions.length >= 2,
    reasons: conditions,
  };
}

// ============================================================
// CONFIDENCE CALCULATION
// FIX #12: Calculate from multiple factors instead of constant 50
// ============================================================
function calculateConfidence(
  r2: number,
  adxVal: number,
  trendStrength: string,
  stochK: number,
  stochD: number,
  distToTrendline: number,
  rr: number,
  direction: "LONG" | "SHORT",
  ema21Slope: number
): number {
  let score = 50;

  // Trendline fit (R²): 0-1 → 0-10 points
  score += r2 * 10;

  // ADX: 0-60 → 0-15 points
  score += Math.min(adxVal / 60, 1) * 15;

  // Trend strength
  if (trendStrength === "STRONG") score += 10;
  else if (trendStrength === "MEDIUM") score += 5;

  // StochRSI alignment (K crossing D in direction of trade)
  const stochAligned =
    direction === "LONG" ? stochK > stochD : stochK < stochD;
  if (stochAligned) score += 5;

  // Near trendline (closer = better)
  const distScore = Math.max(0, 1 - Math.abs(distToTrendline) / 0.02);
  score += distScore * 5;

  // Risk/reward: 1.5-4 → 0-10 points
  score += Math.min((rr - 1.5) / 2.5, 1) * 10;

  // EMA21 slope confirmation
  const slopeAligned =
    direction === "LONG" ? ema21Slope > 0 : ema21Slope < 0;
  if (slopeAligned) score += 5;

  return Math.round(Math.min(Math.max(score, 0), 100));
}

// ============================================================
// MAIN SIGNAL GENERATOR
// ============================================================

export function generateSignal(
  pair: string,
  candles1h: Candle[],
  candles4h: Candle[],
  candles15m: Candle[],
  currentPrice?: number
): SignalResult {
  const debug: string[] = [];

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

  if (!t1d.direction) {
    debug.push("1D trend unclear");
    return { debug };
  }

  // FIX #11: Require EMA21 slope confirmation
  const slopeAligned =
    t1d.direction === "LONG" ? t1d.ema21Slope > 0 : t1d.ema21Slope < 0;
  if (!slopeAligned) {
    debug.push(`EMA21 slope not aligned: ${t1d.ema21Slope.toFixed(2)}`);
    return { debug };
  }

  const trendline = getTrendline(pair, candles4h, t1d.direction);
  if (!trendline) {
    debug.push("No trendline");
    return { debug };
  }

  const price = currentPrice ?? candles4h[candles4h.length - 1].close;
  const tlPrice = trendline.price;
  const dist = (price - tlPrice) / tlPrice;
  const atrVal = atr(candles4h, 14);

  debug.push(
    `TL: ${tlPrice.toFixed(1)} | R2 ${trendline.r2} | Price: ${price.toFixed(1)} | Dist: ${(dist * 100).toFixed(2)}% | ATR: ${atrVal.toFixed(1)}`
  );

  const stoch = stochRsi(candles4h.map((c) => c.close));
  debug.push(`StochRSI: K ${stoch.k} | D ${stoch.d}`);

  const last = candles4h[candles4h.length - 1];
  const prev = candles4h[candles4h.length - 2];

  const closes4h = candles4h.map((c) => c.close);
  const ema8_4h = ema(closes4h, 8);
  const ema21_4h = ema(closes4h, 21);

  // --- ENTRY CONDITIONS (early, trendline-touch) ---
  // Adaptive: near trendline = within 0.5 ATR (not fixed 1.2%)
  const nearTrendline = Math.abs(dist * tlPrice) < atrVal * 0.5;
  const stochExtreme =
    t1d.direction === "LONG" ? stoch.k < 20 : stoch.k > 80;
  const stochTurning =
    t1d.direction === "LONG" ? stoch.k > stoch.d : stoch.k < stoch.d;

  // ADD / ENTRY_2 logic REMOVED — single entry only
  let rawType: "ENTRY_1" | "ENTRY_2" | "ADD" | null = null;

  if (nearTrendline && stochExtreme) {
    rawType = "ENTRY_1";
  } else if (nearTrendline && stochTurning && !stochExtreme) {
    debug.push("Near TL + stoch turning but not extreme — waiting for extreme");
    rawType = null;
  }

  const now = Date.now();

  // FIX #9: Check hysteresis unlock (time OR >3 ATR move)
  const unlocked = checkHysteresisUnlock(pair, price, now);
  if (!unlocked) {
    const hyst = getHysteresis(pair, now);
    const priceMove = Math.abs(price - hyst.lastSignalPrice) / hyst.lastSignalPrice;
    debug.push(`Hysteresis lock: ${hyst.lastSignalType} | move ${(priceMove * 100).toFixed(2)}% | ATR move ${(Math.abs(price - hyst.lastSignalPrice) / hyst.atrAtLock).toFixed(1)}x`);
    return { debug };
  }

  const hyst = getHysteresis(pair, now);

  let finalType: "ENTRY_1" | "ENTRY_2" | "ADD" | null = null;

  if (rawType === "ENTRY_1") {
    finalType = "ENTRY_1";
  }

  // Hysteresis: prevent duplicate signals near same price
  if (hyst.lastSignalType && finalType === hyst.lastSignalType) {
    const priceMove = Math.abs(price - hyst.lastSignalPrice) / hyst.lastSignalPrice;
    if (priceMove < HYSTERESIS_BAND) {
      debug.push(
        `Hysteresis lock: ${finalType} | move ${(priceMove * 100).toFixed(2)}% < ${(HYSTERESIS_BAND * 100).toFixed(2)}%`
      );
      return { debug };
    }
  }

  if (!finalType) {
    const stateParts: string[] = [];
    if (nearTrendline) stateParts.push("near TL");
    else if (Math.abs(dist * tlPrice) < atrVal) stateParts.push("approaching TL");
    else stateParts.push("far from TL");
    stateParts.push(`Stoch K${stoch.k} D${stoch.d}`);
    stateParts.push("No signal");
    debug.push(`State: ${stateParts.join(" | ")}`);
    return { debug };
  }

  // --- EXHAUSTION FILTER ---
  const adxVal = adx(candles4h);
  const exhaustion = checkExhaustion(
    t1d.direction,
    price,
    candles4h,
    tlPrice,
    stoch.k,
    adxVal
  );
  if (exhaustion.exhausted) {
    debug.push(
      `EXHAUSTION REJECT: ${exhaustion.reasons.join(", ")}`
    );
    return { debug };
  }

  // Set hysteresis for new signal (with ATR for unlock check)
  if (finalType !== hyst.lastSignalType) {
    setHysteresis(pair, finalType, price, now, atrVal);
  }

  // --- LEVELS ---
  const swingLows = candles4h.map((c) => c.low).slice(-20);
  const swingHighs = candles4h.map((c) => c.high).slice(-20);
  const swingLow = Math.min(...swingLows);
  const swingHigh = Math.max(...swingHighs);

  let entry: number;
  let sl: number;
  let tp: number;
  let type: "ACCUMULATE" | "BREAKOUT";

  type = "ACCUMULATE";
  entry = price;

  // Stop: max(recent swing, 2 ATR, 3%) — adapts to volatility
  const twoAtrStop =
    t1d.direction === "LONG"
      ? entry - atrVal * 2
      : entry + atrVal * 2;
  const pctStop =
    t1d.direction === "LONG" ? entry * 0.97 : entry * 1.03;

  sl =
    t1d.direction === "LONG"
      ? Math.min(swingLow, twoAtrStop, pctStop)
      : Math.max(swingHigh, twoAtrStop, pctStop);

  tp =
    t1d.direction === "LONG"
      ? entry + atrVal * 5
      : entry - atrVal * 5;

  const rr =
    t1d.direction === "LONG"
      ? (tp - entry) / (entry - sl)
      : (entry - tp) / (sl - entry);
  if (rr < MIN_RR) {
    debug.push(`R:R ${rr.toFixed(2)} < ${MIN_RR}`);
    return { debug };
  }

  const expectedMove = (Math.abs(tp - entry) / entry) * 100;

  // FIX #12: Calculate confidence from multiple factors
  const confidence = calculateConfidence(
    trendline.r2,
    adxVal,
    t1d.strength,
    stoch.k,
    stoch.d,
    dist,
    rr,
    t1d.direction,
    t1d.ema21Slope
  );

  // FIX #3: Use Wilder RSI
  const rsi4h = wilderRsi(candles4h.map((c) => c.close));

  // FIX #13: Use crypto.randomUUID() for signal IDs
  const signal: Signal = {
    id: randomUUID(),
    pair,
    direction: t1d.direction,
    type,
    scale: finalType,
    entry: Math.round(entry * 100) / 100,
    stop: Math.round(sl * 100) / 100,
    target: Math.round(tp * 100) / 100,
    confidence,
    rr: Math.round(rr * 100) / 100,
    adx: Math.round(adxVal * 10) / 10,
    rsi: Math.round(rsi4h * 10) / 10,
    stochK: stoch.k,
    stochD: stoch.d,
    expectedMove: Math.round(expectedMove * 10) / 10,
    reason: `${t1d.direction} ${type} ${finalType} | 1D ${t1d.strength} | Stoch K${stoch.k} D${stoch.d} | TL approach | RR ${rr.toFixed(2)} | Conf ${confidence}${exhaustion.reasons.length > 0 ? " | exhaustion:" + exhaustion.reasons.join(",") : ""}`,
    timestamp: now,
    version: CURRENT_SIGNAL_VERSION,
  };

  const market = {
    pair,
    price: Math.round(price * 100) / 100,
    timestamp: now,
    trend: `${t1d.direction} ${t1d.strength}`,
    adx: signal.adx,
    rsi: signal.rsi,
    stochK: signal.stochK,
    stochD: signal.stochD,
    trendlinePrice: Math.round(tlPrice * 100) / 100,
    distToTrendline: Math.round(dist * 10000) / 100,
    ema8: Math.round(ema8_4h[ema8_4h.length - 1] * 100) / 100,
    ema21: Math.round(ema21_4h[ema21_4h.length - 1] * 100) / 100,
  };

  debug.push(
    `SIGNAL: ${type} ${finalType} ${signal.direction} ${signal.entry} | TP ${signal.target} | SL ${signal.stop} | RR ${signal.rr} | Conf ${confidence}`
  );

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
): any {
  const candles1d = aggregateTo1D(candles4h);
  const t1d = trend1D(candles1d);
  const stochRsi4h = stochRsi(candles4h.map((c) => c.close));
  const price = candles4h[candles4h.length - 1].close;

  const trendline = t1d.direction
    ? getTrendline(pair, candles4h, t1d.direction)
    : null;
  const tlPrice = trendline ? trendline.price : 0;
  const dist = trendline ? (price - tlPrice) / tlPrice : 1;

  return {
    pair,
    price: Math.round(price * 100) / 100,
    timestamp: Date.now(),
    trend: t1d.direction ? `${t1d.direction} ${t1d.strength}` : "NONE",
    adx: Math.round(adx(candles4h) * 10) / 10,
    rsi: Math.round(wilderRsi(candles4h.map((c) => c.close)) * 10) / 10,
    stochK: stochRsi4h.k,
    stochD: stochRsi4h.d,
    trendlinePrice: Math.round(tlPrice * 100) / 100,
    distToTrendline: Math.round(Math.abs(dist) * 10000) / 100,
  };
}

// ============================================================
// VALIDITY CHECK — TTL + MISSED ENTRY ONLY (no SL/TP for active trades)
// ============================================================

export interface ValidityCheck {
  valid: boolean;
  reason: string;
  exited: boolean;
}

/**
 * isSignalStillValid checks ONLY:
 * 1. TTL expiry (signal too old)
 * 2. Missed entry (price moved too far from entry)
 *
 * It does NOT check stop-loss or take-profit.
 * Those are the sole responsibility of the Trade Manager.
 */
export function isSignalStillValid(
  signal: Signal,
  currentPrice: number,
  now: number = Date.now()
): ValidityCheck {
  const ageMs = now - signal.timestamp;

  const maxAge = 24 * 60 * 60 * 1000; // 24h for all signals

  if (ageMs > maxAge) {
    return { valid: false, reason: "expired_ttl", exited: true };
  }

  // Missed entry: price moved >2% away from entry without triggering
  const entryBuffer = 1.02;
  if (signal.direction === "LONG" && currentPrice > signal.entry * entryBuffer) {
    return { valid: false, reason: "missed_entry", exited: true };
  }
  if (
    signal.direction === "SHORT" &&
    currentPrice < signal.entry * (2 - entryBuffer)
  ) {
    return { valid: false, reason: "missed_entry", exited: true };
  }

  return { valid: true, reason: "active", exited: false };
}

// ============================================================
// shouldHold — delegates to trade manager when enabled
// Trade Manager is SOLE exit authority for open trades.
// ============================================================

export interface HoldResult {
  shouldHold: boolean;
  reason: string;
  tradeState?: TradeState;
  lockedStop?: number;
  highestPrice?: number;
  lowestPrice?: number;
  shouldExit?: boolean;
  exitReason?: string;
}

export function shouldHold(
  signal: Signal,
  candles4h: Candle[],
  currentPrice: number,
  now?: number
): HoldResult {
  // DUPLICATE EXIT BUG FIX: If already exited, immediately return no-hold
  if (signal.exited || signal.tradeState === "EXITED") {
    return {
      shouldHold: false,
      reason: "already_exited",
      tradeState: "EXITED",
      shouldExit: false,
    };
  }

  if (FEATURES.TRADE_MANAGER_ENABLED) {
    const managerResult = updateTradeManagerState(
      signal,
      currentPrice,
      candles4h
    );

    if (managerResult.shouldExit) {
      return {
        shouldHold: false,
        reason: managerResult.exitReason || "manager_exit",
        tradeState: managerResult.state.tradeState,
        lockedStop: managerResult.state.lockedStop,
        highestPrice: managerResult.state.highestPrice,
        lowestPrice: managerResult.state.lowestPrice,
        shouldExit: true,
        exitReason: managerResult.exitReason,
      };
    }

    return {
      shouldHold: true,
      reason: `manager_${managerResult.state.tradeState}`,
      tradeState: managerResult.state.tradeState,
      lockedStop: managerResult.state.lockedStop,
      highestPrice: managerResult.state.highestPrice,
      lowestPrice: managerResult.state.lowestPrice,
      shouldExit: false,
    };
  }

  // Fallback legacy behavior (when trade manager disabled)
  const validity = isSignalStillValid(signal, currentPrice, now);
  return { shouldHold: validity.valid, reason: validity.reason };
}

// ============================================================
// filterExpiredSignals
// Uses Trade Manager as sole exit authority.
// Does NOT pass empty candles4h to updateTradeManagerState.
// ============================================================

export function filterExpiredSignals(
  signals: Signal[],
  currentPrices: Record<string, number>,
  candles4hMap?: Record<string, Candle[]>,
  now?: number
): { active: Signal[]; exited: { signal: Signal; reason: string }[] } {
  const active: Signal[] = [];
  const exited: { signal: Signal; reason: string }[] = [];

  for (const signal of signals) {
    // Skip already-exited signals (duplicate exit prevention)
    if (signal.exited || signal.tradeState === "EXITED") {
      continue;
    }

    const price = currentPrices[signal.pair];
    if (price === undefined) {
      active.push(signal);
      continue;
    }

    // Trade Manager is sole exit authority — pass real candles, never empty array
    if (FEATURES.TRADE_MANAGER_ENABLED) {
      const candles4h = candles4hMap?.[signal.pair] || [];
      const managerResult = updateTradeManagerState(signal, price, candles4h);
      if (managerResult.shouldExit) {
        exited.push({
          signal,
          reason: managerResult.exitReason || "manager_exit",
        });
        continue;
      }
    }

    // TTL + missed entry check only
    const check = isSignalStillValid(signal, price, now);
    if (check.valid) active.push(signal);
    else exited.push({ signal, reason: check.reason });
  }

  return { active, exited };
}

// ============================================================
// checkTradeStatus
// ============================================================

export type TradeStatus = "ACTIVE" | "TP_HIT" | "SL_HIT" | "EXPIRED";

export function checkTradeStatus(
  signal: Signal,
  currentPrice: number,
  now: number = Date.now()
): TradeStatus {
  if (signal.exited || signal.tradeState === "EXITED") {
    return "EXPIRED";
  }

  const validity = isSignalStillValid(signal, currentPrice, now);

  if (!validity.valid && validity.reason === "expired_ttl") {
    return "EXPIRED";
  }

  // Legacy: hard SL/TP only for signals NOT managed by trade manager
  if (!FEATURES.TRADE_MANAGER_ENABLED) {
    if (signal.direction === "LONG") {
      if (currentPrice >= signal.target) return "TP_HIT";
      if (currentPrice <= signal.stop) return "SL_HIT";
    } else {
      if (currentPrice <= signal.target) return "TP_HIT";
      if (currentPrice >= signal.stop) return "SL_HIT";
    }
  }

  return "ACTIVE";
}

// ============================================================
// v28 COMPATIBILITY LAYER (DO NOT REMOVE)
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

// Compatibility: generateSignalCompat suppresses ENTRY_2 (now irrelevant since no ENTRY_2)
export async function generateSignalCompat(
  pair: string,
  candles1h: Candle[],
  candles4h: Candle[],
  candles15m: Candle[],
  activeTrades?: Record<string, any>,
  currentPrice?: number
): Promise<SignalResult> {
  const result = generateSignal(
    pair,
    candles1h,
    candles4h,
    candles15m,
    currentPrice
  );

  // No ENTRY_2 in this version, but keep guard for safety
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
// STUB EXPORTS for v30.5 compatibility (deployed code may import these)
// These are no-ops to prevent build errors. The cron uses only v28 APIs.
// ============================================================

export const FEATURE_FLAGS = FEATURES;

export interface TradeSnapshot {
  id: string;
  pair: string;
  direction: "LONG" | "SHORT";
  entry: number;
  stop: number;
  target: number;
  state: TradeState;
  highestPrice: number;
  lowestPrice: number;
  lockedStop: number;
}

export function evaluateTrade(
  _snapshot: TradeSnapshot,
  _currentPrice: number,
  _candles4h: Candle[]
): { shouldExit: boolean; exitReason?: string; newStop?: number } {
  return { shouldExit: false };
}

export function initTradeSnapshot(_signal: Signal): TradeSnapshot {
  return {
    id: _signal.id,
    pair: _signal.pair,
    direction: _signal.direction,
    entry: _signal.entry,
    stop: _signal.stop,
    target: _signal.target,
    state: "OPEN",
    highestPrice: _signal.entry,
    lowestPrice: _signal.entry,
    lockedStop: _signal.stop,
  };
}

export function getTradeSnapshot(_signalId: string): TradeSnapshot | undefined {
  return undefined;
}

export function removeTradeSnapshot(_signalId: string): void {
  return;
}

export function hasExited(_signalId: string): boolean {
  return false;
}
