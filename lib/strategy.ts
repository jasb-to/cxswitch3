// lib/strategy-consolidated.ts — v29.1 FULL SELF-CONTAINED
// ============================================================
// This file contains ALL strategy logic, indicators, types, and regime management
// in a single consolidated file. Copy this entire file to replace your lib/strategy.ts
// ============================================================

// ─── ALL TYPES (from @/lib/types) ───

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

// ─── REGIME PERSISTENCE & CACHE ───

interface RegimeCache {
  regime: MarketRegime;
  timestamp: number;
  pairKey: string;
}

const regimeCache = new Map<string, RegimeCache>();
const REGIME_CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

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
    return { direction: null, strength: "INSUFFICIENT_DATA", confidence: 0, reason: ["not_enough_candles"], detectedAt };
  }

  const closes1d = candles1d.map(c => c.close);
  const closes4h = candles4h.map(c => c.close);

  // EMA structure
  const ema21_1d = ema(closes1d, 21);
  const ema50_1d = ema(closes1d, 50);
  const ema200_1d = ema(closes1d, 200);
  const ema21_4h = ema(closes4h, 21);
  const ema50_4h = ema(closes4h, 50);

  let regimeScore = 0;
  let direction: "LONG" | "SHORT" | "NEUTRAL" | null = null;

  // 1D structure alignment
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
      reasons.push("1D_bullish_lean");
    } else if (e21 < e50) {
      regimeScore -= 15;
      reasons.push("1D_bearish_lean");
    }
  }

  // 4H confirmation
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

  // RSI structure
  const rsi1d = rsi(closes1d);
  const rsi4h = rsi(closes4h);
  if (rsi1d > 60) {
    regimeScore += 10;
    reasons.push(`1D_rsi_strong_${rsi1d.toFixed(0)}`);
  } else if (rsi1d < 40) {
    regimeScore -= 10;
    reasons.push(`1D_rsi_weak_${rsi1d.toFixed(0)}`);
  }

  // ADX confirmation
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

  return { direction, strength, confidence, reason: reasons, detectedAt };
}

export function shouldInvalidateRegime(regime: MarketRegime): boolean {
  if (!regime) return false;
  const age = Date.now() - regime.detectedAt;
  return age > REGIME_CACHE_TTL_MS;
}

