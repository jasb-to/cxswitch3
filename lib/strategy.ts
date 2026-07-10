// lib/strategy.ts — v29.1 POLISHED PRODUCTION
// ============================================================
// Strategy logic, regime engine, exit logic, hysteresis, state persistence.
// NO debug logging in production. NO rejection spam.
// All diagnostics gated behind DEBUG mode.
//
// Changes from diagnostic edition:
//   - logRejection() only logs when DEBUG=true
//   - getMarketSnapshot() accepts pre-computed signalResult (no duplicate generateSignal)
//   - Tier locks: pair+tier based (EARLY vs CONFIRMED separate)
//   - Trend Conflict detection in snapshot
//   - Regime Score / Entry Score separation
//   - Two-tier entry routing: EARLY (70-84) / CONFIRMED (85+)
//   - Clean trader-facing messages only
// ============================================================

const DEBUG = process.env.DEBUG === "true";

// ─── ALL TYPES ───

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
  type: "ENTRY" | "EXIT" | "SCALE_IN" | "SCALE_OUT";
  scale?: string;
  entry: number;
  stop: number;
  target: number;
  confidence: number;
  entryTier: EntryTier;
  positionSizePct: number;
  rr: number;
  adx?: number;
  rsi?: number;
  stochK?: number;
  stochD?: number;
  stoch1hK?: number;
  stoch1hD?: number;
  expectedMove?: number;
  reason?: string;
  timestamp: number;
  version: number;
  tradeState?: "OPEN" | "BREAK_EVEN" | "LOCKED" | "RUNNER" | "EXITED";
  exited?: boolean;
  lockedStop?: number | null;
  highestPrice?: number;
  lowestPrice?: number;
  profitLockActive?: boolean;
  regimeDirection?: "LONG" | "SHORT" | "NEUTRAL" | null;
  regimeSince?: number;
  entryMode?: "PULLBACK" | "REJECTION" | "BREAKOUT";
  confidenceComponents?: ConfidenceComponents;
  exhaustionWarning?: string;
}

export interface MarketData {
  pair: string;
  price: number;
  timestamp: number;
  phase?: string;
  trend?: string;
  htfBias?: "BULLISH" | "BEARISH" | "MIXED";
  regime?: MarketRegime;
  adx?: number;
  rsi?: number;
  stochK?: number;
  stochD?: number;
  stoch1hK?: number;
  stoch1hD?: number;
}

export interface SignalResult {
  signal?: Signal;
  market?: MarketData;
  debug?: string[];
  entryCandidates?: EntryCandidates;
  rejectionStage?: string | null;
}

export interface PairConfig {
  minADX: number;
  momentumThreshold: number;
  volumeMultiplier: number;
  stopLossPct: number;
  takeProfitPct: number;
  maxEntryDriftPct: number;
  isHYPE?: boolean;
  deepCrossThresholdLong?: number;
  deepCrossThresholdShort?: number;
  maxRecentVolatility?: number;
  bePct?: number;
  lockPct?: number;
  runnerPct?: number;
}

export interface TradeManagerUpdate {
  signalId: string;
  newState: "OPEN" | "BREAK_EVEN" | "LOCKED" | "RUNNER" | "EXITED";
  lockedStop: number;
  profitLockActive: boolean;
  highestPrice: number;
  lowestPrice: number;
  exitTriggered: boolean;
  exitReason?: string;
}

export interface ValidityCheck {
  valid: boolean;
  reason: string;
  exited: boolean;
}

export interface HoldResult {
  shouldHold: boolean;
  reason: string;
  managedStop?: number;
}

export interface ExitRecord {
  signalId: string;
  pair: string;
  direction: "LONG" | "SHORT";
  exitTimestamp: number;
  exitReason: string;
  exitPrice: number;
}

export interface RejectionLog {
  pair: string;
  timestamp: number;
  crossDetected: boolean;
  crossDirection: "LONG" | "SHORT" | null;
  regimeDirection: "LONG" | "SHORT" | "NEUTRAL" | null;
  regimeStrength: string;
  confidenceScore: number;
  confidenceBreakdown: Record<string, number>;
  rejectionReason: string;
  stochK: number;
  stochD: number;
  stochPrevK: number;
  stochPrevD: number;
}

export interface MarketRegime {
  direction: "LONG" | "SHORT" | "NEUTRAL" | null;
  strength: string;
  confidence: number;
  score: number;
  reason: string[];
  detectedAt: number;
}

export interface ConfidenceComponents {
  regimeAlignment: number;
  setupQuality: number;
  momentum: number;
  structure: number;
  volume: number;
  riskPenalty: number;
  total: number;
}

export interface EntryCandidate {
  eligible: boolean;
  confidence: number;
  rejectionReason: string | null;
}

export interface EntryCandidates {
  pullback: EntryCandidate;
  rejection: EntryCandidate;
  breakout: EntryCandidate;
}

export interface TrendContext {
  direction: string;
  strength: string;
}

export interface MarketSnapshot {
  pair: string;
  price: number;
  trend: string;
  regime: RegimeDisplay;
  adx?: number;
  rsi?: number;
  stochK?: number;
  stochD?: number;
  stoch1hK?: number;
  stoch1hD?: number;
  trend1h?: TrendContext;
  trend4h?: TrendContext;
  trend1d?: TrendContext;
  entryCandidates?: EntryCandidates;
  rejectionStage?: string | null;
  recommendedAction?: string;
  positionSize?: string;
  whyNoTrade?: string[];
  entryTier?: EntryTier | null;
  trendConflict?: boolean;
}

export interface RegimeDisplay {
  direction: "LONG" | "SHORT" | "NEUTRAL" | "TREND_CONFLICT" | null;
  strength: string;
  confidence: number;
  score: number;
  reason: string[];
}

// ─── SAFE NUMBER FORMATTING ───

function safeNum(v: any): number {
  const n = Number(v);
  return isFinite(n) ? n : 0;
}

function f0(v: any): string { return safeNum(v).toFixed(0); }
function f1(v: any): string { return safeNum(v).toFixed(1); }
function f2(v: any): string { return safeNum(v).toFixed(2); }

// ─── TRADER-FRIENDLY MESSAGES ───

function getTraderReason(internalReason: string | null): string {
  if (!internalReason) return "Analyzing market conditions...";
  const map: Record<string, string> = {
    "regime_neutral": "No directional bias",
    "cooldown_active": "Position cooldown active",
    "confidence_too_low": "Setup developing",
    "no_cross_or_regime_mismatch": "Momentum confirmation pending",
    "no_rejection_pattern_or_regime_mismatch": "No rejection pattern yet",
    "no_breakout_or_regime_mismatch": "Breakout not confirmed",
    "shallow_cross": "Waiting for deeper pullback",
    "extended_cross": "Waiting for pullback",
    "no_stoch_cross": "Waiting for StochRSI confirmation",
    "low_breakout_volume": "Waiting for volume confirmation",
    "adx_weak": "Market lacks strength",
    "high_volatility": "Volatility too high — risk control",
    "time_decay": "Signal expired",
    "entry_drift": "Entry price moved away",
    "already_exited": "Position already closed",
    "stop_hit": "Stop loss triggered",
    "target_hit": "Target reached",
    "trailing_stop": "Trailing stop triggered",
    "regime_reversal": "Trend reversed — exiting",
  };
  for (const [key, value] of Object.entries(map)) {
    if (internalReason.includes(key)) return value;
  }
  return "Analyzing market conditions...";
}

function getRecommendedAction(regime: MarketRegime, bestConfidence: number): { action: string; detail: string } {
  if (!regime.direction || regime.direction === "NEUTRAL") {
    return { action: "WAIT", detail: "No directional bias" };
  }
  if (regime.strength === "NEUTRAL") {
    return { action: "WAIT", detail: "Market lacks strength" };
  }
  if (bestConfidence >= 85) {
    const size = regime.strength === "STRONG" ? "Full Position" : regime.strength === "MODERATE" ? "75% Position" : "50% Position";
    return { action: "CONFIRMED ENTRY", detail: size };
  }
  if (bestConfidence >= 70) {
    const size = regime.strength === "STRONG" ? "33% Position" : regime.strength === "MODERATE" ? "25% Position" : "20% Position";
    return { action: "EARLY ENTRY", detail: size };
  }
  if (bestConfidence >= 50) {
    return { action: "WATCH", detail: "Setup developing" };
  }
  if (regime.strength === "STRONG" || regime.strength === "MODERATE") {
    return { action: "WAIT", detail: "Waiting for setup confirmation" };
  }
  return { action: "WAIT", detail: "Market conditions not favorable" };
}

// ─── ENTRY TIER & POSITION SIZING ───

export type EntryTier = "NO_TRADE" | "EARLY_ENTRY" | "CONFIRMED_ENTRY";

function classifyEntryTier(confidence: number): EntryTier {
  if (confidence >= 85) return "CONFIRMED_ENTRY";
  if (confidence >= 70) return "EARLY_ENTRY";
  return "NO_TRADE";
}

function getPositionSizePct(tier: EntryTier, _regimeStrength: string): number {
  if (tier === "NO_TRADE") return 0;
  if (tier === "EARLY_ENTRY") return 0.33;
  if (tier === "CONFIRMED_ENTRY") return 1.0;
  return 0;
}

