// lib/strategy.ts — v29.2 CONSISTENCY REFACTOR
// ============================================================
// Entry engine redesigned: Location → Structure → Momentum → Risk
// StochRSI confirms setup, does not create or veto it.
// All regime, exit, risk management, hysteresis, lock, Telegram,
// dashboard, cron and persistence logic UNCHANGED.
//
// NEW: Single Source of Truth — EntryEvaluation object consumed by
//      dashboard, cron, Telegram, logs, and API. No duplicate calculations.
//
// NEW SCORING HIERARCHY (100-point scale):
//   Location Score  : 0-30  (proximity to EMAs, trendlines, swing levels)
//   Structure Score : 0-20  (higher highs/lows, trend integrity, rejection)
//   Momentum Score  : 0-30  (StochRSI turn, MACD, ROC, ADX, volume)
//   Risk Score      : 0-20  (ATR quality, stop distance, RR, volatility)
//
// ENTRY TIERS:
//   WAIT            : 0-49   (no setup)
//   WATCH           : 50-69  (setup developing — shows what's missing)
//   EARLY ENTRY     : 70-84  (33% position)
//   CONFIRMED ENTRY : 85+    (100% position)
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
  /** NEW: Full evaluation object for all consumers */
  evaluation?: EntryEvaluation;
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
  /** NEW: Full diagnostic data */
  evaluation?: EntryEvaluation;
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
  location: number;
  structure: number;
  momentum: number;
  risk: number;
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
  /** NEW: Full evaluation for dashboard */
  evaluation?: EntryEvaluation;
}

export interface RegimeDisplay {
  direction: "LONG" | "SHORT" | "NEUTRAL" | "TREND_CONFLICT" | null;
  strength: string;
  confidence: number;
  score: number;
  reason: string[];
}

// ═══════════════════════════════════════════════════════════
// ═══ NEW v29.2 SINGLE SOURCE OF TRUTH ═══
// ═══════════════════════════════════════════════════════════

/** Single evaluation object consumed by ALL surfaces */
export interface EntryEvaluation {
  pair: string;
  direction: "LONG" | "SHORT" | null;
  entryMode: "PULLBACK" | "REJECTION" | "BREAKOUT" | null;
  tier: EntryTier;
  confidence: number;
  thresholds: {
    wait: number;
    watch: number;
    early: number;
    confirmed: number;
  };
  gapToNextTier: number;
  nextTier: EntryTier | null;
  breakdown: ScoreBreakdown;
  missing: MissingComponent[];
  likelyTriggers: string[];
  reasons: string[];
  stochK: number;
  stochD: number;
  stochPrevK: number;
  stochPrevD: number;
  crossDetected: boolean;
  exhaustionWarning: string;
  exhaustionBlocked: boolean;
  entryPrice: number;
  stopDistance: number;
  targetDistance: number;
  rr: number;
  atrPct: number;
  adx4h: number;
  regimeDirection: "LONG" | "SHORT" | "NEUTRAL" | null;
  regimeStrength: string;
}

export interface ScoreBreakdown {
  location: number;
  locationMax: number;
  structure: number;
  structureMax: number;
  momentum: number;
  momentumMax: number;
  risk: number;
  riskMax: number;
  total: number;
  maxTotal: number;
  /** Individual score contributions for debug */
  contributions: ScoreContribution[];
}

export interface ScoreContribution {
  component: "location" | "structure" | "momentum" | "risk";
  name: string;
  points: number;
  rawValue?: string;
}

export interface MissingComponent {
  component: string;
  pointsNeeded: number;
  description: string;
}

export type EntryTier = "NO_TRADE" | "WATCH" | "EARLY_ENTRY" | "CONFIRMED_ENTRY";

// ─── SAFE NUMBER FORMATTING ───

function safeNum(v: any): number {
  const n = Number(v);
  return isFinite(n) ? n : 0;
}

function f0(v: any): string { return safeNum(v).toFixed(0); }
function f1(v: any): string { return safeNum(v).toFixed(1); }
function f2(v: any): string { return safeNum(v).toFixed(2); }
function f3(v: any): string { return safeNum(v).toFixed(3); }

// ─── TRADER-FRIENDLY MESSAGES (REFACTORED) ───

/** Maps internal reason keys to human-readable explanations */
const REASON_MAP: Record<string, string> = {
  "regime_neutral": "No directional bias — regime is neutral",
  "cooldown_active": "Position cooldown active",
  "confidence_too_low": "Setup developing — score below entry threshold",
  "location_weak": "Price not at optimal location (far from EMAs/swing levels)",
  "structure_broken": "Market structure compromised (lower low / higher high)",
  "momentum_missing": "Momentum confirmation pending — StochRSI not aligned",
  "risk_too_high": "Risk parameters unfavorable (ATR spike, poor RR)",
  "adx_weak": "Market lacks strength — ADX below minimum",
  "high_volatility": "Volatility too high — risk control active",
  "time_decay": "Signal expired — entry window closed",
  "entry_drift": "Entry price moved away from signal",
  "already_exited": "Position already closed",
  "stop_hit": "Stop loss triggered",
  "target_hit": "Target reached",
  "trailing_stop": "Trailing stop triggered",
  "regime_reversal": "Trend reversed — exiting position",
  "exhaustion_block": "Market exhausted — cooling off",
  "rr_too_low": "Risk:Reward too low",
  "tier_locked": "Entry tier alert already sent — waiting for next cycle",
  "exhaustion_4h_overbought": "4H extreme overbought — buyers exhausted",
  "exhaustion_4h_oversold": "4H extreme oversold — sellers exhausted",
};

function getTraderReason(internalReason: string | null): string {
  if (!internalReason) return "Analyzing market conditions...";
  for (const [key, value] of Object.entries(REASON_MAP)) {
    if (internalReason.includes(key)) return value;
  }
  return internalReason;
}

// ─── ENTRY TIER & POSITION SIZING ───

const TIER_THRESHOLDS = {
  WAIT: 0,
  WATCH: 50,
  EARLY: 70,
  CONFIRMED: 85,
};

function classifyEntryTier(confidence: number): EntryTier {
  if (confidence >= TIER_THRESHOLDS.CONFIRMED) return "CONFIRMED_ENTRY";
  if (confidence >= TIER_THRESHOLDS.EARLY) return "EARLY_ENTRY";
  if (confidence >= TIER_THRESHOLDS.WATCH) return "WATCH";
  return "NO_TRADE";
}

function getTierGap(currentTier: EntryTier, confidence: number): { gap: number; nextTier: EntryTier | null } {
  switch (currentTier) {
    case "NO_TRADE": return { gap: TIER_THRESHOLDS.WATCH - confidence, nextTier: "WATCH" };
    case "WATCH": return { gap: TIER_THRESHOLDS.EARLY - confidence, nextTier: "EARLY_ENTRY" };
    case "EARLY_ENTRY": return { gap: TIER_THRESHOLDS.CONFIRMED - confidence, nextTier: "CONFIRMED_ENTRY" };
    case "CONFIRMED_ENTRY": return { gap: 0, nextTier: null };
  }
}

function getPositionSizePct(tier: EntryTier, _regimeStrength: string): number {
  if (tier === "NO_TRADE" || tier === "WATCH") return 0;
  if (tier === "EARLY_ENTRY") return 0.33;
  if (tier === "CONFIRMED_ENTRY") return 1.0;
  return 0;
}

// ─── RECOMMENDED ACTION (REFACTORED — consumes EntryEvaluation) ───

interface RecommendedAction {
  action: string;
  detail: string;
  missing: string[];
  progressPct: number;
}

