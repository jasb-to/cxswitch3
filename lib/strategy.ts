// lib/strategy.ts — v29.3 CLEANUP (Single File, Zero Behaviour Change)
// ===================================================================
// CHANGES FROM v29.2:
// - All dead code removed (15 functions, 1 constant object, 2 interfaces)
// - All duplicate calculations eliminated: single indicators computation
// - All duplicate market data objects: single buildMarketData helper
// - All duplicate rejection logs: single logRejection helper
// - Magic numbers extracted to named constants
// - generateSignal collapsed from 462 lines to ~180 lines
// - evaluateEntry collapsed from 235 lines to ~140 lines
// - Explicit alert levels for Telegram verification
// ===================================================================

const DEBUG = process.env.DEBUG === "true";

const TIER = { WAIT: 0, WATCH: 50, EARLY: 70, CONFIRMED: 85 } as const;
const SCORE_MAX = { LOCATION: 30, STRUCTURE: 20, MOMENTUM: 30, RISK: 20 } as const;
const MIN_RR = 1.5;
const VOL_MULT_THRESHOLD = 1.5;
const VOL_MULT_WEAK = 1.1;
const ADX_MIN_STRONG = 25;
const ADX_MIN_MODERATE = 0.7;
const ATR_LOW_PCT = 0.015;
const ATR_NORMAL_PCT = 0.025;
const ATR_ELEVATED_PCT = 0.04;
const SIGNAL_TTL_MS = 4 * 60 * 60 * 1000;
const TIER_LOCK_TTL_MS = 4 * 60 * 60 * 1000;
const EXIT_COOLDOWN_MS = 8 * 60 * 60 * 1000;
const REGIME_CACHE_TTL_MS = 15 * 60 * 1000;
const MAX_REJECTION_LOGS = 1000;
const EMA_FAST = 21;
const EMA_SLOW = 50;
const EMA_TREND = 200;
const RSI_PERIOD = 14;
const STOCH_K = 3;
const STOCH_D = 3;
const LOOKBACK_SWING = 20;
const LOOKBACK_STRUCTURE = 10;
const LOOKBACK_VOLUME = 20;
const LOOKBACK_ATR = 14;
const ROC_LOOKBACK = 4;
const BE_PCT_DEFAULT = 0.01;
const LOCK_PCT_DEFAULT = 0.02;
const RUNNER_PCT_DEFAULT = 0.04;
const RR_EXCELLENT = 3.0;
const RR_GOOD = 2.0;
const EXHAUSTION_OVERBOUGHT = 90;
const EXHAUSTION_OVERBOUGHT_WEAK = 80;
const EXHAUSTION_OVERSOLD = 10;
const EXHAUSTION_OVERSOLD_WEAK = 20;

export interface Candle { timestamp: number; open: number; high: number; low: number; close: number; volume: number; }

export interface Signal {
  id: string; pair: string; direction: "LONG" | "SHORT"; type: "ENTRY" | "EXIT" | "SCALE_IN" | "SCALE_OUT";
  scale?: string; entry: number; stop: number; target: number; confidence: number; entryTier: EntryTier;
  positionSizePct: number; rr: number; adx?: number; rsi?: number; stochK?: number; stochD?: number;
  stoch1hK?: number; stoch1hD?: number; expectedMove?: number; reason?: string; timestamp: number;
  version: number; tradeState?: "OPEN" | "BREAK_EVEN" | "LOCKED" | "RUNNER" | "EXITED";
  exited?: boolean; lockedStop?: number | null; highestPrice?: number; lowestPrice?: number;
  profitLockActive?: boolean; regimeDirection?: "LONG" | "SHORT" | "NEUTRAL" | null;
  regimeSince?: number; entryMode?: "PULLBACK" | "REJECTION" | "BREAKOUT";
  confidenceComponents?: { location: number; structure: number; momentum: number; risk: number; total: number; };
  exhaustionWarning?: string;
}

export interface MarketRegime {
  direction: "LONG" | "SHORT" | "NEUTRAL" | null; strength: string; confidence: number;
  score: number; reason: string[]; detectedAt: number;
}

export interface SignalResult {
  signal?: Signal; market?: MarketData; debug?: string[]; entryCandidates?: EntryCandidates;
  rejectionStage?: string | null; evaluation?: EntryEvaluation;
}

export interface PairConfig {
  minADX: number; momentumThreshold: number; volumeMultiplier: number; stopLossPct: number;
  takeProfitPct: number; maxEntryDriftPct: number; isHYPE?: boolean;
  deepCrossThresholdLong?: number; deepCrossThresholdShort?: number; maxRecentVolatility?: number;
  bePct?: number; lockPct?: number; runnerPct?: number;
}

export interface TradeManagerUpdate {
  signalId: string; newState: "OPEN" | "BREAK_EVEN" | "LOCKED" | "RUNNER" | "EXITED";
  lockedStop: number; profitLockActive: boolean; highestPrice: number; lowestPrice: number;
  exitTriggered: boolean; exitReason?: string;
}

export interface ValidityCheck { valid: boolean; reason: string; exited: boolean; }

export interface HoldResult { shouldHold: boolean; reason: string; managedStop?: number; }

export interface ExitRecord { signalId: string; pair: string; direction: "LONG" | "SHORT"; exitTimestamp: number; exitReason: string; exitPrice: number; }

export interface RejectionLog {
  pair: string; timestamp: number; crossDetected: boolean; crossDirection: "LONG" | "SHORT" | null;
  regimeDirection: "LONG" | "SHORT" | "NEUTRAL" | null; regimeStrength: string;
  confidenceScore: number; confidenceBreakdown: Record<string, number>; rejectionReason: string;
  stochK: number; stochD: number; stochPrevK: number; stochPrevD: number; evaluation?: EntryEvaluation;
}

export interface ConfidenceComponents { location: number; structure: number; momentum: number; risk: number; total: number; }

export interface EntryCandidate { eligible: boolean; confidence: number; rejectionReason: string | null; }

export interface EntryCandidates { pullback: EntryCandidate; rejection: EntryCandidate; breakout: EntryCandidate; }

export interface TrendContext { direction: string; strength: string; }

export interface MarketSnapshot {
  pair: string; price: number; trend: string; regime: RegimeDisplay; adx?: number; rsi?: number;
  stochK?: number; stochD?: number; stoch1hK?: number; stoch1hD?: number; trend1h?: TrendContext;
  trend4h?: TrendContext; trend1d?: TrendContext; entryCandidates?: EntryCandidates; rejectionStage?: string | null;
  recommendedAction?: string; positionSize?: string; whyNoTrade?: string[]; entryTier?: EntryTier | null;
  trendConflict?: boolean; evaluation?: EntryEvaluation;
}

export interface RegimeDisplay { direction: "LONG" | "SHORT" | "NEUTRAL" | "TREND_CONFLICT" | null; strength: string; confidence: number; score: number; reason: string[]; }

export type EntryTier = "NO_TRADE" | "WATCH" | "EARLY_ENTRY" | "CONFIRMED_ENTRY";

export interface EntryEvaluation {
  pair: string; direction: "LONG" | "SHORT" | null; entryMode: "PULLBACK" | "REJECTION" | "BREAKOUT" | null;
  tier: EntryTier; confidence: number; thresholds: { wait: number; watch: number; early: number; confirmed: number; };
  gapToNextTier: number; nextTier: EntryTier | null;
  breakdown: ScoreBreakdown; missing: MissingComponent[]; likelyTriggers: string[]; reasons: string[];
  stochK: number; stochD: number; stochPrevK: number; stochPrevD: number; crossDetected: boolean;
  exhaustionWarning: string; exhaustionBlocked: boolean; entryPrice: number; stopDistance: number;
  targetDistance: number; rr: number; atrPct: number; adx4h: number;
  regimeDirection: "LONG" | "SHORT" | "NEUTRAL" | null; regimeStrength: string;
  alertLevel: "NO_ALERT" | "WATCH_ALERT" | "EARLY_ALERT" | "CONFIRMED_ALERT" | "EXIT_ALERT";
}

export interface ScoreBreakdown {
  location: number; locationMax: number; structure: number; structureMax: number;
  momentum: number; momentumMax: number; risk: number; riskMax: number; total: number; maxTotal: number;
  contributions: ScoreContribution[];
}

export interface ScoreContribution { component: "location" | "structure" | "momentum" | "risk"; name: string; points: number; rawValue?: string; }

export interface MissingComponent { component: string; pointsNeeded: number; description: string; }

interface MarketData { pair: string; price: number; timestamp: number; regime: MarketRegime; adx: number; rsi: number; stochK: number; stochD: number; stoch1hK: number; stoch1hD: number; }

function safeNum(v: any): number { const n = Number(v); return isFinite(n) ? n : 0; }
function f0(v: any): string { return safeNum(v).toFixed(0); }
function f1(v: any): string { return safeNum(v).toFixed(1); }
function f2(v: any): string { return safeNum(v).toFixed(2); }

function classifyTier(c: number): EntryTier {
  if (c >= TIER.CONFIRMED) return "CONFIRMED_ENTRY";
  if (c >= TIER.EARLY) return "EARLY_ENTRY";
  if (c >= TIER.WATCH) return "WATCH";
  return "NO_TRADE";
}

function tierGap(current: EntryTier, c: number): { gap: number; next: EntryTier | null } {
  switch (current) {
    case "NO_TRADE": return { gap: TIER.WATCH - c, next: "WATCH" };
    case "WATCH": return { gap: TIER.EARLY - c, next: "EARLY_ENTRY" };
    case "EARLY_ENTRY": return { gap: TIER.CONFIRMED - c, next: "CONFIRMED_ENTRY" };
    case "CONFIRMED_ENTRY": return { gap: 0, next: null };
  }
}

function positionSize(tier: EntryTier, strength: string): number {
  if (tier === "NO_TRADE" || tier === "WATCH") return 0;
  if (tier === "EARLY_ENTRY") return strength === "STRONG" ? 0.33 : strength === "MODERATE" ? 0.25 : 0.20;
  return strength === "STRONG" ? 1.0 : strength === "MODERATE" ? 0.75 : 0.50;
}

function alertLevel(tier: EntryTier, isFirstWatch: boolean): EntryEvaluation["alertLevel"] {
  if (tier === "NO_TRADE") return "NO_ALERT";
  if (tier === "WATCH") return isFirstWatch ? "WATCH_ALERT" : "NO_ALERT";
  if (tier === "EARLY_ENTRY") return "EARLY_ALERT";
  return "CONFIRMED_ALERT";
}

const tierLockStore = new Map<string, number>();
function tierLockKey(pair: string, tier: EntryTier): string { return pair + ":" + tier; }
function isTierLocked(pair: string, tier: EntryTier, now: number): boolean {
  const lockedAt = tierLockStore.get(tierLockKey(pair, tier));
  if (!lockedAt) return false;
  if (now - lockedAt > TIER_LOCK_TTL_MS) { tierLockStore.delete(tierLockKey(pair, tier)); return false; }
  return true;
}
function setTierLock(pair: string, tier: EntryTier, now: number): void { tierLockStore.set(tierLockKey(pair, tier), now); }
export function clearTierLocksForPair(pair: string): void { for (const key of tierLockStore.keys()) { if (key.startsWith(pair + ":")) tierLockStore.delete(key); } }

const regimeCache = new Map<string, { regime: MarketRegime; timestamp: number; }>();
let persistRegimeFn: ((pair: string, regime: MarketRegime) => Promise<void>) | null = null;
let loadRegimeFn: ((pair: string) => Promise<MarketRegime | null>) | null = null;

