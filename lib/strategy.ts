// lib/strategy.ts — v28 "Trendline Break: StochRSI Timing + Trade Manager"
// ============================================================
// Architecture: stateful trendline, hysteresis bands, TV-exact StochRSI
// EXIT: Stoch extreme opposite (matches chart)
// ALERTS: ENTRY only (no ADD, no ENTRY_2)
// TRADE MANAGER: Isolated profit-locking engine
//
// CHANGELOG v28-PROD:
// - Removed all ADD/ENTRY_2/ENTRY_1 progression logic
// - Single entry per position, no pyramiding
// - Exhaustion filter (2+ conditions required to reject)
// - Dedicated trade manager with state machine
// - Staged profit locking: +3% BE, +5% → +2%, +8% → +4%, +12% trail, +20% ATR trail
// - Trailing only after break-even
// - Duplicate exit prevention via EXITED state
// - Stop never moves backwards
//
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
// TRADE MANAGER — ISOLATED STATE MACHINE
// ============================================================

export type TradeState =
  | "OPEN"
  | "UNDERWATER"
  | "BREAK_EVEN"
  | "LOCKED_2"
  | "LOCKED_4"
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

const tradeManagerStore: Map<string, TradeManagerState> = new Map();

function getTradeManagerState(signal: Signal): TradeManagerState {
  const existing = tradeManagerStore.get(signal.id);
  if (existing) return existing;

  const state: TradeManagerState = {
    tradeState: "OPEN",
    highestPrice: signal.entry,
    lowestPrice: signal.entry,
    lockedStop: signal.stop,
    entryPrice: signal.entry,
    direction: signal.direction,
    initialStop: signal.stop,
  };
  tradeManagerStore.set(signal.id, state);
  return state;
}

/** Remove a trade from the manager store (cleanup after EXITED) */
export function removeTradeManagerState(signalId: string): void {
  tradeManagerStore.delete(signalId);
}

/** Reset all trade manager state (useful for testing) */
export function clearAllTradeManagerState(): void {
  tradeManagerStore.clear();
}