function getRecommendedActionFromEvaluation(evaluation: EntryEvaluation): RecommendedAction {
  const { tier, confidence, gapToNextTier, nextTier, missing } = evaluation;

  const progressPct = Math.min(100, Math.round((confidence / TIER_THRESHOLDS.CONFIRMED) * 100));

  if (!evaluation.direction || evaluation.regimeDirection === "NEUTRAL") {
    return { action: "WAIT", detail: "No directional bias", missing: [], progressPct: 0 };
  }

  if (tier === "NO_TRADE") {
    return {
      action: "WAIT",
      detail: `Score ${f0(confidence)}/100 — need +${f0(gapToNextTier)} for ${nextTier?.replace("_", " ") || "entry"}`,
      missing: missing.map(m => `${m.component}: need +${m.pointsNeeded} (${m.description})`),
      progressPct,
    };
  }

  if (tier === "WATCH") {
    return {
      action: "WATCH",
      detail: `Setup developing at ${f0(confidence)}/100 — need +${f0(gapToNextTier)} for ${nextTier?.replace("_", " ") || "entry"}`,
      missing: missing.map(m => `${m.component}: need +${m.pointsNeeded} (${m.description})`),
      progressPct,
    };
  }

  if (tier === "EARLY_ENTRY") {
    const size = evaluation.regimeStrength === "STRONG" ? "33% Position" : evaluation.regimeStrength === "MODERATE" ? "25% Position" : "20% Position";
    return {
      action: "EARLY ENTRY",
      detail: size,
      missing: missing.map(m => `${m.component}: need +${m.pointsNeeded} for CONFIRMED`),
      progressPct,
    };
  }

  if (tier === "CONFIRMED_ENTRY") {
    const size = evaluation.regimeStrength === "STRONG" ? "Full Position" : evaluation.regimeStrength === "MODERATE" ? "75% Position" : "50% Position";
    return {
      action: "CONFIRMED ENTRY",
      detail: size,
      missing: [],
      progressPct: 100,
    };
  }

  return { action: "WAIT", detail: "Market conditions not favorable", missing: [], progressPct: 0 };
}

// ─── TIER LOCK SYSTEM ───

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


// ═══════════════════════════════════════════════════════════
// ═══ NEW v29.2 ENTRY SCORING ENGINE ═══
// ═══════════════════════════════════════════════════════════
//
// Architecture: Location → Structure → Momentum → Risk
// StochRSI confirms, does not create or veto.
//
// ═══════════════════════════════════════════════════════════

// ─── 1. LOCATION SCORE (0-30) ───
// Price proximity to key levels: EMAs, trendlines, swing levels

function scoreLocation(
  candles1h: Candle[],
  candles4h: Candle[],
  direction: "LONG" | "SHORT",
  _config: PairConfig
): { score: number; reasons: string[]; contributions: ScoreContribution[] } {
  const reasons: string[] = [];
  const contributions: ScoreContribution[] = [];
  let score = 0;

  const closes = candles1h.map(c => c.close);
  const lastClose = closes[closes.length - 1];

  // EMA proximity on 1H
  const ema21_1h = ema(closes, 21);
  const ema50_1h = ema(closes, 50);

  if (ema21_1h.length > 0 && ema50_1h.length > 0) {
    const e21 = ema21_1h[ema21_1h.length - 1];
    const e50 = ema50_1h[ema50_1h.length - 1];
    const prevE21 = ema21_1h.length > 1 ? ema21_1h[ema21_1h.length - 2] : e21;
    const slope21 = e21 - prevE21;

    // Rising EMA21 (trendline proxy) — LONG
    if (direction === "LONG" && slope21 > 0) {
      const distFromE21 = Math.abs(lastClose - e21) / e21;
      if (distFromE21 < 0.01) {
        score += 10;
        reasons.push("loc_ema21_touch:+10 (" + f2(distFromE21 * 100) + "% away)");
        contributions.push({ component: "location", name: "EMA21 touch", points: 10, rawValue: f2(distFromE21 * 100) + "%" });
      }
      else if (distFromE21 < 0.02) {
        score += 7;
        reasons.push("loc_ema21_near:+7 (" + f2(distFromE21 * 100) + "% away)");
        contributions.push({ component: "location", name: "EMA21 near", points: 7, rawValue: f2(distFromE21 * 100) + "%" });
      }
      else if (distFromE21 < 0.035) {
        score += 4;
        reasons.push("loc_ema21_close:+4 (" + f2(distFromE21 * 100) + "% away)");
        contributions.push({ component: "location", name: "EMA21 close", points: 4, rawValue: f2(distFromE21 * 100) + "%" });
      }

      const distFromE50 = Math.abs(lastClose - e50) / e50;
      if (distFromE50 < 0.015) {
        score += 5;
        reasons.push("loc_ema50_near:+5");
        contributions.push({ component: "location", name: "EMA50 near", points: 5, rawValue: f2(distFromE50 * 100) + "%" });
      }
      else if (distFromE50 < 0.03) {
        score += 3;
        reasons.push("loc_ema50_close:+3");
        contributions.push({ component: "location", name: "EMA50 close", points: 3, rawValue: f2(distFromE50 * 100) + "%" });
      }

      // Price between EMA21 and EMA50 (value area)
      if (lastClose < e21 && lastClose > e50 && e21 > e50) {
        score += 5;
        reasons.push("loc_value_area:+5 (between EMA21/EMA50)");
        contributions.push({ component: "location", name: "Value area", points: 5 });
      }
    }

    // Falling EMA21 — SHORT
    if (direction === "SHORT" && slope21 < 0) {
      const distFromE21 = Math.abs(lastClose - e21) / e21;
      if (distFromE21 < 0.01) {
        score += 10;
        reasons.push("loc_ema21_touch:+10");
        contributions.push({ component: "location", name: "EMA21 touch", points: 10, rawValue: f2(distFromE21 * 100) + "%" });
      }
      else if (distFromE21 < 0.02) {
        score += 7;
        reasons.push("loc_ema21_near:+7");
        contributions.push({ component: "location", name: "EMA21 near", points: 7, rawValue: f2(distFromE21 * 100) + "%" });
      }
      else if (distFromE21 < 0.035) {
        score += 4;
        reasons.push("loc_ema21_close:+4");
        contributions.push({ component: "location", name: "EMA21 close", points: 4, rawValue: f2(distFromE21 * 100) + "%" });
      }

      const distFromE50 = Math.abs(lastClose - e50) / e50;
      if (distFromE50 < 0.015) {
        score += 5;
        reasons.push("loc_ema50_near:+5");
        contributions.push({ component: "location", name: "EMA50 near", points: 5, rawValue: f2(distFromE50 * 100) + "%" });
      }
      else if (distFromE50 < 0.03) {
        score += 3;
        reasons.push("loc_ema50_close:+3");
        contributions.push({ component: "location", name: "EMA50 close", points: 3, rawValue: f2(distFromE50 * 100) + "%" });
      }

      if (lastClose > e21 && lastClose < e50 && e21 < e50) {
        score += 5;
        reasons.push("loc_value_area:+5 (between EMA21/EMA50)");
        contributions.push({ component: "location", name: "Value area", points: 5 });
      }
    }
  }

  // 4H EMA proximity (higher timeframe anchor)
  const closes4h = candles4h.map(c => c.close);
  const ema21_4h = ema(closes4h, 21);
  const ema50_4h = ema(closes4h, 50);
  if (ema21_4h.length > 0) {
    const e21_4h = ema21_4h[ema21_4h.length - 1];
    const dist4h = Math.abs(lastClose - e21_4h) / e21_4h;
    if (dist4h < 0.02) {
      score += 5;
      reasons.push("loc_4h_ema21_near:+5");
      contributions.push({ component: "location", name: "4H EMA21 near", points: 5, rawValue: f2(dist4h * 100) + "%" });
    }
  }

  // Swing level proximity
  const swingLow = lowest(candles1h.map(c => c.low), 20);
  const swingHigh = highest(candles1h.map(c => c.high), 20);

  if (direction === "LONG") {
    const distFromSwingLow = (lastClose - swingLow) / swingLow;
    if (distFromSwingLow < 0.015) {
      score += 5;
      reasons.push("loc_swing_low:+5 (" + f2(distFromSwingLow * 100) + "% above)");
      contributions.push({ component: "location", name: "Swing low proximity", points: 5, rawValue: f2(distFromSwingLow * 100) + "%" });
    }
    else if (distFromSwingLow < 0.03) {
      score += 3;
      reasons.push("loc_swing_low_near:+3");
      contributions.push({ component: "location", name: "Swing low near", points: 3, rawValue: f2(distFromSwingLow * 100) + "%" });
    }
  } else {
    const distFromSwingHigh = (swingHigh - lastClose) / swingHigh;
    if (distFromSwingHigh < 0.015) {
      score += 5;
      reasons.push("loc_swing_high:+5 (" + f2(distFromSwingHigh * 100) + "% below)");
      contributions.push({ component: "location", name: "Swing high proximity", points: 5, rawValue: f2(distFromSwingHigh * 100) + "%" });
    }
    else if (distFromSwingHigh < 0.03) {
      score += 3;
      reasons.push("loc_swing_high_near:+3");
      contributions.push({ component: "location", name: "Swing high near", points: 3, rawValue: f2(distFromSwingHigh * 100) + "%" });
    }
  }

  return { score: Math.min(30, score), reasons, contributions };
}