// ─── INDICATOR FUNCTIONS (all indicators self-contained) ───

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
  if (candles.length < period + 1) return 0;

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

    let plusDM = 0,
      minusDM = 0;
    if (upMove > downMove && upMove > 0) plusDM = upMove;
    if (downMove > upMove && downMove > 0) minusDM = downMove;

    plusDMs.push(plusDM);
    minusDMs.push(minusDM);
  }

  let atr = avg(trueRanges.slice(0, period));
  let plusDI = (avg(plusDMs.slice(0, period)) / atr) * 100;
  let minusDI = (avg(minusDMs.slice(0, period)) / atr) * 100;

  const adxValues: number[] = [];
  let adxValue = Math.abs(plusDI - minusDI) / (plusDI + minusDI + 0.001) * 100;
  adxValues.push(adxValue);

  for (let i = period; i < trueRanges.length; i++) {
    atr = (atr * period + trueRanges[i]) / (period + 1);
    plusDI = (avg(plusDMs.slice(Math.max(0, i - period + 1), i + 1)) / atr) * 100;
    minusDI = (avg(minusDMs.slice(Math.max(0, i - period + 1), i + 1)) / atr) * 100;
    adxValue = (adxValue * period + (Math.abs(plusDI - minusDI) / (plusDI + minusDI + 0.001) * 100)) / (period + 1);
    adxValues.push(adxValue);
  }

  return adxValues[adxValues.length - 1] || 0;
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
    if (stoch4h.k > 90) return { isExhausted: true, reason: `4H extreme overbought K${stoch4h.k}`, confidencePenalty: -20 };
    if (stoch4h.k > 80 && stoch4h.k < stoch4h.d) return { isExhausted: true, reason: `4H overbought exhaustion K${stoch4h.k} < D${stoch4h.d}`, confidencePenalty: -15 };
  } else {
    if (stoch4h.k < 10) return { isExhausted: true, reason: `4H extreme oversold K${stoch4h.k}`, confidencePenalty: -20 };
    if (stoch4h.k < 20 && stoch4h.k > stoch4h.d) return { isExhausted: true, reason: `4H oversold exhaustion K${stoch4h.k} > D${stoch4h.d}`, confidencePenalty: -15 };
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

  if (direction === "SHORT" && crossDown && stoch1h.k < 20) {
    return "SHORT momentum exhaustion risk — StochRSI recovering from oversold";
  }
  if (direction === "LONG" && crossUp && stoch1h.k > 80) {
    return "LONG momentum exhaustion risk — StochRSI rolling from overbought";
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

interface EntryCandidate {
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
): EntryCandidate | null {
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

  let regimeAlignment = 30;
  reasons.push("regime_alignment:+30");
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
  if (Math.abs(roc) > 2.0) { momentum += 10; reasons.push("strong_velocity:+10"); }
  else if (Math.abs(roc) > 1.0) { momentum += 5; reasons.push("velocity:+5"); }
  else if (Math.abs(roc) < 0.3) { momentum -= 5; reasons.push("low_velocity:-5"); }

  const closes4h = candles4h.map(c => c.close);
  const stoch4h = stochRsi(closes4h);
  if (direction === "LONG" && stoch4h.k < 50) {
    momentum += 10; reasons.push("4h_context_bullish:+10");
  } else if (direction === "LONG") {
    reasons.push("4h_context_mixed:0");
  }
  if (direction === "SHORT" && stoch4h.k > 50) {
    momentum += 10; reasons.push("4h_context_bearish:+10");
  } else if (direction === "SHORT") {
    reasons.push("4h_context_mixed:0");
  }

  const adx1h = adx(candles1h);
  if (adx1h > config.minADX + 5) { structure += 15; reasons.push(`adx_strong_${adx1h.toFixed(1)}:+15`); }
  else if (adx1h > config.minADX) { structure += 10; reasons.push(`adx_ok_${adx1h.toFixed(1)}:+10`); }
  else if (adx1h > 10) { structure += 5; reasons.push(`adx_weak_${adx1h.toFixed(1)}:+5`); }
  else { structure -= 10; reasons.push(`adx_too_weak_${adx1h.toFixed(1)}:-10`); }

  const avgVol = avg(volumes.slice(-10));
  const lastVol = volumes[volumes.length - 1];
  const lastCandle = candles1h[candles1h.length - 1];
  const volDirection = lastCandle.close > lastCandle.open ? "LONG" : "SHORT";
  if (lastVol > avgVol * config.volumeMultiplier * 1.5) {
    volumeScore += 15; reasons.push("strong_volume:+15");
  } else if (lastVol > avgVol * config.volumeMultiplier) {
    volumeScore += 10; reasons.push("volume_confirms:+10");
  } else if (lastVol > avgVol) {
    volumeScore += 5; reasons.push("volume_above_avg:+5");
  } else {
    volumeScore -= 5; reasons.push("volume_weak:-5");
  }

  if (volDirection !== direction && lastVol > avgVol) {
    volumeScore -= 10; reasons.push("volume_opposes_direction:-10");
  }

  const body = Math.abs(lastCandle.close - lastCandle.open);
  const upperWick = lastCandle.high - Math.max(lastCandle.open, lastCandle.close);
  const lowerWick = Math.min(lastCandle.open, lastCandle.close) - lastCandle.low;
  if (direction === "LONG" && upperWick > body * 2 && upperWick > lowerWick * 2) {
    setupQuality -= 10; reasons.push("upper_rejection_wick:-10");
  }
  if (direction === "SHORT" && lowerWick > body * 2 && lowerWick > upperWick * 2) {
    setupQuality -= 10; reasons.push("lower_rejection_wick:-10");
  }

  const components = buildEntryComponents(regimeAlignment, setupQuality, momentum, structure, volumeScore, 0);

  return {
    direction,
    strength: components.total,
    finalConfidence: components.total,
    reasons,
    confidenceComponents: components,
    stochK: stoch.k,
    stochD: stoch.d,
    stochPrevK: stochPrev.k,
    stochPrevD: stochPrev.d,
    entryPrice: candles1h[candles1h.length - 1].close,
    confidencePenalty: 0,
    exhaustionWarning: "",
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
): EntryCandidate | null {
  const reasons: string[] = [];
  const closes1h = candles1h.map(c => c.close);
  const volumes1h = candles1h.map(c => c.volume);
  if (closes1h.length < 50 || candles15m.length < 20) return null;

  const stoch1h = stochRsi(closes1h);
  const stochPrev1h = stochRsi(closes1h.slice(0, -1));
  const crossUp = stochPrev1h.k <= stochPrev1h.d && stoch1h.k > stoch1h.d;
  const crossDown = stochPrev1h.k >= stochPrev1h.d && stoch1h.k < stoch1h.d;

  let direction: "LONG" | "SHORT" | null = null;
  if (crossUp) direction = "LONG";
  else if (crossDown) direction = "SHORT";

  if (!direction || direction !== regimeDirection) return null;

  const closes15m = candles15m.map(c => c.close);
  const stoch15m = stochRsi(closes15m);
  const stochPrev15m = stochRsi(closes15m.slice(0, -1));
  const cross15mUp = stochPrev15m.k <= stochPrev15m.d && stoch15m.k > stoch15m.d;
  const cross15mDown = stochPrev15m.k >= stochPrev15m.d && stoch15m.k < stoch15m.d;

  if (direction === "LONG" && !cross15mUp) return null;
  if (direction === "SHORT" && !cross15mDown) return null;

  let regimeAlignment = 30;
  reasons.push("regime_alignment:+30");
  let setupQuality = 0, momentum = 0, structure = 0, volumeScore = 0;

  if (direction === "LONG") {
    if (stoch1h.k < 35) { setupQuality += 15; reasons.push("deep_cross_1h:+15"); }
    else if (stoch1h.k < 50) { setupQuality += 5; reasons.push("moderate_cross_1h:+5"); }
    else { setupQuality -= 15; reasons.push("extended_cross_1h:-15"); }
    if (stoch15m.k < 30) { setupQuality += 10; reasons.push("deep_cross_15m:+10"); }
  } else {
    if (stoch1h.k > 65) { setupQuality += 15; reasons.push("deep_cross_1h:+15"); }
    else if (stoch1h.k > 50) { setupQuality += 5; reasons.push("moderate_cross_1h:+5"); }
    else { setupQuality -= 15; reasons.push("extended_cross_1h:-15"); }
    if (stoch15m.k > 70) { setupQuality += 10; reasons.push("deep_cross_15m:+10"); }
  }

  const recentLows = candles1h.slice(-20).map(c => c.low);
  const recentHighs = candles1h.slice(-20).map(c => c.high);
  const swingLow = Math.min(...recentLows);
  const swingHigh = Math.max(...recentHighs);
  const currentPrice = candles1h[candles1h.length - 1].close;

  if (direction === "LONG") {
    const distFromLow = (currentPrice - swingLow) / swingLow;
    if (distFromLow < 0.015) { setupQuality += 10; reasons.push("near_swing_low:+10"); }
    else if (distFromLow < 0.03) { setupQuality += 5; reasons.push("pullback_zone:+5"); }
  } else {
    const distFromHigh = (swingHigh - currentPrice) / swingHigh;
    if (distFromHigh < 0.015) { setupQuality += 10; reasons.push("near_swing_high:+10"); }
    else if (distFromHigh < 0.03) { setupQuality += 5; reasons.push("pullback_zone:+5"); }
  }

  const last1h = candles1h[candles1h.length - 1];
  const body1h = Math.abs(last1h.close - last1h.open);
  const upperWick1h = last1h.high - Math.max(last1h.open, last1h.close);
  const lowerWick1h = Math.min(last1h.open, last1h.close) - last1h.low;

  if (direction === "LONG" && lowerWick1h > body1h * 1.5) {
    setupQuality += 10; reasons.push("lower_wick_rejection:+10");
  } else if (direction === "LONG" && upperWick1h > body1h * 2) {
    setupQuality -= 15; reasons.push("upper_rejection_penalty:-15");
  }
  if (direction === "SHORT" && upperWick1h > body1h * 1.5) {
    setupQuality += 10; reasons.push("upper_wick_rejection:+10");
  } else if (direction === "SHORT" && lowerWick1h > body1h * 2) {
    setupQuality -= 15; reasons.push("lower_rejection_penalty:-15");
  }

  const ema21 = ema(closes1h, 21);
  const ema50 = ema(closes1h, 50);
  if (ema21.length >= 2 && ema50.length >= 2) {
    const e21Now = ema21[ema21.length - 1];
    const e21Prev = ema21[ema21.length - 2];
    const e50Now = ema50[ema50.length - 1];
    if (direction === "LONG" && e21Now > e50Now && e21Prev <= e50Now) {
      structure += 15; reasons.push("ema21_cross_above_50:+15");
    } else if (direction === "LONG" && e21Now > e50Now) {
      structure += 5; reasons.push("above_ema21_50:+5");
    } else if (direction === "LONG") {
      structure -= 10; reasons.push("below_ema_structure:-10");
    }
    if (direction === "SHORT" && e21Now < e50Now && e21Prev >= e50Now) {
      structure += 15; reasons.push("ema21_cross_below_50:+15");
    } else if (direction === "SHORT" && e21Now < e50Now) {
      structure += 5; reasons.push("below_ema21_50:+5");
    } else if (direction === "SHORT") {
      structure -= 10; reasons.push("above_ema_structure:-10");
    }
  }

  const closes4h = candles4h.map(c => c.close);
  const stoch4h = stochRsi(closes4h);
  if (direction === "LONG" && stoch4h.k < 50) {
    momentum += 10; reasons.push("4h_context_bullish:+10");
  } else if (direction === "SHORT" && stoch4h.k > 50) {
    momentum += 10; reasons.push("4h_context_bearish:+10");
  }

  const avgVol = avg(volumes1h.slice(-10));
  const lastVol = volumes1h[volumes1h.length - 1];
  if (lastVol > avgVol * config.volumeMultiplier * 1.5) {
    volumeScore += 15; reasons.push("strong_volume:+15");
  } else if (lastVol > avgVol * config.volumeMultiplier) {
    volumeScore += 10; reasons.push("volume_confirms:+10");
  } else if (lastVol > avgVol) {
    volumeScore += 5; reasons.push("volume_above_avg:+5");
  } else {
    volumeScore -= 5; reasons.push("volume_weak:-5");
  }

  const components = buildEntryComponents(regimeAlignment, setupQuality, momentum, structure, volumeScore, 0);

  return {
    direction,
    strength: components.total,
    finalConfidence: components.total,
    reasons,
    confidenceComponents: components,
    stochK: stoch1h.k,
    stochD: stoch1h.d,
    stochPrevK: stochPrev1h.k,
    stochPrevD: stochPrev1h.d,
    entryPrice: currentPrice,
    confidencePenalty: 0,
    exhaustionWarning: "",
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
): EntryCandidate | null {
  const reasons: string[] = [];
  const closes1h = candles1h.map(c => c.close);
  const volumes1h = candles1h.map(c => c.volume);
  const highs1h = candles1h.map(c => c.high);
  const lows1h = candles1h.map(c => c.low);
  if (closes1h.length < 50 || candles15m.length < 20 || candles4h.length < 30) return null;

  const adx4h = adx(candles4h);
  if (adx4h <= 25) return null;

  const stoch1h = stochRsi(closes1h);
  const stochPrev1h = stochRsi(closes1h.slice(0, -1));
  const crossUp = stochPrev1h.k <= stochPrev1h.d && stoch1h.k > stoch1h.d;
  const crossDown = stochPrev1h.k >= stochPrev1h.d && stoch1h.k < stoch1h.d;

  let direction: "LONG" | "SHORT" | null = null;
  if (crossUp) direction = "LONG";
  else if (crossDown) direction = "SHORT";

  if (!direction || direction !== regimeDirection) return null;

  const closes15m = candles15m.map(c => c.close);
  const stoch15m = stochRsi(closes15m);
  if (direction === "LONG" && stoch15m.k < 30) return null;
  if (direction === "SHORT" && stoch15m.k > 70) return null;

  let regimeAlignment = 30;
  reasons.push("regime_alignment:+30");
  let setupQuality = 0, momentum = 0, structure = 0, volumeScore = 0;

  const lookback = 12;
  const recentHigh = highest(highs1h, lookback);
  const recentLow = lowest(lows1h, lookback);
  const currentPrice = closes1h[closes1h.length - 1];
  const prevPrice = closes1h[closes1h.length - 2];

  if (direction === "LONG") {
    if (currentPrice > recentHigh && prevPrice <= recentHigh) {
      setupQuality += 20; reasons.push("high_breakout:+20");
    } else if (currentPrice > recentHigh * 0.995) {
      setupQuality += 10; reasons.push("near_high_breakout:+10");
    } else {
      setupQuality -= 10; reasons.push("no_breakout:-10");
    }
  } else {
    if (currentPrice < recentLow && prevPrice >= recentLow) {
      setupQuality += 20; reasons.push("low_breakout:+20");
    } else if (currentPrice < recentLow * 1.005) {
      setupQuality += 10; reasons.push("near_low_breakout:+10");
    } else {
      setupQuality -= 10; reasons.push("no_breakout:-10");
    }
  }

  const closes4h = candles4h.map(c => c.close);
  const stoch4h = stochRsi(closes4h);
  if (direction === "LONG" && stoch4h.k > 85) {
    setupQuality -= 15; reasons.push("exhausted_breakout_long:-15");
  }
  if (direction === "SHORT" && stoch4h.k < 15) {
    setupQuality -= 15; reasons.push("exhausted_breakout_short:-15");
  }

  const avgVol = avg(volumes1h.slice(-10));
  const lastVol = volumes1h[volumes1h.length - 1];
  if (lastVol > avgVol * config.volumeMultiplier * 2.0) {
    volumeScore += 20; reasons.push("breakout_volume_surge:+20");
  } else if (lastVol > avgVol * config.volumeMultiplier * 1.5) {
    volumeScore += 15; reasons.push("strong_breakout_volume:+15");
  } else if (lastVol > avgVol * config.volumeMultiplier) {
    volumeScore += 10; reasons.push("breakout_volume:+10");
  } else {
    volumeScore -= 10; reasons.push("weak_breakout_volume:-10");
  }

  if (adx4h > 35) { structure += 15; reasons.push(`adx_extreme_${adx4h.toFixed(1)}:+15`); }
  else if (adx4h > 30) { structure += 10; reasons.push(`adx_strong_${adx4h.toFixed(1)}:+10`); }
  else { structure += 5; reasons.push(`adx_breakout_${adx4h.toFixed(1)}:+5`); }

  if (direction === "LONG" && stoch4h.k < 60) {
    momentum += 10; reasons.push("4h_momentum_room:+10");
  } else if (direction === "SHORT" && stoch4h.k > 40) {
    momentum += 10; reasons.push("4h_momentum_room:+10");
  }

  if (direction === "LONG" && stoch15m.k > 50) {
    momentum += 5; reasons.push("15m_momentum_bullish:+5");
  } else if (direction === "SHORT" && stoch15m.k < 50) {
    momentum += 5; reasons.push("15m_momentum_bearish:+5");
  }

  const components = buildEntryComponents(regimeAlignment, setupQuality, momentum, structure, volumeScore, 0);

  return {
    direction,
    strength: components.total,
    finalConfidence: components.total,
    reasons,
    confidenceComponents: components,
    stochK: stoch1h.k,
    stochD: stoch1h.d,
    stochPrevK: stochPrev1h.k,
    stochPrevD: stochPrev1h.d,
    entryPrice: currentPrice,
    confidencePenalty: 0,
    exhaustionWarning: "",
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
): { candidate: EntryCandidate | null; mode: string; debugLines: string[] } {
  const debugLines: string[] = [];

  const pullback = scorePullbackEntry(candles1h, candles4h, config, pair, regimeDirection);
  const rejection = scoreRejectionEntry(candles1h, candles4h, candles15m, config, pair, regimeDirection);
  const breakout = scoreBreakoutEntry(candles1h, candles4h, candles15m, config, pair, regimeDirection);

  const candidates: { c: EntryCandidate | null; name: string }[] = [
    { c: pullback, name: "PULLBACK" },
    { c: rejection, name: "REJECTION" },
    { c: breakout, name: "BREAKOUT" },
  ];

  let best: EntryCandidate | null = null;
  let bestName = "NONE";

  for (const { c, name } of candidates) {
    if (c) {
      debugLines.push(`${name} candidate: conf=${c.finalConfidence} raw=${c.strength}`);
      if (!best || c.finalConfidence > best.finalConfidence) {
        best = c;
        bestName = name;
      }
    } else {
      debugLines.push(`${name}: no candidate`);
    }
  }

  return { candidate: best, mode: bestName, debugLines };
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

async function recordExit(signalId: string, pair: string, direction: "LONG" | "SHORT", exitPrice: number, exitReason: string, now: number): Promise<void> {
  const r: ExitRecord = { signalId, pair, direction, exitTimestamp: now, exitReason, exitPrice };
  exitStoreById.set(signalId, r);
  exitStoreByPair.set(pair, r);
  if (persistExitFn) { try { await persistExitFn(r); } catch (e) { console.error("[EXIT PERSIST] Failed:", e); } }
}

export async function loadExits(): Promise<void> {
  if (!loadExitsFn) return;
  try { const exits = await loadExitsFn(); for (const r of exits) { exitStoreById.set(r.signalId, r); exitStoreByPair.set(r.pair, r); } }
  catch (e) { console.error("[EXIT LOAD] Failed:", e); }
}

export function hasExited(signalId: string): boolean { return exitStoreById.has(signalId); }

const EXIT_COOLDOWN_MS = 8 * 60 * 60 * 1000;

function isInCooldown(pair: string, now: number, direction?: "LONG" | "SHORT"): { inCooldown: boolean; remainingMs: number; lastExit?: ExitRecord } {
  const lastExit = exitStoreByPair.get(pair);
  if (!lastExit) return { inCooldown: false, remainingMs: 0 };
  if (direction && lastExit.direction !== direction) return { inCooldown: false, remainingMs: 0, lastExit };
  const elapsed = now - lastExit.exitTimestamp;
  return elapsed < EXIT_COOLDOWN_MS ? { inCooldown: true, remainingMs: EXIT_COOLDOWN_MS - elapsed, lastExit } : { inCooldown: false, remainingMs: 0, lastExit };
}

// ─── MAIN SIGNAL GENERATION ───

export const CURRENT_SIGNAL_VERSION = 29;

export async function generateSignal(
  pair: string,
  candles1h: Candle[],
  candles4h: Candle[],
  candles15m: Candle[],
  activeTrades?: Record<string, any>,
  currentPrice?: number
): Promise<SignalResult> {
  const debug: string[] = [];
  const config = getPairConfig(pair);
  const now = Date.now();

  if (activeTrades && activeTrades[pair]) {
    debug.push("Active trade exists, skipping duplicate entry");
    const stoch4hQuick = stochRsi(candles4h.map(c => c.close));
    const stoch1hQuick = stochRsi(candles1h.map(c => c.close));
    const price = currentPrice ?? candles1h[candles1h.length - 1].close;
    const market: MarketData = {
      pair, price: Math.round(price * 100) / 100, timestamp: now,
      phase: "WATCHING", trend: "ACTIVE_TRADE",
      htfBias: "MIXED",
      adx: Math.round(adx(candles4h) * 10) / 10, rsi: Math.round(rsi(candles4h.map(c => c.close)) * 10) / 10,
      stochK: stoch4hQuick.k, stochD: stoch4hQuick.d, stoch1hK: stoch1hQuick.k, stoch1hD: stoch1hQuick.d,
    };
    return { market, debug };
  }

  for (let i = 1; i < candles4h.length; i++) {
    if (candles4h[i].timestamp < candles4h[i - 1].timestamp) { debug.push("Candles not sorted"); return { debug }; }
  }

  const candles1d = aggregateTo1D(candles4h);
  debug.push(`1D candles: ${candles1d.length} days from ${candles4h.length} 4H bars`);

  if (candles1d.length < 25 || candles4h.length < 30 || candles1h.length < 50) {
    debug.push(`Insufficient candle data: 1D=${candles1d.length}, 4H=${candles4h.length}, 1H=${candles1h.length}`);
    return { debug };
  }

  const regime = await getRegime(pair, candles1d, candles4h);
  debug.push(`REGIME: ${regime.direction || "NEUTRAL"} ${regime.strength} conf=${regime.confidence}`);
  debug.push(`Regime reasons: ${regime.reason.join(", ")}`);

  if (!regime.direction || regime.direction === "NEUTRAL") {
    debug.push("Regime is NEUTRAL — no directional bias");
    const price = currentPrice ?? candles1h[candles1h.length - 1].close;
    const stoch4h = stochRsi(candles4h.map(c => c.close));
    const stoch1h = stochRsi(candles1h.map(c => c.close));
    const market: MarketData = {
      pair, price: Math.round(price * 100) / 100, timestamp: now,
      phase: "WATCHING", trend: "NEUTRAL",
      htfBias: "MIXED", regime,
      adx: Math.round(adx(candles4h) * 10) / 10, rsi: Math.round(rsi(candles4h.map(c => c.close)) * 10) / 10,
      stochK: stoch4h.k, stochD: stoch4h.d, stoch1hK: stoch1h.k, stoch1hD: stoch1h.d,
    };
    return { market, debug };
  }

  const price = currentPrice ?? candles1h[candles1h.length - 1].close;
  const stoch4h = stochRsi(candles4h.map(c => c.close));
  const stoch1h = stochRsi(candles1h.map(c => c.close));
  const adx4h = adx(candles4h);

  const cooldown = isInCooldown(pair, now, regime.direction);
  if (cooldown.inCooldown) {
    debug.push(`EXIT COOLDOWN: ${(cooldown.remainingMs / 3600000).toFixed(1)}h remaining`);
    const market: MarketData = {
      pair, price: Math.round(price * 100) / 100, timestamp: now,
      phase: "WATCHING", trend: `${regime.direction} ${regime.strength}`,
      htfBias: regime.direction === "LONG" ? "BULLISH" : "BEARISH", regime,
      adx: Math.round(adx4h * 10) / 10, rsi: Math.round(rsi(candles4h.map(c => c.close)) * 10) / 10,
      stochK: stoch4h.k, stochD: stoch4h.d, stoch1hK: stoch1h.k, stoch1hD: stoch1h.d,
    };
    return { market, debug };
  }

  const { candidate, mode, debugLines } = scoreBestEntry(candles1h, candles4h, candles15m, config, pair, regime.direction);
  for (const line of debugLines) debug.push(line);

  if (!candidate) {
    const stochCurrent = stochRsi(candles1h.map(c => c.close));
    const stochPrevious = stochRsi(candles1h.slice(0, -1).map(c => c.close));
    const crossUp = stochPrevious.k <= stochPrevious.d && stochCurrent.k > stochCurrent.d;
    const crossDown = stochPrevious.k >= stochPrevious.d && stochCurrent.k < stochCurrent.d;
    const crossDetected = crossUp || crossDown;
    const crossDirection = crossUp ? "LONG" : crossDown ? "SHORT" : null;

    let rejectionReason = "no_confirmed_cross";
    if (crossDetected && crossDirection !== regime.direction) {
      rejectionReason = `cross_${crossDirection}_vs_regime_${regime.direction}`;
    }

    logRejection({
      pair,
      timestamp: now,
      crossDetected,
      crossDirection,
      regimeDirection: regime.direction || "NEUTRAL",
      regimeStrength: regime.strength,
      confidenceScore: 0,
      confidenceBreakdown: {},
      rejectionReason,
      stochK: stochCurrent.k,
      stochD: stochCurrent.d,
      stochPrevK: stochPrevious.k,
      stochPrevD: stochPrevious.d,
    });

    debug.push(`REJECTED: ${rejectionReason} | K=${stochCurrent.k} D=${stochCurrent.d} prevK=${stochPrevious.k} prevD=${stochPrevious.d}`);

    const market: MarketData = {
      pair, price: Math.round(price * 100) / 100, timestamp: now,
      phase: "WATCHING", trend: `${regime.direction} ${regime.strength}`,
      htfBias: regime.direction === "LONG" ? "BULLISH" : "BEARISH", regime,
      adx: Math.round(adx4h * 10) / 10, rsi: Math.round(rsi(candles4h.map(c => c.close)) * 10) / 10,
      stochK: stoch4h.k, stochD: stoch4h.d, stoch1hK: stoch1h.k, stoch1hD: stoch1h.d,
    };
    return { market, debug };
  }

  debug.push(`CROSSOVER CONFIRMED: ${candidate.direction} ${mode} prevK${candidate.stochPrevK}<=prevD${candidate.stochPrevD} → K${candidate.stochK}>D${candidate.stochD} raw=${candidate.strength}`);
  debug.push(`Components: ${JSON.stringify(candidate.confidenceComponents)}`);

  const exhaustion = checkExhaustion(stoch4h, candidate.direction);
  if (exhaustion.isExhausted) {
    candidate.confidencePenalty = exhaustion.confidencePenalty;
    candidate.finalConfidence = Math.min(100, Math.max(0, candidate.strength + exhaustion.confidencePenalty));
    candidate.exhaustionWarning = exhaustion.reason;
    candidate.confidenceComponents.riskPenalty = exhaustion.confidencePenalty;
    candidate.confidenceComponents.total = candidate.finalConfidence;
    debug.push(`EXHAUSTION: ${exhaustion.reason} → ${candidate.strength} → ${candidate.finalConfidence}`);
  }

  const uiWarning = getExhaustionWarning(stoch1h, { k: candidate.stochPrevK, d: candidate.stochPrevD }, candidate.direction);
  if (uiWarning && !candidate.exhaustionWarning) {
    candidate.exhaustionWarning = uiWarning;
  } else if (uiWarning) {
    candidate.exhaustionWarning += ` | ${uiWarning}`;
  }

  if (candidate.finalConfidence < config.momentumThreshold) {
    debug.push(`FINAL CONFIDENCE ${candidate.finalConfidence} below threshold ${config.momentumThreshold} — blocked`);

    logRejection({
      pair,
      timestamp: now,
      crossDetected: true,
      crossDirection: candidate.direction,
      regimeDirection: regime.direction || "NEUTRAL",
      regimeStrength: regime.strength,
      confidenceScore: candidate.finalConfidence,
      confidenceBreakdown: candidate.confidenceComponents,
      rejectionReason: `confidence_too_low_${candidate.finalConfidence}_vs_${config.momentumThreshold}`,
      stochK: candidate.stochK,
      stochD: candidate.stochD,
      stochPrevK: candidate.stochPrevK,
      stochPrevD: candidate.stochPrevD,
    });

    const market: MarketData = {
      pair, price: Math.round(price * 100) / 100, timestamp: now,
      phase: "WATCHING", trend: `${regime.direction} ${regime.strength}`,
      htfBias: regime.direction === "LONG" ? "BULLISH" : "BEARISH", regime,
      adx: Math.round(adx4h * 10) / 10, rsi: Math.round(rsi(candles4h.map(c => c.close)) * 10) / 10,
      stochK: stoch4h.k, stochD: stoch4h.d, stoch1hK: stoch1h.k, stoch1hD: stoch1h.d,
    };
    return { market, debug };
  }

  debug.push(`SELECTED: ${candidate.direction} ${mode} conf=${candidate.finalConfidence} (raw=${candidate.strength} penalty=${candidate.confidencePenalty})`);

  const entry = price;
  const sl = candidate.direction === "LONG" ? entry * (1 - config.stopLossPct) : entry * (1 + config.stopLossPct);
  const tp = candidate.direction === "LONG" ? entry * (1 + config.takeProfitPct) : entry * (1 - config.takeProfitPct);
  const rr = Math.abs(tp - entry) / Math.abs(entry - sl);
  debug.push(`R:R ${rr.toFixed(2)} (${(config.stopLossPct * 100).toFixed(0)}% SL / ${(config.takeProfitPct * 100).toFixed(0)}% TP)`);

  const exhaustionNote = candidate.exhaustionWarning ? ` | WARNING: ${candidate.exhaustionWarning}` : "";

  const signal: Signal = {
    id: `${pair}_${now}`,
    pair,
    direction: candidate.direction,
    type: "ENTRY",
    scale: "ENTRY_1",
    entry: Math.round(entry * 100) / 100,
    stop: Math.round(sl * 100) / 100,
    target: Math.round(tp * 100) / 100,
    confidence: candidate.finalConfidence,
    rr: Math.round(rr * 100) / 100,
    adx: Math.round(adx4h * 10) / 10,
    rsi: Math.round(rsi(candles4h.map(c => c.close)) * 10) / 10,
    stochK: stoch4h.k,
    stochD: stoch4h.d,
    stoch1hK: candidate.stochK,
    stoch1hD: candidate.stochD,
    expectedMove: Math.round((Math.abs(tp - entry) / entry) * 100 * 10) / 10,
    reason: `${candidate.direction} ${mode} ENTRY | Regime ${regime.direction} ${regime.strength} (since ${new Date(regime.detectedAt).toISOString().split('T')[0]}) | 1H StochRSI K${candidate.stochK}→D${candidate.stochD} cross (prev K${candidate.stochPrevK}/D${candidate.stochPrevD}) | ${candidate.reasons.join(", ")} | RR ${rr.toFixed(2)} | SL ${(config.stopLossPct * 100).toFixed(1)}% TP ${(config.takeProfitPct * 100).toFixed(1)}%${exhaustionNote}`,
    timestamp: now,
    version: CURRENT_SIGNAL_VERSION,
    tradeState: "OPEN",
    lockedStop: null,
    highestPrice: entry,
    lowestPrice: entry,
    profitLockActive: false,
    regimeDirection: regime.direction,
    regimeSince: regime.detectedAt,
    entryMode: candidate.entryMode,
    confidenceComponents: candidate.confidenceComponents,
    exhaustionWarning: candidate.exhaustionWarning || undefined,
  };

  const market: MarketData = {
    pair, price: Math.round(price * 100) / 100, timestamp: now,
    phase: mode === "BREAKOUT" ? "EXPANSION" : "EARLY_ENTRY",
    trend: `${regime.direction} ${regime.strength}`,
    htfBias: candidate.direction === "LONG" ? "BULLISH" : "BEARISH",
    regime,
    adx: signal.adx, rsi: signal.rsi,
    stochK: stoch4h.k, stochD: stoch4h.d,
    stoch1hK: stoch1h.k, stoch1hD: stoch1h.d,
  };

  debug.push(`SIGNAL: ${signal.direction} ${signal.type} mode=${signal.entryMode} entry=${signal.entry} TP=${signal.target} SL=${signal.stop} RR=${signal.rr} conf=${signal.confidence}`);
  return { signal, market, debug };
}

// ─── Market Snapshot ───

export async function getMarketSnapshot(pair: string, candles1h: Candle[], candles4h: Candle[], candles15m: Candle[]): Promise<MarketData> {
  const candles1d = aggregateTo1D(candles4h);
  const stoch4h = stochRsi(candles4h.map(c => c.close));
  const stoch1h = stochRsi(candles1h.map(c => c.close));
  const price = candles4h[candles4h.length - 1].close;
  const adx4h = adx(candles4h);

  let regime: any;
  try { regime = await getRegime(pair, candles1d, candles4h); } catch { /* ignore */ }

  return {
    pair, price: Math.round(price * 100) / 100, timestamp: Date.now(),
    phase: "WATCHING",
    trend: regime ? `${regime.direction} ${regime.strength}` : "UNKNOWN",
    htfBias: regime?.direction === "LONG" ? "BULLISH" : regime?.direction === "SHORT" ? "BEARISH" : "MIXED",
    regime,
    adx: Math.round(adx4h * 10) / 10, rsi: Math.round(rsi(candles4h.map(c => c.close)) * 10) / 10,
    stochK: stoch4h.k, stochD: stoch4h.d, stoch1hK: stoch1h.k, stoch1hD: stoch1h.d,
  };
}

// ─── Trade Manager ───

export function updateTradeManager(signal: Signal, currentPrice: number): TradeManagerUpdate {
  const highest = Math.max(signal.highestPrice || signal.entry, currentPrice);
  const lowest = Math.min(signal.lowestPrice || signal.entry, currentPrice);
  let state = signal.tradeState || "OPEN";
  let locked = signal.lockedStop || signal.stop;
  let profitLock = signal.profitLockActive || false;
  let exit = false;
  let exitReason = "";

  const pnlPct = signal.direction === "LONG" ? (currentPrice - signal.entry) / signal.entry : (signal.entry - currentPrice) / signal.entry;

  const config = getPairConfig(signal.pair);
  const bePct = config.bePct || 0.015;
  const lockPct = config.lockPct || 0.03;
  const runnerPct = config.runnerPct || 0.05;
  const trailRatio = config.isHYPE ? 0.4 : 0.5;

  if (pnlPct >= bePct && state === "OPEN") { state = "BREAK_EVEN"; locked = signal.entry; }
  if (pnlPct >= lockPct && state === "BREAK_EVEN") {
    state = "LOCKED";
    profitLock = true;
    locked = signal.direction === "LONG" ? signal.entry * (1 + bePct * 0.5) : signal.entry * (1 - bePct * 0.5);
  }
  if (pnlPct >= runnerPct && state === "LOCKED") {
    state = "RUNNER";
    const trailDistance = signal.direction === "LONG" ? (highest - signal.entry) * trailRatio : (signal.entry - lowest) * trailRatio;
    locked = signal.direction === "LONG" ? Math.max(locked, highest - trailDistance) : Math.min(locked, lowest + trailDistance);
  }

  if (signal.direction === "LONG" && currentPrice <= locked) { exit = true; exitReason = state === "RUNNER" ? "trailing_stop" : "stop_hit"; }
  else if (signal.direction === "SHORT" && currentPrice >= locked) { exit = true; exitReason = state === "RUNNER" ? "trailing_stop" : "stop_hit"; }
  if (signal.direction === "LONG" && currentPrice >= signal.target) { exit = true; exitReason = "tp_hit"; }
  else if (signal.direction === "SHORT" && currentPrice <= signal.target) { exit = true; exitReason = "tp_hit"; }

  return { signalId: signal.id, newState: exit ? "EXITED" : state, lockedStop: locked, profitLockActive: profitLock, highestPrice: highest, lowestPrice: lowest, exitTriggered: exit, exitReason: exitReason || undefined };
}

export function isSignalStillValid(signal: Signal, currentPrice: number, now: number = Date.now()): ValidityCheck {
  if (signal.exited || hasExited(signal.id)) return { valid: false, reason: "already_exited", exited: true };
  if (signal.direction === "LONG" && currentPrice <= (signal.lockedStop || signal.stop)) return { valid: false, reason: "stop_hit", exited: true };
  if (signal.direction === "SHORT" && currentPrice >= (signal.lockedStop || signal.stop)) return { valid: false, reason: "stop_hit", exited: true };
  if (signal.direction === "LONG" && currentPrice >= signal.target) return { valid: false, reason: "tp_hit", exited: true };
  if (signal.direction === "SHORT" && currentPrice <= signal.target) return { valid: false, reason: "tp_hit", exited: true };
  return { valid: true, reason: "active", exited: false };
}

export async function shouldHold(signal: Signal, candles4h: Candle[], currentPrice: number, now?: number): Promise<HoldResult> {
  if (signal.exited || hasExited(signal.id)) return { shouldHold: false, reason: "already_exited" };

  const tmUpdate = updateTradeManager(signal, currentPrice);
  if (tmUpdate.exitTriggered) {
    if (now) await recordExit(signal.id, signal.pair, signal.direction, currentPrice, tmUpdate.exitReason || "trade_manager_exit", now);
    return { shouldHold: false, reason: tmUpdate.exitReason || "trade_manager_exit", managedStop: tmUpdate.lockedStop || undefined };
  }

  const candles1d = aggregateTo1D(candles4h);
  try {
    const regime = await getRegime(signal.pair, candles1d, candles4h);
    if (regime.direction && regime.direction !== signal.direction) {
      const inProfit = signal.direction === "LONG" ? currentPrice > signal.entry : currentPrice < signal.entry;
      if (!inProfit) {
        if (now) await recordExit(signal.id, signal.pair, signal.direction, currentPrice, "regime_reversed_unprofitable", now);
        return { shouldHold: false, reason: "regime_reversed_unprofitable" };
      }
    }
  } catch {
    // Fallback: skip regime check on error
  }

  return { shouldHold: true, reason: "active", managedStop: tmUpdate.lockedStop || undefined };
}

export async function filterExpiredSignals(signals: Signal[], currentPrices: Record<string, number>, now?: number): Promise<{ active: Signal[]; exited: { signal: Signal; reason: string }[] }> {
  const active: Signal[] = [], exited: { signal: Signal; reason: string }[] = [];
  for (const signal of signals) {
    if (signal.exited || hasExited(signal.id)) continue;
    const price = currentPrices[signal.pair];
    if (price === undefined) { active.push(signal); continue; }
    const tmUpdate = updateTradeManager(signal, price);
    if (tmUpdate.exitTriggered) {
      exited.push({ signal, reason: tmUpdate.exitReason || "trade_manager" });
      if (now) await recordExit(signal.id, signal.pair, signal.direction, price, tmUpdate.exitReason || "trade_manager", now);
      continue;
    }
    const check = isSignalStillValid(signal, price, now);
    if (check.valid) active.push(signal);
    else { exited.push({ signal, reason: check.reason }); if (now) await recordExit(signal.id, signal.pair, signal.direction, price, check.reason, now); }
  }
  return { active, exited };
}

// ─── UI Helpers ───

export function getCurrentRegime(pair: string): MarketRegime | null {
  return getRegimeSync(pair);
}

export function isSignalStillValidBool(signal: Signal, currentPrice: number): boolean {
  return isSignalStillValid(signal, currentPrice).valid;
}