export function setRegimePersistence(persist: (pair: string, regime: MarketRegime) => Promise<void>, load: (pair: string) => Promise<MarketRegime | null>): void {
  persistRegimeFn = persist; loadRegimeFn = load;
}

async function getRegime(pair: string, candles1d: Candle[], candles4h: Candle[]): Promise<MarketRegime> {
  const cached = regimeCache.get(pair);
  if (cached && Date.now() - cached.timestamp < REGIME_CACHE_TTL_MS) return cached.regime;
  const regime = await evaluateRegime(pair, candles1d, candles4h);
  if (persistRegimeFn) try { await persistRegimeFn(pair, regime); } catch (e) { if (DEBUG) console.error("[REGIME]", e); }
  regimeCache.set(pair, { regime, timestamp: Date.now() });
  return regime;
}

export function getRegimeSync(pair: string): MarketRegime | null {
  const cached = regimeCache.get(pair);
  return cached ? cached.regime : null;
}

function ema(values: number[], period: number): number[] {
  if (values.length < period) return [];
  const k = 2 / (period + 1);
  const out: number[] = [];
  const seed = values.slice(0, period).reduce((a, b) => a + (isFinite(b) ? b : 0), 0) / period;
  let prev = isFinite(seed) ? seed : values[0] || 0;
  out.push(prev);
  for (let i = period; i < values.length; i++) {
    const v = isFinite(values[i]) ? values[i] : prev;
    prev = v * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

function highest(values: number[], period: number): number {
  if (values.length < period) return values[values.length - 1] ?? 0;
  return Math.max(...values.slice(-period));
}

function lowest(values: number[], period: number): number {
  if (values.length < period) return values[values.length - 1] ?? 0;
  return Math.min(...values.slice(-period));
}

function avg(arr: number[]): number {
  if (!arr.length) return 0;
  const sum = arr.reduce((a, b) => a + (isFinite(b) ? b : 0), 0);
  const result = sum / arr.length;
  return isFinite(result) ? result : 0;
}

function rsi(values: number[], period: number = RSI_PERIOD): number {
  if (values.length < period + 1) return 50;
  const diffs: number[] = [];
  for (let i = 1; i < values.length; i++) diffs.push(values[i] - values[i - 1]);
  const gains = diffs.filter(d => d > 0);
  const losses = diffs.filter(d => d < 0).map(d => Math.abs(d));
  const avgGain = avg(gains.slice(-period));
  const avgLoss = avg(losses.slice(-period));
  if (!isFinite(avgGain) || !isFinite(avgLoss)) return 50;
  if (avgLoss === 0) return avgGain > 0 ? 100 : 50;
  const rs = avgGain / avgLoss;
  if (!isFinite(rs)) return 50;
  return 100 - 100 / (1 + rs);
}

function stochRsi(values: number[], period: number = RSI_PERIOD, k: number = STOCH_K, d: number = STOCH_D): { k: number; d: number } {
  const rsiValues: number[] = [];
  for (let i = period; i < values.length; i++) {
    const r = rsi(values.slice(0, i + 1), period);
    if (isFinite(r)) rsiValues.push(r);
  }
  if (rsiValues.length < k) return { k: 50, d: 50 };
  const stochKValues: number[] = [];
  for (let i = k - 1; i < rsiValues.length; i++) {
    const slice = rsiValues.slice(i - k + 1, i + 1);
    const highest = Math.max(...slice);
    const lowest = Math.min(...slice);
    const stochK = lowest === highest ? 50 : ((rsiValues[i] - lowest) / (highest - lowest)) * 100;
    stochKValues.push(isFinite(stochK) ? stochK : 50);
  }
  if (stochKValues.length < d) return { k: stochKValues[stochKValues.length - 1] || 50, d: 50 };
  const dValues = stochKValues.slice(-d);
  return { k: isFinite(stochKValues[stochKValues.length - 1]) ? stochKValues[stochKValues.length - 1] : 50, d: isFinite(avg(dValues)) ? avg(dValues) : 50 };
}

function adx(candles: Candle[], period: number = RSI_PERIOD): number {
  if (candles.length < period * 2) return 0;
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);
  const closes = candles.map(c => c.close);
  const trueRanges: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    trueRanges.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1])));
  }
  const plusDMs: number[] = [];
  const minusDMs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const upMove = highs[i] - highs[i - 1];
    const downMove = lows[i - 1] - lows[i];
    plusDMs.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDMs.push(downMove > upMove && downMove > 0 ? downMove : 0);
  }
  const wildersRma = (values: number[], lookback: number): number[] => {
    if (values.length < lookback) return [];
    const result: number[] = [];
    let sum = values.slice(0, lookback).reduce((a, b) => a + b, 0);
    result.push(sum / lookback);
    for (let i = lookback; i < values.length; i++) {
      const prev = result[result.length - 1];
      sum = prev * lookback - prev + values[i];
      result.push(isFinite(sum / lookback) ? sum / lookback : prev);
    }
    return result;
  };
  const atrRma = wildersRma(trueRanges, period);
  const plusDmRma = wildersRma(plusDMs, period);
  const minusDmRma = wildersRma(minusDMs, period);
  if (atrRma.length < 1) return 0;
  const diPlusArray = plusDmRma.map((p, i) => (p / atrRma[i]) * 100);
  const diMinusArray = minusDmRma.map((m, i) => (m / atrRma[i]) * 100);
  const dxArray = diPlusArray.map((diPlus, i) => {
    const diMinus = diMinusArray[i];
    const di = diPlus + diMinus;
    return di === 0 ? 0 : (Math.abs(diPlus - diMinus) / di) * 100;
  });
  const adxRma = wildersRma(dxArray, period);
  const finalAdx = adxRma[adxRma.length - 1];
  return isFinite(finalAdx) ? finalAdx : 0;
}

function aggregateTo1D(candles4h: Candle[]): Candle[] {
  if (!candles4h || candles4h.length < 6) return [];
  const sorted = [...candles4h].sort((a, b) => a.timestamp - b.timestamp);
  const isSeconds = sorted[0].timestamp < 1e10;
  const tsMultiplier = isSeconds ? 1000 : 1;
  const groups = new Map<string, Candle[]>();
  for (const c of sorted) {
    const key = new Date(c.timestamp * tsMultiplier).toISOString().split("T")[0];
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(c);
  }
  const daily: Candle[] = [];
  for (const [, bars] of groups) {
    if (!bars.length) continue;
    daily.push({
      timestamp: bars[0].timestamp * tsMultiplier,
      open: bars[0].open,
      high: Math.max(...bars.map(b => b.high)),
      low: Math.min(...bars.map(b => b.low)),
      close: bars[bars.length - 1].close,
      volume: bars.reduce((s, b) => s + b.volume, 0)
    });
  }
  return daily.sort((a, b) => a.timestamp - b.timestamp);
}

const PAIR_CONFIGS: Record<string, PairConfig> = {
  default: { minADX: 15, momentumThreshold: 50, volumeMultiplier: 1.2, stopLossPct: 0.025, takeProfitPct: 0.035, maxEntryDriftPct: 0.015 },
  BTC: { minADX: 15, momentumThreshold: 50, volumeMultiplier: 1.2, stopLossPct: 0.02, takeProfitPct: 0.03, maxEntryDriftPct: 0.015 },
  ETH: { minADX: 15, momentumThreshold: 50, volumeMultiplier: 1.2, stopLossPct: 0.025, takeProfitPct: 0.035, maxEntryDriftPct: 0.015 },
  SOL: { minADX: 15, momentumThreshold: 45, volumeMultiplier: 1.3, stopLossPct: 0.03, takeProfitPct: 0.04, maxEntryDriftPct: 0.018 },
  HYPE: {
    minADX: 20, momentumThreshold: 60, volumeMultiplier: 1.5, stopLossPct: 0.06, takeProfitPct: 0.05, maxEntryDriftPct: 0.02,
    isHYPE: true, deepCrossThresholdLong: 25, deepCrossThresholdShort: 75, maxRecentVolatility: 0.08,
    bePct: 0.02, lockPct: 0.025, runnerPct: 0.04,
  },
};

export function getPairConfig(pair: string): PairConfig { return PAIR_CONFIGS[pair] || PAIR_CONFIGS.default; }

async function evaluateRegime(pair: string, candles1d: Candle[], candles4h: Candle[]): Promise<MarketRegime> {
  const reasons: string[] = [];
  const detectedAt = Date.now();
  if (candles1d.length < 20 || candles4h.length < 30) {
    return { direction: "NEUTRAL", strength: "INSUFFICIENT_DATA", confidence: 0, score: 0, reason: ["not_enough_candles"], detectedAt };
  }
  const closes1d = candles1d.map(c => c.close);
  const closes4h = candles4h.map(c => c.close);
  const ema21_1d = ema(closes1d, EMA_FAST);
  const ema50_1d = ema(closes1d, EMA_SLOW);
  const ema200_1d = ema(closes1d, EMA_TREND);
  const ema21_4h = ema(closes4h, EMA_FAST);
  const ema50_4h = ema(closes4h, EMA_SLOW);
  let regimeScore = 0;
  let direction: "LONG" | "SHORT" | "NEUTRAL" = "NEUTRAL";
  let tf1d: "LONG" | "SHORT" | "NEUTRAL" = "NEUTRAL";
  let tf4h: "LONG" | "SHORT" | "NEUTRAL" = "NEUTRAL";
  if (ema21_1d.length > 0 && ema50_1d.length > 0) {
    const e21 = ema21_1d[ema21_1d.length - 1];
    const e50 = ema50_1d[ema50_1d.length - 1];
    const lastClose = closes1d[closes1d.length - 1];
    if (ema200_1d.length > 0) {
      const e200 = ema200_1d[ema200_1d.length - 1];
      if (e21 > e50 && e50 > e200 && lastClose > e200) { regimeScore += 40; tf1d = "LONG"; reasons.push("1D_bullish_stack"); }
      else if (e21 < e50 && e50 < e200 && lastClose < e200) { regimeScore -= 40; tf1d = "SHORT"; reasons.push("1D_bearish_stack"); }
      else if (e21 > e50 && lastClose > e21) { regimeScore += 25; tf1d = "LONG"; reasons.push("1D_bullish_lean"); }
      else if (e21 < e50 && lastClose < e21) { regimeScore -= 25; tf1d = "SHORT"; reasons.push("1D_bearish_lean"); }
      else if (e21 > e50) { regimeScore += 15; tf1d = "LONG"; reasons.push("1D_bullish_weak"); }
      else if (e21 < e50) { regimeScore -= 15; tf1d = "SHORT"; reasons.push("1D_bearish_weak"); }
    } else {
      if (e21 > e50 && lastClose > e21) { regimeScore += 25; tf1d = "LONG"; reasons.push("1D_bullish_21_50"); }
      else if (e21 < e50 && lastClose < e21) { regimeScore -= 25; tf1d = "SHORT"; reasons.push("1D_bearish_21_50"); }
      else if (e21 > e50) { regimeScore += 10; tf1d = "LONG"; reasons.push("1D_bullish_weak"); }
      else if (e21 < e50) { regimeScore -= 10; tf1d = "SHORT"; reasons.push("1D_bearish_weak"); }
    }
  } else if (ema21_1d.length > 0) {
    const e21 = ema21_1d[ema21_1d.length - 1];
    const lastClose = closes1d[closes1d.length - 1];
    if (lastClose > e21) { regimeScore += 10; tf1d = "LONG"; reasons.push("1D_price_above_21ema"); }
    else { regimeScore -= 10; tf1d = "SHORT"; reasons.push("1D_price_below_21ema"); }
  }
  if (ema21_4h.length > 0 && ema50_4h.length > 0) {
    const e21 = ema21_4h[ema21_4h.length - 1];
    const e50 = ema50_4h[ema50_4h.length - 1];
    if (e21 > e50) {
      tf4h = "LONG";
      if (tf1d === "LONG") { regimeScore += 20; reasons.push("4H_confirms_bull"); }
      else { regimeScore += 10; reasons.push("4H_bullish"); }
    } else if (e21 < e50) {
      tf4h = "SHORT";
      if (tf1d === "SHORT") { regimeScore += 20; reasons.push("4H_confirms_bear"); }
      else { regimeScore -= 10; reasons.push("4H_bearish"); }
    }
  }
  if (tf1d !== "NEUTRAL" && tf4h !== "NEUTRAL" && tf1d !== tf4h) {
    regimeScore = Math.round(regimeScore * 0.5);
    reasons.push("conflict_" + tf1d + "_1D_vs_" + tf4h + "_4H");
  }
  const rsi1d = rsi(closes1d);
  if (rsi1d > 60) { regimeScore += (tf1d === "LONG" ? 10 : 5); reasons.push("rsi_" + f0(rsi1d)); }
  else if (rsi1d < 40) { regimeScore -= (tf1d === "SHORT" ? 10 : 5); reasons.push("rsi_" + f0(rsi1d)); }
  const adx1d = adx(candles1d);
  const adx4h = adx(candles4h);
  if (adx1d > ADX_MIN_STRONG) { regimeScore += (tf1d !== "NEUTRAL" ? 15 : 5); reasons.push("adx_" + f1(adx1d)); }
  if (adx4h > ADX_MIN_STRONG) { regimeScore += 10; reasons.push("4H_adx_" + f1(adx4h)); }
  if (tf1d !== "NEUTRAL") direction = tf1d;
  else if (tf4h !== "NEUTRAL") { direction = tf4h; regimeScore += 5; reasons.push("fallback_4H"); }
  const absScore = Math.abs(regimeScore);
  let strength = "NEUTRAL";
  if (absScore > 45) strength = "STRONG";
  else if (absScore > 25) strength = "MODERATE";
  else if (absScore > 10) strength = "WEAK";
  if (absScore < 10) { direction = "NEUTRAL"; strength = "NEUTRAL"; reasons.push("score_neutral"); }
  return { direction, strength, confidence: Math.min(100, absScore), score: regimeScore, reason: reasons, detectedAt };
}

