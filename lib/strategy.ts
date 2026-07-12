// ============================================================
// CXSwitch v35.2 — R-Based Lifecycle + Relaxed Stale Exit + ADD Funnel
// ============================================================

export interface Candle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type TradeLifecyclePhase =
  | "WATCH"
  | "ENTRY"
  | "BUILDING"
  | "TREND"
  | "PROFIT_PROTECTION"
  | "EXIT"
  | "COOLDOWN";

export interface TradeState {
  phase: TradeLifecyclePhase;
  phaseEnteredAt: number;
  highestPrice: number;
  lowestPrice: number;
  entryPrice: number;
  lockedStop: number | null;
  profitLockLevel: number; // 0=none, 1=breakeven, 2=50% trail, 3=75% trail
  exitPersistence: {
    consecutiveClosesBeyondEMA21: number;
    lastCloseBeyondEMA21: number;
    ema21SlopeHistory: number[];
    warningCount: number;
  };
  entryTimestamp: number;
  lastDecisionTimestamp: number;
  realizedPnl: number;
  maxDrawdown: number;
  maxProfit: number;
  // v35.2: Track R-multiple for lifecycle transitions
  currentR: number;
}

export interface Signal {
  id: string;
  pair: string;
  direction: "LONG" | "SHORT";
  type: "ACCUMULATE" | "BREAKOUT";
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
  timestamp: number;
  version: number;
  exited?: boolean;
  tradeState: TradeState;
  entryTier: EntryTier;
  entryMode: "PULLBACK" | "BREAKOUT" | "COUNTER_TREND";
  positionSizePct: number;
  regimeDirection: string;
  conflictEntry: boolean;
  entryTimeframe: string;
  // v34 legacy
  highestPrice?: number;
  lowestPrice?: number;
  lockedStop?: number;
  profitLockActive?: boolean;
}

export interface SignalResult {
  signal?: Signal;
  market?: any;
  debug: string[];
}

export type EntryTier = "NO_TRADE" | "WATCH" | "EARLY_ENTRY" | "CONFIRMED_ENTRY";

export interface HoldResult {
  shouldHold: boolean;
  reason: string;
  updatedTradeState?: TradeState;
}

export const CURRENT_SIGNAL_VERSION = 35;
const MIN_RR = 1.5;
const EXITED_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// ============================================================
// LIFECYCLE CONFIG — R-BASED (not percentage)
// ============================================================
const LIFECYCLE_CONFIG = {
  entryPhaseDurationMs: 4 * 60 * 60 * 1000,      // 4h: no structural exits
  buildingPhaseDurationMs: 8 * 60 * 60 * 1000,     // 8h: can add, wider stops

  // v35.2: R-based thresholds (your fix)
  trendPhaseThresholdR: 1.0,                       // Enter TREND at 1R profit
  profitLockThresholdR: 2.0,                       // Enter PROFIT_PROTECTION at 2R

  // v35.2: Relaxed stale trade (your fix)
  staleTradeHours: 24,                             // 24h (was 8h)
  staleTradeThresholdR: 0.5,                       // <0.5R (was 0.3%)

  minConfidence: 55,
};

const MIN_HOLD_TIMES: Record<string, number> = {
  "15m": 30 * 60 * 1000,
  "1H": 2 * 60 * 60 * 1000,
  "4H": 4 * 60 * 60 * 1000,
  "1D": 24 * 60 * 60 * 1000,
};

const EXIT_PERSISTENCE = {
  normalConsecutiveCloses: 3,
  addConsecutiveCloses: 2,
  conflictConsecutiveCloses: 4,
  trendConsecutiveCloses: 4,
  maxTrackedCloses: 6,
};

const POST_EXIT_COOLDOWN_MS = 4 * 60 * 60 * 1000;

interface PairConfig {
  atrMultiplier: number;
  adxThreshold: number;
  signalCooldownMs: number;
  hysteresisBand: number;
  minRegimeStrength: string;
  aggression: number;
}

const PAIR_CONFIG: Record<string, PairConfig> = {
  "BTC/USD": { atrMultiplier: 2.0, adxThreshold: 22, signalCooldownMs: 4 * 60 * 60 * 1000, hysteresisBand: 0.005, minRegimeStrength: "MEDIUM", aggression: 0.9 },
  "ETH/USD": { atrMultiplier: 2.0, adxThreshold: 22, signalCooldownMs: 4 * 60 * 60 * 1000, hysteresisBand: 0.005, minRegimeStrength: "MEDIUM", aggression: 1.0 },
  "SOL/USD": { atrMultiplier: 3.0, adxThreshold: 14, signalCooldownMs: 2 * 60 * 60 * 1000, hysteresisBand: 0.015, minRegimeStrength: "MEDIUM", aggression: 1.4 },
  "HYPE/USD": { atrMultiplier: 3.0, adxThreshold: 14, signalCooldownMs: 2 * 60 * 60 * 1000, hysteresisBand: 0.015, minRegimeStrength: "MEDIUM", aggression: 1.5 },
};

export function getPairConfig(pair: string): PairConfig {
  return PAIR_CONFIG[pair] || PAIR_CONFIG["BTC/USD"];
}

function avg(arr: number[]): number {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
}

function isValid(v: any): boolean {
  return typeof v === "number" && Number.isFinite(v);
}

export function ema(values: number[], period: number): number[] {
  if (values.length < period || !values.every(isValid)) return [];
  const k = 2 / (period + 1);
  const out: number[] = [];
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out.push(prev);
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out.push(prev);
  }
  return out.every(isValid) ? out : [];
}

