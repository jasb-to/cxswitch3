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
  highestPrice?: number;
  lowestPrice?: number;
  tradeState?: string;
  lockedStop?: number;
  profitLockActive?: boolean;
  entryTier?: EntryTier;
  entryMode?: string;
  positionSizePct?: number;
  regimeDirection?: string;
  conflictEntry?: boolean;
  entryTimeframe?: string;
  // v34: Track exit persistence
  exitPersistence?: {
    consecutiveClosesBeyondEMA21: number;
    lastCloseBeyondEMA21: number;
    ema21Slope: number[];
  };
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
  // v34: Optional updated signal with new state
  updatedSignal?: Partial<Signal>;
}

export interface MarketRegime {
  direction: "LONG" | "SHORT" | null;
  strength: string;
  lockedUntil: number;
  lastCandleTimestamp: number;
}

export interface ExitRecord {
  pair: string;
  timestamp: number;
  reason: string;
}

export const CURRENT_SIGNAL_VERSION = 34;
const MIN_RR = 1.5;
const EXITED_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// v34: Minimum hold times by entry type (in ms)
const MIN_HOLD_TIMES: Record<string, number> = {
  "15m": 30 * 60 * 1000,      // 30 min for 15m entries
  "1H": 2 * 60 * 60 * 1000,   // 2 hours for 1H entries
  "4H": 4 * 60 * 60 * 1000,   // 4 hours for 4H entries
  "1D": 24 * 60 * 60 * 1000,  // 1 day for 1D entries
};

// v34: Exit persistence thresholds
const EXIT_PERSISTENCE = {
  // Normal entries: require 3 consecutive 4H closes beyond condition
  normalConsecutiveCloses: 3,
  // ADD entries: can exit faster (momentum trade)
  addConsecutiveCloses: 2,
  // Conflict entries: require MORE persistence (they're counter-trend)
  conflictConsecutiveCloses: 4,
  // Max closes to track
  maxTrackedCloses: 6,
};

// v34: Post-exit re-entry cooldown
const POST_EXIT_COOLDOWN_MS = 4 * 60 * 60 * 1000; // 4 hours

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

// ─── INDICATORS ───

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

// ─── TREND ───

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

// ─── 1D REGIME (closed candles only) ───

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

// ─── STATE ───

const hysteresisStore = new Map<string, { lastSignalType: "ENTRY_1" | "ENTRY_2" | "ADD" | null; lastSignalPrice: number; lockUntil: number }>();
const signalCooldowns = new Map<string, number>();
// v34: Track post-exit cooldowns
const exitCooldowns = new Map<string, number>();
// v34: Track exit history per pair
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

// v34: Check if re-entry is allowed after exit
function canReenter(pair: string, now: number, debug: string[]): boolean {
  const cooldown = exitCooldowns.get(pair);
  if (cooldown && now < cooldown) {
    const remainingMin = Math.ceil((cooldown - now) / 60000);
    debug.push(`Re-entry blocked: post-exit cooldown (${remainingMin}min remaining)`);
    return false;
  }
  return true;
}

// v34: Record an exit for cooldown tracking
function recordExit(pair: string, reason: string, price: number, now: number) {
  // Set post-exit cooldown
  exitCooldowns.set(pair, now + POST_EXIT_COOLDOWN_MS);
  // Also set standard signal cooldown
  signalCooldowns.set(pair, now + 2 * 60 * 60 * 1000);

  // Track in history
  const history = exitHistory.get(pair) || [];
  history.push({ timestamp: now, reason, price });
  // Keep last 20 exits
  if (history.length > 20) history.shift();
  exitHistory.set(pair, history);
}

// v34: Check for churn pattern (repeated exits in same price zone)
function isChurnPattern(pair: string, currentPrice: number, now: number): boolean {
  const history = exitHistory.get(pair);
  if (!history || history.length < 2) return false;

  // Check last 3 exits within 6 hours and 2% price range
  const recent = history.slice(-3).filter(h => now - h.timestamp < 6 * 60 * 60 * 1000);
  if (recent.length < 2) return false;

  const prices = recent.map(h => h.price);
  const avgPrice = avg(prices);
  const maxDeviation = Math.max(...prices.map(p => Math.abs(p - avgPrice) / avgPrice));

  return maxDeviation < 0.02; // Within 2% of each other = churn
}