interface ComputedIndicators {
  stoch4h: { k: number; d: number }; stoch1h: { k: number; d: number };
  stochPrev4h: { k: number; d: number }; stochPrev1h: { k: number; d: number };
  rsi4h: number; adx4h: number; closes1h: number[]; closes4h: number[];
}

function computeIndicators(candles1h: Candle[], candles4h: Candle[]): ComputedIndicators {
  const closes1h = candles1h.map(c => c.close);
  const closes4h = candles4h.map(c => c.close);
  return {
    stoch4h: stochRsi(closes4h), stoch1h: stochRsi(closes1h),
    stochPrev4h: stochRsi(closes4h.slice(0, -1)), stochPrev1h: stochRsi(closes1h.slice(0, -1)),
    rsi4h: rsi(closes4h), adx4h: adx(candles4h), closes1h, closes4h,
  };
}

function scoreLocation(candles1h: Candle[], candles4h: Candle[], direction: "LONG" | "SHORT", _config: PairConfig): { score: number; reasons: string[]; contributions: ScoreContribution[] } {
  const reasons: string[] = []; const contributions: ScoreContribution[] = []; let score = 0;
  const closes = candles1h.map(c => c.close); const lastClose = closes[closes.length - 1];
  const ema21_1h = ema(closes, EMA_FAST); const ema50_1h = ema(closes, EMA_SLOW);
  if (ema21_1h.length > 0 && ema50_1h.length > 0) {
    const e21 = ema21_1h[ema21_1h.length - 1]; const e50 = ema50_1h[ema50_1h.length - 1];
    const prevE21 = ema21_1h.length > 1 ? ema21_1h[ema21_1h.length - 2] : e21; const slope21 = e21 - prevE21;
    const isBull = direction === "LONG" && slope21 > 0; const isBear = direction === "SHORT" && slope21 < 0;
    if (isBull || isBear) {
      const distFromE21 = Math.abs(lastClose - e21) / e21;
      if (distFromE21 < 0.01) { score += 10; reasons.push("loc_ema21_touch:+10"); contributions.push({ component: "location", name: "EMA21 touch", points: 10, rawValue: f2(distFromE21 * 100) + "%" }); }
      else if (distFromE21 < 0.02) { score += 7; reasons.push("loc_ema21_near:+7"); contributions.push({ component: "location", name: "EMA21 near", points: 7, rawValue: f2(distFromE21 * 100) + "%" }); }
      else if (distFromE21 < 0.035) { score += 4; reasons.push("loc_ema21_close:+4"); contributions.push({ component: "location", name: "EMA21 close", points: 4, rawValue: f2(distFromE21 * 100) + "%" }); }
      const distFromE50 = Math.abs(lastClose - e50) / e50;
      if (distFromE50 < 0.015) { score += 5; reasons.push("loc_ema50_near:+5"); contributions.push({ component: "location", name: "EMA50 near", points: 5, rawValue: f2(distFromE50 * 100) + "%" }); }
      else if (distFromE50 < 0.03) { score += 3; reasons.push("loc_ema50_close:+3"); contributions.push({ component: "location", name: "EMA50 close", points: 3, rawValue: f2(distFromE50 * 100) + "%" }); }
      const inValueArea = direction === "LONG" ? lastClose < e21 && lastClose > e50 && e21 > e50 : lastClose > e21 && lastClose < e50 && e21 < e50;
      if (inValueArea) { score += 5; reasons.push("loc_value_area:+5"); contributions.push({ component: "location", name: "Value area", points: 5 }); }
    }
  }
  const closes4h = candles4h.map(c => c.close); const ema21_4h = ema(closes4h, EMA_FAST);
  if (ema21_4h.length > 0) {
    const dist4h = Math.abs(lastClose - ema21_4h[ema21_4h.length - 1]) / ema21_4h[ema21_4h.length - 1];
    if (dist4h < 0.02) { score += 5; reasons.push("loc_4h_ema21_near:+5"); contributions.push({ component: "location", name: "4H EMA21 near", points: 5, rawValue: f2(dist4h * 100) + "%" }); }
  }
  const swingLow = lowest(candles1h.map(c => c.low), LOOKBACK_SWING);
  const swingHigh = highest(candles1h.map(c => c.high), LOOKBACK_SWING);
  if (direction === "LONG") {
    const distFromSwingLow = (lastClose - swingLow) / swingLow;
    if (distFromSwingLow < 0.015) { score += 5; reasons.push("loc_swing_low:+5"); contributions.push({ component: "location", name: "Swing low proximity", points: 5, rawValue: f2(distFromSwingLow * 100) + "%" }); }
    else if (distFromSwingLow < 0.03) { score += 3; reasons.push("loc_swing_low_near:+3"); contributions.push({ component: "location", name: "Swing low near", points: 3, rawValue: f2(distFromSwingLow * 100) + "%" }); }
  } else {
    const distFromSwingHigh = (swingHigh - lastClose) / swingHigh;
    if (distFromSwingHigh < 0.015) { score += 5; reasons.push("loc_swing_high:+5"); contributions.push({ component: "location", name: "Swing high proximity", points: 5, rawValue: f2(distFromSwingHigh * 100) + "%" }); }
    else if (distFromSwingHigh < 0.03) { score += 3; reasons.push("loc_swing_high_near:+3"); contributions.push({ component: "location", name: "Swing high near", points: 3, rawValue: f2(distFromSwingHigh * 100) + "%" }); }
  }
  return { score: Math.min(SCORE_MAX.LOCATION, score), reasons, contributions };
}