// ─── TIER LOCK SYSTEM ───
// Locks are pair + tier based: BTC/USD:EARLY and BTC/USD:CONFIRMED are independent

const tierLockStore = new Map<string, number>();
const TIER_LOCK_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours

function getTierLockKey(pair: string, tier: EntryTier): string {
  return pair + ":" + tier;
}

function isTierLocked(pair: string, tier: EntryTier, now: number): boolean {
  const key = getTierLockKey(pair, tier);
  const lockedAt = tierLockStore.get(key);
  if (!lockedAt) return false;
  if (now - lockedAt > TIER_LOCK_TTL_MS) {
    tierLockStore.delete(key);
    return false;
  }
  return true;
}

function setTierLock(pair: string, tier: EntryTier, now: number): void {
  tierLockStore.set(getTierLockKey(pair, tier), now);
}

export function clearAllTierLocks(): void {
  tierLockStore.clear();
}

export function clearTierLocksForPair(pair: string): void {
  for (const key of tierLockStore.keys()) {
    if (key.startsWith(pair + ":")) {
      tierLockStore.delete(key);
    }
  }
}


// ─── REGIME PERSISTENCE & CACHE ───

interface RegimeCache {
  regime: MarketRegime;
  timestamp: number;
  pairKey: string;
}

const regimeCache = new Map<string, RegimeCache>();
const REGIME_CACHE_TTL_MS = 15 * 60 * 1000;

let persistRegimeFn: ((pair: string, regime: MarketRegime) => Promise<void>) | null = null;
let loadRegimeFn: ((pair: string) => Promise<MarketRegime | null>) | null = null;

export function setRegimePersistence(
  persist: (pair: string, regime: MarketRegime) => Promise<void>,
  load: (pair: string) => Promise<MarketRegime | null>
): void {
  persistRegimeFn = persist;
  loadRegimeFn = load;
}

async function getRegime(pair: string, candles1d: Candle[], candles4h: Candle[]): Promise<MarketRegime> {
  const cacheKey = pair;
  const cached = regimeCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < REGIME_CACHE_TTL_MS) {
    return cached.regime;
  }

  let regime = await evaluateRegime(pair, candles1d, candles4h);

  if (persistRegimeFn) {
    try {
      await persistRegimeFn(pair, regime);
    } catch (e) {
      if (DEBUG) console.error("[REGIME PERSIST] Failed:", e);
    }
  }

  regimeCache.set(cacheKey, { regime, timestamp: Date.now(), pairKey: pair });
  return regime;
}

export function getRegimeSync(pair: string): MarketRegime | null {
  const cached = regimeCache.get(pair);
  return cached ? cached.regime : null;
}

export async function persistRegime(pair: string, regime: MarketRegime): Promise<void> {
  if (persistRegimeFn) {
    try {
      await persistRegimeFn(pair, regime);
    } catch (e) {
      if (DEBUG) console.error("[REGIME PERSIST DIRECT] Failed:", e);
    }
  }
}

// ─── REGIME EVALUATION ENGINE ───

async function evaluateRegime(pair: string, candles1d: Candle[], candles4h: Candle[]): Promise<MarketRegime> {
  const reasons: string[] = [];
  const detectedAt = Date.now();

  if (candles1d.length < 20 || candles4h.length < 30) {
    return { direction: "NEUTRAL", strength: "INSUFFICIENT_DATA", confidence: 0, score: 0, reason: ["not_enough_candles"], detectedAt };
  }

  const closes1d = candles1d.map(c => c.close);
  const closes4h = candles4h.map(c => c.close);

  const ema21_1d = ema(closes1d, 21);
  const ema50_1d = ema(closes1d, 50);
  const ema200_1d = ema(closes1d, 200);
  const ema21_4h = ema(closes4h, 21);
  const ema50_4h = ema(closes4h, 50);

  let regimeScore = 0;
  let direction: "LONG" | "SHORT" | "NEUTRAL" = "NEUTRAL";
  let tf1d: "LONG" | "SHORT" | "NEUTRAL" = "NEUTRAL";
  let tf4h: "LONG" | "SHORT" | "NEUTRAL" = "NEUTRAL";

  // 1D TIMEFRAME
  if (ema21_1d.length > 0 && ema50_1d.length > 0) {
    const e21 = ema21_1d[ema21_1d.length - 1];
    const e50 = ema50_1d[ema50_1d.length - 1];
    const lastClose = closes1d[closes1d.length - 1];

    if (ema200_1d.length > 0) {
      const e200 = ema200_1d[ema200_1d.length - 1];
      if (e21 > e50 && e50 > e200 && lastClose > e200) {
        regimeScore += 40; tf1d = "LONG"; reasons.push("1D_bullish_stack");
      } else if (e21 < e50 && e50 < e200 && lastClose < e200) {
        regimeScore -= 40; tf1d = "SHORT"; reasons.push("1D_bearish_stack");
      } else if (e21 > e50 && lastClose > e21) {
        regimeScore += 25; tf1d = "LONG"; reasons.push("1D_bullish_lean");
      } else if (e21 < e50 && lastClose < e21) {
        regimeScore -= 25; tf1d = "SHORT"; reasons.push("1D_bearish_lean");
      } else if (e21 > e50) {
        regimeScore += 15; tf1d = "LONG"; reasons.push("1D_bullish_weak");
      } else if (e21 < e50) {
        regimeScore -= 15; tf1d = "SHORT"; reasons.push("1D_bearish_weak");
      }
    } else {
      if (e21 > e50 && lastClose > e21) {
        regimeScore += 25; tf1d = "LONG"; reasons.push("1D_bullish_21_50");
      } else if (e21 < e50 && lastClose < e21) {
        regimeScore -= 25; tf1d = "SHORT"; reasons.push("1D_bearish_21_50");
      } else if (e21 > e50) {
        regimeScore += 10; tf1d = "LONG"; reasons.push("1D_bullish_weak");
      } else if (e21 < e50) {
        regimeScore -= 10; tf1d = "SHORT"; reasons.push("1D_bearish_weak");
      }
    }
  } else if (ema21_1d.length > 0) {
    const e21 = ema21_1d[ema21_1d.length - 1];
    const lastClose = closes1d[closes1d.length - 1];
    if (lastClose > e21) { regimeScore += 10; tf1d = "LONG"; reasons.push("1D_price_above_21ema"); }
    else { regimeScore -= 10; tf1d = "SHORT"; reasons.push("1D_price_below_21ema"); }
  }

  // 4H TIMEFRAME
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

  // TIMEFRAME CONFLICT PENALTY
  if (tf1d !== "NEUTRAL" && tf4h !== "NEUTRAL" && tf1d !== tf4h) {
    regimeScore = Math.round(regimeScore * 0.5);
    reasons.push("conflict_" + tf1d + "_1D_vs_" + tf4h + "_4H");
  }

  // MOMENTUM
  const rsi1d = rsi(closes1d);
  if (rsi1d > 60) { regimeScore += (tf1d === "LONG" ? 10 : 5); reasons.push("rsi_" + f0(rsi1d)); }
  else if (rsi1d < 40) { regimeScore -= (tf1d === "SHORT" ? 10 : 5); reasons.push("rsi_" + f0(rsi1d)); }

  const adx1d = adx(candles1d);
  const adx4h = adx(candles4h);
  if (adx1d > 25) { regimeScore += (tf1d !== "NEUTRAL" ? 15 : 5); reasons.push("adx_" + f1(adx1d)); }
  if (adx4h > 25) { regimeScore += 10; reasons.push("4H_adx_" + f1(adx4h)); }

  // DIRECTION RESOLUTION
  if (tf1d !== "NEUTRAL") direction = tf1d;
  else if (tf4h !== "NEUTRAL") { direction = tf4h; regimeScore += 5; reasons.push("fallback_4H"); }

  // STRENGTH
  const absScore = Math.abs(regimeScore);
  let strength = "NEUTRAL";
  if (absScore > 45) strength = "STRONG";
  else if (absScore > 25) strength = "MODERATE";
  else if (absScore > 10) strength = "WEAK";

  if (absScore < 10) { direction = "NEUTRAL"; strength = "NEUTRAL"; reasons.push("score_neutral"); }

  return { direction, strength, confidence: Math.min(100, absScore), score: regimeScore, reason: reasons, detectedAt };
}

export function shouldInvalidateRegime(regime: MarketRegime): boolean {
  if (!regime) return false;
  const age = Date.now() - regime.detectedAt;
  return age > REGIME_CACHE_TTL_MS;
}

// ─── INDICATOR FUNCTIONS ───