// ─── SIGNAL GENERATION — v34: FIXED EARLY ENTRIES ───

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

  const activeForPair = activeSignals.filter(s => s.pair === pair && !s.exited);
  if (activeForPair.length > 0) {
    debug.push("Active trade exists");
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
  const swingLow20 = Math.min(...candles4h.slice(-20).map(c => c.low));
  const swingHigh20 = Math.max(...candles4h.slice(-20).map(c => c.high));

  const distFromEMA21 = (price - ema21Price) / ema21Price;

  let entryType: "ENTRY_1" | "ENTRY_2" | "ADD" | null = null;
  let confidence = 0;

  const agg = config.aggression;

  // v34: Determine phase before entry
  let phase4h: "EXPANSION" | "EXHAUSTION" | "NEUTRAL" = "NEUTRAL";
  if (t1d.direction === "LONG") {
    if (stoch4h.k > 75) phase4h = "EXPANSION";
    else if (stoch4h.k < 25) phase4h = "EXHAUSTION";
  } else if (t1d.direction === "SHORT") {
    if (stoch4h.k < 25) phase4h = "EXPANSION";
    else if (stoch4h.k > 75) phase4h = "EXHAUSTION";
  }

  // ENTRY_1: Deep pullback
  const nearEMA21 = Math.abs(distFromEMA21) < (0.025 * agg);
  const stochExtremeLong = stoch4h.k < (50 / agg) && stoch4h.d < (55 / agg);
  const stochExtremeShort = stoch4h.k > (50 / agg) && stoch4h.d > (45 / agg);
  const stochExtreme = t1d.direction === "LONG" ? stochExtremeLong : stochExtremeShort;

  // ENTRY_2: Shallow pullback
  const nearEMA8 = Math.abs((price - ema8Price) / ema8Price) < (0.015 * agg);
  const stochTurningLong = stoch4h.k > stoch4h.d && stoch4h.k < (65 / agg);
  const stochTurningShort = stoch4h.k < stoch4h.d && stoch4h.k > (35 / agg);
  const stochTurning = t1d.direction === "LONG" ? stochTurningLong : stochTurningShort;

  // EMA21 touch entry
  const ema21Touch = Math.abs(distFromEMA21) < (0.012 * agg);
  const stochBelowMid = t1d.direction === "LONG" ? stoch4h.k < (70 / agg) : stoch4h.k > (30 / agg);

  // ADD momentum
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
    confidence = 45;
    if (trend4hAligned) confidence += 10;
    else if (trendConflict) confidence -= 5;
    debug.push(`ENTRY_1: stoch cross ${stoch4h.k}/${stoch4h.d} at EMA21, agg=${agg}`);
  } else if (beyondEMA8 && confirmingCandle && (trend4hAligned || !t4h.direction)) {
    entryType = "ADD";
    confidence = 50;
    if (volUp) confidence += 5;
    if (adx4h >= config.adxThreshold) confidence += 5;
    debug.push(`ADD: momentum, beyond EMA8`);
  }

  // Conflict pullback entry
  if (!entryType && trendConflict && isPullback && (stochBelowMid || (stochCross && agg > 1.1))) {
    entryType = "ENTRY_1";
    confidence = 40 + Math.floor(agg * 5);
    debug.push(`ENTRY_1: conflict pullback, stoch ${stoch4h.k}/${stoch4h.d}, agg=${agg}`);
  }

  // v34: PHASE CHECK — Early entries ONLY in EXHAUSTION phase
  if (entryType && entryType !== "ADD" && phase4h !== "EXHAUSTION") {
    debug.push(`BLOCKED: Early entry in ${phase4h} phase (need EXHAUSTION)`);
    // Allow ADD entries in any phase (momentum is momentum)
    // But block ENTRY_1 and ENTRY_2 unless we're in exhaustion
    if (entryType !== "ADD") {
      entryType = null;
      confidence = 0;
    }
  }

  // 1H timing filter
  if ((entryType === "ENTRY_1" || entryType === "ENTRY_2") && candles1h.length >= 30) {
    const timingOk = t1d.direction === "LONG"
      ? stoch1h.k > stoch1h.d || stoch1h.k < 35
      : stoch1h.k < stoch1h.d || stoch1h.k > 65;
    if (!timingOk) {
      const timingPenalty = Math.floor(20 / agg);
      confidence -= timingPenalty;
      debug.push("1H timing opposed (-" + timingPenalty + " conf)");
    }
  }

  // Hysteresis & cooldown
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

  // v34: Post-exit re-entry cooldown check
  if (!canReenter(pair, now, debug)) {
    return { debug };
  }

  // v34: Churn detection — if we've exited multiple times in same zone, block re-entry
  if (isChurnPattern(pair, price, now)) {
    debug.push("Churn pattern detected: blocking re-entry in same price zone");
    return { debug };
  }

  const minConfidence = Math.floor(40 / agg);
  if (!entryType || confidence < minConfidence) {
    debug.push(`No setup (conf=${confidence}, need ${minConfidence})`);
    return { debug };
  }

  setHysteresis(pair, entryType, price, now);

  // ─── CALCULATE LEVELS ───
  let entry: number, sl: number, tp: number, type: "ACCUMULATE" | "BREAKOUT";

  // v34: Fix minRR declaration order
  const minRR = Math.max(1.2, MIN_RR / agg);
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
    return { debug };
  }

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
    entryTier: entryType === "ADD" ? "CONFIRMED_ENTRY" : "EARLY_ENTRY",
    entryMode: entryType === "ADD" ? "BREAKOUT" : "PULLBACK",
    positionSizePct: entryType === "ADD" ? 0.05 : entryType === "ENTRY_1" ? 0.04 : 0.03,
    regimeDirection: t1d.direction,
    conflictEntry: trendConflict,
    entryTimeframe: "4H",
    exited: false,
    highestPrice: entry,
    lowestPrice: entry,
    tradeState: "OPEN",
    // v34: Initialize exit persistence tracking
    exitPersistence: {
      consecutiveClosesBeyondEMA21: 0,
      lastCloseBeyondEMA21: 0,
      ema21Slope: [],
    },
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
    },
    debug,
  };
}