function scoreStructure(candles1h: Candle[], candles4h: Candle[], direction: "LONG" | "SHORT"): { score: number; reasons: string[]; isBroken: boolean; contributions: ScoreContribution[] } {
  const reasons: string[] = []; const contributions: ScoreContribution[] = []; let score = 0; let isBroken = false;
  const closes = candles1h.map(c => c.close); const highs = candles1h.map(c => c.high); const lows = candles1h.map(c => c.low);
  const lastClose = closes[closes.length - 1]; const recentLows = lows.slice(-LOOKBACK_STRUCTURE); const recentHighs = highs.slice(-LOOKBACK_STRUCTURE);
  const countHigher = (arr: number[]) => arr.filter((v, i) => i > 0 && v > arr[i - 1]).length;
  const countLower = (arr: number[]) => arr.filter((v, i) => i > 0 && v < arr[i - 1]).length;
  if (direction === "LONG") {
    const hl = countHigher(recentLows); if (hl >= 4) { score += 5; reasons.push("struct_higher_lows:+5"); contributions.push({ component: "structure", name: "Higher lows", points: 5, rawValue: hl + "/" + (LOOKBACK_STRUCTURE - 1) }); } else if (hl >= 2) { score += 3; reasons.push("struct_higher_lows_weak:+3"); contributions.push({ component: "structure", name: "Higher lows (weak)", points: 3, rawValue: hl + "/" + (LOOKBACK_STRUCTURE - 1) }); }
    const hh = countHigher(recentHighs); if (hh >= 4) { score += 5; reasons.push("struct_higher_highs:+5"); contributions.push({ component: "structure", name: "Higher highs", points: 5, rawValue: hh + "/" + (LOOKBACK_STRUCTURE - 1) }); } else if (hh >= 2) { score += 3; reasons.push("struct_higher_highs_weak:+3"); contributions.push({ component: "structure", name: "Higher highs (weak)", points: 3, rawValue: hh + "/" + (LOOKBACK_STRUCTURE - 1) }); }
    const prevSwingLow = lowest(lows.slice(-LOOKBACK_SWING, -1), LOOKBACK_STRUCTURE);
    if (lastClose > prevSwingLow) { score += 5; reasons.push("struct_no_lower_low:+5"); contributions.push({ component: "structure", name: "No lower low", points: 5 }); } else { score -= 10; reasons.push("struct_lower_low:-10"); contributions.push({ component: "structure", name: "Lower low (broken)", points: -10 }); isBroken = true; }
    const lastCandle = candles1h[candles1h.length - 1]; const bodyPct = (lastCandle.close - lastCandle.open) / (lastCandle.high - lastCandle.low || 1);
    if (bodyPct > 0.6) { score += 3; reasons.push("struct_bullish_body:+3"); contributions.push({ component: "structure", name: "Bullish body", points: 3, rawValue: f2(bodyPct) }); } else if (bodyPct < -0.3) { score -= 5; reasons.push("struct_bearish_body:-5"); contributions.push({ component: "structure", name: "Bearish body", points: -5, rawValue: f2(bodyPct) }); }
    const lowerWick = Math.min(lastCandle.close, lastCandle.open) - lastCandle.low; const candleRange = lastCandle.high - lastCandle.low;
    if (candleRange > 0 && lowerWick / candleRange > 0.4) { score += 2; reasons.push("struct_rejection_wick:+2"); contributions.push({ component: "structure", name: "Rejection wick", points: 2, rawValue: f2(lowerWick / candleRange) }); }
  } else {
    const lh = countLower(recentHighs); if (lh >= 4) { score += 5; reasons.push("struct_lower_highs:+5"); contributions.push({ component: "structure", name: "Lower highs", points: 5, rawValue: lh + "/" + (LOOKBACK_STRUCTURE - 1) }); } else if (lh >= 2) { score += 3; reasons.push("struct_lower_highs_weak:+3"); contributions.push({ component: "structure", name: "Lower highs (weak)", points: 3, rawValue: lh + "/" + (LOOKBACK_STRUCTURE - 1) }); }
    const ll = countLower(recentLows); if (ll >= 4) { score += 5; reasons.push("struct_lower_lows:+5"); contributions.push({ component: "structure", name: "Lower lows", points: 5, rawValue: ll + "/" + (LOOKBACK_STRUCTURE - 1) }); } else if (ll >= 2) { score += 3; reasons.push("struct_lower_lows_weak:+3"); contributions.push({ component: "structure", name: "Lower lows (weak)", points: 3, rawValue: ll + "/" + (LOOKBACK_STRUCTURE - 1) }); }
    const prevSwingHigh = highest(highs.slice(-LOOKBACK_SWING, -1), LOOKBACK_STRUCTURE);
    if (lastClose < prevSwingHigh) { score += 5; reasons.push("struct_no_higher_high:+5"); contributions.push({ component: "structure", name: "No higher high", points: 5 }); } else { score -= 10; reasons.push("struct_higher_high:-10"); contributions.push({ component: "structure", name: "Higher high (broken)", points: -10 }); isBroken = true; }
    const lastCandle = candles1h[candles1h.length - 1]; const bodyPct = (lastCandle.close - lastCandle.open) / (lastCandle.high - lastCandle.low || 1);
    if (bodyPct < -0.6) { score += 3; reasons.push("struct_bearish_body:+3"); contributions.push({ component: "structure", name: "Bearish body", points: 3, rawValue: f2(bodyPct) }); } else if (bodyPct > 0.3) { score -= 5; reasons.push("struct_bullish_body:-5"); contributions.push({ component: "structure", name: "Bullish body", points: -5, rawValue: f2(bodyPct) }); }
    const upperWick = lastCandle.high - Math.max(lastCandle.close, lastCandle.open); const candleRange = lastCandle.high - lastCandle.low;
    if (candleRange > 0 && upperWick / candleRange > 0.4) { score += 2; reasons.push("struct_rejection_wick:+2"); contributions.push({ component: "structure", name: "Rejection wick", points: 2, rawValue: f2(upperWick / candleRange) }); }
  }
  const closes4h = candles4h.map(c => c.close); const ema21_4h = ema(closes4h, EMA_FAST); const ema50_4h = ema(closes4h, EMA_SLOW);
  if (ema21_4h.length > 1 && ema50_4h.length > 0) {
    const e21_4h = ema21_4h[ema21_4h.length - 1]; const e50_4h = ema50_4h[ema50_4h.length - 1]; const prevE21_4h = ema21_4h[ema21_4h.length - 2]; const slope4h = e21_4h - prevE21_4h;
    const trendAligned = direction === "LONG" ? e21_4h > e50_4h && slope4h > 0 : e21_4h < e50_4h && slope4h < 0;
    const trendAgainst = direction === "LONG" ? e21_4h < e50_4h : e21_4h > e50_4h;
    if (trendAligned) { score += 5; reasons.push("struct_4h_trend_intact:+5"); contributions.push({ component: "structure", name: "4H trend intact", points: 5 }); } else if (trendAgainst) { score -= 5; reasons.push("struct_4h_trend_weak:-5"); contributions.push({ component: "structure", name: "4H trend weak", points: -5 }); }
  }
  return { score: Math.min(SCORE_MAX.STRUCTURE, Math.max(-SCORE_MAX.STRUCTURE, score)), reasons, isBroken, contributions };
}

function scoreMomentum(candles1h: Candle[], candles4h: Candle[], direction: "LONG" | "SHORT", config: PairConfig, indicators: ComputedIndicators): { score: number; reasons: string[]; crossDetected: boolean; contributions: ScoreContribution[] } {
  const reasons: string[] = []; const contributions: ScoreContribution[] = []; let score = 0;
  const closes = candles1h.map(c => c.close); const volumes = candles1h.map(c => c.volume);
  const crossUp = indicators.stochPrev1h.k <= indicators.stochPrev1h.d && indicators.stoch1h.k > indicators.stoch1h.d;
  const crossDown = indicators.stochPrev1h.k >= indicators.stochPrev1h.d && indicators.stoch1h.k < indicators.stoch1h.d;
  const crossDetected = direction === "LONG" ? crossUp : crossDown;
  if (direction === "LONG") {
    if (crossUp) { score += 10; reasons.push("mom_stoch_cross_up:+10"); contributions.push({ component: "momentum", name: "StochRSI cross up", points: 10, rawValue: "K=" + f1(indicators.stoch1h.k) + " D=" + f1(indicators.stoch1h.d) }); }
    else if (indicators.stoch1h.k > indicators.stoch1h.d && indicators.stoch1h.k < 80) { score += 5; reasons.push("mom_stoch_bullish:+5"); contributions.push({ component: "momentum", name: "StochRSI bullish", points: 5, rawValue: "K=" + f1(indicators.stoch1h.k) + " D=" + f1(indicators.stoch1h.d) }); }
    else if (indicators.stoch1h.k > 80) { score += 2; reasons.push("mom_stoch_extended:+2"); contributions.push({ component: "momentum", name: "StochRSI extended", points: 2, rawValue: "K=" + f1(indicators.stoch1h.k) }); }
    else { score += 1; reasons.push("mom_stoch_neutral:+1"); contributions.push({ component: "momentum", name: "StochRSI neutral", points: 1, rawValue: "K=" + f1(indicators.stoch1h.k) + " D=" + f1(indicators.stoch1h.d) }); }
  } else {
    if (crossDown) { score += 10; reasons.push("mom_stoch_cross_down:+10"); contributions.push({ component: "momentum", name: "StochRSI cross down", points: 10, rawValue: "K=" + f1(indicators.stoch1h.k) + " D=" + f1(indicators.stoch1h.d) }); }
    else if (indicators.stoch1h.k < indicators.stoch1h.d && indicators.stoch1h.k > 20) { score += 5; reasons.push("mom_stoch_bearish:+5"); contributions.push({ component: "momentum", name: "StochRSI bearish", points: 5, rawValue: "K=" + f1(indicators.stoch1h.k) + " D=" + f1(indicators.stoch1h.d) }); }
    else if (indicators.stoch1h.k < 20) { score += 2; reasons.push("mom_stoch_extended:+2"); contributions.push({ component: "momentum", name: "StochRSI extended", points: 2, rawValue: "K=" + f1(indicators.stoch1h.k) }); }
    else { score += 1; reasons.push("mom_stoch_neutral:+1"); contributions.push({ component: "momentum", name: "StochRSI neutral", points: 1, rawValue: "K=" + f1(indicators.stoch1h.k) + " D=" + f1(indicators.stoch1h.d) }); }
  }
  const roc = ((closes[closes.length - 1] - closes[closes.length - ROC_LOOKBACK]) / closes[closes.length - ROC_LOOKBACK]) * 100;
  const rocAligned = direction === "LONG" ? roc > 0 : roc < 0;
  if (rocAligned) { const rocPoints = Math.min(8, Math.abs(roc) * 2); score += rocPoints; reasons.push("mom_roc:+" + f0(rocPoints)); contributions.push({ component: "momentum", name: "ROC aligned", points: rocPoints, rawValue: f1(roc) + "%" }); }
  else if (Math.abs(roc) > 3) { score -= 3; reasons.push("mom_roc_against:-3"); contributions.push({ component: "momentum", name: "ROC against", points: -3, rawValue: f1(roc) + "%" }); }
  const recentVol = avg(volumes.slice(-3)); const avgVol = avg(volumes.slice(-LOOKBACK_VOLUME)); const volRatio = recentVol / avgVol;
  if (volRatio > config.volumeMultiplier) { score += 5; reasons.push("mom_volume_spike:+5"); contributions.push({ component: "momentum", name: "Volume spike", points: 5, rawValue: f1(volRatio) + "x" }); }
  else if (volRatio > VOL_MULT_WEAK) { score += 2; reasons.push("mom_volume_above:+2"); contributions.push({ component: "momentum", name: "Volume above avg", points: 2, rawValue: f1(volRatio) + "x" }); }
  const adx1h = adx(candles1h);
  if (adx1h > config.minADX) { score += 5; reasons.push("mom_adx_strong:+5"); contributions.push({ component: "momentum", name: "ADX strong", points: 5, rawValue: f1(adx1h) }); }
  else if (adx1h > config.minADX * ADX_MIN_MODERATE) { score += 2; reasons.push("mom_adx_moderate:+2"); contributions.push({ component: "momentum", name: "ADX moderate", points: 2, rawValue: f1(adx1h) }); }
  if (direction === "LONG" && indicators.stoch4h.k > indicators.stoch4h.d) { score += 3; reasons.push("mom_4h_stoch_aligned:+3"); contributions.push({ component: "momentum", name: "4H Stoch aligned", points: 3, rawValue: "K=" + f1(indicators.stoch4h.k) + " D=" + f1(indicators.stoch4h.d) }); }
  else if (direction === "SHORT" && indicators.stoch4h.k < indicators.stoch4h.d) { score += 3; reasons.push("mom_4h_stoch_aligned:+3"); contributions.push({ component: "momentum", name: "4H Stoch aligned", points: 3, rawValue: "K=" + f1(indicators.stoch4h.k) + " D=" + f1(indicators.stoch4h.d) }); }
  return { score: Math.min(SCORE_MAX.MOMENTUM, score), reasons, crossDetected, contributions };
}

