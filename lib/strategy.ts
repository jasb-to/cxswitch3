// lib/strategy.v29.4.1.ts — DATA INTEGRITY + TELEMETRY + RELAXED EXHAUSTION
// =============================================================================
// CHANGES FROM v29.3:
// - aggregateTo1D: timestamp normalization with range validation
// - All indicators: input + output NaN/Infinity guards
// - evaluateRegime: early return on invalid data
// - Exhaustion renamed to momentumRisk, penalty -50 → -15/-8
// - Structure scoring: graded (ratio-based) instead of binary cliffs
// - Lower low / higher high penalty: -10 → -5
// - TEST_MODE feature flag for tier relaxation
// - Full telemetry output on every evaluation
// =============================================================================

const DEBUG = process.env.DEBUG === "true";
const TEST_MODE = process.env.TEST_MODE === "true";

const TIER = TEST_MODE
  ? { WAIT: 0, WATCH: 50, EARLY: 60, CONFIRMED: 75 }
  : { WAIT: 0, WATCH: 50, EARLY: 70, CONFIRMED: 85 };

const SCORE_MAX = { LOCATION: 30, STRUCTURE: 20, MOMENTUM: 30, RISK: 20 };
const MIN_RR = 1.5;
const EXHAUSTION_PENALTY_STRONG = -15;  // Was -50
const EXHAUSTION_PENALTY_WEAK = -8;
const ADX_MIN_STRONG = 25;
const ATR_LOW_PCT = 0.015;
const ATR_NORMAL_PCT = 0.025;
const ATR_ELEVATED_PCT = 0.04;
const SIGNAL_TTL_MS = 4 * 60 * 60 * 1000;
const EMA_FAST = 21;
const EMA_SLOW = 50;
const EMA_TREND = 200;
const RSI_PERIOD = 14;
const LOOKBACK_SWING = 20;
const LOOKBACK_STRUCTURE = 10;
const LOOKBACK_VOLUME = 20;
const LOOKBACK_ATR = 14;
const ROC_LOOKBACK = 4;

// ============================================================
// DATA INTEGRITY — Timestamp normalization
// ============================================================

function normalizeTimestamp(ts: number, nowMs: number = Date.now()): number {
  if (!Number.isFinite(ts)) {
    throw new Error(`Invalid timestamp: ${ts}`);
  }
  
  // Detect seconds vs milliseconds
  if (ts > 1e9 && ts < 1e11) {
    ts *= 1000;
  }
  
  // Sanity check: within last 20 years or next 5 years
  const minTs = nowMs - 20 * 365 * 24 * 3600 * 1000;
  const maxTs = nowMs + 5 * 365 * 24 * 3600 * 1000;
  if (ts < minTs || ts > maxTs) {
    throw new Error(`Timestamp out of range: ${ts}`);
  }
  
  return ts;
}

// ============================================================
// DATA INTEGRITY — Number validation
// ============================================================

function isValidNumber(v: any): boolean {
  return typeof v === 'number' && Number.isFinite(v);
}

// ============================================================
// SAFE INDICATORS — Input + output guards
// ============================================================

function ema(values: number[], period: number): number[] {
  if (values.length < period) return [];
  if (!values.every(isValidNumber)) {
    if (DEBUG) console.error("[EMA] Invalid input values");
    return [];
  }
  
  const k = 2 / (period + 1);
  const out: number[] = [];
  const seed = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  let prev = seed;
  out.push(prev);
  
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out.push(prev);
  }
  
  // OUTPUT GUARD
  if (!out.every(isValidNumber)) {
    if (DEBUG) console.error("[EMA] NaN/Infinity in output");
    return [];
  }
  return out;
}

function rsi(values: number[], period: number = RSI_PERIOD): number | null {
  if (values.length < period + 1) return null;
  if (!values.every(isValidNumber)) return null;
  
  const diffs: number[] = [];
  for (let i = 1; i < values.length; i++) diffs.push(values[i] - values[i - 1]);
  const gains = diffs.filter(d => d > 0);
  const losses = diffs.filter(d => d < 0).map(d => Math.abs(d));
  const avgGain = gains.length ? gains.slice(-period).reduce((a, b) => a + b, 0) / period : 0;
  const avgLoss = losses.length ? losses.slice(-period).reduce((a, b) => a + b, 0) / period : 0;
  
  if (avgLoss === 0) return avgGain > 0 ? 100 : 50;
  const result = 100 - 100 / (1 + avgGain / avgLoss);
  return isValidNumber(result) ? result : null;
}