// ─── 2. STRUCTURE SCORE (0-20) ───
// Market structure: higher highs/lows, trend integrity, rejection patterns

function scoreStructure(
  candles1h: Candle[],
  candles4h: Candle[],
  direction: "LONG" | "SHORT"
): { score: number; reasons: string[]; isBroken: boolean; contributions: ScoreContribution[] } {
  const reasons: string[] = [];
  const contributions: ScoreContribution[] = [];
  let score = 0;
  let isBroken = false;

  const closes = candles1h.map(c => c.close);
  const highs = candles1h.map(c => c.high);
  const lows = candles1h.map(c => c.low);
  const lastClose = closes[closes.length - 1];

  // Higher lows / lower highs check (last 10 candles)
  const recentLows = lows.slice(-10);
  const recentHighs = highs.slice(-10);

  if (direction === "LONG") {
    // Check for higher lows
    let higherLowsCount = 0;
    for (let i = 1; i < recentLows.length; i++) {
      if (recentLows[i] > recentLows[i - 1]) higherLowsCount++;
    }
    if (higherLowsCount >= 4) {
      score += 5;
      reasons.push("struct_higher_lows:+5 (" + higherLowsCount + "/9)");
      contributions.push({ component: "structure", name: "Higher lows", points: 5, rawValue: higherLowsCount + "/9" });
    }
    else if (higherLowsCount >= 2) {
      score += 3;
      reasons.push("struct_higher_lows_weak:+3 (" + higherLowsCount + "/9)");
      contributions.push({ component: "structure", name: "Higher lows (weak)", points: 3, rawValue: higherLowsCount + "/9" });
    }

    // Check for higher highs
    let higherHighsCount = 0;
    for (let i = 1; i < recentHighs.length; i++) {
      if (recentHighs[i] > recentHighs[i - 1]) higherHighsCount++;
    }
    if (higherHighsCount >= 4) {
      score += 5;
      reasons.push("struct_higher_highs:+5 (" + higherHighsCount + "/9)");
      contributions.push({ component: "structure", name: "Higher highs", points: 5, rawValue: higherHighsCount + "/9" });
    }
    else if (higherHighsCount >= 2) {
      score += 3;
      reasons.push("struct_higher_highs_weak:+3 (" + higherHighsCount + "/9)");
      contributions.push({ component: "structure", name: "Higher highs (weak)", points: 3, rawValue: higherHighsCount + "/9" });
    }

    // No lower low (structure intact)
    const prevSwingLow = lowest(lows.slice(-20, -1), 10);
    if (lastClose > prevSwingLow) {
      score += 5;
      reasons.push("struct_no_lower_low:+5");
      contributions.push({ component: "structure", name: "No lower low", points: 5 });
    } else {
      score -= 10;
      reasons.push("struct_lower_low:-10 (BROKEN)");
      contributions.push({ component: "structure", name: "Lower low (broken)", points: -10 });
      isBroken = true;
    }

    // Bullish close (close near high of candle)
    const lastCandle = candles1h[candles1h.length - 1];
    const bodyPct = (lastCandle.close - lastCandle.open) / (lastCandle.high - lastCandle.low || 1);
    if (bodyPct > 0.6) {
      score += 3;
      reasons.push("struct_bullish_body:+3");
      contributions.push({ component: "structure", name: "Bullish body", points: 3, rawValue: f2(bodyPct) });
    }
    else if (bodyPct < -0.3) {
      score -= 5;
      reasons.push("struct_bearish_body:-5");
      contributions.push({ component: "structure", name: "Bearish body", points: -5, rawValue: f2(bodyPct) });
    }

    // Rejection wick at support
    const lowerWick = Math.min(lastCandle.close, lastCandle.open) - lastCandle.low;
    const candleRange = lastCandle.high - lastCandle.low;
    if (candleRange > 0 && lowerWick / candleRange > 0.4) {
      score += 2;
      reasons.push("struct_rejection_wick:+2");
      contributions.push({ component: "structure", name: "Rejection wick", points: 2, rawValue: f2(lowerWick / candleRange) });
    }

  } else {
    // SHORT direction
    let lowerHighsCount = 0;
    for (let i = 1; i < recentHighs.length; i++) {
      if (recentHighs[i] < recentHighs[i - 1]) lowerHighsCount++;
    }
    if (lowerHighsCount >= 4) {
      score += 5;
      reasons.push("struct_lower_highs:+5");
      contributions.push({ component: "structure", name: "Lower highs", points: 5, rawValue: lowerHighsCount + "/9" });
    }
    else if (lowerHighsCount >= 2) {
      score += 3;
      reasons.push("struct_lower_highs_weak:+3");
      contributions.push({ component: "structure", name: "Lower highs (weak)", points: 3, rawValue: lowerHighsCount + "/9" });
    }

    let lowerLowsCount = 0;
    for (let i = 1; i < recentLows.length; i++) {
      if (recentLows[i] < recentLows[i - 1]) lowerLowsCount++;
    }
    if (lowerLowsCount >= 4) {
      score += 5;
      reasons.push("struct_lower_lows:+5");
      contributions.push({ component: "structure", name: "Lower lows", points: 5, rawValue: lowerLowsCount + "/9" });
    }
    else if (lowerLowsCount >= 2) {
      score += 3;
      reasons.push("struct_lower_lows_weak:+3");
      contributions.push({ component: "structure", name: "Lower lows (weak)", points: 3, rawValue: lowerLowsCount + "/9" });
    }

    const prevSwingHigh = highest(highs.slice(-20, -1), 10);
    if (lastClose < prevSwingHigh) {
      score += 5;
      reasons.push("struct_no_higher_high:+5");
      contributions.push({ component: "structure", name: "No higher high", points: 5 });
    } else {
      score -= 10;
      reasons.push("struct_higher_high:-10 (BROKEN)");
      contributions.push({ component: "structure", name: "Higher high (broken)", points: -10 });
      isBroken = true;
    }

    const lastCandle = candles1h[candles1h.length - 1];
    const bodyPct = (lastCandle.close - lastCandle.open) / (lastCandle.high - lastCandle.low || 1);
    if (bodyPct < -0.6) {
      score += 3;
      reasons.push("struct_bearish_body:+3");
      contributions.push({ component: "structure", name: "Bearish body", points: 3, rawValue: f2(bodyPct) });
    }
    else if (bodyPct > 0.3) {
      score -= 5;
      reasons.push("struct_bullish_body:-5");
      contributions.push({ component: "structure", name: "Bullish body", points: -5, rawValue: f2(bodyPct) });
    }

    const upperWick = lastCandle.high - Math.max(lastCandle.close, lastCandle.open);
    const candleRange = lastCandle.high - lastCandle.low;
    if (candleRange > 0 && upperWick / candleRange > 0.4) {
      score += 2;
      reasons.push("struct_rejection_wick:+2");
      contributions.push({ component: "structure", name: "Rejection wick", points: 2, rawValue: f2(upperWick / candleRange) });
    }
  }

  // 4H trend integrity
  const closes4h = candles4h.map(c => c.close);
  const ema21_4h = ema(closes4h, 21);
  const ema50_4h = ema(closes4h, 50);
  if (ema21_4h.length > 1 && ema50_4h.length > 0) {
    const e21_4h = ema21_4h[ema21_4h.length - 1];
    const e50_4h = ema50_4h[ema50_4h.length - 1];
    const prevE21_4h = ema21_4h[ema21_4h.length - 2];
    const slope4h = e21_4h - prevE21_4h;

    if (direction === "LONG" && e21_4h > e50_4h && slope4h > 0) {
      score += 5;
      reasons.push("struct_4h_trend_intact:+5");
      contributions.push({ component: "structure", name: "4H trend intact", points: 5 });
    } else if (direction === "SHORT" && e21_4h < e50_4h && slope4h < 0) {
      score += 5;
      reasons.push("struct_4h_trend_intact:+5");
      contributions.push({ component: "structure", name: "4H trend intact", points: 5 });
    } else if (direction === "LONG" && e21_4h < e50_4h) {
      score -= 5;
      reasons.push("struct_4h_trend_weak:-5");
      contributions.push({ component: "structure", name: "4H trend weak", points: -5 });
    } else if (direction === "SHORT" && e21_4h > e50_4h) {
      score -= 5;
      reasons.push("struct_4h_trend_weak:-5");
      contributions.push({ component: "structure", name: "4H trend weak", points: -5 });
    }
  }

  return { score: Math.min(20, Math.max(-20, score)), reasons, isBroken, contributions };
}