function scoreRisk(candles1h: Candle[], direction: "LONG" | "SHORT", config: PairConfig, entryPrice: number): { score: number; reasons: string[]; stopDistance: number; targetDistance: number; rr: number; atrPct: number; contributions: ScoreContribution[] } {
  const reasons: string[] = []; const contributions: ScoreContribution[] = []; let score = 0;
  const closes = candles1h.map(c => c.close); const lastClose = closes[closes.length - 1];
  const atr = avg(candles1h.slice(-LOOKBACK_ATR).map(c => c.high - c.low)); const atrPct = atr / lastClose;
  if (atrPct < ATR_LOW_PCT) { score += 8; reasons.push("risk_atr_low:+8"); contributions.push({ component: "risk", name: "ATR low", points: 8, rawValue: f2(atrPct * 100) + "%" }); }
  else if (atrPct < ATR_NORMAL_PCT) { score += 5; reasons.push("risk_atr_normal:+5"); contributions.push({ component: "risk", name: "ATR normal", points: 5, rawValue: f2(atrPct * 100) + "%" }); }
  else if (atrPct < ATR_ELEVATED_PCT) { score += 2; reasons.push("risk_atr_elevated:+2"); contributions.push({ component: "risk", name: "ATR elevated", points: 2, rawValue: f2(atrPct * 100) + "%" }); }
  else { score -= 5; reasons.push("risk_atr_high:-5"); contributions.push({ component: "risk", name: "ATR high", points: -5, rawValue: f2(atrPct * 100) + "%" }); }
  const stopDistance = Math.max(atr * 2, entryPrice * config.stopLossPct); const targetDistance = stopDistance * MIN_RR; const rr = targetDistance / stopDistance;
  if (rr >= RR_EXCELLENT) { score += 7; reasons.push("risk_rr_excellent:+7"); contributions.push({ component: "risk", name: "RR excellent", points: 7, rawValue: f2(rr) }); }
  else if (rr >= RR_GOOD) { score += 5; reasons.push("risk_rr_good:+5"); contributions.push({ component: "risk", name: "RR good", points: 5, rawValue: f2(rr) }); }
  else if (rr >= MIN_RR) { score += 3; reasons.push("risk_rr_acceptable:+3"); contributions.push({ component: "risk", name: "RR acceptable", points: 3, rawValue: f2(rr) }); }
  else { score -= 10; reasons.push("risk_rr_poor:-10"); contributions.push({ component: "risk", name: "RR poor", points: -10, rawValue: f2(rr) }); }
  const recentRange = avg(candles1h.slice(-3).map(c => (c.high - c.low) / c.close)); const historicalRange = avg(candles1h.slice(-20, -3).map(c => (c.high - c.low) / c.close)); const volRatio = recentRange / historicalRange;
  if (volRatio < 1.5) { score += 3; reasons.push("risk_vol_stable:+3"); contributions.push({ component: "risk", name: "Volatility stable", points: 3 }); }
  else if (volRatio > 2.5) { score -= 5; reasons.push("risk_vol_spike:-5"); contributions.push({ component: "risk", name: "Volatility spike", points: -5, rawValue: f2(volRatio) + "x" }); }
  if (direction === "LONG") { const recentLow = lowest(candles1h.map(c => c.low), 10); if ((entryPrice - stopDistance) > recentLow * 0.995) { score += 2; reasons.push("risk_stop_logical:+2"); contributions.push({ component: "risk", name: "Stop logical", points: 2 }); } }
  else { const recentHigh = highest(candles1h.map(c => c.high), 10); if ((entryPrice + stopDistance) < recentHigh * 1.005) { score += 2; reasons.push("risk_stop_logical:+2"); contributions.push({ component: "risk", name: "Stop logical", points: 2 }); } }
  return { score: Math.min(SCORE_MAX.RISK, Math.max(-SCORE_MAX.RISK, score)), reasons, stopDistance, targetDistance, rr, atrPct, contributions };
}

function checkExhaustion(stoch4h: { k: number; d: number }, direction: "LONG" | "SHORT"): { isExhausted: boolean; reason: string } {
  if (direction === "LONG") {
    if (stoch4h.k > EXHAUSTION_OVERBOUGHT) return { isExhausted: true, reason: "BLOCK: 4H extreme overbought K" + f1(stoch4h.k) };
    if (stoch4h.k > EXHAUSTION_OVERBOUGHT_WEAK && stoch4h.k < stoch4h.d) return { isExhausted: true, reason: "BLOCK: 4H overbought reversal K" + f1(stoch4h.k) + "<D" + f1(stoch4h.d) };
  } else {
    if (stoch4h.k < EXHAUSTION_OVERSOLD) return { isExhausted: true, reason: "BLOCK: 4H extreme oversold K" + f1(stoch4h.k) };
    if (stoch4h.k < EXHAUSTION_OVERSOLD_WEAK && stoch4h.k > stoch4h.d) return { isExhausted: true, reason: "BLOCK: 4H oversold reversal K" + f1(stoch4h.k) + ">D" + f1(stoch4h.d) };
  }
  return { isExhausted: false, reason: "" };
}

function getExhaustionWarning(stoch1h: { k: number; d: number }, stochPrev1h: { k: number; d: number }, direction: "LONG" | "SHORT"): string {
  const crossDown = stochPrev1h.k >= stochPrev1h.d && stoch1h.k < stoch1h.d;
  const crossUp = stochPrev1h.k <= stochPrev1h.d && stoch1h.k > stoch1h.d;
  if (direction === "LONG" && crossDown && stoch1h.k > 80) return "⚠️ LONG exhaustion risk — StochRSI rolling over from overbought";
  if (direction === "SHORT" && crossUp && stoch1h.k < 20) return "⚠️ SHORT exhaustion risk — StochRSI rolling over from oversold";
  return "";
}

function analyzeMissing(location: { score: number; contributions: ScoreContribution[] }, structure: { score: number; contributions: ScoreContribution[] }, momentum: { score: number; contributions: ScoreContribution[] }, risk: { score: number; contributions: ScoreContribution[] }, direction: "LONG" | "SHORT", crossDetected: boolean): { missing: MissingComponent[]; likelyTriggers: string[] } {
  const missing: MissingComponent[] = []; const likelyTriggers: string[] = [];
  const locationGap = SCORE_MAX.LOCATION - location.score;
  if (locationGap > 5) missing.push({ component: "Location", pointsNeeded: locationGap, description: "Price not near optimal entry zone (EMAs/swing levels)" });
  const structureGap = SCORE_MAX.STRUCTURE - structure.score;
  if (structureGap > 3) {
    const hasBroken = structure.contributions.some(c => c.name.includes("broken"));
    missing.push({ component: "Structure", pointsNeeded: structureGap, description: hasBroken ? "Market structure broken — need higher lows/highs to form" : "Structure developing — waiting for confirmation" });
  }
  const momentumGap = SCORE_MAX.MOMENTUM - momentum.score;
  if (momentumGap > 5) {
    if (!crossDetected) { missing.push({ component: "Momentum", pointsNeeded: momentumGap, description: "StochRSI cross pending — waiting for momentum turn" }); likelyTriggers.push(direction === "LONG" ? "Bullish StochRSI cross (K crossing above D)" : "Bearish StochRSI cross (K crossing below D)"); }
    else {
      const hasVolume = momentum.contributions.some(c => c.name.includes("Volume"));
      if (!hasVolume) { missing.push({ component: "Momentum", pointsNeeded: momentumGap, description: "Volume confirmation missing" }); likelyTriggers.push("Volume expansion >" + f1(VOL_MULT_THRESHOLD) + "x average"); }
      const hasAdx = momentum.contributions.some(c => c.name.includes("ADX"));
      if (!hasAdx) { missing.push({ component: "Momentum", pointsNeeded: Math.min(momentumGap, 5), description: "ADX below threshold — trend strength weak" }); likelyTriggers.push("ADX strengthening above " + f0(15)); }
    }
  }
  const riskGap = SCORE_MAX.RISK - risk.score;
  if (riskGap > 3) {
    const atrHigh = risk.contributions.some(c => c.name === "ATR high");
    if (atrHigh) { missing.push({ component: "Risk", pointsNeeded: riskGap, description: "ATR too high — volatility unfavorable" }); likelyTriggers.push("Volatility contraction"); }
    const rrPoor = risk.contributions.some(c => c.name === "RR poor");
    if (rrPoor) missing.push({ component: "Risk", pointsNeeded: riskGap, description: "Risk:Reward below minimum " + MIN_RR });
  }
  return { missing, likelyTriggers };
}

const rejectionLogs: RejectionLog[] = [];

function logRejection(log: RejectionLog): void {
  rejectionLogs.push(log);
  if (rejectionLogs.length > MAX_REJECTION_LOGS) rejectionLogs.shift();
  if (DEBUG) {
    console.log("[REJECTED] " + log.pair + " | cross=" + (log.crossDetected ? log.crossDirection : "none") + " | regime=" + log.regimeDirection + " | conf=" + log.confidenceScore + " | reason=" + log.rejectionReason);
    if (log.evaluation) {
      console.log("  Location: " + f0(log.evaluation.breakdown.location) + "/" + SCORE_MAX.LOCATION);
      console.log("  Structure: " + f0(log.evaluation.breakdown.structure) + "/" + SCORE_MAX.STRUCTURE);
      console.log("  Momentum: " + f0(log.evaluation.breakdown.momentum) + "/" + SCORE_MAX.MOMENTUM);
      console.log("  Risk: " + f0(log.evaluation.breakdown.risk) + "/" + SCORE_MAX.RISK);
      console.log("  Total: " + f0(log.evaluation.confidence) + "/100");
      if (log.evaluation.missing.length > 0) console.log("  Missing: " + log.evaluation.missing.map(m => m.component + " (+" + m.pointsNeeded + ")").join(", "));
    }
  }
}

export function getRejectionLogs(pair?: string, since?: number): RejectionLog[] {
  let logs = rejectionLogs;
  if (pair) logs = logs.filter(l => l.pair === pair);
  if (since) logs = logs.filter(l => l.timestamp >= since);
  return logs;
}

export function clearRejectionLogs(): void { rejectionLogs.length = 0; }