function sma(values: number[], period: number): number[] {
  if (values.length < period) return [];
  const out: number[] = [];
  for (let i = period - 1; i < values.length; i++) {
    const slice = values.slice(i - period + 1, i + 1).filter(isFinite);
    if (slice.length) out.push(slice.reduce((a, b) => a + b, 0) / slice.length);
  }
  return out;
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

function linearRegression(closes: number[], lookback: number = 50): { slope: number; intercept: number; supportLevel: number; resistanceLevel: number } {
  if (closes.length < lookback) return { slope: 0, intercept: 0, supportLevel: 0, resistanceLevel: 0 };
  const data = closes.slice(-lookback);
  const n = data.length;
  const sumX = (n * (n - 1)) / 2;
  const sumY = data.reduce((a, b) => a + b, 0);
  const sumXY = data.reduce((sum, y, i) => sum + i * y, 0);
  const sumX2 = (n * (n - 1) * (2 * n - 1)) / 6;
  const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
  const intercept = (sumY - slope * sumX) / n;
  const currentLevel = intercept + slope * (n - 1);
  const supportLevel = currentLevel - Math.abs(slope * 5);
  const resistanceLevel = currentLevel + Math.abs(slope * 5);
  return { slope, intercept, supportLevel, resistanceLevel };
}

function rsi(values: number[], period: number = 14): number {
  if (values.length < period + 1) return 50;
  const diffs: number[] = [];
  for (let i = 1; i < values.length; i++) {
    diffs.push(values[i] - values[i - 1]);
  }
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

function stochRsi(values: number[], period: number = 14, k: number = 3, d: number = 3): { k: number; d: number } {
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
  const stochD = avg(dValues);
  const stochK = stochKValues[stochKValues.length - 1];

  return { k: isFinite(stochK) ? stochK : 50, d: isFinite(stochD) ? stochD : 50 };
}

function adx(candles: Candle[], period: number = 14): number {
  if (candles.length < period * 2) return 0;
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);
  const closes = candles.map(c => c.close);

  const trueRanges: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const tr = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    );
    trueRanges.push(tr);
  }

  const plusDMs: number[] = [];
  const minusDMs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const upMove = highs[i] - highs[i - 1];
    const downMove = lows[i - 1] - lows[i];
    let plusDM = 0, minusDM = 0;
    if (upMove > downMove && upMove > 0) plusDM = upMove;
    if (downMove > upMove && downMove > 0) minusDM = downMove;
    plusDMs.push(plusDM);
    minusDMs.push(minusDM);
  }

  const wildersRma = (values: number[], lookback: number): number[] => {
    if (values.length < lookback) return [];
    const result: number[] = [];
    let sum = values.slice(0, lookback).reduce((a, b) => a + b, 0);
    result.push(sum / lookback);
    for (let i = lookback; i < values.length; i++) {
      const prev = result[result.length - 1];
      sum = prev * lookback - prev + values[i];
      const val = sum / lookback;
      result.push(isFinite(val) ? val : prev);
    }
    return result;
  };

  const atrRma = wildersRma(trueRanges, period);
  const plusDmRma = wildersRma(plusDMs, period);
  const minusDmRma = wildersRma(minusDMs, period);

  if (atrRma.length < 1) return 0;

  const diPlusArray: number[] = [];
  const diMinusArray: number[] = [];
  for (let i = 0; i < atrRma.length; i++) {
    const atr = atrRma[i];
    diPlusArray.push((plusDmRma[i] / atr) * 100);
    diMinusArray.push((minusDmRma[i] / atr) * 100);
  }

  const dxArray: number[] = [];
  for (let i = 0; i < diPlusArray.length; i++) {
    const diPlus = diPlusArray[i];
    const diMinus = diMinusArray[i];
    const di = diPlus + diMinus;
    const dx = di === 0 ? 0 : (Math.abs(diPlus - diMinus) / di) * 100;
    dxArray.push(dx);
  }

  const adxRma = wildersRma(dxArray, period);
  const finalAdx = adxRma[adxRma.length - 1];
  return isFinite(finalAdx) ? finalAdx : 0;
}

// ─── CANDLE AGGREGATION ───