export function wilderRsi(values: number[], period = 14): number | null {
  if (values.length < period + 1 || !values.every(isValid)) return null;
  const diffs: number[] = [];
  for (let i = 1; i < values.length; i++) diffs.push(values[i] - values[i - 1]);
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

export function stochRsi(values: number[], rsiPeriod = 14, stochPeriod = 14, kSmooth = 3, dSmooth = 3): { k: number; d: number } {
  if (!values.every(isValid)) return { k: 50, d: 50 };
  const rsiValues: number[] = [];
  for (let i = rsiPeriod; i < values.length; i++) {
    const r = wilderRsi(values.slice(0, i + 1), rsiPeriod);
    if (r !== null) rsiValues.push(r);
  }
  if (rsiValues.length < stochPeriod + kSmooth - 1) {
    return { k: rsiValues[rsiValues.length - 1] || 50, d: 50 };
  }
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
  if (kValues.length < dSmooth) return { k: kValues[kValues.length - 1] || 50, d: 50 };
  return { k: Math.round(kValues[kValues.length - 1] * 10) / 10, d: Math.round(avg(kValues.slice(-dSmooth)) * 10) / 10 };
}

export function adx(candles: Candle[], period = 14): number | null {
  if (candles.length < period * 2) return null;
  const h = candles.map(c => c.high), l = candles.map(c => c.low), c = candles.map(c => c.close);
  const trs: number[] = [], pDM: number[] = [], mDM: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    trs.push(Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1])));
    pDM.push(h[i] - h[i - 1] > l[i - 1] - l[i] ? Math.max(h[i] - h[i - 1], 0) : 0);
    mDM.push(l[i - 1] - l[i] > h[i] - h[i - 1] ? Math.max(l[i - 1] - l[i], 0) : 0);
  }
  const smooth = (vals: number[], lookback: number) => {
    const r = [avg(vals.slice(0, lookback))];
    for (let i = lookback; i < vals.length; i++) r.push((r[r.length - 1] * (lookback - 1) + vals[i]) / lookback);
    return r;
  };
  const atrS = smooth(trs, period), pDIS = smooth(pDM, period), mDIS = smooth(mDM, period);
  if (!atrS.length) return null;
  const dx = atrS.map((_, i) => {
    const p = (pDIS[i] / atrS[i]) * 100, m = (mDIS[i] / atrS[i]) * 100;
    return p + m === 0 ? 0 : (Math.abs(p - m) / (p + m)) * 100;
  });
  const adxS = smooth(dx, period);
  const v = adxS[adxS.length - 1];
  return isValid(v) ? Math.round(v * 10) / 10 : null;
}