/**
 * Core trade manager update.
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

  if (state.tradeState === "OPEN" && pnlPct < 0) {
    state.tradeState = "UNDERWATER";
  }

  if (state.tradeState === "UNDERWATER" && pnlPct >= 0) {
    state.tradeState = "OPEN";
  }

  // +3% → Break Even
  if (
    FEATURES.BREAK_EVEN_ENABLED &&
    (state.tradeState === "OPEN" || state.tradeState === "UNDERWATER") &&
    pnlPct >= 3
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

  // +5% → Lock at +2%
  if (
    FEATURES.PROFIT_LOCK_ENABLED &&
    (state.tradeState === "BREAK_EVEN" || state.tradeState === "OPEN") &&
    pnlPct >= 5
  ) {
    state.tradeState = "LOCKED_2";
    const newStop =
      signal.direction === "LONG" ? entry * 1.02 : entry * 0.98;
    if (
      (signal.direction === "LONG" && newStop > state.lockedStop) ||
      (signal.direction === "SHORT" && newStop < state.lockedStop)
    ) {
      state.lockedStop = newStop;
    }
  }

  // +8% → Lock at +4%
  if (
    FEATURES.PROFIT_LOCK_ENABLED &&
    state.tradeState === "LOCKED_2" &&
    pnlPct >= 8
  ) {
    state.tradeState = "LOCKED_4";
    const newStop =
      signal.direction === "LONG" ? entry * 1.04 : entry * 0.96;
    if (
      (signal.direction === "LONG" && newStop > state.lockedStop) ||
      (signal.direction === "SHORT" && newStop < state.lockedStop)
    ) {
      state.lockedStop = newStop;
    }
  }

  // +12% → RUNNER (trail using ATR or EMA20)
  if (
    FEATURES.TRAIL_STOP_ENABLED &&
    (state.tradeState === "LOCKED_4" || state.tradeState === "LOCKED_2") &&
    pnlPct >= 12
  ) {
    state.tradeState = "RUNNER";
  }

  // --- TRAILING STOP (only after break-even) ---
  if (
    FEATURES.TRAIL_STOP_ENABLED &&
    (state.tradeState === "BREAK_EVEN" ||
      state.tradeState === "LOCKED_2" ||
      state.tradeState === "LOCKED_4" ||
      state.tradeState === "RUNNER")
  ) {
    const atrVal = atr(candles4h, 14);
    const closes4h = candles4h.map((c) => c.close);
    const ema20Arr = ema(closes4h, 20);
    const ema20Price = ema20Arr[ema20Arr.length - 1];

    let trailPrice: number | null = null;

    if (state.tradeState === "RUNNER") {
      if (pnlPct < 20) {
        // +12% to +20%: Trail using EMA20 ± 1.5 ATR, never below lockedStop
        const atrTrail =
          signal.direction === "LONG"
            ? Math.max(ema20Price - atrVal * 1.5, state.lockedStop)
            : Math.min(ema20Price + atrVal * 1.5, state.lockedStop);
        trailPrice = atrTrail;
      } else {
        // +20%+: Pure ATR trailing stop from current price
        const atrTrail =
          signal.direction === "LONG"
            ? currentPrice - atrVal * 2
            : currentPrice + atrVal * 2;
        trailPrice = atrTrail;
      }
    }

    if (trailPrice !== null) {
      if (
        (signal.direction === "LONG" && trailPrice > state.lockedStop) ||
        (signal.direction === "SHORT" && trailPrice < state.lockedStop)
      ) {
        state.lockedStop = trailPrice;
      }
    }
  }

  // --- EXIT CHECKS ---
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
        pnlPct >= 3
          ? "profit_lock_stop"
          : pnlPct >= 0
            ? "break_even_stop"
            : "initial_stop",
    };
  }

  // 2. Initial hard stop hit
  if (
    (signal.direction === "LONG" && currentPrice <= signal.stop) ||
    (signal.direction === "SHORT" && currentPrice >= signal.stop)
  ) {
    state.tradeState = "EXITED";
    return { state, shouldExit: true, exitReason: "initial_stop" };
  }

  // 3. Target hit (legacy, kept for compatibility)
  if (
    (signal.direction === "LONG" && currentPrice >= signal.target) ||
    (signal.direction === "SHORT" && currentPrice <= signal.target)
  ) {
    state.tradeState = "EXITED";
    return { state, shouldExit: true, exitReason: "target_hit" };
  }

  return { state, shouldExit: false };
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
): { index: number; price: number; timestamp: number }[] {
  const pivots: { index: number; price: number; timestamp: number }[] = [];

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
      pivots.push({ index: i, price: c.low, timestamp: c.timestamp });
    }
    if (direction === "SHORT" && isSwingHigh) {
      pivots.push({ index: i, price: c.high, timestamp: c.timestamp });
    }
  }

  return pivots;
}

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
      existing.slope * lastPivot.index + existing.intercept;
    const deviation =
      Math.abs(lastPivot.price - projectedPrice) / projectedPrice;

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

  const slope =
    (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
  const intercept = (sumY - slope * sumX) / n;

  const yMean = sumY / n;
  const ssTotal = recentPivots.reduce(
    (s, p) => s + Math.pow(p.price - yMean, 2),
    0
  );
  const ssResidual = recentPivots.reduce(
    (s, p) => s + Math.pow(p.price - (slope * p.index + intercept), 2),
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

  const currentIndex = len - 1;
  const price = slope * currentIndex + intercept;

  return { price, r2: Math.round(r2 * 100) / 100, age: 0 };
}

function trend1D(candles1d: Candle[]): {
  direction: "LONG" | "SHORT" | null;
  strength: string;
} {
  const len = candles1d.length;
  if (len < 25) return { direction: null, strength: "WEAK" };

  const closes = candles1d.map((c) => c.close);
  const ema8 = ema(closes, 8);
  const ema21 = ema(closes, 21);

  const direction =
    ema8[ema8.length - 1] > ema21[ema21.length - 1] ? "LONG" : "SHORT";

  const highs = candles1d.slice(-20).map((c) => c.high);
  const lows = candles1d.slice(-20).map((c) => c.low);
  const hh = highs[highs.length - 1] > Math.max(...highs.slice(0, -1));
  const ll = lows[lows.length - 1] < Math.min(...lows.slice(0, -1));

  const strength =
    (direction === "LONG" && hh) || (direction === "SHORT" && ll)
      ? "STRONG"
      : "MEDIUM";

  return { direction, strength };
}

export function ema(closes: number[], period: number): number[] {
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
    trs.push(
      Math.max(
        c.high - c.low,
        Math.abs(c.high - p.close),
        Math.abs(c.low - p.close)
      )
    );
  }
  return avg(trs);
}

// ============================================================
// HYSTERESIS (simplified: only ENTRY_1, no progression)
// ============================================================

interface HysteresisState {
  lastSignalType: "ENTRY_1" | "ENTRY_2" | "ADD" | null;
  lastSignalPrice: number;
  lockUntil: number;
}

const hysteresisStore: Map<string, HysteresisState> = new Map();
const HYSTERESIS_BAND = 0.005;

function getHysteresis(pair: string, now: number): HysteresisState {
  const state = hysteresisStore.get(pair);
  if (!state) return { lastSignalType: null, lastSignalPrice: 0, lockUntil: 0 };
  if (now > state.lockUntil)
    return { lastSignalType: null, lastSignalPrice: 0, lockUntil: 0 };
  return state;
}

function setHysteresis(
  pair: string,
  type: "ENTRY_1" | "ENTRY_2" | "ADD",
  price: number,
  now: number
): void {
  // Always 24h lock for single-entry system
  const lockDuration = 24 * 60 * 60 * 1000;
  hysteresisStore.set(pair, {
    lastSignalType: type,
    lastSignalPrice: price,
    lockUntil: now + lockDuration,
  });
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
  debug.push(`1D: ${t1d.direction || "NONE"} ${t1d.strength}`);

  if (!t1d.direction) {
    debug.push("1D trend unclear");
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

  debug.push(
    `TL: ${tlPrice.toFixed(1)} | R2 ${trendline.r2} | Price: ${price.toFixed(1)} | Dist: ${(dist * 100).toFixed(2)}%`
  );

  const stoch = stochRsi(candles4h.map((c) => c.close));
  debug.push(`StochRSI: K ${stoch.k} | D ${stoch.d}`);

  const last = candles4h[candles4h.length - 1];
  const prev = candles4h[candles4h.length - 2];

  const closes4h = candles4h.map((c) => c.close);
  const ema8_4h = ema(closes4h, 8);
  const ema21_4h = ema(closes4h, 21);

  // --- ENTRY CONDITIONS (early, trendline-touch) ---
  const nearTrendline = Math.abs(dist) < 0.012;
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
    else if (Math.abs(dist) < 0.03) stateParts.push("approaching TL");
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

  // Set hysteresis for new signal
  if (finalType !== hyst.lastSignalType) {
    setHysteresis(pair, finalType, price, now);
  }

  // --- LEVELS ---
  const atrVal = atr(candles4h, 14);
  const swingLows = candles4h.map((c) => c.low).slice(-20);
  const swingHighs = candles4h.map((c) => c.high).slice(-20);
  const swingLow = Math.min(...swingLows);
  const swingHigh = Math.max(...swingHighs);

  let entry: number;
  let sl: number;
  let tp: number;
  let type: "ACCUMULATE" | "BREAKOUT";
  let confidence: number;
  let expectedMove: number;

  type = "ACCUMULATE";
  entry = price;
  sl =
    t1d.direction === "LONG"
      ? Math.min(swingLow, entry - atrVal * 2)
      : Math.max(swingHigh, entry + atrVal * 2);
  tp =
    t1d.direction === "LONG"
      ? entry + atrVal * 5
      : entry - atrVal * 5;
  confidence = 50;
  expectedMove = (Math.abs(tp - entry) / entry) * 100;

  // Ensure initial stop is approximately 3% (allow room to breathe)
  const stopPct = Math.abs(entry - sl) / entry;
  if (stopPct < 0.025) {
    sl =
      t1d.direction === "LONG"
        ? entry * 0.97
        : entry * 1.03;
  } else if (stopPct > 0.04) {
    sl =
      t1d.direction === "LONG"
        ? entry * 0.97
        : entry * 1.03;
  }

  const rr =
    t1d.direction === "LONG"
      ? (tp - entry) / (entry - sl)
      : (entry - tp) / (sl - entry);
  if (rr < MIN_RR) {
    debug.push(`R:R ${rr.toFixed(2)} < ${MIN_RR}`);
    return { debug };
  }

  const rsi4h = rsi(candles4h.map((c) => c.close));

  const signal: Signal = {
    id: `${pair}_${Date.now()}`,
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
    reason: `${t1d.direction} ${type} ${finalType} | 1D ${t1d.strength} | Stoch K${stoch.k} D${stoch.d} | TL approach | RR ${rr.toFixed(2)}${exhaustion.reasons.length > 0 ? " | exhaustion:" + exhaustion.reasons.join(",") : ""}`,
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
    `SIGNAL: ${type} ${finalType} ${signal.direction} ${signal.entry} | TP ${signal.target} | SL ${signal.stop} | RR ${signal.rr}`
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
    rsi: Math.round(rsi(candles4h.map((c) => c.close)) * 10) / 10,
    stochK: stochRsi4h.k,
    stochD: stochRsi4h.d,
    trendlinePrice: Math.round(tlPrice * 100) / 100,
    distToTrendline: Math.round(Math.abs(dist) * 10000) / 100,
  };
}

// ============================================================
// VALIDITY CHECK
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

  const maxAge =
    signal.type === "ACCUMULATE"
      ? 24 * 60 * 60 * 1000
      : 4 * 60 * 60 * 1000;

  if (ageMs > maxAge) {
    return { valid: false, reason: "expired_ttl", exited: true };
  }

  const entryBuffer = signal.type === "ACCUMULATE" ? 1.02 : 1.005;
  if (signal.direction === "LONG" && currentPrice > signal.entry * entryBuffer) {
    return { valid: false, reason: "missed_entry", exited: true };
  }
  if (
    signal.direction === "SHORT" &&
    currentPrice < signal.entry * (2 - entryBuffer)
  ) {
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

// ============================================================
// shouldHold — delegates to trade manager when enabled
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
  const candles1d = aggregateTo1D(candles4h);
  const t1d = trend1D(candles1d);
  const trendReversed =
    (signal.direction === "LONG" && t1d.direction === "SHORT") ||
    (signal.direction === "SHORT" && t1d.direction === "LONG");

  if (trendReversed) {
    const inProfit =
      signal.direction === "LONG"
        ? currentPrice > signal.entry
        : currentPrice < signal.entry;
    if (!inProfit) {
      return { shouldHold: false, reason: "trend_reversed_unprofitable" };
    }
  }

  const closes4h = candles4h.map((c) => c.close);
  const stoch = stochRsi(closes4h);

  const stochExtremeOpposite =
    signal.direction === "LONG" ? stoch.k < 20 : stoch.k > 80;

  if (stochExtremeOpposite) {
    return { shouldHold: false, reason: "stoch_extreme_opposite_exit" };
  }

  const validity = isSignalStillValid(signal, currentPrice, now);
  return { shouldHold: validity.valid, reason: validity.reason };
}

// ============================================================
// filterExpiredSignals
// ============================================================

export function filterExpiredSignals(
  signals: Signal[],
  currentPrices: Record<string, number>,
  now?: number
): { active: Signal[]; exited: { signal: Signal; reason: string }[] } {
  const active: Signal[] = [];
  const exited: { signal: Signal; reason: string }[] = [];

  for (const signal of signals) {
    // DUPLICATE EXIT BUG FIX: Skip already-exited signals
    if (signal.exited || signal.tradeState === "EXITED") {
      continue;
    }

    const price = currentPrices[signal.pair];
    if (price === undefined) {
      active.push(signal);
      continue;
    }

    if (FEATURES.TRADE_MANAGER_ENABLED) {
      const managerResult = updateTradeManagerState(signal, price, []);
      if (managerResult.shouldExit) {
        exited.push({
          signal,
          reason: managerResult.exitReason || "manager_exit",
        });
        continue;
      }
    }

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