// ─── VALIDITY — SL & TP ONLY ───

export function isSignalStillValid(signal: Signal, currentPrice: number): { valid: boolean; reason: string; exited: boolean } {
  if (signal.direction === "LONG" && currentPrice <= signal.stop) return { valid: false, reason: "sl_hit", exited: true };
  if (signal.direction === "SHORT" && currentPrice >= signal.stop) return { valid: false, reason: "sl_hit", exited: true };
  if (signal.direction === "LONG" && currentPrice >= signal.target) return { valid: false, reason: "tp_hit", exited: true };
  if (signal.direction === "SHORT" && currentPrice <= signal.target) return { valid: false, reason: "tp_hit", exited: true };
  return { valid: true, reason: "active", exited: false };
}

// ─── TRADE STATE MANAGER — v34: Integrated with shouldHold ───

export interface TradeState {
  highestPrice: number;
  lowestPrice: number;
  pnl: number;
  newState: string;
  lockedStop?: number;
  profitLockActive: boolean;
}

export function calculateTradeState(signal: Signal, currentPrice: number): TradeState {
  const highest = Math.max(signal.highestPrice || signal.entry, currentPrice);
  const lowest = Math.min(signal.lowestPrice || signal.entry, currentPrice);
  const pnl = signal.direction === "LONG" 
    ? (currentPrice - signal.entry) / signal.entry 
    : (signal.entry - currentPrice) / signal.entry;

  let profitLockActive = false;
  let lockedStop: number | undefined;

  // v34: Tighter profit lock for ADD entries (momentum trades)
  const lockThreshold = signal.scale === "ADD" ? 0.04 : 0.05;
  const lockAggressive = signal.scale === "ADD" ? 0.06 : 0.08;
  const lockFull = signal.scale === "ADD" ? 0.10 : 0.12;

  if (pnl > lockFull) {
    profitLockActive = true;
    lockedStop = signal.direction === "LONG"
      ? Math.max(signal.stop, signal.entry + (currentPrice - signal.entry) * 0.75)
      : Math.min(signal.stop, signal.entry - (signal.entry - currentPrice) * 0.75);
  } else if (pnl > lockAggressive) {
    profitLockActive = true;
    lockedStop = signal.direction === "LONG"
      ? Math.max(signal.stop, signal.entry + (currentPrice - signal.entry) * 0.5)
      : Math.min(signal.stop, signal.entry - (signal.entry - currentPrice) * 0.5);
  } else if (pnl > lockThreshold) {
    profitLockActive = true;
    const buffer = signal.entry * 0.005;
    lockedStop = signal.direction === "LONG"
      ? Math.max(signal.stop, signal.entry + buffer)
      : Math.min(signal.stop, signal.entry - buffer);
  }

  let newState = "ENTRY";
  if (pnl > lockThreshold) newState = "PROFIT_ZONE";
  if (profitLockActive) newState = "LOCKED";
  if (pnl < -0.005) newState = "DRAWDOWN";

  return { highestPrice: highest, lowestPrice: lowest, pnl, newState, lockedStop, profitLockActive };
}