// ─── 3. MOMENTUM SCORE (0-30) ───
// StochRSI turn, MACD, ROC, ADX, volume — confirms existing setup

function scoreMomentum(
  candles1h: Candle[],
  candles4h: Candle[],
  direction: "LONG" | "SHORT",
  config: PairConfig
): { score: number; reasons: string[]; stochK: number; stochD: number; stochPrevK: number; stochPrevD: number; crossDetected: boolean; contributions: ScoreContribution[] } {
  const reasons: string[] = [];
  const contributions: ScoreContribution[] = [];
  let score = 0;

  const closes = candles1h.map(c => c.close);
  const volumes = candles1h.map(c => c.volume);

  const stoch = stochRsi(closes);
  const stochPrev = stochRsi(closes.slice(0, -1));

  const crossUp = stochPrev.k <= stochPrev.d && stoch.k > stoch.d;
  const crossDown = stochPrev.k >= stochPrev.d && stoch.k < stoch.d;
  const crossDetected = direction === "LONG" ? crossUp : crossDown;

  // StochRSI — CONFIRMS, does not veto
  if (direction === "LONG") {
    if (crossUp) {
      score += 10;
      reasons.push("mom_stoch_cross_up:+10 (K=" + f1(stoch.k) + ", D=" + f1(stoch.d) + ")");
      contributions.push({ component: "momentum", name: "StochRSI cross up", points: 10, rawValue: "K=" + f1(stoch.k) + " D=" + f1(stoch.d) });
    } else if (stoch.k > stoch.d && stoch.k < 80) {
      score += 5;
      reasons.push("mom_stoch_bullish:+5 (K>D, not overbought)");
      contributions.push({ component: "momentum", name: "StochRSI bullish", points: 5, rawValue: "K=" + f1(stoch.k) + " D=" + f1(stoch.d) });
    } else if (stoch.k > 80) {
      score += 2;
      reasons.push("mom_stoch_extended:+2 (overbought but trending)");
      contributions.push({ component: "momentum", name: "StochRSI extended", points: 2, rawValue: "K=" + f1(stoch.k) });
    } else {
      score += 1;
      reasons.push("mom_stoch_neutral:+1 (waiting for turn)");
      contributions.push({ component: "momentum", name: "StochRSI neutral", points: 1, rawValue: "K=" + f1(stoch.k) + " D=" + f1(stoch.d) });
    }
  } else {
    if (crossDown) {
      score += 10;
      reasons.push("mom_stoch_cross_down:+10");
      contributions.push({ component: "momentum", name: "StochRSI cross down", points: 10, rawValue: "K=" + f1(stoch.k) + " D=" + f1(stoch.d) });
    } else if (stoch.k < stoch.d && stoch.k > 20) {
      score += 5;
      reasons.push("mom_stoch_bearish:+5 (K<D, not oversold)");
      contributions.push({ component: "momentum", name: "StochRSI bearish", points: 5, rawValue: "K=" + f1(stoch.k) + " D=" + f1(stoch.d) });
    } else if (stoch.k < 20) {
      score += 2;
      reasons.push("mom_stoch_extended:+2 (oversold but trending)");
      contributions.push({ component: "momentum", name: "StochRSI extended", points: 2, rawValue: "K=" + f1(stoch.k) });
    } else {
      score += 1;
      reasons.push("mom_stoch_neutral:+1");
      contributions.push({ component: "momentum", name: "StochRSI neutral", points: 1, rawValue: "K=" + f1(stoch.k) + " D=" + f1(stoch.d) });
    }
  }

  // ROC (rate of change)
  const roc = ((closes[closes.length - 1] - closes[closes.length - 4]) / closes[closes.length - 4]) * 100;
  if (direction === "LONG" && roc > 0) {
    const rocPoints = Math.min(8, roc * 2);
    score += rocPoints;
    reasons.push("mom_roc:+" + f0(rocPoints) + " (" + f1(roc) + "%)");
    contributions.push({ component: "momentum", name: "ROC positive", points: rocPoints, rawValue: f1(roc) + "%" });
  } else if (direction === "SHORT" && roc < 0) {
    const rocPoints = Math.min(8, Math.abs(roc) * 2);
    score += rocPoints;
    reasons.push("mom_roc:+" + f0(rocPoints) + " (" + f1(roc) + "%)");
    contributions.push({ component: "momentum", name: "ROC negative", points: rocPoints, rawValue: f1(roc) + "%" });
  } else if (Math.abs(roc) > 3) {
    score -= 3;
    reasons.push("mom_roc_against:-3 (" + f1(roc) + "%)");
    contributions.push({ component: "momentum", name: "ROC against", points: -3, rawValue: f1(roc) + "%" });
  }

  // Volume confirmation
  const recentVol = avg(volumes.slice(-3));
  const avgVol = avg(volumes.slice(-20));
  if (recentVol > avgVol * config.volumeMultiplier) {
    score += 5;
    reasons.push("mom_volume_spike:+5 (" + f1(recentVol / avgVol) + "x avg)");
    contributions.push({ component: "momentum", name: "Volume spike", points: 5, rawValue: f1(recentVol / avgVol) + "x" });
  } else if (recentVol > avgVol * 1.1) {
    score += 2;
    reasons.push("mom_volume_above:+2 (" + f1(recentVol / avgVol) + "x avg)");
    contributions.push({ component: "momentum", name: "Volume above avg", points: 2, rawValue: f1(recentVol / avgVol) + "x" });
  }

  // ADX improving
  const adx1h = adx(candles1h);
  if (adx1h > config.minADX) {
    score += 5;
    reasons.push("mom_adx_strong:+5 (" + f1(adx1h) + ")");
    contributions.push({ component: "momentum", name: "ADX strong", points: 5, rawValue: f1(adx1h) });
  } else if (adx1h > config.minADX * 0.7) {
    score += 2;
    reasons.push("mom_adx_moderate:+2 (" + f1(adx1h) + ")");
    contributions.push({ component: "momentum", name: "ADX moderate", points: 2, rawValue: f1(adx1h) });
  }

  // 4H momentum alignment
  const closes4h = candles4h.map(c => c.close);
  const stoch4h = stochRsi(closes4h);
  if (direction === "LONG" && stoch4h.k > stoch4h.d) {
    score += 3;
    reasons.push("mom_4h_stoch_aligned:+3");
    contributions.push({ component: "momentum", name: "4H Stoch aligned", points: 3, rawValue: "K=" + f1(stoch4h.k) + " D=" + f1(stoch4h.d) });
  } else if (direction === "SHORT" && stoch4h.k < stoch4h.d) {
    score += 3;
    reasons.push("mom_4h_stoch_aligned:+3");
    contributions.push({ component: "momentum", name: "4H Stoch aligned", points: 3, rawValue: "K=" + f1(stoch4h.k) + " D=" + f1(stoch4h.d) });
  }

  return {
    score: Math.min(30, score),
    reasons,
    stochK: stoch.k,
    stochD: stoch.d,
    stochPrevK: stochPrev.k,
    stochPrevD: stochPrev.d,
    crossDetected,
    contributions,
  };
}

// ─── 4. RISK SCORE (0-20) ───
// ATR quality, stop distance, RR, volatility