function evaluateEntry(candles1h: Candle[], candles4h: Candle[], candles15m: Candle[], config: PairConfig, pair: string, regimeDirection: "LONG" | "SHORT", indicators: ComputedIndicators): { evaluation: EntryEvaluation | null; candidates: EntryCandidates; debug: string[] } {
  const debug: string[] = [];
  const closes = candles1h.map(c => c.close); const highs = candles1h.map(c => c.high); const lows = candles1h.map(c => c.low);
  const lastClose = closes[closes.length - 1]; const prevClose = closes[closes.length - 2];
  const recentHigh = highest(highs, LOOKBACK_SWING); const recentLow = lowest(lows, LOOKBACK_SWING);
  let entryMode: "PULLBACK" | "REJECTION" | "BREAKOUT" = "PULLBACK";
  let direction: "LONG" | "SHORT" | null = null;
  if (lastClose > recentHigh && prevClose <= recentHigh) { direction = "LONG"; entryMode = "BREAKOUT"; }
  else if (lastClose < recentLow && prevClose >= recentLow) { direction = "SHORT"; entryMode = "BREAKOUT"; }
  if (!direction) {
    if (lastClose > recentLow * 1.005 && lows[lows.length - 2] <= recentLow * 1.002) { direction = "LONG"; entryMode = "REJECTION"; }
    else if (lastClose < recentHigh * 0.995 && highs[highs.length - 2] >= recentHigh * 0.998) { direction = "SHORT"; entryMode = "REJECTION"; }
  }
  if (!direction) {
    const crossUp = indicators.stochPrev1h.k <= indicators.stochPrev1h.d && indicators.stoch1h.k > indicators.stoch1h.d;
    const crossDown = indicators.stochPrev1h.k >= indicators.stochPrev1h.d && indicators.stoch1h.k < indicators.stoch1h.d;
    if (crossUp) direction = "LONG";
    else if (crossDown) direction = "SHORT";
  }
  if (!direction || direction !== regimeDirection) {
    const candidates: EntryCandidates = {
      pullback: { eligible: false, confidence: 0, rejectionReason: "no_cross_or_regime_mismatch" },
      rejection: { eligible: false, confidence: 0, rejectionReason: "no_rejection_pattern_or_regime_mismatch" },
      breakout: { eligible: false, confidence: 0, rejectionReason: "no_breakout_or_regime_mismatch" },
    };
    if (DEBUG) debug.push("No direction detected or regime mismatch");
    return { evaluation: null, candidates, debug };
  }
  const location = scoreLocation(candles1h, candles4h, direction, config);
  const structure = scoreStructure(candles1h, candles4h, direction);
  let entryPrice = lastClose;
  if (direction === "LONG") entryPrice = Math.min(lastClose, candles1h[candles1h.length - 1].low * 1.002);
  else entryPrice = Math.max(lastClose, candles1h[candles1h.length - 1].high * 0.998);
  const risk = scoreRisk(candles1h, direction, config, entryPrice);
  const momentum = scoreMomentum(candles1h, candles4h, direction, config, indicators);
  const exhaustion = checkExhaustion(indicators.stoch4h, direction);
  let total = location.score + structure.score + momentum.score + risk.score;
  let reasons = [...location.reasons, ...structure.reasons, ...momentum.reasons, ...risk.reasons];
  const allContributions = [...location.contributions, ...structure.contributions, ...momentum.contributions, ...risk.contributions];
  let exhaustionBlocked = false;
  if (exhaustion.isExhausted) { total -= 50; reasons.push(exhaustion.reason); exhaustionBlocked = true; }
  total = Math.min(100, Math.max(0, total));
  const tier = classifyTier(total);
  const { gap, next } = tierGap(tier, total);
  const { missing, likelyTriggers } = analyzeMissing(location, structure, momentum, risk, direction, momentum.crossDetected);
  const exhaustionWarning = getExhaustionWarning(indicators.stoch1h, indicators.stochPrev1h, direction);
  const breakdown: ScoreBreakdown = {
    location: location.score, locationMax: SCORE_MAX.LOCATION, structure: structure.score, structureMax: SCORE_MAX.STRUCTURE,
    momentum: momentum.score, momentumMax: SCORE_MAX.MOMENTUM, risk: risk.score, riskMax: SCORE_MAX.RISK, total, maxTotal: 100, contributions: allContributions,
  };
  const evaluation: EntryEvaluation = {
    pair, direction, entryMode, tier, confidence: total,
    thresholds: { wait: TIER.WAIT, watch: TIER.WATCH, early: TIER.EARLY, confirmed: TIER.CONFIRMED },
    gapToNextTier: gap, nextTier: next, breakdown, missing, likelyTriggers, reasons,
    stochK: indicators.stoch1h.k, stochD: indicators.stoch1h.d, stochPrevK: indicators.stochPrev1h.k, stochPrevD: indicators.stochPrev1h.d,
    crossDetected: momentum.crossDetected, exhaustionWarning, exhaustionBlocked, entryPrice,
    stopDistance: risk.stopDistance, targetDistance: risk.targetDistance, rr: risk.rr, atrPct: risk.atrPct, adx4h: indicators.adx4h,
    regimeDirection, regimeStrength: "", alertLevel: alertLevel(tier, false),
  };
  const candidates: EntryCandidates = {
    pullback: { eligible: entryMode === "PULLBACK" && total >= TIER.EARLY, confidence: entryMode === "PULLBACK" ? total : 0, rejectionReason: entryMode === "PULLBACK" && total < TIER.EARLY ? "confidence_too_low:" + f0(total) : null },
    rejection: { eligible: entryMode === "REJECTION" && total >= TIER.EARLY, confidence: entryMode === "REJECTION" ? total : 0, rejectionReason: entryMode === "REJECTION" && total < TIER.EARLY ? "confidence_too_low:" + f0(total) : null },
    breakout: { eligible: entryMode === "BREAKOUT" && total >= TIER.EARLY, confidence: entryMode === "BREAKOUT" ? total : 0, rejectionReason: entryMode === "BREAKOUT" && total < TIER.EARLY ? "confidence_too_low:" + f0(total) : null },
  };
  if (DEBUG) {
    debug.push("=== v29.3 ENTRY EVALUATION ===");
    debug.push("Direction: " + direction + " | Mode: " + entryMode);
    debug.push("Location: " + f0(location.score) + "/" + SCORE_MAX.LOCATION);
    for (const c of location.contributions) debug.push("  " + c.name + ": " + (c.points >= 0 ? "+" : "") + c.points + (c.rawValue ? " (" + c.rawValue + ")" : ""));
    debug.push("Structure: " + f0(structure.score) + "/" + SCORE_MAX.STRUCTURE);
    for (const c of structure.contributions) debug.push("  " + c.name + ": " + (c.points >= 0 ? "+" : "") + c.points + (c.rawValue ? " (" + c.rawValue + ")" : ""));
    debug.push("Momentum: " + f0(momentum.score) + "/" + SCORE_MAX.MOMENTUM);
    for (const c of momentum.contributions) debug.push("  " + c.name + ": " + (c.points >= 0 ? "+" : "") + c.points + (c.rawValue ? " (" + c.rawValue + ")" : ""));
    debug.push("Risk: " + f0(risk.score) + "/" + SCORE_MAX.RISK);
    for (const c of risk.contributions) debug.push("  " + c.name + ": " + (c.points >= 0 ? "+" : "") + c.points + (c.rawValue ? " (" + c.rawValue + ")" : ""));
    debug.push("Total: " + f0(total) + "/100 | Tier: " + tier);
    if (exhaustion.isExhausted) debug.push("EXHAUSTION PENALTY: -50");
    debug.push("Stoch K=" + f1(indicators.stoch1h.k) + " D=" + f1(indicators.stoch1h.d) + " cross=" + (momentum.crossDetected ? "YES" : "NO"));
    debug.push("RR=" + f2(risk.rr) + " ATR%=" + f2(risk.atrPct * 100) + "%");
    if (missing.length > 0) { debug.push("Missing:"); for (const m of missing) debug.push("  " + m.component + ": need +" + m.pointsNeeded + " — " + m.description); }
    if (likelyTriggers.length > 0) debug.push("Likely triggers: " + likelyTriggers.join(", "));
  }
  return { evaluation, candidates, debug };
}

function buildMarketData(pair: string, price: number, timestamp: number, regime: MarketRegime, indicators: ComputedIndicators): MarketData {
  return { pair, price, timestamp, regime, adx: indicators.adx4h, rsi: indicators.rsi4h, stochK: indicators.stoch4h.k, stochD: indicators.stoch4h.d, stoch1hK: indicators.stoch1h.k, stoch1hD: indicators.stoch1h.d };
}

function buildRejectionLog(pair: string, now: number, crossDetected: boolean, crossDirection: "LONG" | "SHORT" | null, regimeDirection: "LONG" | "SHORT" | "NEUTRAL" | null, regimeStrength: string, confidenceScore: number, confidenceBreakdown: Record<string, number>, rejectionReason: string, stochK: number, stochD: number, stochPrevK: number, stochPrevD: number, evaluation?: EntryEvaluation): RejectionLog {
  return { pair, timestamp: now, crossDetected, crossDirection, regimeDirection, regimeStrength, confidenceScore, confidenceBreakdown, rejectionReason, stochK, stochD, stochPrevK, stochPrevD, evaluation };
}

function getTrendContext(candles: Candle[]): TrendContext {
  if (candles.length < 50) return { direction: "NEUTRAL", strength: "INSUFFICIENT_DATA" };
  const closes = candles.map(c => c.close).filter(isFinite);
  const ema21v = ema(closes, EMA_FAST);
  const ema50v = ema(closes, EMA_SLOW);
  if (ema21v.length < 2 || ema50v.length < 2) return { direction: "NEUTRAL", strength: "INSUFFICIENT_DATA" };
  const e21 = ema21v[ema21v.length - 1];
  const e50 = ema50v[ema50v.length - 1];
  const slope21 = e21 - ema21v[ema21v.length - 2];
  if (!isFinite(e21) || !isFinite(e50)) return { direction: "NEUTRAL", strength: "INSUFFICIENT_DATA" };
  if (e21 > e50 && slope21 > 0) return { direction: "BULLISH", strength: Math.abs(slope21 / e21 * 100) > 0.1 ? "STRONG" : "MODERATE" };
  if (e21 < e50 && slope21 < 0) return { direction: "BEARISH", strength: Math.abs(slope21 / e21 * 100) > 0.1 ? "STRONG" : "MODERATE" };
  if (e21 > e50) return { direction: "BULLISH", strength: "WEAK" };
  return { direction: "BEARISH", strength: "WEAK" };
}

function detectTrendConflict(trend1h: TrendContext, trend4h: TrendContext, trend1d: TrendContext): { isConflict: boolean; details: string[] } {
  const htf1 = trend1h.direction.toUpperCase();
  const htf2 = trend4h.direction.toUpperCase();
  const ltf = trend1d.direction.toUpperCase();
  const details: string[] = [];
  if (htf1 === "NEUTRAL" || htf2 === "NEUTRAL" || htf1 === "INSUFFICIENT_DATA" || htf2 === "INSUFFICIENT_DATA") return { isConflict: false, details };
  if (htf1 !== htf2) return { isConflict: false, details };
  if (ltf === "NEUTRAL" || ltf === "INSUFFICIENT_DATA") return { isConflict: false, details };
  if (ltf === htf1) return { isConflict: false, details };
  details.push("1H " + trend1h.direction + " (" + trend1h.strength + ")");
  details.push("4H " + trend4h.direction + " (" + trend4h.strength + ")");
  details.push("1D " + trend1d.direction + " (" + trend1d.strength + ")");
  details.push("Higher timeframe disagreement — no trades until resolved.");
  return { isConflict: true, details };
}

export const CURRENT_SIGNAL_VERSION = 30;