function stochRsi(values: number[], period: number = RSI_PERIOD, k: number = 3, d: number = 3): { k: number; d: number } {
  if (!values.every(isValidNumber)) return { k: 50, d: 50 };
  
  const rsiValues: number[] = [];
  for (let i = period; i < values.length; i++) {
    const r = rsi(values.slice(0, i + 1), period);
    if (r !== null) rsiValues.push(r);
  }
  if (rsiValues.length < k) return { k: rsiValues[rsiValues.length - 1] || 50, d: 50 };
  
  const stochKValues: number[] = [];
  for (let i = k - 1; i < rsiValues.length; i++) {
    const slice = rsiValues.slice(i - k + 1, i + 1);
    const highest = Math.max(...slice);
    const lowest = Math.min(...slice);
    const stochK = lowest === highest ? 50 : ((rsiValues[i] - lowest) / (highest - lowest)) * 100;
    stochKValues.push(isValidNumber(stochK) ? stochK : 50);
  }
  if (stochKValues.length < d) return { k: stochKValues[stochKValues.length - 1] || 50, d: 50 };
  
  const dValues = stochKValues.slice(-d);
  const result = {
    k: isValidNumber(stochKValues[stochKValues.length - 1]) ? stochKValues[stochKValues.length - 1] : 50,
    d: isValidNumber(dValues.reduce((a, b) => a + b, 0) / dValues.length) ? dValues.reduce((a, b) => a + b, 0) / dValues.length : 50
  };
  return result;
}

function adx(candles: Candle[], period: number = RSI_PERIOD): number | null {
  if (candles.length < period * 2) return null;
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);
  const closes = candles.map(c => c.close);
  
  if (![...highs, ...lows, ...closes].every(isValidNumber)) return null;
  
  // ... (ADX calculation same as v29.3) ...
  // Final return with guard:
  const finalAdx = /* calculated value */;
  return isValidNumber(finalAdx) ? finalAdx : null;
}

// ============================================================
// FIXED aggregateTo1D — normalize timestamps FIRST
// ============================================================

function aggregateTo1D(candles4h: Candle[]): Candle[] {
  if (!candles4h || candles4h.length < 6) return [];
  
  // Normalize timestamps FIRST
  const normalized: Candle[] = [];
  for (const c of candles4h) {
    try {
      const ts = normalizeTimestamp(c.timestamp);
      normalized.push({ ...c, timestamp: ts });
    } catch (e) {
      if (DEBUG) console.error("[aggregateTo1D] Skipping invalid timestamp:", e);
      continue;
    }
  }
  
  if (normalized.length < 6) return [];
  
  const sorted = [...normalized].sort((a, b) => a.timestamp - b.timestamp);
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
      volume: bars.reduce((s, b) => s + b.volume, 0)
    });
  }
  return daily.sort((a, b) => a.timestamp - b.timestamp);
}

// ============================================================
// SAFE REGIME DETECTION
// ============================================================

async function evaluateRegime(pair: string, candles1d: Candle[], candles4h: Candle[]): Promise<MarketRegime> {
  const reasons: string[] = [];
  const detectedAt = Date.now();
  
  if (candles1d.length < 20 || candles4h.length < 30) {
    return { direction: "NEUTRAL", strength: "INSUFFICIENT_DATA", confidence: 0, score: 0, reason: ["not_enough_candles"], detectedAt };
  }
  
  const closes1d = candles1d.map(c => c.close);
  const closes4h = candles4h.map(c => c.close);
  
  // Guard: invalid data
  if (!closes1d.every(isValidNumber) || !closes4h.every(isValidNumber)) {
    return { direction: "NEUTRAL", strength: "INVALID_DATA", confidence: 0, score: 0, reason: ["invalid_candle_data"], detectedAt };
  }
  
  const ema21_1d = ema(closes1d, EMA_FAST);
  const ema50_1d = ema(closes1d, EMA_SLOW);
  
  // Guard: EMA calculation failed
  if (!ema21_1d.length || !ema50_1d.length) {
    return { direction: "NEUTRAL", strength: "INSUFFICIENT_DATA", confidence: 0, score: 0, reason: ["ema_calculation_failed"], detectedAt };
  }
  
  // ... rest of regime logic unchanged ...
}

// ============================================================
// MOMENTUM RISK (renamed from checkExhaustion)
// ============================================================