function aggregateTo1D(candles4h: Candle[]): Candle[] {
  if (!candles4h || candles4h.length < 6) return [];
  const sorted = [...candles4h].sort((a, b) => a.timestamp - b.timestamp);

  const sampleTs = sorted[0].timestamp;
  const isSeconds = sampleTs < 1e10;
  const tsMultiplier = isSeconds ? 1000 : 1;

  const groups: Map<string, Candle[]> = new Map();
  for (const c of sorted) {
    const ts = c.timestamp * tsMultiplier;
    const d = new Date(ts);
    const key = d.toISOString().split("T")[0];
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

// ─── PAIR CONFIG ───

const MIN_RR = 1.5;

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

export function getPairConfig(pair: string): PairConfig {
  return PAIR_CONFIGS[pair] || PAIR_CONFIGS.default;
}


// ─── EXHAUSTION CHECK ───

function checkExhaustion(
  stoch4h: { k: number; d: number },
  tradeDirection: "LONG" | "SHORT"
): { isExhausted: boolean; reason: string; confidencePenalty: number } {
  if (tradeDirection === "LONG") {
    if (stoch4h.k > 90) {
      return { isExhausted: true, reason: "BLOCK: 4H extreme overbought K" + stoch4h.k + " — buyers exhausted", confidencePenalty: -50 };
    }
    if (stoch4h.k > 80 && stoch4h.k < stoch4h.d) {
      return { isExhausted: true, reason: "BLOCK: 4H overbought reversal K" + stoch4h.k + "<D" + stoch4h.d + " — momentum rolling over", confidencePenalty: -40 };
    }
  } else {
    if (stoch4h.k < 10) {
      return { isExhausted: true, reason: "BLOCK: 4H extreme oversold K" + stoch4h.k + " — sellers exhausted", confidencePenalty: -50 };
    }
    if (stoch4h.k < 20 && stoch4h.k > stoch4h.d) {
      return { isExhausted: true, reason: "BLOCK: 4H oversold reversal K" + stoch4h.k + ">D" + stoch4h.d + " — momentum rolling over", confidencePenalty: -40 };
    }
  }
  return { isExhausted: false, reason: "", confidencePenalty: 0 };
}

function getExhaustionWarning(
  stoch1h: { k: number; d: number },
  stochPrev1h: { k: number; d: number },
  direction: "LONG" | "SHORT"
): string {
  const crossUp = stochPrev1h.k <= stochPrev1h.d && stoch1h.k > stoch1h.d;
  const crossDown = stochPrev1h.k >= stochPrev1h.d && stoch1h.k < stoch1h.d;

  if (direction === "LONG" && crossDown && stoch1h.k > 80) {
    return "⚠️ LONG exhaustion risk — StochRSI rolling over from overbought";
  }
  if (direction === "SHORT" && crossUp && stoch1h.k < 20) {
    return "⚠️ SHORT exhaustion risk — StochRSI rolling over from oversold";
  }
  return "";
}

// ─── REJECTION LOGGING (DEBUG ONLY) ───

const rejectionLogs: RejectionLog[] = [];
const MAX_REJECTION_LOGS = 1000;

function logRejection(log: RejectionLog): void {
  rejectionLogs.push(log);
  if (rejectionLogs.length > MAX_REJECTION_LOGS) {
    rejectionLogs.shift();
  }
  // Only log to console in DEBUG mode
  if (DEBUG) {
    console.log("[REJECTED] " + log.pair + " | cross=" + (log.crossDetected ? log.crossDirection : "none") + " | regime=" + log.regimeDirection + " | conf=" + log.confidenceScore + " | reason=" + log.rejectionReason);
  }
}

export function getRejectionLogs(pair?: string, since?: number): RejectionLog[] {
  let logs = rejectionLogs;
  if (pair) logs = logs.filter(l => l.pair === pair);
  if (since) logs = logs.filter(l => l.timestamp >= since);
  return logs;
}

export function clearRejectionLogs(): void {
  rejectionLogs.length = 0;
}

// ─── CONFIDENCE ENGINE ───

interface EntryCandidateInternal {
  direction: "LONG" | "SHORT";
  strength: number;
  finalConfidence: number;
  reasons: string[];
  confidenceComponents: ConfidenceComponents;
  stochK: number;
  stochD: number;
  stochPrevK: number;
  stochPrevD: number;
  entryPrice: number;
  confidencePenalty: number;
  exhaustionWarning: string;
  entryMode: "PULLBACK" | "REJECTION" | "BREAKOUT";
}

function buildEntryComponents(
  regimeAlignment: number,
  setupQuality: number,
  momentum: number,
  structure: number,
  volume: number,
  riskPenalty: number
): ConfidenceComponents {
  const total = Math.min(100, Math.max(0, regimeAlignment + setupQuality + momentum + structure + volume + riskPenalty));
  return {
    regimeAlignment,
    setupQuality,
    momentum,
    structure,
    volume,
    riskPenalty,
    total,
  };
}

// ─── MODE A: PULLBACK ENTRY ───

function scorePullbackEntry(
  candles1h: Candle[],
  candles4h: Candle[],
  config: PairConfig,
  pair: string,
  regimeDirection: "LONG" | "SHORT"
): EntryCandidateInternal | null {
  const reasons: string[] = [];
  const closes = candles1h.map(c => c.close);
  const volumes = candles1h.map(c => c.volume);
  if (closes.length < 50) return null;

  const stoch = stochRsi(closes);
  const stochPrev = stochRsi(closes.slice(0, -1));

  const crossUp = stochPrev.k <= stochPrev.d && stoch.k > stoch.d;
  const crossDown = stochPrev.k >= stochPrev.d && stoch.k < stoch.d;

  let direction: "LONG" | "SHORT" | null = null;
  if (crossUp) direction = "LONG";
  else if (crossDown) direction = "SHORT";

  if (!direction) return null;
  if (direction !== regimeDirection) return null;

  let regimeAlignment = 25;
  reasons.push("regime_alignment:+25");
  let setupQuality = 0, momentum = 0, structure = 0, volumeScore = 0;

  if (config.isHYPE) {
    if (direction === "LONG") {
      if (stoch.k < (config.deepCrossThresholdLong || 25)) { setupQuality += 20; reasons.push("deep_cross:+20"); }
      else if (stoch.k < 40) { setupQuality += 10; reasons.push("moderate_cross:+10"); }
      else { setupQuality -= 20; reasons.push("shallow_cross:-20"); }
    } else {
      if (stoch.k > (config.deepCrossThresholdShort || 75)) { setupQuality += 20; reasons.push("deep_cross:+20"); }
      else if (stoch.k > 60) { setupQuality += 10; reasons.push("moderate_cross:+10"); }
      else { setupQuality -= 20; reasons.push("shallow_cross:-20"); }
    }
  } else {
    if (direction === "LONG") {
      if (stoch.k < 35) { setupQuality += 15; reasons.push("deep_cross:+15"); }
      else if (stoch.k < 50) { setupQuality += 5; reasons.push("moderate_cross:+5"); }
      else if (stoch.k > 70) { setupQuality -= 15; reasons.push("extended_cross:-15"); }
    } else {
      if (stoch.k > 65) { setupQuality += 15; reasons.push("deep_cross:+15"); }
      else if (stoch.k > 50) { setupQuality += 5; reasons.push("moderate_cross:+5"); }
      else if (stoch.k < 30) { setupQuality -= 15; reasons.push("extended_cross:-15"); }
    }
  }

  const roc = ((closes[closes.length - 1] - closes[closes.length - 4]) / closes[closes.length - 4]) * 100;

  if (Math.abs(roc) > 2) {
    momentum += Math.min(15, Math.abs(roc) * 3);
    reasons.push("momentum_roc:" + f1(roc) + ":+" + f0(Math.min(15, Math.abs(roc) * 3)));
  }

  const ema21 = ema(closes, 21);
  const ema50 = ema(closes, 50);
  const lastClose = closes[closes.length - 1];
  if (ema21.length > 0 && ema50.length > 0) {
    const e21 = ema21[ema21.length - 1];
    const e50 = ema50[ema50.length - 1];
    if (direction === "LONG" && lastClose > e21) {
      structure += 10;
      reasons.push("price_above_21ema:+10");
    } else if (direction === "SHORT" && lastClose < e21) {
      structure += 10;
      reasons.push("price_below_21ema:+10");
    }
    if (direction === "LONG" && e21 > e50) {
      structure += 10;
      reasons.push("21ema_above_50ema:+10");
    } else if (direction === "SHORT" && e21 < e50) {
      structure += 10;
      reasons.push("21ema_below_50ema:+10");
    }
  }

  const recentVol = avg(volumes.slice(-5));
  const avgVol = avg(volumes.slice(-20));
  if (recentVol > avgVol * config.volumeMultiplier) {
    volumeScore += 10;
    reasons.push("volume_spike:+10");
  }

  const atr = avg(candles1h.slice(-14).map(c => c.high - c.low));
  const atrPct = atr / lastClose;
  let riskPenalty = 0;
  if (atrPct > 0.03) {
    riskPenalty -= 15;
    reasons.push("high_volatility:-15");
  }

  const closes4h = candles4h.map(c => c.close);
  const stoch4h = stochRsi(closes4h);
  const exhaustion = checkExhaustion(stoch4h, direction);
  let confidencePenalty = exhaustion.confidencePenalty;
  if (exhaustion.isExhausted) {
    reasons.push(exhaustion.reason);
  }

  const stoch1h = stochRsi(closes);
  const stochPrev1h = stochRsi(closes.slice(0, -1));
  const exhaustionWarning = getExhaustionWarning(stoch1h, stochPrev1h, direction);

  let entryPrice = lastClose;
  if (direction === "LONG") {
    entryPrice = Math.min(lastClose, candles1h[candles1h.length - 1].low * 1.002);
  } else {
    entryPrice = Math.max(lastClose, candles1h[candles1h.length - 1].high * 0.998);
  }

  const confidenceComponents = buildEntryComponents(regimeAlignment, setupQuality, momentum, structure, volumeScore, riskPenalty);
  const finalConfidence = confidenceComponents.total + confidencePenalty;

  return {
    direction,
    strength: finalConfidence,
    finalConfidence,
    reasons,
    confidenceComponents,
    stochK: stoch.k,
    stochD: stoch.d,
    stochPrevK: stochPrev.k,
    stochPrevD: stochPrev.d,
    entryPrice,
    confidencePenalty,
    exhaustionWarning,
    entryMode: "PULLBACK",
  };
}

// ─── MODE B: REJECTION ENTRY ───

function scoreRejectionEntry(
  candles1h: Candle[],
  candles4h: Candle[],
  candles15m: Candle[],
  config: PairConfig,
  pair: string,
  regimeDirection: "LONG" | "SHORT"
): EntryCandidateInternal | null {
  const reasons: string[] = [];
  const closes = candles1h.map(c => c.close);
  const highs = candles1h.map(c => c.high);
  const lows = candles1h.map(c => c.low);
  const volumes = candles1h.map(c => c.volume);
  if (closes.length < 50 || candles15m.length < 20) return null;

  const stoch = stochRsi(closes);
  const stochPrev = stochRsi(closes.slice(0, -1));

  const recentHigh = highest(highs, 10);
  const recentLow = lowest(lows, 10);
  const lastClose = closes[closes.length - 1];

  let direction: "LONG" | "SHORT" | null = null;
  let setupQuality = 0;

  if (lastClose > recentLow * 1.005 && lows[lows.length - 2] <= recentLow * 1.002) {
    direction = "LONG";
    setupQuality += 20;
    reasons.push("support_rejection:+20");
  }
  else if (lastClose < recentHigh * 0.995 && highs[highs.length - 2] >= recentHigh * 0.998) {
    direction = "SHORT";
    setupQuality += 20;
    reasons.push("resistance_rejection:+20");
  }

  if (!direction || direction !== regimeDirection) return null;

  const crossUp = stochPrev.k <= stochPrev.d && stoch.k > stoch.d;
  const crossDown = stochPrev.k >= stochPrev.d && stoch.k < stoch.d;

  if (direction === "LONG" && !crossUp) {
    setupQuality -= 10;
    reasons.push("no_stoch_cross:-10");
  } else if (direction === "SHORT" && !crossDown) {
    setupQuality -= 10;
    reasons.push("no_stoch_cross:-10");
  }

  let regimeAlignment = 25;
  reasons.push("regime_alignment:+25");
  let momentum = 0, structure = 0, volumeScore = 0;

  const closes15m = candles15m.map(c => c.close);
  const roc15m = ((closes15m[closes15m.length - 1] - closes15m[closes15m.length - 4]) / closes15m[closes15m.length - 4]) * 100;
  if (Math.abs(roc15m) > 1.5) {
    momentum += Math.min(15, Math.abs(roc15m) * 3);
    reasons.push("momentum_15m:" + f1(roc15m) + ":+" + f0(Math.min(15, Math.abs(roc15m) * 3)));
  }

  const recentVol = volumes[volumes.length - 1];
  const avgVol = avg(volumes.slice(-10));
  if (recentVol > avgVol * 1.5) {
    volumeScore += 15;
    reasons.push("rejection_volume:+15");
  }

  const atr = avg(candles1h.slice(-14).map(c => c.high - c.low));
  const atrPct = atr / lastClose;
  let riskPenalty = 0;
  if (atrPct > 0.03) {
    riskPenalty -= 15;
    reasons.push("high_volatility:-15");
  }

  const closes4h = candles4h.map(c => c.close);
  const stoch4h = stochRsi(closes4h);
  const exhaustion = checkExhaustion(stoch4h, direction);
  let confidencePenalty = exhaustion.confidencePenalty;
  if (exhaustion.isExhausted) {
    reasons.push(exhaustion.reason);
  }

  const stoch1h = stochRsi(closes);
  const stochPrev1h = stochRsi(closes.slice(0, -1));
  const exhaustionWarning = getExhaustionWarning(stoch1h, stochPrev1h, direction);

  const confidenceComponents = buildEntryComponents(regimeAlignment, setupQuality, momentum, structure, volumeScore, riskPenalty);
  const finalConfidence = confidenceComponents.total + confidencePenalty;

  return {
    direction,
    strength: finalConfidence,
    finalConfidence,
    reasons,
    confidenceComponents,
    stochK: stoch.k,
    stochD: stoch.d,
    stochPrevK: stochPrev.k,
    stochPrevD: stochPrev.d,
    entryPrice: lastClose,
    confidencePenalty,
    exhaustionWarning,
    entryMode: "REJECTION",
  };
}

// ─── MODE C: BREAKOUT ENTRY ───

function scoreBreakoutEntry(
  candles1h: Candle[],
  candles4h: Candle[],
  candles15m: Candle[],
  config: PairConfig,
  pair: string,
  regimeDirection: "LONG" | "SHORT"
): EntryCandidateInternal | null {
  const reasons: string[] = [];
  const closes = candles1h.map(c => c.close);
  const highs = candles1h.map(c => c.high);
  const lows = candles1h.map(c => c.low);
  const volumes = candles1h.map(c => c.volume);
  if (closes.length < 50) return null;

  const stoch = stochRsi(closes);
  const stochPrev = stochRsi(closes.slice(0, -1));

  const recentHigh = highest(highs, 20);
  const recentLow = lowest(lows, 20);
  const lastClose = closes[closes.length - 1];
  const prevClose = closes[closes.length - 2];

  let direction: "LONG" | "SHORT" | null = null;
  let setupQuality = 0;

  if (lastClose > recentHigh && prevClose <= recentHigh) {
    direction = "LONG";
    setupQuality += 25;
    reasons.push("resistance_breakout:+25");
  }
  else if (lastClose < recentLow && prevClose >= recentLow) {
    direction = "SHORT";
    setupQuality += 25;
    reasons.push("support_breakdown:+25");
  }

  if (!direction || direction !== regimeDirection) return null;

  const recentVol = volumes[volumes.length - 1];
  const avgVol = avg(volumes.slice(-10));
  if (recentVol > avgVol * config.volumeMultiplier) {
    setupQuality += 15;
    reasons.push("breakout_volume:+15");
  } else {
    setupQuality -= 10;
    reasons.push("low_breakout_volume:-10");
  }

  if (direction === "LONG" && stoch.k > 85) {
    setupQuality -= 15;
    reasons.push("stoch_overbought:-15");
  } else if (direction === "SHORT" && stoch.k < 15) {
    setupQuality -= 15;
    reasons.push("stoch_oversold:-15");
  }

  let regimeAlignment = 25;
  reasons.push("regime_alignment:+25");
  let momentum = 0, structure = 0, volumeScore = 0;

  const roc = ((closes[closes.length - 1] - closes[closes.length - 4]) / closes[closes.length - 4]) * 100;
  if (Math.abs(roc) > 2) {
    momentum += Math.min(15, Math.abs(roc) * 3);
    reasons.push("momentum_roc:" + f1(roc) + ":+" + f0(Math.min(15, Math.abs(roc) * 3)));
  }

  const adx1h = adx(candles1h);
  if (adx1h > config.minADX) {
    structure += 15;
    reasons.push("adx_confirms:" + f1(adx1h) + ":+15");
  } else {
    structure -= 10;
    reasons.push("adx_weak:" + f1(adx1h) + ":-10");
  }

  const atr = avg(candles1h.slice(-14).map(c => c.high - c.low));
  const atrPct = atr / lastClose;
  let riskPenalty = 0;
  if (atrPct > 0.03) {
    riskPenalty -= 15;
    reasons.push("high_volatility:-15");
  }

  const closes4h = candles4h.map(c => c.close);
  const stoch4h = stochRsi(closes4h);
  const exhaustion = checkExhaustion(stoch4h, direction);
  let confidencePenalty = exhaustion.confidencePenalty;
  if (exhaustion.isExhausted) {
    reasons.push(exhaustion.reason);
  }

  const stoch1h = stochRsi(closes);
  const stochPrev1h = stochRsi(closes.slice(0, -1));
  const exhaustionWarning = getExhaustionWarning(stoch1h, stochPrev1h, direction);

  const confidenceComponents = buildEntryComponents(regimeAlignment, setupQuality, momentum, structure, volumeScore, riskPenalty);
  const finalConfidence = confidenceComponents.total + confidencePenalty;

  return {
    direction,
    strength: finalConfidence,
    finalConfidence,
    reasons,
    confidenceComponents,
    stochK: stoch.k,
    stochD: stoch.d,
    stochPrevK: stochPrev.k,
    stochPrevD: stochPrev.d,
    entryPrice: lastClose,
    confidencePenalty,
    exhaustionWarning,
    entryMode: "BREAKOUT",
  };
}


// ─── Entry Orchestrator ───

function scoreBestEntry(
  candles1h: Candle[],
  candles4h: Candle[],
  candles15m: Candle[],
  config: PairConfig,
  pair: string,
  regimeDirection: "LONG" | "SHORT"
): { candidate: EntryCandidateInternal | null; candidates: EntryCandidates; debug: string[] } {
  const debug: string[] = [];

  const pullback = scorePullbackEntry(candles1h, candles4h, config, pair, regimeDirection);
  const rejection = scoreRejectionEntry(candles1h, candles4h, candles15m, config, pair, regimeDirection);
  const breakout = scoreBreakoutEntry(candles1h, candles4h, candles15m, config, pair, regimeDirection);

  const candidates: EntryCandidates = {
    pullback: {
      eligible: !!pullback && (pullback.finalConfidence >= 70),
      confidence: pullback?.finalConfidence || 0,
      rejectionReason: pullback
        ? (pullback.finalConfidence < 70 ? "confidence_too_low:" + f0(pullback.finalConfidence) : null)
        : "no_cross_or_regime_mismatch",
    },
    rejection: {
      eligible: !!rejection && (rejection.finalConfidence >= 70),
      confidence: rejection?.finalConfidence || 0,
      rejectionReason: rejection
        ? (rejection.finalConfidence < 70 ? "confidence_too_low:" + f0(rejection.finalConfidence) : null)
        : "no_rejection_pattern_or_regime_mismatch",
    },
    breakout: {
      eligible: !!breakout && (breakout.finalConfidence >= 70),
      confidence: breakout?.finalConfidence || 0,
      rejectionReason: breakout
        ? (breakout.finalConfidence < 70 ? "confidence_too_low:" + f0(breakout.finalConfidence) : null)
        : "no_breakout_or_regime_mismatch",
    },
  };

  if (DEBUG) {
    debug.push("PULLBACK: " + (candidates.pullback.eligible ? "PASS" : "FAIL") + " conf=" + f0(candidates.pullback.confidence) + (candidates.pullback.rejectionReason ? " " + candidates.pullback.rejectionReason : ""));
    debug.push("REJECTION: " + (candidates.rejection.eligible ? "PASS" : "FAIL") + " conf=" + f0(candidates.rejection.confidence) + (candidates.rejection.rejectionReason ? " " + candidates.rejection.rejectionReason : ""));
    debug.push("BREAKOUT: " + (candidates.breakout.eligible ? "PASS" : "FAIL") + " conf=" + f0(candidates.breakout.confidence) + (candidates.breakout.rejectionReason ? " " + candidates.breakout.rejectionReason : ""));
  }

  let best: EntryCandidateInternal | null = null;
  if (pullback && (!best || pullback.finalConfidence > best.finalConfidence)) best = pullback;
  if (rejection && (!best || rejection.finalConfidence > best.finalConfidence)) best = rejection;
  if (breakout && (!best || breakout.finalConfidence > best.finalConfidence)) best = breakout;

  if (best && best.finalConfidence < 70) {
    if (DEBUG) debug.push("Best candidate confidence " + f1(best.finalConfidence) + " below minimum 70 (NO_TRADE)");
    best = null;
  }

  return { candidate: best, candidates, debug };
}

// ─── Trend Context Helper ───

function getTrendContext(candles: Candle[]): TrendContext {
  if (candles.length < 50) return { direction: "NEUTRAL", strength: "INSUFFICIENT_DATA" };
  const closes = candles.map(c => c.close).filter(isFinite);
  const ema21v = ema(closes, 21);
  const ema50v = ema(closes, 50);
  if (ema21v.length < 2 || ema50v.length < 2) return { direction: "NEUTRAL", strength: "INSUFFICIENT_DATA" };

  const e21 = ema21v[ema21v.length - 1];
  const e50 = ema50v[ema50v.length - 1];
  const slope21 = e21 - ema21v[ema21v.length - 2];

  let direction = "NEUTRAL";
  let strength = "NEUTRAL";

  if (!isFinite(e21) || !isFinite(e50)) return { direction: "NEUTRAL", strength: "INSUFFICIENT_DATA" };

  if (e21 > e50 && slope21 > 0) {
    direction = "BULLISH";
    strength = Math.abs(slope21 / e21 * 100) > 0.1 ? "STRONG" : "MODERATE";
  } else if (e21 < e50 && slope21 < 0) {
    direction = "BEARISH";
    strength = Math.abs(slope21 / e21 * 100) > 0.1 ? "STRONG" : "MODERATE";
  } else if (e21 > e50) {
    direction = "BULLISH";
    strength = "WEAK";
  } else if (e21 < e50) {
    direction = "BEARISH";
    strength = "WEAK";
  }

  return { direction, strength };
}

// ─── TREND CONFLICT DETECTION ───

function detectTrendConflict(trend1h: TrendContext, trend4h: TrendContext, trend1d: TrendContext): boolean {
  const htf1 = trend1h.direction.toUpperCase();
  const htf2 = trend4h.direction.toUpperCase();
  const ltf = trend1d.direction.toUpperCase();

  if (htf1 === "NEUTRAL" || htf2 === "NEUTRAL" || htf1 === "INSUFFICIENT_DATA" || htf2 === "INSUFFICIENT_DATA") return false;
  if (htf1 !== htf2) return false;
  if (ltf === "NEUTRAL" || ltf === "INSUFFICIENT_DATA") return false;
  if (ltf === htf1) return false;

  return true;
}

// ─── MAIN SIGNAL GENERATION ───

export const CURRENT_SIGNAL_VERSION = 29;

export async function generateSignal(
  pair: string,
  candles1h: Candle[],
  candles4h: Candle[],
  candles15m: Candle[],
  currentPrice: number
): Promise<SignalResult> {
  const debug: string[] = [];
  if (DEBUG) {
    debug.push("=== generateSignal " + pair + " ===");
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
  if (DEBUG) {
    debug.push("trend context: 1h=" + trend1h.direction + "/" + trend1h.strength + " 4h=" + trend4h.direction + "/" + trend4h.strength + " 1d=" + trend1d.direction + "/" + trend1d.strength);
  }

  if (!regime.direction || regime.direction === "NEUTRAL" || regime.strength === "NEUTRAL") {
    const stoch4h = stochRsi(candles4h.map(c => c.close));
    const rejectionLog: RejectionLog = {
      pair,
      timestamp: Date.now(),
      crossDetected: false,
      crossDirection: null,
      regimeDirection: regime.direction,
      regimeStrength: regime.strength,
      confidenceScore: 0,
      confidenceBreakdown: {},
      rejectionReason: "Regime is NEUTRAL — no directional bias",
      stochK: stoch4h.k,
      stochD: stoch4h.d,
      stochPrevK: 0,
      stochPrevD: 0,
    };
    logRejection(rejectionLog);
    if (DEBUG) debug.push("REJECTED: regime is neutral");

    return {
      market: {
        pair,
        price: currentPrice,
        timestamp: Date.now(),
        regime,
        adx: adx(candles4h),
        rsi: rsi(candles4h.map(c => c.close)),
        stochK: stoch4h.k,
        stochD: stoch4h.d,
        stoch1hK: stochRsi(candles1h.map(c => c.close)).k,
        stoch1hD: stochRsi(candles1h.map(c => c.close)).d,
      },
      debug,
      entryCandidates: {
        pullback: { eligible: false, confidence: 0, rejectionReason: "regime_neutral" },
        rejection: { eligible: false, confidence: 0, rejectionReason: "regime_neutral" },
        breakout: { eligible: false, confidence: 0, rejectionReason: "regime_neutral" },
      },
      rejectionStage: "No directional bias",
    };
  }

  const now = Date.now();
  const cooldown = isInCooldown(pair, now, regime.direction);
  if (cooldown.inCooldown) {
    if (DEBUG) debug.push("REJECTED: cooldown active, remaining " + f1(cooldown.remainingMs / 60000) + "min");
    return {
      market: {
        pair,
        price: currentPrice,
        timestamp: now,
        regime,
        adx: adx(candles4h),
        rsi: rsi(candles4h.map(c => c.close)),
        stochK: stochRsi(candles4h.map(c => c.close)).k,
        stochD: stochRsi(candles4h.map(c => c.close)).d,
        stoch1hK: stochRsi(candles1h.map(c => c.close)).k,
        stoch1hD: stochRsi(candles1h.map(c => c.close)).d,
      },
      debug,
      entryCandidates: {
        pullback: { eligible: false, confidence: 0, rejectionReason: "cooldown_active" },
        rejection: { eligible: false, confidence: 0, rejectionReason: "cooldown_active" },
        breakout: { eligible: false, confidence: 0, rejectionReason: "cooldown_active" },
      },
      rejectionStage: "Position cooldown (" + f0(cooldown.remainingMs / 60000) + "min remaining)",
    };
  }

  const { candidate, candidates, debug: entryDebug } = scoreBestEntry(candles1h, candles4h, candles15m, config, pair, regime.direction);
  if (DEBUG) debug.push(...entryDebug);

  if (!candidate) {
    const stoch4h = stochRsi(candles4h.map(c => c.close));
    const rejectionLog: RejectionLog = {
      pair,
      timestamp: now,
      crossDetected: false,
      crossDirection: null,
      regimeDirection: regime.direction,
      regimeStrength: regime.strength,
      confidenceScore: 0,
      confidenceBreakdown: {},
      rejectionReason: "No entry candidate met threshold. Best: pullback=" + f0(candidates.pullback.confidence) + " rejection=" + f0(candidates.rejection.confidence) + " breakout=" + f0(candidates.breakout.confidence),
      stochK: stoch4h.k,
      stochD: stoch4h.d,
      stochPrevK: 0,
      stochPrevD: 0,
    };
    logRejection(rejectionLog);
    if (DEBUG) debug.push("REJECTED: no entry candidate met threshold");

    let rejectionStage = "Waiting for setup confirmation";
    if (!candidates.pullback.eligible && !candidates.rejection.eligible && !candidates.breakout.eligible) {
      const bestConf = Math.max(candidates.pullback.confidence, candidates.rejection.confidence, candidates.breakout.confidence);
      if (bestConf >= 50) rejectionStage = "Setup developing (" + f0(bestConf) + "%)";
      else rejectionStage = "Waiting for momentum confirmation";
    }

    return {
      market: {
        pair,
        price: currentPrice,
        timestamp: now,
        regime,
        adx: adx(candles4h),
        rsi: rsi(candles4h.map(c => c.close)),
        stochK: stoch4h.k,
        stochD: stoch4h.d,
        stoch1hK: stochRsi(candles1h.map(c => c.close)).k,
        stoch1hD: stochRsi(candles1h.map(c => c.close)).d,
      },
      debug,
      entryCandidates: candidates,
      rejectionStage,
    };
  }

  // Check exhaustion block
  if (candidate.confidencePenalty <= -40) {
    const stoch4h = stochRsi(candles4h.map(c => c.close));
    const rejectionLog: RejectionLog = {
      pair,
      timestamp: now,
      crossDetected: true,
      crossDirection: candidate.direction,
      regimeDirection: regime.direction,
      regimeStrength: regime.strength,
      confidenceScore: candidate.finalConfidence,
      confidenceBreakdown: {
        regimeAlignment: candidate.confidenceComponents.regimeAlignment,
        setupQuality: candidate.confidenceComponents.setupQuality,
        momentum: candidate.confidenceComponents.momentum,
        structure: candidate.confidenceComponents.structure,
        volume: candidate.confidenceComponents.volume,
        riskPenalty: candidate.confidenceComponents.riskPenalty,
      },
      rejectionReason: candidate.exhaustionWarning || "Exhaustion block",
      stochK: stoch4h.k,
      stochD: stoch4h.d,
      stochPrevK: candidate.stochPrevK,
      stochPrevD: candidate.stochPrevD,
    };
    logRejection(rejectionLog);
    if (DEBUG) debug.push("REJECTED: exhaustion block — " + candidate.exhaustionWarning);

    return {
      market: {
        pair,
        price: currentPrice,
        timestamp: now,
        regime,
        adx: adx(candles4h),
        rsi: rsi(candles4h.map(c => c.close)),
        stochK: stoch4h.k,
        stochD: stoch4h.d,
        stoch1hK: candidate.stochK,
        stoch1hD: candidate.stochD,
      },
      debug,
      entryCandidates: candidates,
      rejectionStage: "Market exhausted — " + (candidate.exhaustionWarning?.replace("BLOCK: ", "") || "cooling off"),
    };
  }

  // Calculate stops and targets
  const atr = avg(candles1h.slice(-14).map(c => c.high - c.low));
  const stopDistance = Math.max(atr * 2, currentPrice * config.stopLossPct);
  const targetDistance = stopDistance * MIN_RR;

  let stop = candidate.direction === "LONG" ? candidate.entryPrice - stopDistance : candidate.entryPrice + stopDistance;
  let target = candidate.direction === "LONG" ? candidate.entryPrice + targetDistance : candidate.entryPrice - targetDistance;

  // RR check
  const rr = targetDistance / stopDistance;
  if (rr < MIN_RR) {
    const stoch4h = stochRsi(candles4h.map(c => c.close));
    const rejectionLog: RejectionLog = {
      pair,
      timestamp: now,
      crossDetected: true,
      crossDirection: candidate.direction,
      regimeDirection: regime.direction,
      regimeStrength: regime.strength,
      confidenceScore: candidate.finalConfidence,
      confidenceBreakdown: {
        regimeAlignment: candidate.confidenceComponents.regimeAlignment,
        setupQuality: candidate.confidenceComponents.setupQuality,
        momentum: candidate.confidenceComponents.momentum,
        structure: candidate.confidenceComponents.structure,
        volume: candidate.confidenceComponents.volume,
        riskPenalty: candidate.confidenceComponents.riskPenalty,
      },
      rejectionReason: "RR " + f2(rr) + " below minimum " + MIN_RR,
      stochK: stoch4h.k,
      stochD: stoch4h.d,
      stochPrevK: candidate.stochPrevK,
      stochPrevD: candidate.stochPrevD,
    };
    logRejection(rejectionLog);
    if (DEBUG) debug.push("REJECTED: RR " + f2(rr) + " < " + MIN_RR);

    return {
      market: {
        pair,
        price: currentPrice,
        timestamp: now,
        regime,
        adx: adx(candles4h),
        rsi: rsi(candles4h.map(c => c.close)),
        stochK: stoch4h.k,
        stochD: stoch4h.d,
        stoch1hK: candidate.stochK,
        stoch1hD: candidate.stochD,
      },
      debug,
      entryCandidates: candidates,
      rejectionStage: "Risk:Reward too low (" + f2(rr) + " < " + MIN_RR + ")",
    };
  }

  // ADX check - soft penalty instead of hard block for early entries
  const adx4h = adx(candles4h);
  if (adx4h < config.minADX) {
    const adxPenalty = Math.round((config.minADX - adx4h) * 2);
    candidate.finalConfidence -= adxPenalty;
    if (DEBUG) debug.push("ADX " + f1(adx4h) + " below threshold " + config.minADX + ", penalty -" + adxPenalty);

    if (candidate.finalConfidence < 70) {
      const stoch4h = stochRsi(candles4h.map(c => c.close));
      const rejectionLog: RejectionLog = {
        pair,
        timestamp: now,
        crossDetected: true,
        crossDirection: candidate.direction,
        regimeDirection: regime.direction,
        regimeStrength: regime.strength,
        confidenceScore: candidate.finalConfidence,
        confidenceBreakdown: {
          regimeAlignment: candidate.confidenceComponents.regimeAlignment,
          setupQuality: candidate.confidenceComponents.setupQuality,
          momentum: candidate.confidenceComponents.momentum,
          structure: candidate.confidenceComponents.structure,
          volume: candidate.confidenceComponents.volume,
          riskPenalty: candidate.confidenceComponents.riskPenalty,
        },
        rejectionReason: "ADX " + f1(adx4h) + " too low, confidence dropped to " + f0(candidate.finalConfidence) + " after penalty",
        stochK: stoch4h.k,
        stochD: stoch4h.d,
        stochPrevK: candidate.stochPrevK,
        stochPrevD: candidate.stochPrevD,
      };
      logRejection(rejectionLog);
      if (DEBUG) debug.push("REJECTED: ADX penalty dropped confidence below EARLY_ENTRY (70)");

      return {
        market: {
          pair,
          price: currentPrice,
          timestamp: now,
          regime,
          adx: adx4h,
          rsi: rsi(candles4h.map(c => c.close)),
          stochK: stoch4h.k,
          stochD: stoch4h.d,
          stoch1hK: candidate.stochK,
          stoch1hD: candidate.stochD,
        },
        debug,
        entryCandidates: candidates,
        rejectionStage: "ADX penalty — confidence " + f0(candidate.finalConfidence) + " below EARLY_ENTRY (70)",
      };
    }
  }

  // Classify entry tier and position size
  const entryTier = classifyEntryTier(candidate.finalConfidence);
  const positionSizePct = getPositionSizePct(entryTier, regime.strength);

  if (entryTier === "NO_TRADE") {
    if (DEBUG) debug.push("REJECTED: confidence " + f1(candidate.finalConfidence) + " below EARLY_ENTRY threshold (70)");
    return {
      market: {
        pair,
        price: currentPrice,
        timestamp: now,
        regime,
        adx: adx4h,
        rsi: rsi(candles4h.map(c => c.close)),
        stochK: stochRsi(candles4h.map(c => c.close)).k,
        stochD: stochRsi(candles4h.map(c => c.close)).d,
        stoch1hK: candidate.stochK,
        stoch1hD: candidate.stochD,
      },
      debug,
      entryCandidates: candidates,
      rejectionStage: "Setup developing (" + f0(candidate.finalConfidence) + "%) — below entry threshold",
    };
  }

  // Check tier lock
  if (isTierLocked(pair, entryTier, now)) {
    if (DEBUG) debug.push("REJECTED: tier lock active for " + pair + ":" + entryTier);
    return {
      market: {
        pair,
        price: currentPrice,
        timestamp: now,
        regime,
        adx: adx4h,
        rsi: rsi(candles4h.map(c => c.close)),
        stochK: stochRsi(candles4h.map(c => c.close)).k,
        stochD: stochRsi(candles4h.map(c => c.close)).d,
        stoch1hK: candidate.stochK,
        stoch1hD: candidate.stochD,
      },
      debug,
      entryCandidates: candidates,
      rejectionStage: entryTier + " alert already sent — waiting for next cycle",
    };
  }

  // Set tier lock
  setTierLock(pair, entryTier, now);

  // Generate signal with tier and sizing
  const signalId = pair + "-" + candidate.direction + "-" + now;
  const signal: Signal = {
    id: signalId,
    pair,
    direction: candidate.direction,
    type: "ENTRY",
    entry: candidate.entryPrice,
    stop,
    target,
    confidence: candidate.finalConfidence,
    entryTier,
    positionSizePct,
    rr,
    adx: adx4h,
    rsi: rsi(candles4h.map(c => c.close)),
    stochK: stochRsi(candles4h.map(c => c.close)).k,
    stochD: stochRsi(candles4h.map(c => c.close)).d,
    stoch1hK: candidate.stochK,
    stoch1hD: candidate.stochD,
    expectedMove: targetDistance,
    reason: candidate.reasons.join(" | "),
    timestamp: now,
    version: CURRENT_SIGNAL_VERSION,
    tradeState: "OPEN",
    regimeDirection: regime.direction,
    regimeSince: regime.detectedAt,
    entryMode: candidate.entryMode,
    confidenceComponents: candidate.confidenceComponents,
    exhaustionWarning: candidate.exhaustionWarning || undefined,
  };

  if (DEBUG) debug.push("SIGNAL: " + candidate.direction + " " + pair + " @ " + f2(candidate.entryPrice) + " tier=" + entryTier + " conf=" + f1(candidate.finalConfidence) + " size=" + f0(positionSizePct * 100) + "% rr=" + f2(rr) + " mode=" + candidate.entryMode);

  return {
    signal,
    market: {
      pair,
      price: currentPrice,
      timestamp: now,
      regime,
      adx: adx4h,
      rsi: rsi(candles4h.map(c => c.close)),
      stochK: stochRsi(candles4h.map(c => c.close)).k,
      stochD: stochRsi(candles4h.map(c => c.close)).d,
      stoch1hK: candidate.stochK,
      stoch1hD: candidate.stochD,
    },
    debug,
    entryCandidates: candidates,
  };
}


// ─── Exit Store ───

const exitStoreById: Map<string, ExitRecord> = new Map();
const exitStoreByPair: Map<string, ExitRecord> = new Map();

let persistExitFn: ((record: ExitRecord) => Promise<void>) | null = null;
let loadExitsFn: (() => Promise<ExitRecord[]>) | null = null;

export function setExitPersistence(persist: (r: ExitRecord) => Promise<void>, load: () => Promise<ExitRecord[]>): void {
  persistExitFn = persist;
  loadExitsFn = load;
}

async function recordExit(signalId: string, pair: string, direction: "LONG" | "SHORT", exitReason: string, exitPrice: number, now: number = Date.now()): Promise<void> {
  const r: ExitRecord = { signalId, pair, direction, exitTimestamp: now, exitReason, exitPrice };
  exitStoreById.set(signalId, r);
  exitStoreByPair.set(pair, r);
  // Clear all tier locks for this pair on exit
  clearTierLocksForPair(pair);
  if (persistExitFn) {
    try { await persistExitFn(r); }
    catch (e) { if (DEBUG) console.error("[EXIT PERSIST] Failed:", e); }
  }
}

export async function loadExits(): Promise<void> {
  if (!loadExitsFn) return;
  try {
    const exits = await loadExitsFn();
    for (const r of exits) {
      exitStoreById.set(r.signalId, r);
      exitStoreByPair.set(r.pair, r);
    }
  } catch (e) { if (DEBUG) console.error("[EXIT LOAD] Failed:", e); }
}

export function hasExited(signalId: string): boolean {
  return exitStoreById.has(signalId);
}

const EXIT_COOLDOWN_MS = 8 * 60 * 60 * 1000;

function isInCooldown(pair: string, now: number, direction?: "LONG" | "SHORT"): { inCooldown: boolean; remainingMs: number } {
  const lastExit = exitStoreByPair.get(pair);
  if (!lastExit) return { inCooldown: false, remainingMs: 0 };
  if (direction && lastExit.direction !== direction) return { inCooldown: false, remainingMs: 0 };
  const elapsed = now - lastExit.exitTimestamp;
  if (elapsed < EXIT_COOLDOWN_MS) {
    return { inCooldown: true, remainingMs: EXIT_COOLDOWN_MS - elapsed };
  }
  return { inCooldown: false, remainingMs: 0 };
}

// ─── Trade Manager ───

export function updateTradeManager(signal: Signal, currentPrice: number): TradeManagerUpdate {
  const highest = Math.max(signal.highestPrice || signal.entry, currentPrice);
  const lowest = Math.min(signal.lowestPrice || signal.entry, currentPrice);
  let state = signal.tradeState || "OPEN";
  let lockedStop = signal.lockedStop || signal.stop;
  let profitLockActive = signal.profitLockActive || false;
  let exitTriggered = false;
  let exitReason: string | undefined;

  const config = getPairConfig(signal.pair);
  const bePct = config.bePct || 0.01;
  const lockPct = config.lockPct || 0.02;
  const runnerPct = config.runnerPct || 0.04;

  const profitPct = signal.direction === "LONG"
    ? (currentPrice - signal.entry) / signal.entry
    : (signal.entry - currentPrice) / signal.entry;

  if (state === "OPEN" && profitPct >= bePct) {
    state = "BREAK_EVEN";
    lockedStop = signal.entry;
  }

  if (state === "BREAK_EVEN" && profitPct >= lockPct) {
    state = "LOCKED";
    profitLockActive = true;
    lockedStop = signal.entry + (signal.direction === "LONG" ? signal.entry * 0.005 : -signal.entry * 0.005);
  }

  if (state === "LOCKED" && profitPct >= runnerPct) {
    state = "RUNNER";
  }

  // Trailing stop for RUNNER
  if (state === "RUNNER" && signal.direction === "LONG") {
    const trailStop = highest * (1 - config.stopLossPct * 0.5);
    if (trailStop > lockedStop) lockedStop = trailStop;
  } else if (state === "RUNNER" && signal.direction === "SHORT") {
    const trailStop = lowest * (1 + config.stopLossPct * 0.5);
    if (trailStop < lockedStop || lockedStop === signal.stop) lockedStop = trailStop;
  }

  // Check stop hit
  if (signal.direction === "LONG" && currentPrice <= lockedStop) {
    exitTriggered = true;
    exitReason = state === "RUNNER" ? "trailing_stop" : "stop_loss";
  } else if (signal.direction === "SHORT" && currentPrice >= lockedStop) {
    exitTriggered = true;
    exitReason = state === "RUNNER" ? "trailing_stop" : "stop_loss";
  }

  // Check target hit
  if (!exitTriggered) {
    if (signal.direction === "LONG" && currentPrice >= signal.target) {
      exitTriggered = true;
      exitReason = "target_hit";
    } else if (signal.direction === "SHORT" && currentPrice <= signal.target) {
      exitTriggered = true;
      exitReason = "target_hit";
    }
  }

  if (exitTriggered) {
    recordExit(signal.id, signal.pair, signal.direction, exitReason!, currentPrice);
  }

  return {
    signalId: signal.id,
    newState: exitTriggered ? "EXITED" : state,
    lockedStop,
    profitLockActive,
    highestPrice: highest,
    lowestPrice: lowest,
    exitTriggered,
    exitReason,
  };
}

// ─── Signal Validity ───

export function isSignalStillValid(signal: Signal, currentPrice: number, now: number = Date.now()): ValidityCheck {
  if (signal.exited || hasExited(signal.id)) return { valid: false, reason: "already_exited", exited: true };
  if (signal.direction === "LONG" && currentPrice <= (signal.lockedStop || signal.stop)) {
    return { valid: false, reason: "stop_hit", exited: true };
  }
  if (signal.direction === "SHORT" && currentPrice >= (signal.lockedStop || signal.stop)) {
    return { valid: false, reason: "stop_hit", exited: true };
  }
  const drift = Math.abs(currentPrice - signal.entry) / signal.entry;
  if (drift > (getPairConfig(signal.pair).maxEntryDriftPct || 0.01)) {
    return { valid: false, reason: "entry_drift_" + f1(drift * 100) + "%", exited: false };
  }
  if (now - signal.timestamp > 4 * 60 * 60 * 1000) {
    return { valid: false, reason: "time_decay", exited: false };
  }
  return { valid: true, reason: "", exited: false };
}

export function isSignalStillValidBool(signal: Signal, currentPrice: number): boolean {
  return isSignalStillValid(signal, currentPrice).valid;
}

// ─── Hold / Position Management ───

export async function shouldHold(signal: Signal, candles4h: Candle[], currentPrice: number): Promise<HoldResult> {
  if (signal.exited || hasExited(signal.id)) return { shouldHold: false, reason: "already_exited" };

  const tmUpdate = updateTradeManager(signal, currentPrice);
  if (tmUpdate.exitTriggered) {
    return { shouldHold: false, reason: tmUpdate.exitReason || "exit_triggered", managedStop: tmUpdate.lockedStop };
  }

  // Regime reversal check
  const candles1d = aggregateTo1D(candles4h);
  const regime = await getRegime(signal.pair, candles1d, candles4h);
  if (regime.direction && regime.direction !== "NEUTRAL" && regime.direction !== signal.direction) {
    if (regime.strength === "STRONG" && regime.confidence > 70) {
      return { shouldHold: false, reason: "regime_reversal_" + regime.direction + "_strong", managedStop: tmUpdate.lockedStop };
    }
  }

  return { shouldHold: true, reason: "hold", managedStop: tmUpdate.lockedStop };
}

// ─── Filter Expired Signals ───

export async function filterExpiredSignals(signals: Signal[], currentPrices: Record<string, number>): Promise<{ active: Signal[]; exited: { signal: Signal; reason: string }[] }> {
  const active: Signal[] = [];
  const exited: { signal: Signal; reason: string }[] = [];
  for (const signal of signals) {
    if (signal.exited || hasExited(signal.id)) continue;
    const price = currentPrices[signal.pair];
    if (!price) { active.push(signal); continue; }
    const check = isSignalStillValid(signal, price);
    if (!check.valid && check.exited) {
      exited.push({ signal, reason: check.reason });
      await recordExit(signal.id, signal.pair, signal.direction, check.reason, price);
    } else if (!check.valid) {
      exited.push({ signal, reason: check.reason });
    } else {
      active.push(signal);
    }
  }
  return { active, exited };
}


// ─── Market Snapshot ───
// CRITICAL: This function does NOT call generateSignal().
// The cron passes the pre-computed SignalResult from its earlier generateSignal() call.
// This prevents duplicate calculation and duplicate logs.

export async function getMarketSnapshot(
  pair: string,
  candles1h: Candle[],
  candles4h: Candle[],
  candles15m: Candle[],
  currentPrice: number,
  precomputedSignalResult?: SignalResult
): Promise<MarketSnapshot> {
  const candles1d = aggregateTo1D(candles4h);
  const stoch4h = stochRsi(candles4h.map(c => c.close));
  const stoch1h = stochRsi(candles1h.map(c => c.close));
  const regime = await getRegime(pair, candles1d, candles4h);

  const trend1h = getTrendContext(candles1h);
  const trend4h = getTrendContext(candles4h);
  const trend1d = getTrendContext(candles1d);

  // Use pre-computed signal result if provided (cron path), otherwise compute (debug path only)
  const signalResult = precomputedSignalResult || (DEBUG ? await generateSignal(pair, candles1h, candles4h, candles15m, currentPrice) : {
    entryCandidates: { pullback: { eligible: false, confidence: 0, rejectionReason: null }, rejection: { eligible: false, confidence: 0, rejectionReason: null }, breakout: { eligible: false, confidence: 0, rejectionReason: null } },
    rejectionStage: null,
  });

  // Detect trend conflict
  const trendConflict = detectTrendConflict(trend1h, trend4h, trend1d);

  // Build regime display with trend conflict override
  let regimeDisplay: RegimeDisplay = {
    direction: regime.direction || "NEUTRAL",
    strength: regime.strength,
    confidence: safeNum(regime.confidence),
    score: safeNum(regime.score),
    reason: regime.reason,
  };

  // Override direction for display when trend conflict detected
  if (trendConflict) {
    regimeDisplay.direction = "TREND_CONFLICT";
  }

  const bestConf = Math.max(
    signalResult.entryCandidates?.pullback?.confidence || 0,
    signalResult.entryCandidates?.rejection?.confidence || 0,
    signalResult.entryCandidates?.breakout?.confidence || 0
  );
  const rec = getRecommendedAction(regime, bestConf);

  // Build "Why no trade?" messages
  const whyNoTrade: string[] = [];
  if (trendConflict) {
    whyNoTrade.push("⚠ Trend Conflict — Waiting for higher timeframe confirmation");
  } else if (signalResult.rejectionStage) {
    whyNoTrade.push("• " + signalResult.rejectionStage);
  } else if (bestConf < 70) {
    whyNoTrade.push("• Setup developing (" + f0(bestConf) + "%)");
  }

  // Determine entry tier from precomputed result
  let entryTier: EntryTier | null = null;
  if (signalResult.signal) {
    entryTier = signalResult.signal.entryTier;
  }

  return {
    pair,
    price: currentPrice,
    trend: regimeDisplay.direction || "NEUTRAL",
    regime: regimeDisplay,
    adx: adx(candles4h),
    rsi: rsi(candles4h.map(c => c.close)),
    stochK: stoch4h.k,
    stochD: stoch4h.d,
    stoch1hK: stoch1h.k,
    stoch1hD: stoch1h.d,
    trend1h,
    trend4h,
    trend1d,
    entryCandidates: signalResult.entryCandidates,
    rejectionStage: signalResult.rejectionStage || null,
    recommendedAction: trendConflict ? "WAIT" : rec.action,
    positionSize: trendConflict ? "Waiting for confirmation" : rec.detail,
    whyNoTrade: whyNoTrade.length > 0 ? whyNoTrade : ["• Waiting for market setup"],
    entryTier,
    trendConflict,
  };
}

// ─── UI Helpers ───

export function getCurrentRegime(pair: string): MarketRegime | null {
  return getRegimeSync(pair);
}