function scoreRisk(
  candles1h: Candle[],
  candles4h: Candle[],
  direction: "LONG" | "SHORT",
  config: PairConfig,
  entryPrice: number
): { score: number; reasons: string[]; stopDistance: number; targetDistance: number; rr: number; atrPct: number; contributions: ScoreContribution[] } {
  const reasons: string[] = [];
  const contributions: ScoreContribution[] = [];
  let score = 0;

  const closes = candles1h.map(c => c.close);
  const lastClose = closes[closes.length - 1];

  const atr = avg(candles1h.slice(-14).map(c => c.high - c.low));
  const atrPct = atr / lastClose;

  // ATR quality
  if (atrPct < 0.015) {
    score += 8;
    reasons.push("risk_atr_low:+8 (" + f2(atrPct * 100) + "%)");
    contributions.push({ component: "risk", name: "ATR low", points: 8, rawValue: f2(atrPct * 100) + "%" });
  } else if (atrPct < 0.025) {
    score += 5;
    reasons.push("risk_atr_normal:+5 (" + f2(atrPct * 100) + "%)");
    contributions.push({ component: "risk", name: "ATR normal", points: 5, rawValue: f2(atrPct * 100) + "%" });
  } else if (atrPct < 0.04) {
    score += 2;
    reasons.push("risk_atr_elevated:+2 (" + f2(atrPct * 100) + "%)");
    contributions.push({ component: "risk", name: "ATR elevated", points: 2, rawValue: f2(atrPct * 100) + "%" });
  } else {
    score -= 5;
    reasons.push("risk_atr_high:-5 (" + f2(atrPct * 100) + "%)");
    contributions.push({ component: "risk", name: "ATR high", points: -5, rawValue: f2(atrPct * 100) + "%" });
  }

  // Stop distance quality
  const stopDistance = Math.max(atr * 2, entryPrice * config.stopLossPct);
  const targetDistance = stopDistance * MIN_RR;
  const rr = targetDistance / stopDistance;

  if (rr >= 3.0) {
    score += 7;
    reasons.push("risk_rr_excellent:+7 (" + f2(rr) + ")");
    contributions.push({ component: "risk", name: "RR excellent", points: 7, rawValue: f2(rr) });
  } else if (rr >= 2.0) {
    score += 5;
    reasons.push("risk_rr_good:+5 (" + f2(rr) + ")");
    contributions.push({ component: "risk", name: "RR good", points: 5, rawValue: f2(rr) });
  } else if (rr >= MIN_RR) {
    score += 3;
    reasons.push("risk_rr_acceptable:+3 (" + f2(rr) + ")");
    contributions.push({ component: "risk", name: "RR acceptable", points: 3, rawValue: f2(rr) });
  } else {
    score -= 10;
    reasons.push("risk_rr_poor:-10 (" + f2(rr) + " < " + MIN_RR + ")");
    contributions.push({ component: "risk", name: "RR poor", points: -10, rawValue: f2(rr) });
  }

  // Volatility check (recent vs historical)
  const recentRange = avg(candles1h.slice(-3).map(c => (c.high - c.low) / c.close));
  const historicalRange = avg(candles1h.slice(-20, -3).map(c => (c.high - c.low) / c.close));
  if (recentRange < historicalRange * 1.5) {
    score += 3;
    reasons.push("risk_vol_stable:+3");
    contributions.push({ component: "risk", name: "Volatility stable", points: 3 });
  } else if (recentRange > historicalRange * 2.5) {
    score -= 5;
    reasons.push("risk_vol_spike:-5");
    contributions.push({ component: "risk", name: "Volatility spike", points: -5, rawValue: f2(recentRange / historicalRange) + "x" });
  }

  // Position near logical stop level
  if (direction === "LONG") {
    const recentLow = lowest(candles1h.map(c => c.low), 10);
    const stopAboveLow = (entryPrice - stopDistance) > recentLow * 0.995;
    if (stopAboveLow) {
      score += 2;
      reasons.push("risk_stop_logical:+2 (above recent low)");
      contributions.push({ component: "risk", name: "Stop logical", points: 2 });
    }
  } else {
    const recentHigh = highest(candles1h.map(c => c.high), 10);
    const stopBelowHigh = (entryPrice + stopDistance) < recentHigh * 1.005;
    if (stopBelowHigh) {
      score += 2;
      reasons.push("risk_stop_logical:+2 (below recent high)");
      contributions.push({ component: "risk", name: "Stop logical", points: 2 });
    }
  }

  return {
    score: Math.min(20, Math.max(-20, score)),
    reasons,
    stopDistance,
    targetDistance,
    rr,
    atrPct,
    contributions,
  };
}


// ─── EXHAUSTION CHECK (UNCHANGED) ───

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

// ─── MISSING COMPONENTS ANALYZER ───

function analyzeMissingComponents(
  location: { score: number; contributions: ScoreContribution[] },
  structure: { score: number; contributions: ScoreContribution[] },
  momentum: { score: number; contributions: ScoreContribution[] },
  risk: { score: number; contributions: ScoreContribution[] },
  direction: "LONG" | "SHORT",
  crossDetected: boolean
): { missing: MissingComponent[]; likelyTriggers: string[] } {
  const missing: MissingComponent[] = [];
  const likelyTriggers: string[] = [];

  // Location gaps
  const locationGap = 30 - location.score;
  if (locationGap > 5) {
    missing.push({
      component: "Location",
      pointsNeeded: locationGap,
      description: "Price not near optimal entry zone (EMAs/swing levels)"
    });
  }

  // Structure gaps
  const structureGap = 20 - structure.score;
  if (structureGap > 3) {
    const hasBroken = structure.contributions.some(c => c.name.includes("broken"));
    if (hasBroken) {
      missing.push({
        component: "Structure",
        pointsNeeded: structureGap,
        description: "Market structure broken — need higher lows/highs to form"
      });
    } else {
      missing.push({
        component: "Structure",
        pointsNeeded: structureGap,
        description: "Structure developing — waiting for confirmation"
      });
    }
  }

  // Momentum gaps
  const momentumGap = 30 - momentum.score;
  if (momentumGap > 5) {
    if (!crossDetected) {
      missing.push({
        component: "Momentum",
        pointsNeeded: momentumGap,
        description: "StochRSI cross pending — waiting for momentum turn"
      });
      likelyTriggers.push(direction === "LONG" ? "Bullish StochRSI cross" : "Bearish StochRSI cross");
    } else {
      const hasVolume = momentum.contributions.some(c => c.name.includes("Volume"));
      if (!hasVolume) {
        missing.push({
          component: "Momentum",
          pointsNeeded: momentumGap,
          description: "Volume confirmation missing"
        });
        likelyTriggers.push("Volume expansion");
      }
      const hasAdx = momentum.contributions.some(c => c.name.includes("ADX"));
      if (!hasAdx) {
        missing.push({
          component: "Momentum",
          pointsNeeded: Math.min(momentumGap, 5),
          description: "ADX below threshold — trend strength weak"
        });
        likelyTriggers.push("ADX strengthening above " + f0(15));
      }
    }
  }

  // Risk gaps
  const riskGap = 20 - risk.score;
  if (riskGap > 3) {
    const atrHigh = risk.contributions.some(c => c.name === "ATR high");
    if (atrHigh) {
      missing.push({
        component: "Risk",
        pointsNeeded: riskGap,
        description: "ATR too high — volatility unfavorable"
      });
      likelyTriggers.push("Volatility contraction");
    }
    const rrPoor = risk.contributions.some(c => c.name === "RR poor");
    if (rrPoor) {
      missing.push({
        component: "Risk",
        pointsNeeded: riskGap,
        description: "Risk:Reward below minimum " + MIN_RR
      });
    }
  }

  return { missing, likelyTriggers };
}

// ─── REJECTION LOGGING (DEBUG ONLY) ───

const rejectionLogs: RejectionLog[] = [];
const MAX_REJECTION_LOGS = 1000;