export async function generateSignal(pair: string, candles1h: Candle[], candles4h: Candle[], candles15m: Candle[], currentPrice: number): Promise<SignalResult> {
  const debug: string[] = [];
  if (DEBUG) {
    debug.push("=== generateSignal v29.3 " + pair + " ===");
    debug.push("candles: 1h=" + candles1h.length + " 4h=" + candles4h.length + " 15m=" + candles15m.length);
    debug.push("price=" + f2(currentPrice));
  }
  const config = getPairConfig(pair);
  const candles1d = aggregateTo1D(candles4h);
  const regime = await getRegime(pair, candles1d, candles4h);
  if (DEBUG) {
    debug.push("regime: direction=" + regime.direction + " strength=" + regime.strength + " score=" + regime.score + " conf=" + regime.confidence);
    debug.push("regime reasons: " + regime.reason.join(", "));
  }
  const trend1h = getTrendContext(candles1h);
  const trend4h = getTrendContext(candles4h);
  const trend1d = getTrendContext(candles1d);
  if (DEBUG) debug.push("trend context: 1h=" + trend1h.direction + "/" + trend1h.strength + " 4h=" + trend4h.direction + "/" + trend4h.strength + " 1d=" + trend1d.direction + "/" + trend1d.strength);
  const trendConflict = detectTrendConflict(trend1h, trend4h, trend1d);
  if (trendConflict.isConflict) {
    const indicators = computeIndicators(candles1h, candles4h);
    if (DEBUG) { debug.push("TREND CONFLICT DETECTED:"); for (const d of trendConflict.details) debug.push("  " + d); }
    return {
      market: buildMarketData(pair, currentPrice, Date.now(), regime, indicators),
      debug, entryCandidates: { pullback: { eligible: false, confidence: 0, rejectionReason: "trend_conflict" }, rejection: { eligible: false, confidence: 0, rejectionReason: "trend_conflict" }, breakout: { eligible: false, confidence: 0, rejectionReason: "trend_conflict" } },
      rejectionStage: "Trend Conflict\n" + trendConflict.details.join("\n"),
    };
  }
  if (!regime.direction || regime.direction === "NEUTRAL" || regime.strength === "NEUTRAL") {
    const indicators = computeIndicators(candles1h, candles4h);
    logRejection(buildRejectionLog(pair, Date.now(), false, null, regime.direction, regime.strength, 0, {}, "Regime is NEUTRAL — no directional bias", indicators.stoch4h.k, indicators.stoch4h.d, 0, 0));
    if (DEBUG) debug.push("REJECTED: regime is neutral");
    return {
      market: buildMarketData(pair, currentPrice, Date.now(), regime, indicators),
      debug, entryCandidates: { pullback: { eligible: false, confidence: 0, rejectionReason: "regime_neutral" }, rejection: { eligible: false, confidence: 0, rejectionReason: "regime_neutral" }, breakout: { eligible: false, confidence: 0, rejectionReason: "regime_neutral" } },
      rejectionStage: "No directional bias",
    };
  }
  const now = Date.now();
  const cooldown = isInCooldown(pair, now, regime.direction);
  if (cooldown.inCooldown) {
    const indicators = computeIndicators(candles1h, candles4h);
    if (DEBUG) debug.push("REJECTED: cooldown active, remaining " + f1(cooldown.remainingMs / 60000) + "min");
    return {
      market: buildMarketData(pair, currentPrice, now, regime, indicators),
      debug, entryCandidates: { pullback: { eligible: false, confidence: 0, rejectionReason: "cooldown_active" }, rejection: { eligible: false, confidence: 0, rejectionReason: "cooldown_active" }, breakout: { eligible: false, confidence: 0, rejectionReason: "cooldown_active" } },
      rejectionStage: "Position cooldown (" + f0(cooldown.remainingMs / 60000) + "min remaining)",
    };
  }
  const indicators = computeIndicators(candles1h, candles4h);
  const { evaluation, candidates, debug: entryDebug } = evaluateEntry(candles1h, candles4h, candles15m, config, pair, regime.direction, indicators);
  if (DEBUG) debug.push(...entryDebug);
  if (!evaluation) {
    logRejection(buildRejectionLog(pair, now, false, null, regime.direction, regime.strength, 0, {}, "No entry candidate met threshold. Best: pullback=" + f0(candidates.pullback.confidence) + " rejection=" + f0(candidates.rejection.confidence) + " breakout=" + f0(candidates.breakout.confidence), indicators.stoch4h.k, indicators.stoch4h.d, 0, 0));
    if (DEBUG) debug.push("REJECTED: no entry candidate met threshold");
    let rejectionStage = "Waiting for setup confirmation";
    const bestConf = Math.max(candidates.pullback.confidence, candidates.rejection.confidence, candidates.breakout.confidence);
    if (bestConf >= TIER.WATCH) rejectionStage = "Setup developing (" + f0(bestConf) + "%)";
    else rejectionStage = "Waiting for momentum confirmation";
    return { market: buildMarketData(pair, currentPrice, now, regime, indicators), debug, entryCandidates: candidates, rejectionStage };
  }
  evaluation.regimeStrength = regime.strength;
  if (evaluation.exhaustionBlocked && evaluation.confidence < TIER.EARLY) {
    logRejection(buildRejectionLog(pair, now, evaluation.crossDetected, evaluation.direction, regime.direction, regime.strength, evaluation.confidence, { location: evaluation.breakdown.location, structure: evaluation.breakdown.structure, momentum: evaluation.breakdown.momentum, risk: evaluation.breakdown.risk }, evaluation.exhaustionWarning || "Exhaustion block", indicators.stoch4h.k, indicators.stoch4h.d, evaluation.stochPrevK, evaluation.stochPrevD, evaluation));
    if (DEBUG) debug.push("REJECTED: exhaustion block — " + evaluation.exhaustionWarning);
    return { market: buildMarketData(pair, currentPrice, now, regime, indicators), debug, entryCandidates: candidates, rejectionStage: "Market exhausted — " + (evaluation.exhaustionWarning?.replace("⚠️ ", "").replace("⚠ ", "") || "cooling off"), evaluation };
  }
  const stop = evaluation.direction === "LONG" ? evaluation.entryPrice - evaluation.stopDistance : evaluation.entryPrice + evaluation.stopDistance;
  const target = evaluation.direction === "LONG" ? evaluation.entryPrice + evaluation.targetDistance : evaluation.entryPrice - evaluation.targetDistance;
  if (evaluation.rr < MIN_RR) {
    logRejection(buildRejectionLog(pair, now, evaluation.crossDetected, evaluation.direction, regime.direction, regime.strength, evaluation.confidence, { location: evaluation.breakdown.location, structure: evaluation.breakdown.structure, momentum: evaluation.breakdown.momentum, risk: evaluation.breakdown.risk }, "RR " + f2(evaluation.rr) + " below minimum " + MIN_RR, indicators.stoch4h.k, indicators.stoch4h.d, evaluation.stochPrevK, evaluation.stochPrevD, evaluation));
    if (DEBUG) debug.push("REJECTED: RR " + f2(evaluation.rr) + " < " + MIN_RR);
    return { market: buildMarketData(pair, currentPrice, now, regime, indicators), debug, entryCandidates: candidates, rejectionStage: "Risk:Reward too low (" + f2(evaluation.rr) + " < " + MIN_RR + ")", evaluation };
  }
  let finalConfidence = evaluation.confidence;
  if (indicators.adx4h < config.minADX) {
    const adxPenalty = Math.round((config.minADX - indicators.adx4h) * 2);
    finalConfidence -= adxPenalty;
    if (DEBUG) debug.push("ADX " + f1(indicators.adx4h) + " below threshold " + config.minADX + ", penalty -" + adxPenalty);
    if (finalConfidence < TIER.EARLY) {
      logRejection(buildRejectionLog(pair, now, evaluation.crossDetected, evaluation.direction, regime.direction, regime.strength, finalConfidence, { location: evaluation.breakdown.location, structure: evaluation.breakdown.structure, momentum: evaluation.breakdown.momentum, risk: evaluation.breakdown.risk }, "ADX " + f1(indicators.adx4h) + " too low, confidence dropped to " + f0(finalConfidence) + " after penalty", indicators.stoch4h.k, indicators.stoch4h.d, evaluation.stochPrevK, evaluation.stochPrevD, evaluation));
      if (DEBUG) debug.push("REJECTED: ADX penalty dropped confidence below EARLY_ENTRY (" + TIER.EARLY + ")");
      return { market: buildMarketData(pair, currentPrice, now, regime, indicators), debug, entryCandidates: candidates, rejectionStage: "ADX penalty — confidence " + f0(finalConfidence) + " below EARLY_ENTRY (" + TIER.EARLY + ")", evaluation: { ...evaluation, confidence: finalConfidence, tier: classifyTier(finalConfidence) } };
    }
  }
  const entryTier = classifyTier(finalConfidence);
  const positionSizePct = positionSize(entryTier, regime.strength);
  if (entryTier === "NO_TRADE" || entryTier === "WATCH") {
    if (DEBUG) debug.push("REJECTED: confidence " + f1(finalConfidence) + " below EARLY_ENTRY threshold (" + TIER.EARLY + ")");
    const rec = { action: entryTier === "WATCH" ? "WATCH" : "WAIT", detail: "Score " + f0(finalConfidence) + "/100 — need +" + f0(tierGap(entryTier, finalConfidence).gap) + " for " + (tierGap(entryTier, finalConfidence).next?.replace("_", " ") || "entry"), missing: evaluation.missing.map(m => m.component + " (" + m.description + ")"), progressPct: Math.min(100, Math.round((finalConfidence / TIER.CONFIRMED) * 100)) };
    return { market: buildMarketData(pair, currentPrice, now, regime, indicators), debug, entryCandidates: candidates, rejectionStage: rec.detail, evaluation: { ...evaluation, confidence: finalConfidence, tier: entryTier } };
  }
  if (isTierLocked(pair, entryTier, now)) {
    if (DEBUG) debug.push("REJECTED: tier lock active for " + pair + ":" + entryTier);
    return { market: buildMarketData(pair, currentPrice, now, regime, indicators), debug, entryCandidates: candidates, rejectionStage: entryTier + " alert already sent — waiting for next cycle", evaluation };
  }
  setTierLock(pair, entryTier, now);
  const signalId = pair + "-" + evaluation.direction + "-" + now;
  const signal: Signal = {
    id: signalId, pair, direction: evaluation.direction!, type: "ENTRY", entry: evaluation.entryPrice, stop, target,
    confidence: finalConfidence, entryTier, positionSizePct, rr: evaluation.rr, adx: indicators.adx4h, rsi: indicators.rsi4h,
    stochK: indicators.stoch4h.k, stochD: indicators.stoch4h.d, stoch1hK: indicators.stoch1h.k, stoch1hD: indicators.stoch1h.d,
    expectedMove: evaluation.targetDistance, reason: evaluation.reasons.join(" | "), timestamp: now, version: CURRENT_SIGNAL_VERSION,
    tradeState: "OPEN", regimeDirection: regime.direction, regimeSince: regime.detectedAt, entryMode: evaluation.entryMode!,
    confidenceComponents: { location: evaluation.breakdown.location, structure: evaluation.breakdown.structure, momentum: evaluation.breakdown.momentum, risk: evaluation.breakdown.risk, total: finalConfidence },
    exhaustionWarning: evaluation.exhaustionWarning || undefined,
  };
  if (DEBUG) debug.push("SIGNAL: " + evaluation.direction + " " + pair + " @ " + f2(evaluation.entryPrice) + " tier=" + entryTier + " conf=" + f1(finalConfidence) + " size=" + f0(positionSizePct * 100) + "% rr=" + f2(evaluation.rr) + " mode=" + evaluation.entryMode);
  return { signal, market: buildMarketData(pair, currentPrice, now, regime, indicators), debug, entryCandidates: candidates, evaluation };
}

const exitStoreById: Map<string, ExitRecord> = new Map();
const exitStoreByPair: Map<string, ExitRecord> = new Map();
let persistExitFn: ((record: ExitRecord) => Promise<void>) | null = null;
let loadExitsFn: (() => Promise<ExitRecord[]>) | null = null;

export function setExitPersistence(persist: (r: ExitRecord) => Promise<void>, load: () => Promise<ExitRecord[]>): void {
  persistExitFn = persist; loadExitsFn = load;
}

async function recordExit(signalId: string, pair: string, direction: "LONG" | "SHORT", exitReason: string, exitPrice: number, now: number = Date.now()): Promise<void> {
  const r: ExitRecord = { signalId, pair, direction, exitTimestamp: now, exitReason, exitPrice };
  exitStoreById.set(signalId, r); exitStoreByPair.set(pair, r);
  clearTierLocksForPair(pair);
  if (persistExitFn) try { await persistExitFn(r); } catch (e) { if (DEBUG) console.error("[EXIT PERSIST]", e); }
}

export async function loadExits(): Promise<void> {
  if (!loadExitsFn) return;
  try { const exits = await loadExitsFn(); for (const r of exits) { exitStoreById.set(r.signalId, r); exitStoreByPair.set(r.pair, r); } }
  catch (e) { if (DEBUG) console.error("[EXIT LOAD]", e); }
}

export function hasExited(signalId: string): boolean { return exitStoreById.has(signalId); }

function isInCooldown(pair: string, now: number, direction?: "LONG" | "SHORT"): { inCooldown: boolean; remainingMs: number } {
  const lastExit = exitStoreByPair.get(pair);
  if (!lastExit) return { inCooldown: false, remainingMs: 0 };
  if (direction && lastExit.direction !== direction) return { inCooldown: false, remainingMs: 0 };
  const elapsed = now - lastExit.exitTimestamp;
  if (elapsed < EXIT_COOLDOWN_MS) return { inCooldown: true, remainingMs: EXIT_COOLDOWN_MS - elapsed };
  return { inCooldown: false, remainingMs: 0 };
}

