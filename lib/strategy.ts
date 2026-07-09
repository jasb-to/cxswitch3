// lib/strategy-consolidated.ts — v29.1 DIAGNOSTIC EDITION
// ============================================================
// INSTRUMENTED VERSION — Full diagnostics exposed. NO trading logic changed.
// All scoring, thresholds, and filters are identical to v29.1.
// Only additions: regime.score, entryCandidates, rejectionStage, debug lines,
// and getTrendContext() for independent timeframe analysis.
// ============================================================

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

// ─── DIAGNOSTIC TYPES (NEW) ───

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
      console.error("[REGIME PERSIST] Failed:", e);
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
      console.error("[REGIME PERSIST DIRECT] Failed:", e);
    }
  }
}

// ─── REGIME EVALUATION ENGINE ───

async function evaluateRegime(pair: string, candles1d: Candle[], candles4h: Candle[]): Promise<MarketRegime> {
  const reasons: string[] = [];
  const detectedAt = Date.now();

  if (candles1d.length < 25 || candles4h.length < 30) {
    return { direction: null, strength: "INSUFFICIENT_DATA", confidence: 0, score: 0, reason: ["not_enough_candles"], detectedAt };
  }

  const closes1d = candles1d.map(c => c.close);
  const closes4h = candles4h.map(c => c.close);

  const ema21_1d = ema(closes1d, 21);
  const ema50_1d = ema(closes1d, 50);
  const ema200_1d = ema(closes1d, 200);
  const ema21_4h = ema(closes4h, 21);
  const ema50_4h = ema(closes4h, 50);

  let regimeScore = 0;
  let direction: "LONG" | "SHORT" | "NEUTRAL" | null = null;

  if (ema21_1d.length > 0 && ema50_1d.length > 0 && ema200_1d.length > 0) {
    const e21 = ema21_1d[ema21_1d.length - 1];
    const e50 = ema50_1d[ema50_1d.length - 1];
    const e200 = ema200_1d[ema200_1d.length - 1];

    if (e21 > e50 && e50 > e200) {
      regimeScore += 40;
      direction = "LONG";
      reasons.push("1D_bullish_stack");
    } else if (e21 < e50 && e50 < e200) {
      regimeScore -= 40;
      direction = "SHORT";
      reasons.push("1D_bearish_stack");
    } else if (e21 > e50) {
      regimeScore += 15;
      direction = "LONG";
      reasons.push("1D_bullish_lean");
    } else if (e21 < e50) {
      regimeScore -= 15;
      direction = "SHORT";
      reasons.push("1D_bearish_lean");
    }
  }

  if (ema21_4h.length > 0 && ema50_4h.length > 0) {
    const e21 = ema21_4h[ema21_4h.length - 1];
    const e50 = ema50_4h[ema50_4h.length - 1];

    if (direction === "LONG" && e21 > e50) {
      regimeScore += 20;
      reasons.push("4H_confirms_bull");
    } else if (direction === "SHORT" && e21 < e50) {
      regimeScore += 20;
      reasons.push("4H_confirms_bear");
    } else if (e21 > e50) {
      regimeScore += 10;
      reasons.push("4H_bullish");
    } else if (e21 < e50) {
      regimeScore -= 10;
      reasons.push("4H_bearish");
    }
  }

  const rsi1d = rsi(closes1d);
  const rsi4h = rsi(closes4h);
  if (rsi1d > 60) {
    regimeScore += 10;
    reasons.push(`1D_rsi_strong_${rsi1d.toFixed(0)}`);
  } else if (rsi1d < 40) {
    regimeScore -= 10;
    reasons.push(`1D_rsi_weak_${rsi1d.toFixed(0)}`);
  }

  const adx1d = adx(candles1d);
  const adx4h = adx(candles4h);
  if (adx1d > 25) {
    regimeScore += 15;
    reasons.push(`1D_adx_strong_${adx1d.toFixed(1)}`);
  } else if (adx1d < 20) {
    regimeScore -= 10;
    reasons.push(`1D_adx_weak_${adx1d.toFixed(1)}`);
  }

  if (adx4h > 30) {
    regimeScore += 10;
    reasons.push(`4H_adx_trending_${adx4h.toFixed(1)}`);
  }

  let strength = "NEUTRAL";
  if (Math.abs(regimeScore) > 50) strength = "STRONG";
  else if (Math.abs(regimeScore) > 30) strength = "MODERATE";
  else if (Math.abs(regimeScore) > 10) strength = "WEAK";

  if (Math.abs(regimeScore) < 10) {
    direction = "NEUTRAL";
    strength = "NEUTRAL";
    reasons.push("score_neutral");
  }

  const confidence = Math.min(100, Math.max(0, Math.abs(regimeScore)));

  return { direction, strength, confidence, score: regimeScore, reason: reasons, detectedAt };
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
    const slice = values.slice(i - period + 1, i + 1);
    out.push(slice.reduce((a, b) => a + b, 0) / period);
  }
  return out;
}