// ─── shouldHold — v34: PERSISTENT EXITS + STATE-AWARE MANAGEMENT ───

export function shouldHold(
  signal: Signal,
  candles4h: Candle[],
  candles1d: Candle[],
  currentPrice: number
): HoldResult {
  const now = Date.now();
  const timeInTrade = now - signal.timestamp;
  const config = getPairConfig(signal.pair);

  // v34: 1. MINIMUM HOLD TIME — ABSOLUTE GUARD (moved to top)
  const entryTf = signal.entryTimeframe || "4H";
  const minHold = MIN_HOLD_TIMES[entryTf] || MIN_HOLD_TIMES["4H"];
  const conflictMinHold = signal.conflictEntry ? minHold * 1.5 : minHold;

  if (timeInTrade < conflictMinHold) {
    return { shouldHold: true, reason: `min_hold_${Math.floor(timeInTrade / 60000)}min` };
  }

  // v34: 2. Calculate trade state (profit lock, etc.)
  const tradeState = calculateTradeState(signal, currentPrice);

  // v34: 3. SL / TP — ALWAYS override everything (hard stops)
  const v = isSignalStillValid(signal, currentPrice);
  if (!v.valid) {
    // Record exit for cooldown tracking
    recordExit(signal.pair, v.reason, currentPrice, now);
    return { shouldHold: false, reason: v.reason };
  }

  // v34: 4. If profit lock is active, use locked stop as effective SL
  if (tradeState.profitLockActive && tradeState.lockedStop) {
    const effectiveSL = tradeState.lockedStop;
    if (signal.direction === "LONG" && currentPrice <= effectiveSL) {
      recordExit(signal.pair, "profit_lock_stop", currentPrice, now);
      return { shouldHold: false, reason: "profit_lock_stop" };
    }
    if (signal.direction === "SHORT" && currentPrice >= effectiveSL) {
      recordExit(signal.pair, "profit_lock_stop", currentPrice, now);
      return { shouldHold: false, reason: "profit_lock_stop" };
    }
  }

  if (candles4h.length < 50) {
    return { 
      shouldHold: true, 
      reason: "structure_intact",
      updatedSignal: {
        highestPrice: tradeState.highestPrice,
        lowestPrice: tradeState.lowestPrice,
        tradeState: tradeState.newState,
        lockedStop: tradeState.lockedStop,
        profitLockActive: tradeState.profitLockActive,
      }
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

    // v34: Determine required consecutive closes based on entry type
    let requiredCloses: number;
    if (signal.conflictEntry) {
      requiredCloses = EXIT_PERSISTENCE.conflictConsecutiveCloses;
    } else if (signal.scale === "ADD") {
      requiredCloses = EXIT_PERSISTENCE.addConsecutiveCloses;
    } else {
      requiredCloses = EXIT_PERSISTENCE.normalConsecutiveCloses;
    }

    // v34: Track consecutive closes beyond EMA21
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

    // v34: Structure break requires ALL conditions:
    // 1. Required consecutive closes beyond EMA21
    // 2. EMA21 slope confirming the break direction
    // 3. Price beyond EMA50
    // 4. (For conflict entries) Stochastic confirming momentum

    const ema21SlopingDown = e21_0 < e21_1;
    const ema21SlopingUp = e21_0 > e21_1;
    const emaSlopeConfirming = signal.direction === "LONG" ? ema21SlopingDown : ema21SlopingUp;

    const beyondEMA50 = signal.direction === "LONG" ? c0 < e50_0 : c0 > e50_0;

    if (consecutiveBeyond >= requiredCloses && emaSlopeConfirming && beyondEMA50) {
      // v34: Extra check for conflict entries — require stoch confirmation
      if (signal.conflictEntry) {
        const stoch4h = stochRsi(closes);
        const stochConfirming = signal.direction === "LONG"
          ? stoch4h.k < stoch4h.d && stoch4h.k < 40
          : stoch4h.k > stoch4h.d && stoch4h.k > 60;

        if (!stochConfirming) {
          // Not enough momentum confirmation yet
          return { 
            shouldHold: true, 
            reason: `structure_weakening_${consecutiveBeyond}/${requiredCloses}`,
            updatedSignal: {
              highestPrice: tradeState.highestPrice,
              lowestPrice: tradeState.lowestPrice,
              tradeState: tradeState.newState,
              lockedStop: tradeState.lockedStop,
              profitLockActive: tradeState.profitLockActive,
              exitPersistence: {
                consecutiveClosesBeyondEMA21: consecutiveBeyond,
                lastCloseBeyondEMA21: now,
                ema21Slope: [e21_0, e21_1, e21_2],
              }
            }
          };
        }
      }

      recordExit(signal.pair, "4h_structure_break", currentPrice, now);
      return { shouldHold: false, reason: "4h_structure_break" };
    }

    // v34: If we're getting close to structure break but not there yet, warn
    if (consecutiveBeyond >= 2 && consecutiveBeyond < requiredCloses) {
      return { 
        shouldHold: true, 
        reason: `structure_warning_${consecutiveBeyond}/${requiredCloses}`,
        updatedSignal: {
          highestPrice: tradeState.highestPrice,
          lowestPrice: tradeState.lowestPrice,
          tradeState: tradeState.newState,
          lockedStop: tradeState.lockedStop,
          profitLockActive: tradeState.profitLockActive,
          exitPersistence: {
            consecutiveClosesBeyondEMA21: consecutiveBeyond,
            lastCloseBeyondEMA21: now,
            ema21Slope: [e21_0, e21_1, e21_2],
          }
        }
      };
    }
  }

  // v34: 5. EMA21 BREACH by 1.5x ATR — but respect trade state
  const atr4h = atr(candles4h, 14);
  if (e21.length > 0) {
    const ema21Price = e21[e21.length - 1];
    const breach = atr4h * 1.5;

    // v34: If in PROFIT_ZONE or LOCKED, require 2x ATR breach (more room)
    const effectiveBreach = (tradeState.newState === "PROFIT_ZONE" || tradeState.newState === "LOCKED") 
      ? breach * 1.5 
      : breach;

    if (signal.direction === "LONG" && currentPrice < ema21Price - effectiveBreach) {
      recordExit(signal.pair, "ema21_breach", currentPrice, now);
      return { shouldHold: false, reason: "ema21_breach" };
    }
    if (signal.direction === "SHORT" && currentPrice > ema21Price + effectiveBreach) {
      recordExit(signal.pair, "ema21_breach", currentPrice, now);
      return { shouldHold: false, reason: "ema21_breach" };
    }
  }

  // v34: 6. 1D REGIME FLIP — STRONG only
  if (candles1d.length >= 25) {
    const regime = getPersistentRegime(signal.pair, candles1d, now);
    const adx1d = adx(candles1d) ?? 0;
    const isStrongFlip = regime.strength === "STRONG" || adx1d >= config.adxThreshold;
    if (regime.direction && regime.direction !== signal.direction && isStrongFlip) {
      recordExit(signal.pair, "regime_flip", currentPrice, now);
      return { shouldHold: false, reason: "regime_flip" };
    }
  }

  // v34: 7. Time-based exit — if trade hasn't moved meaningfully in 12+ hours
  const hoursInTrade = timeInTrade / (60 * 60 * 1000);
  if (hoursInTrade > 12 && Math.abs(tradeState.pnl) < 0.005) {
    // Trade has been open 12+ hours and moved less than 0.5% — dead trade
    recordExit(signal.pair, "time_decay", currentPrice, now);
    return { shouldHold: false, reason: "time_decay" };
  }

  return { 
    shouldHold: true, 
    reason: "structure_intact",
    updatedSignal: {
      highestPrice: tradeState.highestPrice,
      lowestPrice: tradeState.lowestPrice,
      tradeState: tradeState.newState,
      lockedStop: tradeState.lockedStop,
      profitLockActive: tradeState.profitLockActive,
    }
  };
}

// ─── FILTER ───

export function filterExpiredSignals(signals: Signal[], currentPrices?: Record<string, number>) {
  const active: Signal[] = [];
  const exited: { signal: Signal; reason: string }[] = [];
  for (const signal of signals) {
    if (!signal.exited) {
      const price = currentPrices?.[signal.pair];
      if (price !== undefined) {
        const check = isSignalStillValid(signal, price);
        if (!check.valid) { exited.push({ signal, reason: check.reason }); continue; }
      }
      active.push(signal);
      continue;
    }
    if (Date.now() - signal.timestamp < EXITED_TTL_MS) active.push(signal);
  }
  return { active, exited };
}

// ─── SNAPSHOT ───

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

  let phase4h: "EXPANSION" | "EXHAUSTION" | "NEUTRAL" = "NEUTRAL";
  if (t1d.direction === "LONG") {
    if (stoch4h.k > 75) phase4h = "EXPANSION";
    else if (stoch4h.k < 25) phase4h = "EXHAUSTION";
  } else if (t1d.direction === "SHORT") {
    if (stoch4h.k < 25) phase4h = "EXPANSION";
    else if (stoch4h.k > 75) phase4h = "EXHAUSTION";
  }

  let phase1h: "EXPANSION" | "EXHAUSTION" | "NEUTRAL" = "NEUTRAL";
  if (t1d.direction === "LONG") {
    if (stoch1h.k > 75) phase1h = "EXPANSION";
    else if (stoch1h.k < 25) phase1h = "EXHAUSTION";
  } else if (t1d.direction === "SHORT") {
    if (stoch1h.k < 25) phase1h = "EXPANSION";
    else if (stoch1h.k > 75) phase1h = "EXHAUSTION";
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

  const whyNoTrade: string[] = [];
  if (!signalResult?.signal) {
    if (signalResult?.debug?.length) whyNoTrade.push(...signalResult.debug);
    else whyNoTrade.push("No setup detected");
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
    whyNoTrade,
    signal: signalResult?.signal || null,
    ...signalResult?.market,
  };
}

// ─── TRADE MANAGER — v34: DEPRECATED, use calculateTradeState instead ───

export function updateTradeManagerCompat(signal: Signal, currentPrice: number) {
  return calculateTradeState(signal, currentPrice);
}

// ─── COOLDOWNS — v34: Enhanced with exit tracking ───

export function recordExitCooldown(pair: string, now: number = Date.now()) {
  signalCooldowns.set(pair + "_exit", now);
  signalCooldowns.set(pair, now + 2 * 60 * 60 * 1000);
}

// v34: Get exit history for a pair
export function getExitHistory(pair: string): { timestamp: number; reason: string; price: number }[] {
  return exitHistory.get(pair) || [];
}

// v34: Get remaining cooldown time
export function getReentryCooldownRemaining(pair: string, now: number = Date.now()): number {
  const cooldown = exitCooldowns.get(pair);
  if (!cooldown) return 0;
  return Math.max(0, cooldown - now);
}

// ─── COMPAT ───

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