export function updateTradeManager(signal: Signal, currentPrice: number): TradeManagerUpdate {
  const highest = Math.max(signal.highestPrice || signal.entry, currentPrice);
  const lowest = Math.min(signal.lowestPrice || signal.entry, currentPrice);
  let state = signal.tradeState || "OPEN";
  let lockedStop = signal.lockedStop || signal.stop;
  let profitLockActive = signal.profitLockActive || false;
  let exitTriggered = false;
  let exitReason: string | undefined;
  const config = getPairConfig(signal.pair);
  const bePct = config.bePct || BE_PCT_DEFAULT;
  const lockPct = config.lockPct || LOCK_PCT_DEFAULT;
  const runnerPct = config.runnerPct || RUNNER_PCT_DEFAULT;
  const profitPct = signal.direction === "LONG" ? (currentPrice - signal.entry) / signal.entry : (signal.entry - currentPrice) / signal.entry;
  if (state === "OPEN" && profitPct >= bePct) { state = "BREAK_EVEN"; lockedStop = signal.entry; }
  if (state === "BREAK_EVEN" && profitPct >= lockPct) { state = "LOCKED"; profitLockActive = true; lockedStop = signal.entry + (signal.direction === "LONG" ? signal.entry * 0.005 : -signal.entry * 0.005); }
  if (state === "LOCKED" && profitPct >= runnerPct) state = "RUNNER";
  if (state === "RUNNER" && signal.direction === "LONG") { const trailStop = highest * (1 - config.stopLossPct * 0.5); if (trailStop > lockedStop) lockedStop = trailStop; }
  else if (state === "RUNNER" && signal.direction === "SHORT") { const trailStop = lowest * (1 + config.stopLossPct * 0.5); if (trailStop < lockedStop || lockedStop === signal.stop) lockedStop = trailStop; }
  if (signal.direction === "LONG" && currentPrice <= lockedStop) { exitTriggered = true; exitReason = state === "RUNNER" ? "trailing_stop" : "stop_loss"; }
  else if (signal.direction === "SHORT" && currentPrice >= lockedStop) { exitTriggered = true; exitReason = state === "RUNNER" ? "trailing_stop" : "stop_loss"; }
  if (!exitTriggered) {
    if (signal.direction === "LONG" && currentPrice >= signal.target) { exitTriggered = true; exitReason = "target_hit"; }
    else if (signal.direction === "SHORT" && currentPrice <= signal.target) { exitTriggered = true; exitReason = "target_hit"; }
  }
  if (exitTriggered) recordExit(signal.id, signal.pair, signal.direction, exitReason!, currentPrice);
  return { signalId: signal.id, newState: exitTriggered ? "EXITED" : state, lockedStop, profitLockActive, highestPrice: highest, lowestPrice: lowest, exitTriggered, exitReason };
}

export function isSignalStillValid(signal: Signal, currentPrice: number, now: number = Date.now()): ValidityCheck {
  if (signal.exited || hasExited(signal.id)) return { valid: false, reason: "already_exited", exited: true };
  if (signal.direction === "LONG" && currentPrice <= (signal.lockedStop || signal.stop)) return { valid: false, reason: "stop_hit", exited: true };
  if (signal.direction === "SHORT" && currentPrice >= (signal.lockedStop || signal.stop)) return { valid: false, reason: "stop_hit", exited: true };
  const drift = Math.abs(currentPrice - signal.entry) / signal.entry;
  if (drift > (getPairConfig(signal.pair).maxEntryDriftPct || 0.01)) return { valid: false, reason: "entry_drift_" + f1(drift * 100) + "%", exited: false };
  if (now - signal.timestamp > SIGNAL_TTL_MS) return { valid: false, reason: "time_decay", exited: false };
  return { valid: true, reason: "", exited: false };
}

export function isSignalStillValidBool(signal: Signal, currentPrice: number): boolean {
  return isSignalStillValid(signal, currentPrice).valid;
}

export async function shouldHold(signal: Signal, candles4h: Candle[], currentPrice: number): Promise<HoldResult> {
  if (signal.exited || hasExited(signal.id)) return { shouldHold: false, reason: "already_exited" };
  const tmUpdate = updateTradeManager(signal, currentPrice);
  if (tmUpdate.exitTriggered) return { shouldHold: false, reason: tmUpdate.exitReason || "exit_triggered", managedStop: tmUpdate.lockedStop };
  const candles1d = aggregateTo1D(candles4h);
  const regime = await getRegime(signal.pair, candles1d, candles4h);
  if (regime.direction && regime.direction !== "NEUTRAL" && regime.direction !== signal.direction) {
    if (regime.strength === "STRONG" && regime.confidence > 70) return { shouldHold: false, reason: "regime_reversal_" + regime.direction + "_strong", managedStop: tmUpdate.lockedStop };
  }
  return { shouldHold: true, reason: "hold", managedStop: tmUpdate.lockedStop };
}

export async function filterExpiredSignals(signals: Signal[], currentPrices: Record<string, number>): Promise<{ active: Signal[]; exited: { signal: Signal; reason: string }[] }> {
  const active: Signal[] = [];
  const exited: { signal: Signal; reason: string }[] = [];
  for (const signal of signals) {
    if (signal.exited || hasExited(signal.id)) continue;
    const price = currentPrices[signal.pair];
    if (!price) { active.push(signal); continue; }
    const check = isSignalStillValid(signal, price);
    if (!check.valid && check.exited) { exited.push({ signal, reason: check.reason }); await recordExit(signal.id, signal.pair, signal.direction, check.reason, price); }
    else if (!check.valid) { exited.push({ signal, reason: check.reason }); }
    else { active.push(signal); }
  }
  return { active, exited };
}

export async function getMarketSnapshot(pair: string, candles1h: Candle[], candles4h: Candle[], candles15m: Candle[], currentPrice: number, precomputedSignalResult?: SignalResult): Promise<MarketSnapshot> {
  const candles1d = aggregateTo1D(candles4h);
  const indicators = computeIndicators(candles1h, candles4h);
  const regime = await getRegime(pair, candles1d, candles4h);
  const trend1h = getTrendContext(candles1h);
  const trend4h = getTrendContext(candles4h);
  const trend1d = getTrendContext(candles1d);
  const signalResult = precomputedSignalResult || (DEBUG ? await generateSignal(pair, candles1h, candles4h, candles15m, currentPrice) : { entryCandidates: { pullback: { eligible: false, confidence: 0, rejectionReason: null }, rejection: { eligible: false, confidence: 0, rejectionReason: null }, breakout: { eligible: false, confidence: 0, rejectionReason: null } }, rejectionStage: null });
  const conflictResult = detectTrendConflict(trend1h, trend4h, trend1d);
  let regimeDisplay: RegimeDisplay = { direction: regime.direction || "NEUTRAL", strength: regime.strength, confidence: safeNum(regime.confidence), score: safeNum(regime.score), reason: regime.reason };
  if (conflictResult.isConflict) regimeDisplay.direction = "TREND_CONFLICT";
  let rec: { action: string; detail: string; missing: string[]; progressPct: number };
  if (signalResult.evaluation) {
    const tier = signalResult.evaluation.tier;
    const conf = signalResult.evaluation.confidence;
    const gap = signalResult.evaluation.gapToNextTier;
    const next = signalResult.evaluation.nextTier;
    const progressPct = Math.min(100, Math.round((conf / TIER.CONFIRMED) * 100));
    if (!signalResult.evaluation.direction || signalResult.evaluation.regimeDirection === "NEUTRAL") rec = { action: "WAIT", detail: "No directional bias", missing: [], progressPct: 0 };
    else if (tier === "NO_TRADE") rec = { action: "WAIT", detail: "Score " + f0(conf) + "/100 — need +" + f0(gap) + " for " + (next?.replace("_", " ") || "entry"), missing: signalResult.evaluation.missing.map(m => m.component + ": need +" + m.pointsNeeded + " (" + m.description + ")"), progressPct };
    else if (tier === "WATCH") rec = { action: "WATCH", detail: "Setup developing at " + f0(conf) + "/100 — need +" + f0(gap) + " for " + (next?.replace("_", " ") || "entry"), missing: signalResult.evaluation.missing.map(m => m.component + ": need +" + m.pointsNeeded + " (" + m.description + ")"), progressPct };
    else if (tier === "EARLY_ENTRY") rec = { action: "EARLY ENTRY", detail: (regime.strength === "STRONG" ? "33%" : regime.strength === "MODERATE" ? "25%" : "20%") + " Position", missing: signalResult.evaluation.missing.map(m => m.component + ": need +" + m.pointsNeeded + " for CONFIRMED"), progressPct };
    else rec = { action: "CONFIRMED ENTRY", detail: (regime.strength === "STRONG" ? "Full" : regime.strength === "MODERATE" ? "75%" : "50%") + " Position", missing: [], progressPct: 100 };
  } else {
    const bestConf = Math.max(signalResult.entryCandidates?.pullback?.confidence || 0, signalResult.entryCandidates?.rejection?.confidence || 0, signalResult.entryCandidates?.breakout?.confidence || 0);
    rec = { action: bestConf >= TIER.EARLY ? "EARLY ENTRY" : "WAIT", detail: "Score " + f0(bestConf) + "/100", missing: [], progressPct: Math.round((bestConf / TIER.CONFIRMED) * 100) };
  }
  const whyNoTrade: string[] = [];
  if (conflictResult.isConflict) { whyNoTrade.push("⚠ Trend Conflict"); for (const detail of conflictResult.details) whyNoTrade.push("  " + detail); }
  else if (signalResult.evaluation) {
    whyNoTrade.push("• " + rec.action + " — " + rec.detail);
    if (signalResult.evaluation.missing.length > 0) for (const m of signalResult.evaluation.missing) whyNoTrade.push("  Missing: " + m.component + " (+" + m.pointsNeeded + ") — " + m.description);
    if (signalResult.evaluation.likelyTriggers.length > 0) whyNoTrade.push("  Likely trigger: " + signalResult.evaluation.likelyTriggers.join(", "));
  } else if (signalResult.rejectionStage) whyNoTrade.push("• " + signalResult.rejectionStage);
  else {
    const bestConf = Math.max(signalResult.entryCandidates?.pullback?.confidence || 0, signalResult.entryCandidates?.rejection?.confidence || 0, signalResult.entryCandidates?.breakout?.confidence || 0);
    if (bestConf < TIER.WATCH) whyNoTrade.push("• Waiting for market setup (" + f0(bestConf) + "%)");
    else whyNoTrade.push("• Setup developing (" + f0(bestConf) + "%)");
  }
  let entryTier: EntryTier | null = null;
  if (signalResult.signal) entryTier = signalResult.signal.entryTier;
  else if (signalResult.evaluation) entryTier = signalResult.evaluation.tier;
  return {
    pair, price: currentPrice, trend: regimeDisplay.direction || "NEUTRAL", regime: regimeDisplay,
    adx: indicators.adx4h, rsi: indicators.rsi4h, stochK: indicators.stoch4h.k, stochD: indicators.stoch4h.d,
    stoch1hK: indicators.stoch1h.k, stoch1hD: indicators.stoch1h.d, trend1h, trend4h, trend1d,
    entryCandidates: signalResult.entryCandidates, rejectionStage: signalResult.rejectionStage || null,
    recommendedAction: conflictResult.isConflict ? "WAIT" : rec.action,
    positionSize: conflictResult.isConflict ? "Waiting for confirmation" : rec.detail,
    whyNoTrade: whyNoTrade.length > 0 ? whyNoTrade : ["• Waiting for market setup"],
    entryTier, trendConflict: conflictResult.isConflict, evaluation: signalResult.evaluation,
  };
}

export function getCurrentRegime(pair: string): MarketRegime | null { return getRegimeSync(pair); }