function ema(values: number[], period: number): number[] {
  if (values.length < period) return [];
  const k = 2 / (period + 1);
  const out: number[] = [];
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out.push(prev);
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
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
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
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
  if (avgLoss === 0) return avgGain > 0 ? 100 : 50;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function stochRsi(values: number[], period: number = 14, k: number = 3, d: number = 3): { k: number; d: number } {
  const rsiValues: number[] = [];
  for (let i = period; i < values.length; i++) {
    rsiValues.push(rsi(values.slice(0, i + 1), period));
  }
  if (rsiValues.length < k) return { k: 50, d: 50 };

  const stochKValues: number[] = [];
  for (let i = k - 1; i < rsiValues.length; i++) {
    const slice = rsiValues.slice(i - k + 1, i + 1);
    const highest = Math.max(...slice);
    const lowest = Math.min(...slice);
    const stochK = lowest === highest ? 50 : ((rsiValues[i] - lowest) / (highest - lowest)) * 100;
    stochKValues.push(stochK);
  }

  if (stochKValues.length < d) return { k: stochKValues[stochKValues.length - 1] || 50, d: 50 };

  const dValues = stochKValues.slice(-d);
  const stochD = avg(dValues);
  const stochK = stochKValues[stochKValues.length - 1];

  return { k: stochK, d: stochD };
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
      sum = result[result.length - 1] * lookback - result[result.length - 1] + values[i];
      result.push(sum / lookback);
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
  return adxRma[adxRma.length - 1] || 0;
}

// ─── CANDLE AGGREGATION ───

function aggregateTo1D(candles4h: Candle[]): Candle[] {
  if (!candles4h || candles4h.length < 6) return [];
  const sorted = [...candles4h].sort((a, b) => a.timestamp - b.timestamp);
  const groups: Map<string, Candle[]> = new Map();
  for (const c of sorted) {
    const d = new Date(c.timestamp);
    const key = d.toISOString().split("T")[0];
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
      volume: bars.reduce((s, b) => s + b.volume, 0)
    });
  }
  return daily.sort((a, b) => a.timestamp - b.timestamp);
}

// ─── PAIR CONFIG ───

const MIN_RR = 1.5;

const PAIR_CONFIGS: Record<string, PairConfig> = {
  default: { minADX: 20, momentumThreshold: 55, volumeMultiplier: 1.3, stopLossPct: 0.025, takeProfitPct: 0.035, maxEntryDriftPct: 0.01 },
  BTC: { minADX: 20, momentumThreshold: 55, volumeMultiplier: 1.3, stopLossPct: 0.02, takeProfitPct: 0.03, maxEntryDriftPct: 0.01 },
  ETH: { minADX: 20, momentumThreshold: 55, volumeMultiplier: 1.3, stopLossPct: 0.025, takeProfitPct: 0.035, maxEntryDriftPct: 0.01 },
  SOL: { minADX: 18, momentumThreshold: 50, volumeMultiplier: 1.4, stopLossPct: 0.03, takeProfitPct: 0.04, maxEntryDriftPct: 0.012 },
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
      return { isExhausted: true, reason: `BLOCK: 4H extreme overbought K${stoch4h.k} — buyers exhausted`, confidencePenalty: -50 };
    }
    if (stoch4h.k > 80 && stoch4h.k < stoch4h.d) {
      return { isExhausted: true, reason: `BLOCK: 4H overbought reversal K${stoch4h.k}<D${stoch4h.d} — momentum rolling over`, confidencePenalty: -40 };
    }
  } else {
    if (stoch4h.k < 10) {
      return { isExhausted: true, reason: `BLOCK: 4H extreme oversold K${stoch4h.k} — sellers exhausted`, confidencePenalty: -50 };
    }
    if (stoch4h.k < 20 && stoch4h.k > stoch4h.d) {
      return { isExhausted: true, reason: `BLOCK: 4H oversold reversal K${stoch4h.k}>D${stoch4h.d} — momentum rolling over`, confidencePenalty: -40 };
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

// ─── REJECTION LOGGING ───

const rejectionLogs: RejectionLog[] = [];
const MAX_REJECTION_LOGS = 1000;

function logRejection(log: RejectionLog): void {
  rejectionLogs.push(log);
  if (rejectionLogs.length > MAX_REJECTION_LOGS) {
    rejectionLogs.shift();
  }
  console.log(`[REJECTED] ${log.pair} | cross=${log.crossDetected ? log.crossDirection : "none"} | regime=${log.regimeDirection} | conf=${log.confidenceScore} | reason=${log.rejectionReason}`);
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
 