function atr(candles: Candle[], period = 14): number {
  const trs: number[] = [];
  for (let i = Math.max(1, candles.length - period); i < candles.length; i++) {
    trs.push(Math.max(candles[i].high - candles[i].low, Math.abs(candles[i].high - candles[i - 1].close), Math.abs(candles[i].low - candles[i - 1].close)));
  }
  return avg(trs);
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

function detectTrend(candles: Candle[]) {
  if (candles.length < 25) return { direction: null as "LONG" | "SHORT" | null, strength: "WEAK" };
  const closes = candles.map(c => c.close);
  const e8 = ema(closes, 8), e21 = ema(closes, 21);
  if (!e8.length || !e21.length) return { direction: null as "LONG" | "SHORT" | null, strength: "WEAK" };
  const direction = e8[e8.length - 1] > e21[e21.length - 1] ? "LONG" : "SHORT";
  const highs = candles.slice(-20).map(c => c.high), lows = candles.slice(-20).map(c => c.low);
  const hh = highs[highs.length - 1] > Math.max(...highs.slice(0, -1));
  const ll = lows[lows.length - 1] < Math.min(...lows.slice(0, -1));
  const strength = (direction === "LONG" && hh) || (direction === "SHORT" && ll) ? "STRONG" : "MEDIUM";
  return { direction, strength };
}

const regimeStore = new Map<string, { direction: "LONG" | "SHORT"; strength: string; lockedUntil: number; lastCandleTimestamp: number }>();
const DIRECTION_LOCK_MS = 8 * 60 * 60 * 1000;

function getPersistentRegime(pair: string, candles1d: Candle[], now: number) {
  const current = detectTrend(candles1d);
  const stored = regimeStore.get(pair);
  if (!stored) {
    if (current.direction) {
      const lastCandle = candles1d[candles1d.length - 1];
      regimeStore.set(pair, {
        direction: current.direction,
        strength: current.strength,
        lockedUntil: now + DIRECTION_LOCK_MS,
        lastCandleTimestamp: lastCandle?.timestamp ?? now,
      });
    }
    return current;
  }
  const lastCandle = candles1d[candles1d.length - 1];
  if (!lastCandle || lastCandle.timestamp <= stored.lastCandleTimestamp) {
    return { direction: stored.direction, strength: stored.strength };
  }
  if (current.direction === stored.direction) {
    regimeStore.set(pair, { ...stored, strength: current.strength, lastCandleTimestamp: lastCandle.timestamp });
    return { direction: stored.direction, strength: current.strength };
  }
  if (now < stored.lockedUntil) return { direction: stored.direction, strength: stored.strength };
  const config = getPairConfig(pair);
  const adxVal = adx(candles1d) ?? 0;
  const isStrong = current.strength === "STRONG" || adxVal >= config.adxThreshold;
  if (isStrong) {
    regimeStore.set(pair, {
      direction: current.direction!,
      strength: current.strength,
      lockedUntil: now + DIRECTION_LOCK_MS,
      lastCandleTimestamp: lastCandle.timestamp,
    });
    return current;
  }
  return { direction: stored.direction, strength: stored.strength };
}

const hysteresisStore = new Map<string, { lastSignalType: "ENTRY_1" | "ENTRY_2" | "ADD" | null; lastSignalPrice: number; lockUntil: number }>();
const signalCooldowns = new Map<string, number>();
const exitCooldowns = new Map<string, number>();
const exitHistory = new Map<string, { timestamp: number; reason: string; price: number }[]>();

function getHysteresis(pair: string, now: number) {
  const s = hysteresisStore.get(pair);
  if (!s || now > s.lockUntil) return { lastSignalType: null, lastSignalPrice: 0, lockUntil: 0 };
  return s;
}

function setHysteresis(pair: string, type: "ENTRY_1" | "ENTRY_2" | "ADD", price: number, now: number) {
  const config = getPairConfig(pair);
  hysteresisStore.set(pair, { lastSignalType: type, lastSignalPrice: price, lockUntil: now + (type === "ADD" ? config.signalCooldownMs : 24 * 60 * 60 * 1000) });
}

function recordExit(pair: string, reason: string, price: number, now: number) {
  exitCooldowns.set(pair, now + POST_EXIT_COOLDOWN_MS);
  signalCooldowns.set(pair, now + 2 * 60 * 60 * 1000);
  const history = exitHistory.get(pair) || [];
  history.push({ timestamp: now, reason, price });
  if (history.length > 20) history.shift();
  exitHistory.set(pair, history);
}

function canReenter(pair: string, now: number, debug: string[]): boolean {
  const cooldown = exitCooldowns.get(pair);
  if (cooldown && now < cooldown) {
    const remainingMin = Math.ceil((cooldown - now) / 60000);
    debug.push(`Re-entry blocked: post-exit cooldown (${remainingMin}min remaining)`);
    return false;
  }
  return true;
}

function isChurnPattern(pair: string, currentPrice: number, now: number): boolean {
  const history = exitHistory.get(pair);
  if (!history || history.length < 2) return false;
  const recent = history.slice(-3).filter(h => now - h.timestamp < 6 * 60 * 60 * 1000);
  if (recent.length < 2) return false;
  const prices = recent.map(h => h.price);
  const avgPrice = avg(prices);
  const maxDeviation = Math.max(...prices.map(p => Math.abs(p - avgPrice) / avgPrice));
  return maxDeviation < 0.02;
}

function createInitialTradeState(entryPrice: number, timestamp: number): TradeState {
  return {
    phase: "ENTRY",
    phaseEnteredAt: timestamp,
    highestPrice: entryPrice,
    lowestPrice: entryPrice,
    entryPrice,
    lockedStop: null,
    profitLockLevel: 0,
    exitPersistence: {
      consecutiveClosesBeyondEMA21: 0,
      lastCloseBeyondEMA21: 0,
      ema21SlopeHistory: [],
      warningCount: 0,
    },
    entryTimestamp: timestamp,
    lastDecisionTimestamp: timestamp,
    realizedPnl: 0,
    maxDrawdown: 0,
    maxProfit: 0,
    currentR: 0,
  };
}

export function migrateV34ToV35(signal: Signal): TradeState {
  const now = Date.now();
  const entry = signal.entry;
  const highest = signal.highestPrice || entry;
  const lowest = signal.lowestPrice || entry;
  const locked = signal.lockedStop || null;
  const profitLock = signal.profitLockActive ? 1 : 0;

  const timeInTrade = now - signal.timestamp;
  let phase: TradeLifecyclePhase = "ENTRY";

  if (timeInTrade > LIFECYCLE_CONFIG.entryPhaseDurationMs + LIFECYCLE_CONFIG.buildingPhaseDurationMs) {
    phase = "TREND";
  } else if (timeInTrade > LIFECYCLE_CONFIG.entryPhaseDurationMs) {
    phase = "BUILDING";
  }

  return {
    phase,
    phaseEnteredAt: signal.timestamp,
    highestPrice: highest,
    lowestPrice: lowest,
    entryPrice: entry,
    lockedStop: locked,
    profitLockLevel: profitLock,
    exitPersistence: {
      consecutiveClosesBeyondEMA21: 0,
      lastCloseBeyondEMA21: 0,
      ema21SlopeHistory: [],
      warningCount: 0,
    },
    entryTimestamp: signal.timestamp,
    lastDecisionTimestamp: now,
    realizedPnl: 0,
    maxDrawdown: 0,
    maxProfit: 0,
    currentR: 0,
  };
}

// v35.2: R-based state updates
function updateTradeState(state: TradeState, signal: Signal, currentPrice: number, now: number): TradeState {
  const highest = Math.max(state.highestPrice, currentPrice);
  const lowest = Math.min(state.lowestPrice, currentPrice);

  // Calculate R-multiple
  const risk = Math.abs(signal.entry - signal.stop);
  const currentR = risk > 0 
    ? (signal.direction === "LONG" ? (currentPrice - signal.entry) : (signal.entry - currentPrice)) / risk
    : 0;

  const pnl = signal.direction === "LONG"
    ? (currentPrice - state.entryPrice) / state.entryPrice
    : (state.entryPrice - currentPrice) / state.entryPrice;

  const maxProfit = Math.max(state.maxProfit, pnl);
  const maxDrawdown = Math.min(state.maxDrawdown, pnl);

  let newPhase = state.phase;
  let newPhaseEnteredAt = state.phaseEnteredAt;
  const timeInPhase = now - state.phaseEnteredAt;

  // ENTRY → BUILDING: After entry duration
  if (state.phase === "ENTRY" && timeInPhase > LIFECYCLE_CONFIG.entryPhaseDurationMs) {
    newPhase = "BUILDING";
    newPhaseEnteredAt = now;
  }

  // BUILDING → TREND: At 1R profit (your fix)
  if (state.phase === "BUILDING" && currentR >= LIFECYCLE_CONFIG.trendPhaseThresholdR) {
    newPhase = "TREND";
    newPhaseEnteredAt = now;
  }

  // TREND → PROFIT_PROTECTION: At 2R profit (your fix)
  if ((state.phase === "TREND" || state.phase === "BUILDING") && currentR >= LIFECYCLE_CONFIG.profitLockThresholdR) {
    newPhase = "PROFIT_PROTECTION";
    newPhaseEnteredAt = now;
  }

  // Profit lock levels (also R-based now)
  let profitLockLevel = state.profitLockLevel;
  let lockedStop = state.lockedStop;

  // v35.2: R-based profit locks
  if (currentR >= 3.0 && profitLockLevel < 3) {
    profitLockLevel = 3;
    lockedStop = signal.direction === "LONG"
      ? Math.max(signal.stop, state.entryPrice + (currentPrice - state.entryPrice) * 0.75)
      : Math.min(signal.stop, state.entryPrice - (state.entryPrice - currentPrice) * 0.75);
  } else if (currentR >= 2.0 && profitLockLevel < 2) {
    profitLockLevel = 2;
    lockedStop = signal.direction === "LONG"
      ? Math.max(signal.stop, state.entryPrice + (currentPrice - state.entryPrice) * 0.5)
      : Math.min(signal.stop, state.entryPrice - (state.entryPrice - currentPrice) * 0.5);
  } else if (currentR >= 1.0 && profitLockLevel < 1) {
    profitLockLevel = 1;
    const buffer = state.entryPrice * 0.005;
    lockedStop = signal.direction === "LONG"
      ? Math.max(signal.stop, state.entryPrice + buffer)
      : Math.min(signal.stop, state.entryPrice - buffer);
  }

  return {
    ...state,
    phase: newPhase,
    phaseEnteredAt: newPhaseEnteredAt,
    highestPrice: highest,
    lowestPrice: lowest,
    lockedStop,
    profitLockLevel,
    lastDecisionTimestamp: now,
    maxProfit,
    maxDrawdown,
    currentR,
  };
}

export function generateSignal(
  pair: string,
  candles1h: Candle[],
  candles4h: Candle[],
  candles1d: Candle[],
  activeSignals: Signal[],
  currentPrice?: number
): SignalResult {
  const debug: string[] = [];
  const now = Date.now();
  const config = getPairConfig(pair);

  const anyActiveForPair = activeSignals.filter(s => s.pair === pair && !s.exited);
  if (anyActiveForPair.length > 0) {
    debug.push(`BLOCKED: Active trade exists (id=${anyActiveForPair[0].id})`);
    return { debug };
  }

  if (candles1d.length < 25 || candles4h.length < 30) {
    debug.push("Insufficient data");
    return { debug };
  }

  const t1d = getPersistentRegime(pair, candles1d, now);
  debug.push(`1D: ${t1d.direction || "NONE"} ${t1d.strength}`);

  if (!t1d.direction) {
    debug.push("1D direction unclear");
    return { debug };
  }

  const t4h = detectTrend(candles4h);
  debug.push(`4H: ${t4h.direction || "NONE"} ${t4h.strength}`);

  const closes4h = candles4h.map(c => c.close);
  const e8_4h = ema(closes4h, 8);
  const e21_4h = ema(closes4h, 21);
  const e50_4h = ema(closes4h, 50);

  if (!e8_4h.length || !e21_4h.length) {
    debug.push("EMA calc failed");
    return { debug };
  }

  const price = currentPrice ?? candles4h[candles4h.length - 1].close;
  const last4h = candles4h[candles4h.length - 1];
  const prev4h = candles4h[candles4h.length - 2];

  const stoch4h = stochRsi(closes4h);
  let stoch1h = { k: 50, d: 50 };
  if (candles1h.length >= 30) stoch1h = stochRsi(candles1h.map(c => c.close));

  const adx4h = adx(candles4h) ?? 0;
  const atrVal = atr(candles4h, 14);

  const ema21Price = e21_4h[e21_4h.length - 1];
  const ema8Price = e8_4h[e8_4h.length - 1];

  const distFromEMA21 = (price - ema21Price) / ema21Price;

  let entryType: "ENTRY_1" | "ENTRY_2" | "ADD" | null = null;
  let confidence = 0;
  let entryMode: "PULLBACK" | "BREAKOUT" | "COUNTER_TREND" = "PULLBACK";

  const agg = config.aggression;

  let phase4h: "EXPANSION" | "EXHAUSTION" | "BUILDING" | "NEUTRAL" = "NEUTRAL";
  if (t1d.direction === "LONG") {
    if (stoch4h.k > 75) phase4h = "EXPANSION";
    else if (stoch4h.k < 25) phase4h = "EXHAUSTION";
    else phase4h = "BUILDING";
  } else if (t1d.direction === "SHORT") {
    if (stoch4h.k < 25) phase4h = "EXPANSION";
    else if (stoch4h.k > 75) phase4h = "EXHAUSTION";
    else phase4h = "BUILDING";
  }

  const structureRespected = t1d.direction === "LONG"
    ? price > ema21Price && ema8Price > ema21Price
    : price < ema21Price && ema8Price < ema21Price;

  const nearEMA21 = Math.abs(distFromEMA21) < (0.025 * agg);
  const stochExtremeLong = stoch4h.k < (50 / agg) && stoch4h.d < (55 / agg);
  const stochExtremeShort = stoch4h.k > (50 / agg) && stoch4h.d > (45 / agg);
  const stochExtreme = t1d.direction === "LONG" ? stochExtremeLong : stochExtremeShort;

  const nearEMA8 = Math.abs((price - ema8Price) / ema8Price) < (0.015 * agg);
  const stochTurningLong = stoch4h.k > stoch4h.d && stoch4h.k < (65 / agg);
  const stochTurningShort = stoch4h.k < stoch4h.d && stoch4h.k > (35 / agg);
  const stochTurning = t1d.direction === "LONG" ? stochTurningLong : stochTurningShort;

  const ema21Touch = Math.abs(distFromEMA21) < (0.012 * agg);
  const stochBelowMid = t1d.direction === "LONG" ? stoch4h.k < (70 / agg) : stoch4h.k > (30 / agg);

  const beyondEMA8 = t1d.direction === "LONG" ? price > ema8Price * 1.005 : price < ema8Price * 0.995;
  const confirmingCandle = t1d.direction === "LONG"
    ? last4h.close > last4h.open && last4h.close > prev4h.close
    : last4h.close < last4h.open && last4h.close < prev4h.close;
  const volUp = last4h.volume > avg(candles4h.slice(-10).map(c => c.volume)) * 1.2;

  const trend4hAligned = t4h.direction === t1d.direction;
  const emaAligned = t1d.direction === "LONG"
    ? ema8Price > ema21Price
    : ema8Price < ema21Price;

  const isPullback = nearEMA21 || nearEMA8;
  const trendConflict = t4h.direction && t4h.direction !== t1d.direction;
  const stochCrossBullish = stoch4h.k > stoch4h.d && stoch4h.k > 35;
  const stochCrossBearish = stoch4h.k < stoch4h.d && stoch4h.k < 65;
  const stochCross = t1d.direction === "LONG" ? stochCrossBullish : stochCrossBearish;

  // Calculate "distance to trade" metrics
  let distanceToEntry: number | null = null;
  let nextTrigger: string | null = null;

  if (nearEMA21 && stochExtreme && emaAligned) {
    entryType = "ENTRY_1";
    confidence = 75;
    if (trend4hAligned) confidence += 10;
    else if (trendConflict) confidence -= 10;
    if (adx4h >= config.adxThreshold) confidence += 5;
    debug.push(`ENTRY_1: EMA21 pullback, stoch ${stoch4h.k}/${stoch4h.d}` + (trendConflict ? " (4H conflict)" : ""));
  } else if (nearEMA8 && stochTurning && emaAligned) {
    entryType = "ENTRY_2";
    confidence = 60;
    if (trend4hAligned) confidence += 10;
    else if (trendConflict) confidence -= 10;
    debug.push(`ENTRY_2: EMA8 pullback, stoch turning ${stoch4h.k}/${stoch4h.d}` + (trendConflict ? " (4H conflict)" : ""));
  } else if (ema21Touch && stochBelowMid && emaAligned) {
    entryType = "ENTRY_1";
    confidence = 55;
    if (trend4hAligned) confidence += 10;
    debug.push(`ENTRY_1: EMA21 touch, stoch ${stoch4h.k}/${stoch4h.d} below mid`);
  } else if (nearEMA21 && stochCross && emaAligned && agg > 1.1) {
    entryType = "ENTRY_1";
    confidence = 50;
    if (trend4hAligned) confidence += 10;
    else if (trendConflict) confidence -= 5;
    debug.push(`ENTRY_1: stoch cross ${stoch4h.k}/${stoch4h.d} at EMA21, agg=${agg}`);
  } else if (beyondEMA8 && confirmingCandle && (trend4hAligned || !t4h.direction)) {
    entryType = "ADD";
    entryMode = "BREAKOUT";
    confidence = 50;
    if (volUp) confidence += 5;
    if (adx4h >= config.adxThreshold) confidence += 5;
    debug.push(`ADD: momentum, beyond EMA8`);
  }

  if (!entryType && trendConflict && isPullback && (stochBelowMid || (stochCross && agg > 1.1))) {
    entryType = "ENTRY_1";
    entryMode = "COUNTER_TREND";
    confidence = 45;
    debug.push(`ENTRY_1: conflict pullback, stoch ${stoch4h.k}/${stoch4h.d}, agg=${agg}`);
  }

  if (entryType && entryType !== "ADD" && phase4h === "EXPANSION" && !structureRespected) {
    debug.push(`BLOCKED: Early entry in EXPANSION phase without structure respect`);
    entryType = null;
    confidence = 0;
  }

  // ═══════════════════════════════════════════════════════════
  // FIX: Reduced 1H timing penalty so good setups aren't killed
  // ═══════════════════════════════════════════════════════════
  if ((entryType === "ENTRY_1" || entryType === "ENTRY_2") && candles1h.length >= 30) {
    const timingOk = t1d.direction === "LONG"
      ? stoch1h.k > stoch1h.d || stoch1h.k < 35
      : stoch1h.k < stoch1h.d || stoch1h.k > 65;
    if (!timingOk) {
      const timingPenalty = Math.floor(6 / agg); // Was 15. BTC: 6, ETH: 6, SOL/HYPE: 4
      confidence -= timingPenalty;
      debug.push("1H timing check (-" + timingPenalty + " conf)");
    }
  }

  if (!entryType) {
    const distToEMA21Pct = Math.abs(distFromEMA21) * 100;

    if (!emaAligned) {
      nextTrigger = "Wait for EMA alignment";
      distanceToEntry = null;
    } else if (distToEMA21Pct > 3) {
      nextTrigger = `Price ${distToEMA21Pct.toFixed(1)}% from EMA21 — need pullback`;
      distanceToEntry = distToEMA21Pct;
    } else if (stoch4h.k > 40 && stoch4h.k < 60) {
      nextTrigger = `Stoch at ${stoch4h.k.toFixed(1)} — need extreme (<25 or >75)`;
      distanceToEntry = t1d.direction === "LONG" ? stoch4h.k - 25 : 75 - stoch4h.k;
    } else {
      nextTrigger = "Setup forming — watch for confirmation";
      distanceToEntry = 0;
    }
  }

  const hyst = getHysteresis(pair, now);
  if (hyst.lastSignalType && entryType === hyst.lastSignalType) {
    if (Math.abs(price - hyst.lastSignalPrice) / hyst.lastSignalPrice < config.hysteresisBand) {
      debug.push("Hysteresis lock");
      return { debug };
    }
  }

  const lastSignal = signalCooldowns.get(pair);
  if (lastSignal && now - lastSignal < config.signalCooldownMs) {
    debug.push(`Cooldown active`);
    return { debug };
  }

  if (!canReenter(pair, now, debug)) {
    return { debug };
  }

  if (isChurnPattern(pair, price, now)) {
    debug.push("Churn pattern detected: blocking re-entry in same price zone");
    return { debug };
  }

  if (!entryType || confidence < LIFECYCLE_CONFIG.minConfidence) {
    debug.push(`No setup (conf=${confidence}, need ${LIFECYCLE_CONFIG.minConfidence})`);
    return { debug, market: { distanceToEntry, nextTrigger } };
  }

  setHysteresis(pair, entryType, price, now);

  let entry: number, sl: number, tp: number, type: "ACCUMULATE" | "BREAKOUT";

  const minRR = Math.max(1.3, MIN_RR / agg);
  const stopMultiplier = config.atrMultiplier * (1 + (agg - 1) * 0.5);
  const swingLow = Math.min(...candles4h.slice(-30).map(c => c.low));
  const swingHigh = Math.max(...candles4h.slice(-30).map(c => c.high));

  if (entryType === "ENTRY_1" || entryType === "ENTRY_2") {
    type = "ACCUMULATE";
    entry = price;
    const atrStop = atrVal * stopMultiplier;
    sl = t1d.direction === "LONG"
      ? Math.min(swingLow, entry - atrStop)
      : Math.max(swingHigh, entry + atrStop);
    const minTarget = t1d.direction === "LONG"
      ? Math.max(entry + atrVal * 4, entry * 1.05)
      : Math.min(entry - atrVal * 4, entry * 0.95);
    tp = t1d.direction === "LONG"
      ? Math.max(swingHigh, minTarget)
      : Math.min(swingLow, minTarget);
  } else {
    type = "BREAKOUT";
    entry = price;
    sl = t1d.direction === "LONG"
      ? Math.min(ema21Price * 0.995, entry - atrVal * 1.5)
      : Math.max(ema21Price * 1.005, entry + atrVal * 1.5);
    const minTarget = t1d.direction === "LONG"
      ? entry + (entry - sl) * minRR
      : entry - (sl - entry) * minRR;
    tp = t1d.direction === "LONG"
      ? Math.max(swingHigh, minTarget)
      : Math.min(swingLow, minTarget);
  }

  const rr = t1d.direction === "LONG" ? (tp - entry) / (entry - sl) : (entry - tp) / (sl - entry);
  if (rr < minRR) {
    debug.push(`R:R ${rr.toFixed(2)} < ${minRR.toFixed(2)}`);
    return { debug, market: { distanceToEntry, nextTrigger } };
  }

  const tradeState = createInitialTradeState(entry, now);

  const signal: Signal = {
    id: `${pair}_${now}`,
    pair,
    direction: t1d.direction,
    type,
    scale: entryType,
    entry: Math.round(entry * 100) / 100,
    stop: Math.round(sl * 100) / 100,
    target: Math.round(tp * 100) / 100,
    confidence: Math.min(confidence, 95),
    rr: Math.round(rr * 100) / 100,
    adx: Math.round(adx4h * 10) / 10,
    rsi: Math.round((wilderRsi(closes4h) ?? 50) * 10) / 10,
    stochK: stoch4h.k,
    stochD: stoch4h.d,
    timestamp: now,
    version: CURRENT_SIGNAL_VERSION,
    tradeState,
    entryTier: entryType === "ADD" ? "CONFIRMED_ENTRY" : "EARLY_ENTRY",
    entryMode,
    positionSizePct: entryType === "ADD" ? 0.05 : entryType === "ENTRY_1" ? 0.04 : 0.03,
    regimeDirection: t1d.direction,
    conflictEntry: trendConflict,
    entryTimeframe: "4H",
    exited: false,
  };

  signalCooldowns.set(pair, now);

  return {
    signal,
    market: {
      pair, price: Math.round(price * 100) / 100, timestamp: now,
      trend: `${t1d.direction} ${t1d.strength}`,
      adx: signal.adx, rsi: signal.rsi, stochK: signal.stochK, stochD: signal.stochD,
      ema21: Math.round(ema21Price * 100) / 100,
      distToEMA21: Math.round(distFromEMA21 * 10000) / 100,
      distanceToEntry,
      nextTrigger,
    },
    debug,
  };
}

export function isSignalStillValid(signal: Signal, currentPrice: number): { valid: boolean; reason: string; exited: boolean } {
  if (signal.direction === "LONG" && currentPrice <= signal.stop) return { valid: false, reason: "sl_hit", exited: true };
  if (signal.direction === "SHORT" && currentPrice >= signal.stop) return { valid: false, reason: "sl_hit", exited: true };
  if (signal.direction === "LONG" && currentPrice >= signal.target) return { valid: false, reason: "tp_hit", exited: true };
  if (signal.direction === "SHORT" && currentPrice <= signal.target) return { valid: false, reason: "tp_hit", exited: true };
  return { valid: true, reason: "active", exited: false };
}

export function shouldHold(
  signal: Signal,
  candles4h: Candle[],
  candles1d: Candle[],
  currentPrice: number
): HoldResult {
  const now = Date.now();
  const timeInTrade = now - signal.timestamp;
  const config = getPairConfig(signal.pair);

  if (!signal.tradeState || !signal.tradeState.phase) {
    signal.tradeState = migrateV34ToV35(signal);
  }

  const updatedState = updateTradeState(signal.tradeState, signal, currentPrice, now);

  const entryTf = signal.entryTimeframe || "4H";
  const minHold = MIN_HOLD_TIMES[entryTf] || MIN_HOLD_TIMES["4H"];
  const conflictMinHold = signal.conflictEntry ? minHold * 1.5 : minHold;

  const sltpCheck = isSignalStillValid(signal, currentPrice);
  if (!sltpCheck.valid) {
    recordExit(signal.pair, sltpCheck.reason, currentPrice, now);
    return { 
      shouldHold: false, 
      reason: sltpCheck.reason,
      updatedTradeState: { ...updatedState, phase: "EXIT", phaseEnteredAt: now }
    };
  }

  if (timeInTrade < conflictMinHold) {
    return { 
      shouldHold: true, 
      reason: `min_hold_${Math.floor(timeInTrade / 60000)}min`,
      updatedTradeState: updatedState
    };
  }

  if (updatedState.profitLockLevel > 0 && updatedState.lockedStop) {
    const effectiveSL = updatedState.lockedStop;
    if (signal.direction === "LONG" && currentPrice <= effectiveSL) {
      recordExit(signal.pair, "profit_lock_stop", currentPrice, now);
      return { 
        shouldHold: false, 
        reason: "profit_lock_stop",
        updatedTradeState: { ...updatedState, phase: "EXIT", phaseEnteredAt: now }
      };
    }
    if (signal.direction === "SHORT" && currentPrice >= effectiveSL) {
      recordExit(signal.pair, "profit_lock_stop", currentPrice, now);
      return { 
        shouldHold: false, 
        reason: "profit_lock_stop",
        updatedTradeState: { ...updatedState, phase: "EXIT", phaseEnteredAt: now }
      };
    }
  }

  // v35.2: Relaxed stale trade — 24h + <0.5R (your fix)
  const hoursInTrade = timeInTrade / (60 * 60 * 1000);
  if (hoursInTrade > LIFECYCLE_CONFIG.staleTradeHours && updatedState.currentR < LIFECYCLE_CONFIG.staleTradeThresholdR) {
    recordExit(signal.pair, "time_decay", currentPrice, now);
    return { 
      shouldHold: false, 
      reason: "time_decay",
      updatedTradeState: { ...updatedState, phase: "EXIT", phaseEnteredAt: now }
    };
  }

  if (candles4h.length < 50) {
    return {
      shouldHold: true,
      reason: "structure_intact",
      updatedTradeState: updatedState,
    };
  }

  const closes = candles4h.map(c => c.close);
  const e21 = ema(closes, 21);
  const e50 = ema(closes, 50);

  if (e21.length >= 3 && e50.length >= 3) {
    const c0 = candles4h[candles4h.length - 1].close;
    const c1 = candles4h[candles4h.length - 2].close;
    const c2 = candles4h[candles4h.length - 3].close;
    const e21_0 = e21[e21.length - 1];
    const e21_1 = e21[e21.length - 2];
    const e21_2 = e21[e21.length - 3];
    const e50_0 = e50[e50.length - 1];

    let requiredCloses: number;
    if (updatedState.phase === "TREND" || updatedState.phase === "PROFIT_PROTECTION") {
      requiredCloses = EXIT_PERSISTENCE.trendConsecutiveCloses;
    } else if (signal.conflictEntry) {
      requiredCloses = EXIT_PERSISTENCE.conflictConsecutiveCloses;
    } else if (signal.scale === "ADD") {
      requiredCloses = EXIT_PERSISTENCE.addConsecutiveCloses;
    } else {
      requiredCloses = EXIT_PERSISTENCE.normalConsecutiveCloses;
    }

    let consecutiveBeyond = 0;
    const recentCloses = [c0, c1, c2];
    const recentE21 = [e21_0, e21_1, e21_2];

    for (let i = 0; i < recentCloses.length; i++) {
      const beyond = signal.direction === "LONG"
        ? recentCloses[i] < recentE21[i]
        : recentCloses[i] > recentE21[i];
      if (beyond) consecutiveBeyond++;
      else break;
    }

    const ema21SlopingDown = e21_0 < e21_1;
    const ema21SlopingUp = e21_0 > e21_1;
    const emaSlopeConfirming = signal.direction === "LONG" ? ema21SlopingDown : ema21SlopingUp;
    const beyondEMA50 = signal.direction === "LONG" ? c0 < e50_0 : c0 > e50_0;

    const structureConfirmed = updatedState.phase === "TREND" || updatedState.phase === "PROFIT_PROTECTION"
      ? beyondEMA50
      : true;

    if (consecutiveBeyond >= requiredCloses && emaSlopeConfirming && structureConfirmed) {
      if (signal.conflictEntry) {
        const stoch4h = stochRsi(closes);
        const stochConfirming = signal.direction === "LONG"
          ? stoch4h.k < stoch4h.d && stoch4h.k < 40
          : stoch4h.k > stoch4h.d && stoch4h.k > 60;

        if (!stochConfirming) {
          return {
            shouldHold: true,
            reason: `structure_weakening_${consecutiveBeyond}/${requiredCloses}`,
            updatedTradeState: {
              ...updatedState,
              exitPersistence: {
                ...updatedState.exitPersistence,
                consecutiveClosesBeyondEMA21: consecutiveBeyond,
                lastCloseBeyondEMA21: now,
                ema21SlopeHistory: [e21_0, e21_1, e21_2],
                warningCount: updatedState.exitPersistence.warningCount + 1,
              }
            }
          };
        }
      }

      recordExit(signal.pair, "4h_structure_break", currentPrice, now);
      return { 
        shouldHold: false, 
        reason: "4h_structure_break",
        updatedTradeState: { ...updatedState, phase: "EXIT", phaseEnteredAt: now }
      };
    }

    if (consecutiveBeyond >= 2 && consecutiveBeyond < requiredCloses) {
      return {
        shouldHold: true,
        reason: `structure_warning_${consecutiveBeyond}/${requiredCloses}`,
        updatedTradeState: {
          ...updatedState,
          exitPersistence: {
            ...updatedState.exitPersistence,
            consecutiveClosesBeyondEMA21: consecutiveBeyond,
            lastCloseBeyondEMA21: now,
            ema21SlopeHistory: [e21_0, e21_1, e21_2],
            warningCount: updatedState.exitPersistence.warningCount + 1,
          }
        }
      };
    }
  }

  const atr4h = atr(candles4h, 14);
  if (e21.length > 0) {
    const ema21Price = e21[e21.length - 1];
    const breach = atr4h * 1.5;
    const effectiveBreach = (updatedState.phase === "TREND" || updatedState.phase === "PROFIT_PROTECTION")
      ? breach * 2.0
      : breach;

    if (signal.direction === "LONG" && currentPrice < ema21Price - effectiveBreach) {
      recordExit(signal.pair, "ema21_breach", currentPrice, now);
      return { 
        shouldHold: false, 
        reason: "ema21_breach",
        updatedTradeState: { ...updatedState, phase: "EXIT", phaseEnteredAt: now }
      };
    }
    if (signal.direction === "SHORT" && currentPrice > ema21Price + effectiveBreach) {
      recordExit(signal.pair, "ema21_breach", currentPrice, now);
      return { 
        shouldHold: false, 
        reason: "ema21_breach",
        updatedTradeState: { ...updatedState, phase: "EXIT", phaseEnteredAt: now }
      };
    }
  }

  if (candles1d.length >= 25) {
    const regime = getPersistentRegime(signal.pair, candles1d, now);
    const adx1d = adx(candles1d) ?? 0;
    const isStrongFlip = regime.strength === "STRONG" || adx1d >= config.adxThreshold;
    if (regime.direction && regime.direction !== signal.direction && isStrongFlip) {
      recordExit(signal.pair, "regime_flip", currentPrice, now);
      return { 
        shouldHold: false, 
        reason: "regime_flip",
        updatedTradeState: { ...updatedState, phase: "EXIT", phaseEnteredAt: now }
      };
    }
  }

  return {
    shouldHold: true,
    reason: "structure_intact",
    updatedTradeState: updatedState,
  };
}

export function filterExpiredSignals(signals: Signal[], currentPrices?: Record<string, number>) {
  const active: Signal[] = [];
  const exited: { signal: Signal; reason: string }[] = [];
  const now = Date.now();

  for (const signal of signals) {
    if (!signal.exited) {
      const price = currentPrices?.[signal.pair];
      if (price !== undefined) {
        const check = isSignalStillValid(signal, price);
        if (!check.valid) {
          recordExit(signal.pair, check.reason, price, now);
          exited.push({ signal, reason: check.reason });
          continue;
        }
      }
      active.push(signal);
      continue;
    }
    if (Date.now() - signal.timestamp < EXITED_TTL_MS) active.push(signal);
  }
  return { active, exited };
}

export function getMarketSnapshot(
  pair: string,
  candles1h: Candle[],
  candles4h: Candle[],
  candles15m: Candle[],
  candles1d: Candle[],
  currentPrice?: number,
  signalResult?: SignalResult
) {
  const t1h = detectTrend(candles1h);
  const t4h = detectTrend(candles4h);
  const t1d = detectTrend(candles1d);
  const price = currentPrice ?? candles4h[candles4h.length - 1].close;

  const stoch4h = stochRsi(candles4h.map(c => c.close));
  const stoch1h = candles1h.length >= 30 ? stochRsi(candles1h.map(c => c.close)) : { k: 50, d: 50 };
  const regimePersist = regimeStore.get(pair);
  const adxVal = adx(candles4h) ?? 0;
  const config = getPairConfig(pair);

  const closes4h = candles4h.map(c => c.close);
  const e21_4h = ema(closes4h, 21);
  const ema21Price = e21_4h.length > 0 ? e21_4h[e21_4h.length - 1] : 0;
  const distToEMA21 = ema21Price > 0 ? (price - ema21Price) / ema21Price : 0;

  const trendStrength = {
    adx: adxVal,
    isStrong: adxVal >= config.adxThreshold,
  };

  let phase4h: "EXPANSION" | "EXHAUSTION" | "BUILDING" | "NEUTRAL" = "NEUTRAL";
  if (t1d.direction === "LONG") {
    if (stoch4h.k > 75) phase4h = "EXPANSION";
    else if (stoch4h.k < 25) phase4h = "EXHAUSTION";
    else phase4h = "BUILDING";
  } else if (t1d.direction === "SHORT") {
    if (stoch4h.k < 25) phase4h = "EXPANSION";
    else if (stoch4h.k > 75) phase4h = "EXHAUSTION";
    else phase4h = "BUILDING";
  }

  let phase1h: "EXPANSION" | "EXHAUSTION" | "BUILDING" | "NEUTRAL" = "NEUTRAL";
  if (t1d.direction === "LONG") {
    if (stoch1h.k > 75) phase1h = "EXPANSION";
    else if (stoch1h.k < 25) phase1h = "EXHAUSTION";
    else phase1h = "BUILDING";
  } else if (t1d.direction === "SHORT") {
    if (stoch1h.k < 25) phase1h = "EXPANSION";
    else if (stoch1h.k > 75) phase1h = "EXHAUSTION";
    else phase1h = "BUILDING";
  }

  let structure15m = "Neutral";
  if (candles15m.length >= 20) {
    const t15m = detectTrend(candles15m);
    if (t15m.direction === t1d.direction) {
      structure15m = t15m.strength === "STRONG" ? "Breakout" : "Building";
    } else if (t15m.direction && t15m.direction !== t1d.direction) {
      structure15m = "Reversal";
    }
  }

  let readiness = 0;
  if (t1d.direction) readiness += 30;
  if (t4h.direction === t1d.direction) readiness += 25;
  if (trendStrength.isStrong) readiness += 20;
  if (signalResult?.signal) readiness += 25;
  else if (Math.abs(distToEMA21) < 0.01) readiness += 15;

  const summary: {
    status: string;
    debug?: string[];
    distanceToEntry?: number | null;
    nextTrigger?: string | null;
    blocks?: string[];
  } = {
    status: signalResult?.signal ? "READY" : "WATCH",
  };

  if (!signalResult?.signal && signalResult?.debug?.length) {
    const blocks: string[] = [];
    const debugLines: string[] = [];

    let rrBlocker: string | null = null;
    let confBlocker: string | null = null;
    let hysteresisBlocker = false;
    let cooldownBlocker = false;
    let churnBlocker = false;
    let blockedEarly = false;

    for (const line of signalResult.debug) {
      debugLines.push(line);

      if (line.includes("R:R") && line.includes("<")) {
        rrBlocker = line;
      } else if (line.includes("conf=") && line.includes("need")) {
        confBlocker = line;
      } else if (line.includes("Hysteresis lock")) {
        hysteresisBlocker = true;
      } else if (line.includes("Cooldown active")) {
        cooldownBlocker = true;
      } else if (line.includes("Churn pattern")) {
        churnBlocker = true;
      } else if (line.includes("BLOCKED: Early entry in EXPANSION")) {
        blockedEarly = true;
      }
    }

    if (rrBlocker) {
      const rrMatch = rrBlocker.match(/R:R\s+([\d.]+)\s*<\s*([\d.]+)/);
      if (rrMatch) {
        blocks.push(`R:R ${rrMatch[1]} < ${rrMatch[2]} (need ${rrMatch[2]}+)`);
      } else {
        blocks.push("Insufficient risk:reward");
      }
    } else if (confBlocker) {
      const confMatch = confBlocker.match(/conf=(\d+),\s*need\s*(\d+)/);
      if (confMatch) {
        blocks.push(`No setup (conf=${confMatch[1]}, need ${confMatch[2]})`);
      } else {
        blocks.push("Insufficient confidence");
      }
    } else if (hysteresisBlocker) {
      blocks.push("Hysteresis lock");
    } else if (cooldownBlocker) {
      blocks.push("Cooldown active");
    } else if (churnBlocker) {
      blocks.push("Churn pattern — avoid re-entry");
    } else if (blockedEarly) {
      blocks.push("Early entry blocked in EXPANSION phase");
    } else {
      const fallback = signalResult.debug.find(d => d.includes("BLOCKED") || d.includes("No setup") || d.includes("Insufficient"));
      blocks.push(fallback || "No valid setup");
    }

    summary.debug = debugLines;
    summary.blocks = blocks;
  }

  if (signalResult?.market?.nextTrigger) {
    summary.nextTrigger = signalResult.market.nextTrigger;
    summary.distanceToEntry = signalResult.market.distanceToEntry;
  }

  return {
    pair,
    price: Math.round(price * 100) / 100,
    timestamp: Date.now(),
    trend: t1d.direction ? `${t1d.direction} ${t1d.strength}` : "NONE",
    regime: {
      direction: t1d.direction,
      strength: t1d.strength,
      confidence: t1d.direction ? (t1d.strength === "STRONG" ? 75 : 50) : 0,
      lockedUntil: regimePersist?.lockedUntil || null,
    },
    adx: Math.round(adxVal * 10) / 10,
    rsi: Math.round((wilderRsi(closes4h) ?? 50) * 10) / 10,
    stochK: stoch4h.k,
    stochD: stoch4h.d,
    stoch1hK: stoch1h.k,
    stoch1hD: stoch1h.d,
    ema21: Math.round(ema21Price * 100) / 100,
    distToEMA21: Math.round(distToEMA21 * 10000) / 100,
    trend1h: t1h.direction ? { direction: t1h.direction, strength: t1h.strength } : null,
    trend4h: t4h.direction ? { direction: t4h.direction, strength: t4h.strength } : null,
    trend1d: t1d.direction ? { direction: t1d.direction, strength: t1d.strength } : null,
    trendStrength,
    phase1h,
    phase4h,
    structure15m,
    readiness,
    recommendedAction: signalResult?.signal ? `${signalResult.signal.direction} ${signalResult.signal.type}` : null,
    entryTier: signalResult?.signal ? (signalResult.signal.scale === "ADD" ? "CONFIRMED_ENTRY" : "EARLY_ENTRY") : null,
    positionSize: signalResult?.signal ? (signalResult.signal.scale === "ADD" ? "FULL" : "STARTER") : null,
    summary,
    signal: signalResult?.signal || null,
    ...signalResult?.market,
  };
}

export function updateTradeManagerCompat(signal: Signal, currentPrice: number) {
  if (!signal.tradeState || !signal.tradeState.phase) {
    signal.tradeState = migrateV34ToV35(signal);
  }
  const now = Date.now();
  return updateTradeState(signal.tradeState, signal, currentPrice, now);
}

export function recordExitCooldown(pair: string, now: number = Date.now()) {
  recordExit(pair, "manual_cooldown", 0, now);
}

export function getExitHistory(pair: string): { timestamp: number; reason: string; price: number }[] {
  return exitHistory.get(pair) || [];
}

export function getReentryCooldownRemaining(pair: string, now: number = Date.now()): number {
  const cooldown = exitCooldowns.get(pair);
  if (!cooldown) return 0;
  return Math.max(0, cooldown - now);
}

export function isSignalStillValidBool(signal: Signal, currentPrice: number): boolean {
  return isSignalStillValid(signal, currentPrice).valid;
}

export async function generateSignalAsync(
  pair: string,
  candles1h: Candle[],
  candles4h: Candle[],
  candles15m: Candle[],
  activeSignals?: Signal[],
  currentPrice?: number
): Promise<SignalResult> {
  return generateSignal(pair, candles1h, candles4h, aggregateTo1D(candles4h), activeSignals || [], currentPrice);
}

export function shouldHoldCompat(
  signal: Signal,
  candles4h: Candle[],
  candles1h: Candle[],
  currentPrice: number
): HoldResult {
  return shouldHold(signal, candles4h, aggregateTo1D(candles4h), currentPrice);
}

export async function loadExits(): Promise<any[]> { return []; }
export function setRegimePersistence(): void {}
export function setExitPersistence(): void {}
export function setTelemetryPersistence(): void {}
export async function persistTelemetry(): Promise<void> {}

export function calculateTradeState(signal: Signal, currentPrice: number): any {
  return updateTradeManagerCompat(signal, currentPrice);
}