function logRejection(log: RejectionLog): void {
  rejectionLogs.push(log);
  if (rejectionLogs.length > MAX_REJECTION_LOGS) {
    rejectionLogs.shift();
  }
  if (DEBUG) {
    console.log("[REJECTED] " + log.pair + " | cross=" + (log.crossDetected ? log.crossDirection : "none") + " | regime=" + log.regimeDirection + " | conf=" + log.confidenceScore + " | reason=" + log.rejectionReason);
    if (log.evaluation) {
      console.log("  Location: " + f0(log.evaluation.breakdown.location) + "/30");
      console.log("  Structure: " + f0(log.evaluation.breakdown.structure) + "/20");
      console.log("  Momentum: " + f0(log.evaluation.breakdown.momentum) + "/30");
      console.log("  Risk: " + f0(log.evaluation.breakdown.risk) + "/20");
      console.log("  Total: " + f0(log.evaluation.confidence) + "/100");
      if (log.evaluation.missing.length > 0) {
        console.log("  Missing: " + log.evaluation.missing.map(m => m.component + " (+" + m.pointsNeeded + ")").join(", "));
      }
    }
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

// ─── NEW ENTRY ORCHESTRATOR — SINGLE SOURCE OF TRUTH ───
// Replaces scoreBestEntry, scorePullbackEntry, scoreRejectionEntry, scoreBreakoutEntry
// Returns ONE EntryEvaluation object consumed by ALL surfaces

function evaluateEntry(
  candles1h: Candle[],
  candles4h: Candle[],
  candles15m: Candle[],
  config: PairConfig,
  pair: string,
  regimeDirection: "LONG" | "SHORT"
): { evaluation: EntryEvaluation | null; candidates: EntryCandidates; debug: string[] } {
  const debug: string[] = [];

  // Determine entry mode and direction from price action
  const closes = candles1h.map(c => c.close);
  const highs = candles1h.map(c => c.high);
  const lows = candles1h.map(c => c.low);
  const lastClose = closes[closes.length - 1];
  const prevClose = closes[closes.length - 2];

  const recentHigh = highest(highs, 20);
  const recentLow = lowest(lows, 20);

  // Detect entry mode
  let entryMode: "PULLBACK" | "REJECTION" | "BREAKOUT" = "PULLBACK";
  let direction: "LONG" | "SHORT" | null = null;

  // Breakout detection
  if (lastClose > recentHigh && prevClose <= recentHigh) {
    direction = "LONG";
    entryMode = "BREAKOUT";
  } else if (lastClose < recentLow && prevClose >= recentLow) {
    direction = "SHORT";
    entryMode = "BREAKOUT";
  }

  // Rejection detection (if not breakout)
  if (!direction) {
    if (lastClose > recentLow * 1.005 && lows[lows.length - 2] <= recentLow * 1.002) {
      direction = "LONG";
      entryMode = "REJECTION";
    } else if (lastClose < recentHigh * 0.995 && highs[highs.length - 2] >= recentHigh * 0.998) {
      direction = "SHORT";
      entryMode = "REJECTION";
    }
  }

  // Default to pullback if no clear pattern
  if (!direction) {
    const stoch = stochRsi(closes);
    const stochPrev = stochRsi(closes.slice(0, -1));
    const crossUp = stochPrev.k <= stochPrev.d && stoch.k > stoch.d;
    const crossDown = stochPrev.k >= stochPrev.d && stoch.k < stoch.d;

    if (crossUp) direction = "LONG";
    else if (crossDown) direction = "SHORT";
  }

  // Must align with regime
  if (!direction || direction !== regimeDirection) {
    const candidates: EntryCandidates = {
      pullback: { eligible: false, confidence: 0, rejectionReason: "no_cross_or_regime_mismatch" },
      rejection: { eligible: false, confidence: 0, rejectionReason: "no_rejection_pattern_or_regime_mismatch" },
      breakout: { eligible: false, confidence: 0, rejectionReason: "no_breakout_or_regime_mismatch" },
    };
    if (DEBUG) debug.push("No direction detected or regime mismatch");
    return { evaluation: null, candidates, debug };
  }

  // Compute the four scores
  const location = scoreLocation(candles1h, candles4h, direction, config);
  const structure = scoreStructure(candles1h, candles4h, direction);

  // Entry price
  let entryPrice = lastClose;
  if (direction === "LONG") {
    entryPrice = Math.min(lastClose, candles1h[candles1h.length - 1].low * 1.002);
  } else {
    entryPrice = Math.max(lastClose, candles1h[candles1h.length - 1].high * 0.998);
  }

  const risk = scoreRisk(candles1h, candles4h, direction, config, entryPrice);
  const momentum = scoreMomentum(candles1h, candles4h, direction, config);

  // Exhaustion check on 4H
  const closes4h = candles4h.map(c => c.close);
  const stoch4h = stochRsi(closes4h);
  const exhaustion = checkExhaustion(stoch4h, direction);

  // Build total
  let total = location.score + structure.score + momentum.score + risk.score;
  let reasons = [
    ...location.reasons,
    ...structure.reasons,
    ...momentum.reasons,
    ...risk.reasons,
  ];

  const allContributions = [
    ...location.contributions,
    ...structure.contributions,
    ...momentum.contributions,
    ...risk.contributions,
  ];

  let exhaustionBlocked = false;
  if (exhaustion.isExhausted) {
    total += exhaustion.confidencePenalty;
    reasons.push(exhaustion.reason);
    exhaustionBlocked = true;
  }

  total = Math.min(100, Math.max(0, total));

  const tier = classifyEntryTier(total);
  const { gap, nextTier } = getTierGap(tier, total);

  const { missing, likelyTriggers } = analyzeMissingComponents(
    location, structure, momentum, risk, direction, momentum.crossDetected
  );

  const stoch1h = stochRsi(closes);
  const stochPrev1h = stochRsi(closes.slice(0, -1));
  const exhaustionWarning = getExhaustionWarning(stoch1h, stochPrev1h, direction);

  const adx4h = adx(candles4h);

  const breakdown: ScoreBreakdown = {
    location: location.score,
    locationMax: 30,
    structure: structure.score,
    structureMax: 20,
    momentum: momentum.score,
    momentumMax: 30,
    risk: risk.score,
    riskMax: 20,
    total,
    maxTotal: 100,
    contributions: allContributions,
  };

  const evaluation: EntryEvaluation = {
    pair,
    direction,
    entryMode,
    tier,
    confidence: total,
    thresholds: {
      wait: TIER_THRESHOLDS.WAIT,
      watch: TIER_THRESHOLDS.WATCH,
      early: TIER_THRESHOLDS.EARLY,
      confirmed: TIER_THRESHOLDS.CONFIRMED,
    },
    gapToNextTier: gap,
    nextTier,
    breakdown,
    missing,
    likelyTriggers,
    reasons,
    stochK: momentum.stochK,
    stochD: momentum.stochD,
    stochPrevK: momentum.stochPrevK,
    stochPrevD: momentum.stochPrevD,
    crossDetected: momentum.crossDetected,
    exhaustionWarning,
    exhaustionBlocked,
    entryPrice,
    stopDistance: risk.stopDistance,
    targetDistance: risk.targetDistance,
    rr: risk.rr,
    atrPct: risk.atrPct,
    adx4h,
    regimeDirection,
    regimeStrength: "", // filled by caller
  };

  // Build candidate scores for each mode
  const pullbackScore = entryMode === "PULLBACK" ? total : 0;
  const rejectionScore = entryMode === "REJECTION" ? total : 0;
  const breakoutScore = entryMode === "BREAKOUT" ? total : 0;

  const candidates: EntryCandidates = {
    pullback: {
      eligible: entryMode === "PULLBACK" && total >= TIER_THRESHOLDS.EARLY,
      confidence: pullbackScore,
      rejectionReason: entryMode === "PULLBACK" && total < TIER_THRESHOLDS.EARLY ? "confidence_too_low:" + f0(total) : null,
    },
    rejection: {
      eligible: entryMode === "REJECTION" && total >= TIER_THRESHOLDS.EARLY,
      confidence: rejectionScore,
      rejectionReason: entryMode === "REJECTION" && total < TIER_THRESHOLDS.EARLY ? "confidence_too_low:" + f0(total) : null,
    },
    breakout: {
      eligible: entryMode === "BREAKOUT" && total >= TIER_THRESHOLDS.EARLY,
      confidence: breakoutScore,
      rejectionReason: entryMode === "BREAKOUT" && total < TIER_THRESHOLDS.EARLY ? "confidence_too_low:" + f0(total) : null,
    },
  };

  if (DEBUG) {
    debug.push("=== v29.2 ENTRY EVALUATION ===");
    debug.push("Direction: " + direction + " | Mode: " + entryMode);
    debug.push("Location: " + f0(location.score) + "/30");
    for (const c of location.contributions) {
      debug.push("  " + c.name + ": " + (c.points >= 0 ? "+" : "") + c.points + (c.rawValue ? " (" + c.rawValue + ")" : ""));
    }
    debug.push("Structure: " + f0(structure.score) + "/20");
    for (const c of structure.contributions) {
      debug.push("  " + c.name + ": " + (c.points >= 0 ? "+" : "") + c.points + (c.rawValue ? " (" + c.rawValue + ")" : ""));
    }
    debug.push("Momentum: " + f0(momentum.score) + "/30");
    for (const c of momentum.contributions) {
      debug.push("  " + c.name + ": " + (c.points >= 0 ? "+" : "") + c.points + (c.rawValue ? " (" + c.rawValue + ")" : ""));
    }
    debug.push("Risk: " + f0(risk.score) + "/20");
    for (const c of risk.contributions) {
      debug.push("  " + c.name + ": " + (c.points >= 0 ? "+" : "") + c.points + (c.rawValue ? " (" + c.rawValue + ")" : ""));
    }
    debug.push("Total: " + f0(total) + "/100 | Tier: " + tier);
    if (exhaustion.isExhausted) debug.push("EXHAUSTION PENALTY: " + f0(exhaustion.confidencePenalty));
    debug.push("Stoch K=" + f1(momentum.stochK) + " D=" + f1(momentum.stochD) + " cross=" + (momentum.crossDetected ? "YES" : "NO"));
    debug.push("RR=" + f2(risk.rr) + " ATR%=" + f2(risk.atrPct * 100) + "%");
    if (missing.length > 0) {
      debug.push("Missing:");
      for (const m of missing) {
        debug.push("  " + m.component + ": need +" + m.pointsNeeded + " — " + m.description);
      }
    }
    if (likelyTriggers.length > 0) {
      debug.push("Likely triggers: " + likelyTriggers.join(", "));
    }
  }

  return { evaluation, candidates, debug };
}

// ─── FORMAT EVALUATION FOR OUTPUT (used by all surfaces) ───

export function formatEvaluation(evaluation: EntryEvaluation): string {
  const lines: string[] = [];
  lines.push(evaluation.pair + "  —  " + (evaluation.direction || "NEUTRAL") + "  —  " + evaluation.tier.replace("_", " "));
  lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  lines.push("Location  ..... " + f0(evaluation.breakdown.location) + " / " + evaluation.breakdown.locationMax);
  lines.push("Structure .... " + f0(evaluation.breakdown.structure) + " / " + evaluation.breakdown.structureMax);
  lines.push("Momentum ..... " + f0(evaluation.breakdown.momentum) + " / " + evaluation.breakdown.momentumMax);
  lines.push("Risk ......... " + f0(evaluation.breakdown.risk) + " / " + evaluation.breakdown.riskMax);
  lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  lines.push("TOTAL: " + f0(evaluation.confidence) + " / 100");

  if (evaluation.tier !== "CONFIRMED_ENTRY") {
    lines.push("Need +" + f0(evaluation.gapToNextTier) + " for " + (evaluation.nextTier?.replace("_", " ") || "entry"));
  }

  if (evaluation.missing.length > 0) {
    lines.push("");
    lines.push("Missing:");
    for (const m of evaluation.missing) {
      lines.push("  " + m.component + " (+" + m.pointsNeeded + "): " + m.description);
    }
  }

  if (evaluation.likelyTriggers.length > 0) {
    lines.push("");
    lines.push("Likely trigger: " + evaluation.likelyTriggers.join(", "));
  }

  return lines.join("\n");
}

// ─── DEPRECATED: Old scoring functions removed ───
// scorePullbackEntry, scoreRejectionEntry, scoreBreakoutEntry, scoreBestEntry
// have been replaced by evaluateEntry() with Location → Structure → Momentum → Risk architecture.

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

function detectTrendConflict(trend1h: TrendContext, trend4h: TrendContext, trend1d: TrendContext): { isConflict: boolean; details: string[] } {
  const htf1 = trend1h.direction.toUpperCase();
  const htf2 = trend4h.direction.toUpperCase();
  const ltf = trend1d.direction.toUpperCase();

  const details: string[] = [];

  if (htf1 === "NEUTRAL" || htf2 === "NEUTRAL" || htf1 === "INSUFFICIENT_DATA" || htf2 === "INSUFFICIENT_DATA") {
    return { isConflict: false, details };
  }
  if (htf1 !== htf2) return { isConflict: false, details };
  if (ltf === "NEUTRAL" || ltf === "INSUFFICIENT_DATA") return { isConflict: false, details };
  if (ltf === htf1) return { isConflict: false, details };

  details.push("1H " + trend1h.direction + " (" + trend1h.strength + ")");
  details.push("4H " + trend4h.direction + " (" + trend4h.strength + ")");
  details.push("1D " + trend1d.direction + " (" + trend1d.strength + ")");
  details.push("Higher timeframe disagreement — no trades until resolved.");

  return { isConflict: true, details };
}


// ─── MAIN SIGNAL GENERATION ───

export const CURRENT_SIGNAL_VERSION = 30;

export async function generateSignal(
  pair: string,
  candles1h: Candle[],
  candles4h: Candle[],
  candles15m: Candle[],
  currentPrice: number
): Promise<SignalResult> {
  const debug: string[] = [];
  if (DEBUG) {
    debug.push("=== generateSignal v29.2 " + pair + " ===");
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

  // Trend conflict check
  const trendConflict = detectTrendConflict(trend1h, trend4h, trend1d);
  if (trendConflict.isConflict) {
    const stoch4h = stochRsi(candles4h.map(c => c.close));
    if (DEBUG) {
      debug.push("TREND CONFLICT DETECTED:");
      for (const d of trendConflict.details) debug.push("  " + d);
    }
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
        pullback: { eligible: false, confidence: 0, rejectionReason: "trend_conflict" },
        rejection: { eligible: false, confidence: 0, rejectionReason: "trend_conflict" },
        breakout: { eligible: false, confidence: 0, rejectionReason: "trend_conflict" },
      },
      rejectionStage: "Trend Conflict\n" + trendConflict.details.join("\n"),
    };
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

  // Use new v29.2 entry engine — SINGLE SOURCE OF TRUTH
  const { evaluation, candidates, debug: entryDebug } = evaluateEntry(candles1h, candles4h, candles15m, config, pair, regime.direction);
  if (DEBUG) debug.push(...entryDebug);

  if (!evaluation) {
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

  // Fill regime strength into evaluation
  evaluation.regimeStrength = regime.strength;

  // Check exhaustion block
  if (evaluation.exhaustionBlocked && evaluation.confidence < TIER_THRESHOLDS.EARLY) {
    const stoch4h = stochRsi(candles4h.map(c => c.close));
    const rejectionLog: RejectionLog = {
      pair,
      timestamp: now,
      crossDetected: evaluation.crossDetected,
      crossDirection: evaluation.direction,
      regimeDirection: regime.direction,
      regimeStrength: regime.strength,
      confidenceScore: evaluation.confidence,
      confidenceBreakdown: {
        location: evaluation.breakdown.location,
        structure: evaluation.breakdown.structure,
        momentum: evaluation.breakdown.momentum,
        risk: evaluation.breakdown.risk,
      },
      rejectionReason: evaluation.exhaustionWarning || "Exhaustion block",
      stochK: stoch4h.k,
      stochD: stoch4h.d,
      stochPrevK: evaluation.stochPrevK,
      stochPrevD: evaluation.stochPrevD,
      evaluation,
    };
    logRejection(rejectionLog);
    if (DEBUG) debug.push("REJECTED: exhaustion block — " + evaluation.exhaustionWarning);

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
        stoch1hK: evaluation.stochK,
        stoch1hD: evaluation.stochD,
      },
      debug,
      entryCandidates: candidates,
      rejectionStage: "Market exhausted — " + (evaluation.exhaustionWarning?.replace("⚠️ ", "").replace("⚠ ", "") || "cooling off"),
      evaluation,
    };
  }

  // Calculate stops and targets
  const stop = evaluation.direction === "LONG" ? evaluation.entryPrice - evaluation.stopDistance : evaluation.entryPrice + evaluation.stopDistance;
  const target = evaluation.direction === "LONG" ? evaluation.entryPrice + evaluation.targetDistance : evaluation.entryPrice - evaluation.targetDistance;

  // RR check
  if (evaluation.rr < MIN_RR) {
    const stoch4h = stochRsi(candles4h.map(c => c.close));
    const rejectionLog: RejectionLog = {
      pair,
      timestamp: now,
      crossDetected: evaluation.crossDetected,
      crossDirection: evaluation.direction,
      regimeDirection: regime.direction,
      regimeStrength: regime.strength,
      confidenceScore: evaluation.confidence,
      confidenceBreakdown: {
        location: evaluation.breakdown.location,
        structure: evaluation.breakdown.structure,
        momentum: evaluation.breakdown.momentum,
        risk: evaluation.breakdown.risk,
      },
      rejectionReason: "RR " + f2(evaluation.rr) + " below minimum " + MIN_RR,
      stochK: stoch4h.k,
      stochD: stoch4h.d,
      stochPrevK: evaluation.stochPrevK,
      stochPrevD: evaluation.stochPrevD,
      evaluation,
    };
    logRejection(rejectionLog);
    if (DEBUG) debug.push("REJECTED: RR " + f2(evaluation.rr) + " < " + MIN_RR);

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
        stoch1hK: evaluation.stochK,
        stoch1hD: evaluation.stochD,
      },
      debug,
      entryCandidates: candidates,
      rejectionStage: "Risk:Reward too low (" + f2(evaluation.rr) + " < " + MIN_RR + ")",
      evaluation,
    };
  }

  // ADX check - soft penalty instead of hard block for early entries
  const adx4h = adx(candles4h);
  let finalConfidence = evaluation.confidence;
  if (adx4h < config.minADX) {
    const adxPenalty = Math.round((config.minADX - adx4h) * 2);
    finalConfidence -= adxPenalty;
    if (DEBUG) debug.push("ADX " + f1(adx4h) + " below threshold " + config.minADX + ", penalty -" + adxPenalty);

    if (finalConfidence < TIER_THRESHOLDS.EARLY) {
      const stoch4h = stochRsi(candles4h.map(c => c.close));
      const rejectionLog: RejectionLog = {
        pair,
        timestamp: now,
        crossDetected: evaluation.crossDetected,
        crossDirection: evaluation.direction,
        regimeDirection: regime.direction,
        regimeStrength: regime.strength,
        confidenceScore: finalConfidence,
        confidenceBreakdown: {
          location: evaluation.breakdown.location,
          structure: evaluation.breakdown.structure,
          momentum: evaluation.breakdown.momentum,
          risk: evaluation.breakdown.risk,
        },
        rejectionReason: "ADX " + f1(adx4h) + " too low, confidence dropped to " + f0(finalConfidence) + " after penalty",
        stochK: stoch4h.k,
        stochD: stoch4h.d,
        stochPrevK: evaluation.stochPrevK,
        stochPrevD: evaluation.stochPrevD,
        evaluation,
      };
      logRejection(rejectionLog);
      if (DEBUG) debug.push("REJECTED: ADX penalty dropped confidence below EARLY_ENTRY (" + TIER_THRESHOLDS.EARLY + ")");

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
          stoch1hK: evaluation.stochK,
          stoch1hD: evaluation.stochD,
        },
        debug,
        entryCandidates: candidates,
        rejectionStage: "ADX penalty — confidence " + f0(finalConfidence) + " below EARLY_ENTRY (" + TIER_THRESHOLDS.EARLY + ")",
        evaluation,
      };
    }
  }

  // Classify entry tier and position size
  const entryTier = classifyEntryTier(finalConfidence);
  const positionSizePct = getPositionSizePct(entryTier, regime.strength);

  if (entryTier === "NO_TRADE" || entryTier === "WATCH") {
    if (DEBUG) debug.push("REJECTED: confidence " + f1(finalConfidence) + " below EARLY_ENTRY threshold (" + TIER_THRESHOLDS.EARLY + ")");

    // Build detailed rejection stage with evaluation data
    const rec = getRecommendedActionFromEvaluation({ ...evaluation, confidence: finalConfidence, tier: entryTier });

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
        stoch1hK: evaluation.stochK,
        stoch1hD: evaluation.stochD,
      },
      debug,
      entryCandidates: candidates,
      rejectionStage: rec.detail,
      evaluation: { ...evaluation, confidence: finalConfidence, tier: entryTier },
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
        stoch1hK: evaluation.stochK,
        stoch1hD: evaluation.stochD,
      },
      debug,
      entryCandidates: candidates,
      rejectionStage: entryTier + " alert already sent — waiting for next cycle",
      evaluation,
    };
  }

  // Set tier lock
  setTierLock(pair, entryTier, now);

  // Generate signal with tier and sizing
  const signalId = pair + "-" + evaluation.direction + "-" + now;
  const signal: Signal = {
    id: signalId,
    pair,
    direction: evaluation.direction!,
    type: "ENTRY",
    entry: evaluation.entryPrice,
    stop,
    target,
    confidence: finalConfidence,
    entryTier,
    positionSizePct,
    rr: evaluation.rr,
    adx: adx4h,
    rsi: rsi(candles4h.map(c => c.close)),
    stochK: stochRsi(candles4h.map(c => c.close)).k,
    stochD: stochRsi(candles4h.map(c => c.close)).d,
    stoch1hK: evaluation.stochK,
    stoch1hD: evaluation.stochD,
    expectedMove: evaluation.targetDistance,
    reason: evaluation.reasons.join(" | "),
    timestamp: now,
    version: CURRENT_SIGNAL_VERSION,
    tradeState: "OPEN",
    regimeDirection: regime.direction,
    regimeSince: regime.detectedAt,
    entryMode: evaluation.entryMode!,
    confidenceComponents: {
      location: evaluation.breakdown.location,
      structure: evaluation.breakdown.structure,
      momentum: evaluation.breakdown.momentum,
      risk: evaluation.breakdown.risk,
      total: finalConfidence,
    },
    exhaustionWarning: evaluation.exhaustionWarning || undefined,
  };

  if (DEBUG) debug.push("SIGNAL: " + evaluation.direction + " " + pair + " @ " + f2(evaluation.entryPrice) + " tier=" + entryTier + " conf=" + f1(finalConfidence) + " size=" + f0(positionSizePct * 100) + "% rr=" + f2(evaluation.rr) + " mode=" + evaluation.entryMode);

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
      stoch1hK: evaluation.stochK,
      stoch1hD: evaluation.stochD,
    },
    debug,
    entryCandidates: candidates,
    evaluation,
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