function momentumRisk(
  stoch4h: { k: number; d: number },
  direction: "LONG" | "SHORT",
  regimeStrength: string
): { isRisky: boolean; penalty: number; reason: string } {
  if (direction === "LONG") {
    if (stoch4h.k > 90) {
      return { isRisky: true, penalty: EXHAUSTION_PENALTY_STRONG, reason: `4H extreme overbought K${stoch4h.k.toFixed(1)}` };
    }
    if (stoch4h.k > 85 && stoch4h.k < stoch4h.d && regimeStrength !== "STRONG") {
      return { isRisky: true, penalty: EXHAUSTION_PENALTY_WEAK, reason: `4H overbought reversal K${stoch4h.k.toFixed(1)}<D${stoch4h.d.toFixed(1)}` };
    }
  } else {
    if (stoch4h.k < 10) {
      return { isRisky: true, penalty: EXHAUSTION_PENALTY_STRONG, reason: `4H extreme oversold K${stoch4h.k.toFixed(1)}` };
    }
    if (stoch4h.k < 15 && stoch4h.k > stoch4h.d && regimeStrength !== "STRONG") {
      return { isRisky: true, penalty: EXHAUSTION_PENALTY_WEAK, reason: `4H oversold reversal K${stoch4h.k.toFixed(1)}>D${stoch4h.d.toFixed(1)}` };
    }
  }
  return { isRisky: false, penalty: 0, reason: "" };
}

// ============================================================
// GRADED STRUCTURE SCORING (no more binary cliffs)
// ============================================================

function scoreStructure(candles1h: Candle[], candles4h: Candle[], direction: "LONG" | "SHORT") {
  // ... higher lows scoring ...
  const hl = countHigher(recentLows);
  const hlRatio = hl / (LOOKBACK_STRUCTURE - 1);
  
  if (hlRatio >= 0.7) { score += 10; reasons.push("struct_higher_lows_strong:+10"); }
  else if (hlRatio >= 0.5) { score += 7; reasons.push("struct_higher_lows:+7"); }
  else if (hlRatio >= 0.3) { score += 3; reasons.push("struct_higher_lows_weak:+3"); }
  // else: 0 (no penalty for partial structure)
  
  // ... lower low penalty reduced ...
  const prevSwingLow = lowest(lows.slice(-LOOKBACK_SWING, -1), LOOKBACK_STRUCTURE);
  if (lastClose > prevSwingLow) {
    score += 5; reasons.push("struct_no_lower_low:+5");
  } else {
    score -= 5; reasons.push("struct_lower_low:-5");  // Was -10
    isBroken = true;
  }
  
  // ... same pattern for higher highs / lower highs / lower lows ...
}

// ============================================================
// TELEMETRY — Every evaluation outputs full breakdown
// ============================================================

export interface ScoreTelemetry {
  timestamp: number;
  pair: string;
  regime: string;
  regimeStrength: string;
  regimeScore: number;
  entryScore: number;
  components: { location: number; structure: number; momentum: number; risk: number };
  penalties: Record<string, number>;
  vetoes: string[];
  missing: string[];
  action: string;
  entryMode: string | null;
  direction: "LONG" | "SHORT" | null;
  rr: number;
  adx: number | null;
  stochK: number;
  stochD: number;
  stoch4hK: number;
  telegramFired: boolean;
  positionSize: number;
}

// In evaluateEntry, after scoring:
const telemetry: ScoreTelemetry = {
  timestamp: now,
  pair,
  regime: regime.direction || "NEUTRAL",
  regimeStrength: regime.strength,
  regimeScore: regime.score,
  entryScore: finalConfidence,
  components: {
    location: location.score,
    structure: structure.score,
    momentum: momentum.score,
    risk: risk.score
  },
  penalties: {
    ...(momentumRiskResult.isRisky ? { momentumRisk: momentumRiskResult.penalty } : {}),
    ...(adx4h < config.minADX ? { adx: -(config.minADX - adx4h) * 2 } : {})
  },
  vetoes: [
    ...(momentumRiskResult.isRisky && finalConfidence < TIER.EARLY ? ["momentum_risk"] : []),
    ...(rr < MIN_RR ? ["rr_below_minimum"] : [])
  ],
  missing: analysis.missing.map(m => m.component),
  action: finalTier === "CONFIRMED_ENTRY" ? "CONFIRMED_ENTRY" : finalTier === "EARLY_ENTRY" ? "EARLY_ENTRY" : finalTier === "WATCH" ? "WATCH" : "WAIT",
  entryMode: evaluation.entryMode || null,
  direction: evaluation.direction || null,
  rr: risk.rr,
  adx: adx4h,
  stochK: indicators.stoch1h.k,
  stochD: indicators.stoch1h.d,
  stoch4hK: indicators.stoch4h.k,
  telegramFired: telegramFired,
  positionSize: positionSizePct
};

// Persist telemetry for analysis
await persistTelemetry(telemetry);