// ─── Market Snapshot (REFACTORED — uses EntryEvaluation) ───

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

  // Detect trend conflict with details
  const conflictResult = detectTrendConflict(trend1h, trend4h, trend1d);

  // Build regime display with trend conflict override
  let regimeDisplay: RegimeDisplay = {
    direction: regime.direction || "NEUTRAL",
    strength: regime.strength,
    confidence: safeNum(regime.confidence),
    score: safeNum(regime.score),
    reason: regime.reason,
  };

  // Override direction for display when trend conflict detected
  if (conflictResult.isConflict) {
    regimeDisplay.direction = "TREND_CONFLICT";
  }

  // Build recommendation from evaluation if available
  let rec: RecommendedAction;
  if (signalResult.evaluation) {
    rec = getRecommendedActionFromEvaluation(signalResult.evaluation);
  } else {
    const bestConf = Math.max(
      signalResult.entryCandidates?.pullback?.confidence || 0,
      signalResult.entryCandidates?.rejection?.confidence || 0,
      signalResult.entryCandidates?.breakout?.confidence || 0
    );
    rec = { action: bestConf >= 70 ? "EARLY ENTRY" : "WAIT", detail: "Score " + f0(bestConf) + "/100", missing: [], progressPct: Math.round((bestConf / 85) * 100) };
  }

  // Build "Why no trade?" messages using evaluation if available
  const whyNoTrade: string[] = [];
  if (conflictResult.isConflict) {
    whyNoTrade.push("⚠ Trend Conflict");
    for (const detail of conflictResult.details) {
      whyNoTrade.push("  " + detail);
    }
  } else if (signalResult.evaluation) {
    const eval_ = signalResult.evaluation;
    whyNoTrade.push("• " + rec.action + " — " + rec.detail);
    if (eval_.missing.length > 0) {
      for (const m of eval_.missing) {
        whyNoTrade.push("  Missing: " + m.component + " (+" + m.pointsNeeded + ") — " + m.description);
      }
    }
    if (eval_.likelyTriggers.length > 0) {
      whyNoTrade.push("  Likely trigger: " + eval_.likelyTriggers.join(", "));
    }
  } else if (signalResult.rejectionStage) {
    whyNoTrade.push("• " + signalResult.rejectionStage);
  } else {
    const bestConf = Math.max(
      signalResult.entryCandidates?.pullback?.confidence || 0,
      signalResult.entryCandidates?.rejection?.confidence || 0,
      signalResult.entryCandidates?.breakout?.confidence || 0
    );
    if (bestConf < TIER_THRESHOLDS.WATCH) {
      whyNoTrade.push("• Waiting for market setup (" + f0(bestConf) + "%)");
    } else {
      whyNoTrade.push("• Setup developing (" + f0(bestConf) + "%)");
    }
  }

  // Determine entry tier from precomputed result
  let entryTier: EntryTier | null = null;
  if (signalResult.signal) {
    entryTier = signalResult.signal.entryTier;
  } else if (signalResult.evaluation) {
    entryTier = signalResult.evaluation.tier;
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
    recommendedAction: conflictResult.isConflict ? "WAIT" : rec.action,
    positionSize: conflictResult.isConflict ? "Waiting for confirmation" : rec.detail,
    whyNoTrade: whyNoTrade.length > 0 ? whyNoTrade : ["• Waiting for market setup"],
    entryTier,
    trendConflict: conflictResult.isConflict,
    evaluation: signalResult.evaluation,
  };
}

// ─── UI Helpers ───

export function getCurrentRegime(pair: string): MarketRegime | null {
  return getRegimeSync(pair);
}
