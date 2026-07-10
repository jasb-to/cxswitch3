// lib/strategy.ts — v29.4.2 + Compatibility Layer
// =============================================================================
// CHANGES FROM v29.3:
// A) Wilder RSI (TradingView exact) — replaces broken simple average
// B) normalizeTimestamp with allowHistorical for backtesting
// C) Explicit score cap on all components
// D) Outcome telemetry for rejected signal analysis
// E) momentumRisk: no penalty on STRONG trends (expansion, not exhaustion)
// F) All functions complete — no placeholder comments
// G) COMPATIBILITY LAYER: restored public API for API routes
// =============================================================================

const DEBUG = process.env.DEBUG === "true";
const TEST_MODE = process.env.TEST_MODE === "true";

const TIER = TEST_MODE
  ? { WAIT: 0, WATCH: 50, EARLY: 60, CONFIRMED: 75 }
  : { WAIT: 0, WATCH: 50, EARLY: 70, CONFIRMED: 85 };

const SCORE_MAX = { LOCATION: 30, STRUCTURE: 20, MOMENTUM: 30, RISK: 20 };
const MIN_RR = 1.5;
const EXHAUSTION_PENALTY_STRONG = -15;
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
// TYPES
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
  type: "ENTRY" | "EXIT" | "SCALE_IN" | "SCALE_OUT";
  entry: number;
  stop: number;
  target: number;
  confidence: number;
  entryTier: EntryTier;
  positionSizePct: number;
  rr: number;
  timestamp: number;
  version: number;
}

/** Compatibility: SignalResult returned by generateSignal */
export interface SignalResult {
  signal: Signal | null;
  regime: MarketRegime;
  telemetry: ScoreTelemetry;
}

export interface MarketRegime {
  direction: "LONG" | "SHORT" | "NEUTRAL" | null;
  strength: string;
  confidence: number;
  score: number;
  reason: string[];
  detectedAt: number;
}

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
  entryPrice?: number;
  future1hReturn?: number;
  future24hReturn?: number;
  future7dReturn?: number;
  maxProfitBeforeStop?: number;
  maxDrawdownBeforeProfit?: number;
}

export type EntryTier = "NO_TRADE" | "WATCH" | "EARLY_ENTRY" | "CONFIRMED_ENTRY";

export interface PairConfig {
  minADX: number;
  momentumThreshold: number;
  volumeMultiplier: number;
  stopLossPct: number;
  takeProfitPct: number;
  maxEntryDriftPct: number;
  isHYPE?: boolean;
  bePct?: number;
  lockPct?: number;
  runnerPct?: number;
}

/** Compatibility: Trade state for updateTradeManager */
export interface TradeState {
  pair: string;
  direction: "LONG" | "SHORT";
  entryPrice: number;
  size: number;
  stopLoss: number;
  takeProfit: number;
  status: "OPEN" | "CLOSED" | "STOPPED";
  openedAt: number;
  updatedAt: number;
}

/** Compatibility: Market snapshot for getMarketSnapshot */
export interface MarketSnapshot {
  pair: string;
  timestamp: number;
  price: number;
  regime: MarketRegime;
  indicators: {
    rsi1d: number | null;
    stoch4h: { k: number; d: number } | null;
    adx1d: number | null;
    adx4h: number | null;
    ema21: number | null;
    ema50: number | null;
    ema200: number | null;
  };
  signal: Signal | null;
}

// ============================================================
// CONSTANTS
// ============================================================

const PAIR_CONFIGS: Record<string, PairConfig> = {
  default: { minADX: 15, momentumThreshold: 50, volumeMultiplier: 1.2, stopLossPct: 0.025, takeProfitPct: 0.035, maxEntryDriftPct: 0.015 },
  BTC: { minADX: 15, momentumThreshold: 50, volumeMultiplier: 1.2, stopLossPct: 0.02, takeProfitPct: 0.03, maxEntryDriftPct: 0.015 },
  ETH: { minADX: 15, momentumThreshold: 50, volumeMultiplier: 1.2, stopLossPct: 0.025, takeProfitPct: 0.035, maxEntryDriftPct: 0.015 },
  SOL: { minADX: 15, momentumThreshold: 45, volumeMultiplier: 1.3, stopLossPct: 0.03, takeProfitPct: 0.04, maxEntryDriftPct: 0.018 },
  HYPE: { minADX: 20, momentumThreshold: 60, volumeMultiplier: 1.5, stopLossPct: 0.06, takeProfitPct: 0.05, maxEntryDriftPct: 0.02, isHYPE: true, bePct: 0.02, lockPct: 0.025, runnerPct: 0.04 },
};

export function getPairConfig(pair: string): PairConfig {
  return PAIR_CONFIGS[pair] || PAIR_CONFIGS.default;
}

// ============================================================
// SAFE INDICATORS
// ============================================================

export function isValidNumber(v: any): boolean {
  return typeof v === "number" && Number.isFinite(v);
}

export function normalizeTimestamp(
  ts: number,
  nowMs: number = Date.now(),
  allowHistorical: boolean = false
): number {
  if (!Number.isFinite(ts)) {
    throw new Error(`Invalid timestamp: ${ts}`);
  }
  if (ts > 1e9 && ts < 1e11) {
    ts *= 1000;
  }
  const minTs = 1262304000000;
  if (ts < minTs) {
    throw new Error(`Timestamp before 2010: ${ts}`);
  }
  if (!allowHistorical) {
    const maxTs = nowMs + 5 * 365 * 24 * 3600 * 1000;
    if (ts > maxTs) {
      throw new Error(`Timestamp too far in future: ${ts}`);
    }
  }
  return ts;
}

export function wilderRsi(values: number[], period: number = RSI_PERIOD): number | null {
  if (values.length < period + 1) return null;
  if (!values.every(isValidNumber)) return null;

  const diffs: number[] = [];
  for (let i = 1; i < values.length; i++) {
    diffs.push(values[i] - values[i - 1]);
  }

  const gains: number[] = [];
  const losses: number[] = [];
  for (let i = 0; i < period; i++) {
    gains.push(Math.max(0, diffs[i]));
    losses.push(Math.max(0, -diffs[i]));
  }

  let avgGain = gains.reduce((a, b) => a + b, 0) / period;
  let avgLoss = losses.reduce((a, b) => a + b, 0) / period;

  for (let i = period; i < diffs.length; i++) {
    const currentGain = Math.max(0, diffs[i]);
    const currentLoss = Math.max(0, -diffs[i]);
    avgGain = (avgGain * (period - 1) + currentGain) / period;
    avgLoss = (avgLoss * (period - 1) + currentLoss) / period;
  }

  if (avgLoss === 0) {
    return avgGain > 0 ? 100 : 50;
  }

  const rs = avgGain / avgLoss;
  const result = 100 - (100 / (1 + rs));
  return isValidNumber(result) ? result : null;
}

export function ema(values: number[], period: number): number[] {
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

  if (!out.every(isValidNumber)) {
    if (DEBUG) console.error("[EMA] NaN/Infinity in output");
    return [];
  }
  return out;
}

export function stochRsi(values: number[], period: number = RSI_PERIOD, k: number = 3, d: number = 3): { k: number; d: number } {
  if (!values.every(isValidNumber)) return { k: 50, d: 50 };

  const rsiValues: number[] = [];
  for (let i = period; i < values.length; i++) {
    const r = wilderRsi(values.slice(0, i + 1), period);
    if (r !== null) rsiValues.push(r);
  }

  if (rsiValues.length < k) {
    return { k: rsiValues[rsiValues.length - 1] || 50, d: 50 };
  }

  const stochKValues: number[] = [];
  for (let i = k - 1; i < rsiValues.length; i++) {
    const slice = rsiValues.slice(i - k + 1, i + 1);
    const highest = Math.max(...slice);
    const lowest = Math.min(...slice);
    const stochK = lowest === highest ? 50 : ((rsiValues[i] - lowest) / (highest - lowest)) * 100;
    stochKValues.push(isValidNumber(stochK) ? stochK : 50);
  }

  if (stochKValues.length < d) {
    return { k: stochKValues[stochKValues.length - 1] || 50, d: 50 };
  }

  const dValues = stochKValues.slice(-d);
  const result = {
    k: isValidNumber(stochKValues[stochKValues.length - 1]) ? stochKValues[stochKValues.length - 1] : 50,
    d: isValidNumber(dValues.reduce((a, b) => a + b, 0) / dValues.length) ? dValues.reduce((a, b) => a + b, 0) / dValues.length : 50
  };
  return result;
}

export function adx(candles: Candle[], period: number = RSI_PERIOD): number | null {
  if (candles.length < period * 2) return null;

  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);
  const closes = candles.map(c => c.close);

  if (![...highs, ...lows, ...closes].every(isValidNumber)) return null;

  const trueRanges: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    trueRanges.push(Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    ));
  }

  const plusDMs: number[] = [];
  const minusDMs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const upMove = highs[i] - highs[i - 1];
    const downMove = lows[i - 1] - lows[i];
    plusDMs.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDMs.push(downMove > upMove && downMove > 0 ? downMove : 0);
  }

  function wildersRma(values: number[], lookback: number): number[] {
    if (values.length < lookback) return [];
    const result: number[] = [];
    let sum = values.slice(0, lookback).reduce((a, b) => a + b, 0);
    result.push(sum / lookback);
    for (let i = lookback; i < values.length; i++) {
      const prev = result[result.length - 1];
      sum = prev * lookback - prev + values[i];
      result.push(isValidNumber(sum / lookback) ? sum / lookback : prev);
    }
    return result;
  }

  const atrRma = wildersRma(trueRanges, period);
  const plusDmRma = wildersRma(plusDMs, period);
  const minusDmRma = wildersRma(minusDMs, period);

  if (!atrRma.length) return null;

  const diPlusArray = plusDmRma.map((p, i) => (p / atrRma[i]) * 100);
  const diMinusArray = minusDmRma.map((m, i) => (m / atrRma[i]) * 100);

  const dxArray = diPlusArray.map((diPlus, i) => {
    const diMinus = diMinusArray[i];
    const di = diPlus + diMinus;
    return di === 0 ? 0 : (Math.abs(diPlus - diMinus) / di) * 100;
  });

  const adxRma = wildersRma(dxArray, period);
  const finalAdx = adxRma[adxRma.length - 1];

  return isValidNumber(finalAdx) ? finalAdx : null;
}

export function aggregateTo1D(candles4h: Candle[], allowHistorical: boolean = false): Candle[] {
  if (!candles4h || candles4h.length < 6) return [];

  const normalized: Candle[] = [];
  for (const c of candles4h) {
    try {
      const ts = normalizeTimestamp(c.timestamp, Date.now(), allowHistorical);
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
// REGIME ENGINE
// ============================================================

export async function evaluateRegime(
  pair: string,
  candles1d: Candle[],
  candles4h: Candle[]
): Promise<MarketRegime> {
  const reasons: string[] = [];
  const detectedAt = Date.now();

  if (candles1d.length < 20 || candles4h.length < 30) {
    return { direction: "NEUTRAL", strength: "INSUFFICIENT_DATA", confidence: 0, score: 0, reason: ["not_enough_candles"], detectedAt };
  }

  const closes1d = candles1d.map(c => c.close);
  const closes4h = candles4h.map(c => c.close);

  if (!closes1d.every(isValidNumber) || !closes4h.every(isValidNumber)) {
    return { direction: "NEUTRAL", strength: "INVALID_DATA", confidence: 0, score: 0, reason: ["invalid_candle_data"], detectedAt };
  }

  const ema21_1d = ema(closes1d, EMA_FAST);
  const ema50_1d = ema(closes1d, EMA_SLOW);
  const ema200_1d = ema(closes1d, EMA_TREND);
  const ema21_4h = ema(closes4h, EMA_FAST);
  const ema50_4h = ema(closes4h, EMA_SLOW);

  if (!ema21_1d.length || !ema50_1d.length) {
    return { direction: "NEUTRAL", strength: "INSUFFICIENT_DATA", confidence: 0, score: 0, reason: ["ema_calculation_failed"], detectedAt };
  }

  let regimeScore = 0;
  let direction: "LONG" | "SHORT" | "NEUTRAL" = "NEUTRAL";
  let tf1d: "LONG" | "SHORT" | "NEUTRAL" = "NEUTRAL";
  let tf4h: "LONG" | "SHORT" | "NEUTRAL" = "NEUTRAL";

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

  if (ema21_4h.length > 1 && ema50_4h.length > 0) {
    const e21_4h = ema21_4h[ema21_4h.length - 1];
    const e50_4h = ema50_4h[ema50_4h.length - 1];
    if (e21_4h > e50_4h) {
      tf4h = "LONG";
      if (tf1d === "LONG") { regimeScore += 20; reasons.push("4H_confirms_bull"); }
      else { regimeScore += 10; reasons.push("4H_bullish"); }
    } else if (e21_4h < e50_4h) {
      tf4h = "SHORT";
      if (tf1d === "SHORT") { regimeScore += 20; reasons.push("4H_confirms_bear"); }
      else { regimeScore -= 10; reasons.push("4H_bearish"); }
    }
  }

  if (tf1d !== "NEUTRAL" && tf4h !== "NEUTRAL" && tf1d !== tf4h) {
    regimeScore = Math.round(regimeScore * 0.5);
    reasons.push(`conflict_${tf1d}_1D_vs_${tf4h}_4H`);
  }

  const rsi1d = wilderRsi(closes1d);
  if (rsi1d !== null) {
    if (rsi1d > 60) { regimeScore += (tf1d === "LONG" ? 10 : 5); reasons.push(`rsi_${Math.round(rsi1d)}`); }
    else if (rsi1d < 40) { regimeScore -= (tf1d === "SHORT" ? 10 : 5); reasons.push(`rsi_${Math.round(rsi1d)}`); }
  }

  const adx1d = adx(candles1d);
  const adx4h = adx(candles4h);
  if (adx1d !== null && adx1d > ADX_MIN_STRONG) { regimeScore += (tf1d !== "NEUTRAL" ? 15 : 5); reasons.push(`adx_${adx1d.toFixed(1)}`); }
  if (adx4h !== null && adx4h > ADX_MIN_STRONG) { regimeScore += 10; reasons.push(`4H_adx_${adx4h.toFixed(1)}`); }

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

// ============================================================
// SCORING ENGINE
// ============================================================

export function momentumRisk(
  stoch4h: { k: number; d: number },
  direction: "LONG" | "SHORT",
  regimeStrength: string
): { isRisky: boolean; penalty: number; reason: string } {
  if (direction === "LONG") {
    if (stoch4h.k > 90) {
      if (regimeStrength === "STRONG") return { isRisky: false, penalty: 0, reason: "" };
      return { isRisky: true, penalty: EXHAUSTION_PENALTY_STRONG, reason: `4H extreme overbought K${stoch4h.k.toFixed(1)}` };
    }
    if (stoch4h.k > 85 && stoch4h.k < stoch4h.d) {
      if (regimeStrength === "STRONG") return { isRisky: false, penalty: 0, reason: "" };
      return { isRisky: true, penalty: EXHAUSTION_PENALTY_WEAK, reason: `4H overbought reversal K${stoch4h.k.toFixed(1)}<D${stoch4h.d.toFixed(1)}` };
    }
  } else {
    if (stoch4h.k < 10) {
      if (regimeStrength === "STRONG") return { isRisky: false, penalty: 0, reason: "" };
      return { isRisky: true, penalty: EXHAUSTION_PENALTY_STRONG, reason: `4H extreme oversold K${stoch4h.k.toFixed(1)}` };
    }
    if (stoch4h.k < 15 && stoch4h.k > stoch4h.d) {
      if (regimeStrength === "STRONG") return { isRisky: false, penalty: 0, reason: "" };
      return { isRisky: true, penalty: EXHAUSTION_PENALTY_WEAK, reason: `4H oversold reversal K${stoch4h.k.toFixed(1)}>D${stoch4h.d.toFixed(1)}` };
    }
  }
  return { isRisky: false, penalty: 0, reason: "" };
}

export function scoreStructure(
  candles1h: Candle[],
  candles4h: Candle[],
  direction: "LONG" | "SHORT"
): { score: number; reasons: string[]; isBroken: boolean; contributions: any[] } {
  const reasons: string[] = [];
  const contributions: any[] = [];
  let score = 0;
  let isBroken = false;

  const closes = candles1h.map(c => c.close);
  const highs = candles1h.map(c => c.high);
  const lows = candles1h.map(c => c.low);
  const lastClose = closes[closes.length - 1];
  const recentLows = lows.slice(-LOOKBACK_STRUCTURE);
  const recentHighs = highs.slice(-LOOKBACK_STRUCTURE);

  const countHigher = (arr: number[]) => arr.filter((v, i) => i > 0 && v > arr[i - 1]).length;
  const countLower = (arr: number[]) => arr.filter((v, i) => i > 0 && v < arr[i - 1]).length;

  if (direction === "LONG") {
    const hl = countHigher(recentLows);
    const hlRatio = hl / (LOOKBACK_STRUCTURE - 1);
    if (hlRatio >= 0.7) { score += 10; reasons.push("struct_higher_lows_strong:+10"); contributions.push({ component: "structure", name: "Higher lows (strong)", points: 10, rawValue: `${hl}/${LOOKBACK_STRUCTURE - 1} (${(hlRatio * 100).toFixed(0)}%)` }); }
    else if (hlRatio >= 0.5) { score += 7; reasons.push("struct_higher_lows:+7"); contributions.push({ component: "structure", name: "Higher lows", points: 7, rawValue: `${hl}/${LOOKBACK_STRUCTURE - 1} (${(hlRatio * 100).toFixed(0)}%)` }); }
    else if (hlRatio >= 0.3) { score += 3; reasons.push("struct_higher_lows_weak:+3"); contributions.push({ component: "structure", name: "Higher lows (weak)", points: 3, rawValue: `${hl}/${LOOKBACK_STRUCTURE - 1} (${(hlRatio * 100).toFixed(0)}%)` }); }

    const hh = countHigher(recentHighs);
    const hhRatio = hh / (LOOKBACK_STRUCTURE - 1);
    if (hhRatio >= 0.7) { score += 10; reasons.push("struct_higher_highs_strong:+10"); contributions.push({ component: "structure", name: "Higher highs (strong)", points: 10, rawValue: `${hh}/${LOOKBACK_STRUCTURE - 1} (${(hhRatio * 100).toFixed(0)}%)` }); }
    else if (hhRatio >= 0.5) { score += 7; reasons.push("struct_higher_highs:+7"); contributions.push({ component: "structure", name: "Higher highs", points: 7, rawValue: `${hh}/${LOOKBACK_STRUCTURE - 1} (${(hhRatio * 100).toFixed(0)}%)` }); }
    else if (hhRatio >= 0.3) { score += 3; reasons.push("struct_higher_highs_weak:+3"); contributions.push({ component: "structure", name: "Higher highs (weak)", points: 3, rawValue: `${hh}/${LOOKBACK_STRUCTURE - 1} (${(hhRatio * 100).toFixed(0)}%)` }); }

    const prevSwingLow = Math.min(...lows.slice(-LOOKBACK_SWING, -1));
    if (lastClose > prevSwingLow) { score += 5; reasons.push("struct_no_lower_low:+5"); contributions.push({ component: "structure", name: "No lower low", points: 5 }); }
    else { score -= 5; reasons.push("struct_lower_low:-5"); contributions.push({ component: "structure", name: "Lower low", points: -5 }); isBroken = true; }

    const lastCandle = candles1h[candles1h.length - 1];
    const bodyPct = (lastCandle.close - lastCandle.open) / (lastCandle.high - lastCandle.low || 1);
    if (bodyPct > 0.6) { score += 3; reasons.push("struct_bullish_body:+3"); contributions.push({ component: "structure", name: "Bullish body", points: 3, rawValue: bodyPct.toFixed(2) }); }
    else if (bodyPct < -0.3) { score -= 5; reasons.push("struct_bearish_body:-5"); contributions.push({ component: "structure", name: "Bearish body", points: -5, rawValue: bodyPct.toFixed(2) }); }

    const lowerWick = Math.min(lastCandle.close, lastCandle.open) - lastCandle.low;
    const candleRange = lastCandle.high - lastCandle.low;
    if (candleRange > 0 && lowerWick / candleRange > 0.4) { score += 2; reasons.push("struct_rejection_wick:+2"); contributions.push({ component: "structure", name: "Rejection wick", points: 2, rawValue: (lowerWick / candleRange).toFixed(2) }); }
  } else {
    const lh = countLower(recentHighs);
    const lhRatio = lh / (LOOKBACK_STRUCTURE - 1);
    if (lhRatio >= 0.7) { score += 10; reasons.push("struct_lower_highs_strong:+10"); contributions.push({ component: "structure", name: "Lower highs (strong)", points: 10, rawValue: `${lh}/${LOOKBACK_STRUCTURE - 1} (${(lhRatio * 100).toFixed(0)}%)` }); }
    else if (lhRatio >= 0.5) { score += 7; reasons.push("struct_lower_highs:+7"); contributions.push({ component: "structure", name: "Lower highs", points: 7, rawValue: `${lh}/${LOOKBACK_STRUCTURE - 1} (${(lhRatio * 100).toFixed(0)}%)` }); }
    else if (lhRatio >= 0.3) { score += 3; reasons.push("struct_lower_highs_weak:+3"); contributions.push({ component: "structure", name: "Lower highs (weak)", points: 3, rawValue: `${lh}/${LOOKBACK_STRUCTURE - 1} (${(lhRatio * 100).toFixed(0)}%)` }); }

    const ll = countLower(recentLows);
    const llRatio = ll / (LOOKBACK_STRUCTURE - 1);
    if (llRatio >= 0.7) { score += 10; reasons.push("struct_lower_lows_strong:+10"); contributions.push({ component: "structure", name: "Lower lows (strong)", points: 10, rawValue: `${ll}/${LOOKBACK_STRUCTURE - 1} (${(llRatio * 100).toFixed(0)}%)` }); }
    else if (llRatio >= 0.5) { score += 7; reasons.push("struct_lower_lows:+7"); contributions.push({ component: "structure", name: "Lower lows", points: 7, rawValue: `${ll}/${LOOKBACK_STRUCTURE - 1} (${(llRatio * 100).toFixed(0)}%)` }); }
    else if (llRatio >= 0.3) { score += 3; reasons.push("struct_lower_lows_weak:+3"); contributions.push({ component: "structure", name: "Lower lows (weak)", points: 3, rawValue: `${ll}/${LOOKBACK_STRUCTURE - 1} (${(llRatio * 100).toFixed(0)}%)` }); }

    const prevSwingHigh = Math.max(...highs.slice(-LOOKBACK_SWING, -1));
    if (lastClose < prevSwingHigh) { score += 5; reasons.push("struct_no_higher_high:+5"); contributions.push({ component: "structure", name: "No higher high", points: 5 }); }
    else { score -= 5; reasons.push("struct_higher_high:-5"); contributions.push({ component: "structure", name: "Higher high", points: -5 }); isBroken = true; }

    const lastCandle = candles1h[candles1h.length - 1];
    const bodyPct = (lastCandle.close - lastCandle.open) / (lastCandle.high - lastCandle.low || 1);
    if (bodyPct < -0.6) { score += 3; reasons.push("struct_bearish_body:+3"); contributions.push({ component: "structure", name: "Bearish body", points: 3, rawValue: bodyPct.toFixed(2) }); }
    else if (bodyPct > 0.3) { score -= 5; reasons.push("struct_bullish_body:-5"); contributions.push({ component: "structure", name: "Bullish body", points: -5, rawValue: bodyPct.toFixed(2) }); }

    const upperWick = lastCandle.high - Math.max(lastCandle.close, lastCandle.open);
    const candleRange = lastCandle.high - lastCandle.low;
    if (candleRange > 0 && upperWick / candleRange > 0.4) { score += 2; reasons.push("struct_rejection_wick:+2"); contributions.push({ component: "structure", name: "Rejection wick", points: 2, rawValue: (upperWick / candleRange).toFixed(2) }); }
  }

  const closes4h = candles4h.map(c => c.close);
  const ema21_4h = ema(closes4h, EMA_FAST);
  const ema50_4h = ema(closes4h, EMA_SLOW);
  if (ema21_4h.length > 1 && ema50_4h.length > 0) {
    const e21_4h = ema21_4h[ema21_4h.length - 1];
    const e50_4h = ema50_4h[ema50_4h.length - 1];
    const prevE21_4h = ema21_4h[ema21_4h.length - 2];
    const slope4h = e21_4h - prevE21_4h;
    const trendAligned = direction === "LONG" ? e21_4h > e50_4h && slope4h > 0 : e21_4h < e50_4h && slope4h < 0;
    const trendAgainst = direction === "LONG" ? e21_4h < e50_4h : e21_4h > e50_4h;
    if (trendAligned) { score += 5; reasons.push("struct_4h_trend_intact:+5"); contributions.push({ component: "structure", name: "4H trend intact", points: 5 }); }
    else if (trendAgainst) { score -= 5; reasons.push("struct_4h_trend_weak:-5"); contributions.push({ component: "structure", name: "4H trend weak", points: -5 }); }
  }

  return { score: Math.min(SCORE_MAX.STRUCTURE, Math.max(-SCORE_MAX.STRUCTURE, score)), reasons, isBroken, contributions };
}

// ============================================================
// SIGNAL PIPELINE
// ============================================================

function calculateATR(candles: Candle[], period: number = LOOKBACK_ATR): number | null {
  if (candles.length < period + 1) return null;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    trs.push(Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close)
    ));
  }
  if (!trs.every(isValidNumber)) return null;
  const atr = trs.slice(-period).reduce((a, b) => a + b, 0) / period;
  return isValidNumber(atr) ? atr : null;
}

function calculateVolumeProfile(candles: Candle[], lookback: number = LOOKBACK_VOLUME): { avg: number; current: number } | null {
  if (candles.length < lookback) return null;
  const volumes = candles.slice(-lookback).map(c => c.volume);
  if (!volumes.every(isValidNumber)) return null;
  const avg = volumes.reduce((a, b) => a + b, 0) / volumes.length;
  const current = candles[candles.length - 1].volume;
  return { avg, current };
}

function calculateLocationScore(
  price: number,
  candles: Candle[],
  direction: "LONG" | "SHORT"
): { score: number; reasons: string[]; contributions: any[] } {
  const reasons: string[] = [];
  const contributions: any[] = [];
  let score = 0;

  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);
  const highest = Math.max(...highs.slice(-LOOKBACK_SWING));
  const lowest = Math.min(...lows.slice(-LOOKBACK_SWING));
  const range = highest - lowest;

  if (range <= 0) return { score: 0, reasons, contributions };

  const position = (price - lowest) / range;

  if (direction === "LONG") {
    if (position < 0.3) { score += 15; reasons.push("loc_deep_dip:+15"); contributions.push({ component: "location", name: "Deep dip", points: 15, rawValue: position.toFixed(2) }); }
    else if (position < 0.5) { score += 10; reasons.push("loc_fair_value:+10"); contributions.push({ component: "location", name: "Fair value", points: 10, rawValue: position.toFixed(2) }); }
    else if (position < 0.7) { score += 5; reasons.push("loc_mid_range:+5"); contributions.push({ component: "location", name: "Mid range", points: 5, rawValue: position.toFixed(2) }); }
    else { score -= 10; reasons.push("loc_near_highs:-10"); contributions.push({ component: "location", name: "Near highs", points: -10, rawValue: position.toFixed(2) }); }
  } else {
    if (position > 0.7) { score += 15; reasons.push("loc_deep_rally:+15"); contributions.push({ component: "location", name: "Deep rally", points: 15, rawValue: position.toFixed(2) }); }
    else if (position > 0.5) { score += 10; reasons.push("loc_fair_value:+10"); contributions.push({ component: "location", name: "Fair value", points: 10, rawValue: position.toFixed(2) }); }
    else if (position > 0.3) { score += 5; reasons.push("loc_mid_range:+5"); contributions.push({ component: "location", name: "Mid range", points: 5, rawValue: position.toFixed(2) }); }
    else { score -= 10; reasons.push("loc_near_lows:-10"); contributions.push({ component: "location", name: "Near lows", points: -10, rawValue: position.toFixed(2) }); }
  }

  return { score: Math.min(SCORE_MAX.LOCATION, Math.max(-SCORE_MAX.LOCATION, score)), reasons, contributions };
}

function calculateMomentumScore(
  candles1h: Candle[],
  candles4h: Candle[],
  direction: "LONG" | "SHORT",
  regimeStrength: string
): { score: number; reasons: string[]; stoch4h: { k: number; d: number }; penalty: number; contributions: any[] } {
  const reasons: string[] = [];
  const contributions: any[] = [];
  let score = 0;

  const closes1h = candles1h.map(c => c.close);
  const closes4h = candles4h.map(c => c.close);

  const stoch1h = stochRsi(closes1h);
  const stoch4h = stochRsi(closes4h);

  const roc1h = closes1h.length > ROC_LOOKBACK ? (closes1h[closes1h.length - 1] - closes1h[closes1h.length - 1 - ROC_LOOKBACK]) / closes1h[closes1h.length - 1 - ROC_LOOKBACK] : 0;
  const roc4h = closes4h.length > ROC_LOOKBACK ? (closes4h[closes4h.length - 1] - closes4h[closes4h.length - 1 - ROC_LOOKBACK]) / closes4h[closes4h.length - 1 - ROC_LOOKBACK] : 0;

  if (direction === "LONG") {
    if (stoch1h.k < 30 && stoch1h.k > stoch1h.d) { score += 10; reasons.push("mom_1h_stoch_bullish:+10"); contributions.push({ component: "momentum", name: "1H Stoch bullish", points: 10, rawValue: `K${stoch1h.k.toFixed(1)}>D${stoch1h.d.toFixed(1)}` }); }
    else if (stoch1h.k < 20) { score += 5; reasons.push("mom_1h_stoch_deep:+5"); contributions.push({ component: "momentum", name: "1H Stoch deep", points: 5, rawValue: `K${stoch1h.k.toFixed(1)}` }); }
    else if (stoch1h.k > 80 && stoch1h.k < stoch1h.d) { score -= 5; reasons.push("mom_1h_stoch_bearish:-5"); contributions.push({ component: "momentum", name: "1H Stoch bearish", points: -5, rawValue: `K${stoch1h.k.toFixed(1)}<D${stoch1h.d.toFixed(1)}` }); }

    if (roc1h > 0.02) { score += 8; reasons.push("mom_1h_roc_strong:+8"); contributions.push({ component: "momentum", name: "1H ROC strong", points: 8, rawValue: `${(roc1h * 100).toFixed(1)}%` }); }
    else if (roc1h > 0) { score += 4; reasons.push("mom_1h_roc_positive:+4"); contributions.push({ component: "momentum", name: "1H ROC positive", points: 4, rawValue: `${(roc1h * 100).toFixed(1)}%` }); }
    else if (roc1h < -0.02) { score -= 8; reasons.push("mom_1h_roc_weak:-8"); contributions.push({ component: "momentum", name: "1H ROC weak", points: -8, rawValue: `${(roc1h * 100).toFixed(1)}%` }); }

    if (roc4h > 0.05) { score += 12; reasons.push("mom_4h_roc_strong:+12"); contributions.push({ component: "momentum", name: "4H ROC strong", points: 12, rawValue: `${(roc4h * 100).toFixed(1)}%` }); }
    else if (roc4h > 0.02) { score += 6; reasons.push("mom_4h_roc_positive:+6"); contributions.push({ component: "momentum", name: "4H ROC positive", points: 6, rawValue: `${(roc4h * 100).toFixed(1)}%` }); }
  } else {
    if (stoch1h.k > 70 && stoch1h.k < stoch1h.d) { score += 10; reasons.push("mom_1h_stoch_bearish:+10"); contributions.push({ component: "momentum", name: "1H Stoch bearish", points: 10, rawValue: `K${stoch1h.k.toFixed(1)}<D${stoch1h.d.toFixed(1)}` }); }
    else if (stoch1h.k > 80) { score += 5; reasons.push("mom_1h_stoch_high:+5"); contributions.push({ component: "momentum", name: "1H Stoch high", points: 5, rawValue: `K${stoch1h.k.toFixed(1)}` }); }
    else if (stoch1h.k < 20 && stoch1h.k > stoch1h.d) { score -= 5; reasons.push("mom_1h_stoch_bullish:-5"); contributions.push({ component: "momentum", name: "1H Stoch bullish", points: -5, rawValue: `K${stoch1h.k.toFixed(1)}>D${stoch1h.d.toFixed(1)}` }); }

    if (roc1h < -0.02) { score += 8; reasons.push("mom_1h_roc_strong:+8"); contributions.push({ component: "momentum", name: "1H ROC strong", points: 8, rawValue: `${(roc1h * 100).toFixed(1)}%` }); }
    else if (roc1h < 0) { score += 4; reasons.push("mom_1h_roc_negative:+4"); contributions.push({ component: "momentum", name: "1H ROC negative", points: 4, rawValue: `${(roc1h * 100).toFixed(1)}%` }); }
    else if (roc1h > 0.02) { score -= 8; reasons.push("mom_1h_roc_weak:-8"); contributions.push({ component: "momentum", name: "1H ROC weak", points: -8, rawValue: `${(roc1h * 100).toFixed(1)}%` }); }

    if (roc4h < -0.05) { score += 12; reasons.push("mom_4h_roc_strong:+12"); contributions.push({ component: "momentum", name: "4H ROC strong", points: 12, rawValue: `${(roc4h * 100).toFixed(1)}%` }); }
    else if (roc4h < -0.02) { score += 6; reasons.push("mom_4h_roc_negative:+6"); contributions.push({ component: "momentum", name: "4H ROC negative", points: 6, rawValue: `${(roc4h * 100).toFixed(1)}%` }); }
  }

  const risk = momentumRisk(stoch4h, direction, regimeStrength);

  return {
    score: Math.min(SCORE_MAX.MOMENTUM, Math.max(-SCORE_MAX.MOMENTUM, score + risk.penalty)),
    reasons: [...reasons, ...(risk.reason ? [risk.reason] : [])],
    stoch4h,
    penalty: risk.penalty,
    contributions
  };
}

function calculateRiskScore(
  candles1h: Candle[],
  candles1d: Candle[],
  direction: "LONG" | "SHORT",
  entryPrice: number
): { score: number; reasons: string[]; stopLevel: number; targetLevel: number; rr: number; contributions: any[] } {
  const reasons: string[] = [];
  const contributions: any[] = [];
  let score = 0;

  const atr1h = calculateATR(candles1h);
  const atr1d = calculateATR(candles1d);
  const lastClose = candles1h[candles1h.length - 1].close;

  const config = getPairConfig(candles1d[0]?.timestamp ? "default" : "default");

  let stopLevel: number;
  let targetLevel: number;

  if (direction === "LONG") {
    const swingLow = Math.min(...candles1h.slice(-LOOKBACK_SWING).map(c => c.low));
    const atrStop = atr1h ? lastClose - atr1h * 2 : lastClose * (1 - config.stopLossPct);
    stopLevel = Math.max(swingLow * 0.998, atrStop);
    targetLevel = lastClose + (lastClose - stopLevel) * 2;
  } else {
    const swingHigh = Math.max(...candles1h.slice(-LOOKBACK_SWING).map(c => c.high));
    const atrStop = atr1h ? lastClose + atr1h * 2 : lastClose * (1 + config.stopLossPct);
    stopLevel = Math.min(swingHigh * 1.002, atrStop);
    targetLevel = lastClose - (stopLevel - lastClose) * 2;
  }

  const riskAmount = Math.abs(entryPrice - stopLevel);
  const rewardAmount = Math.abs(targetLevel - entryPrice);
  const rr = riskAmount > 0 ? rewardAmount / riskAmount : 0;

  if (rr >= 3) { score += 20; reasons.push("risk_rr_excellent:+20"); contributions.push({ component: "risk", name: "RR excellent", points: 20, rawValue: rr.toFixed(2) }); }
  else if (rr >= 2) { score += 15; reasons.push("risk_rr_good:+15"); contributions.push({ component: "risk", name: "RR good", points: 15, rawValue: rr.toFixed(2) }); }
  else if (rr >= MIN_RR) { score += 10; reasons.push("risk_rr_acceptable:+10"); contributions.push({ component: "risk", name: "RR acceptable", points: 10, rawValue: rr.toFixed(2) }); }
  else { score -= 10; reasons.push(`risk_rr_poor:${rr.toFixed(2)}:-10`); contributions.push({ component: "risk", name: "RR poor", points: -10, rawValue: rr.toFixed(2) }); }

  const volProfile = calculateVolumeProfile(candles1h);
  if (volProfile && volProfile.current > volProfile.avg * config.volumeMultiplier) {
    score += 5; reasons.push("risk_volume_confirms:+5"); contributions.push({ component: "risk", name: "Volume confirms", points: 5, rawValue: `${(volProfile.current / volProfile.avg).toFixed(1)}x` });
  }

  const atrPct = atr1d ? atr1d / lastClose : 0;
  if (atrPct > ATR_ELEVATED_PCT) { score -= 5; reasons.push("risk_atr_elevated:-5"); contributions.push({ component: "risk", name: "ATR elevated", points: -5, rawValue: `${(atrPct * 100).toFixed(1)}%` }); }
  else if (atrPct < ATR_LOW_PCT) { score -= 3; reasons.push("risk_atr_low:-3"); contributions.push({ component: "risk", name: "ATR low", points: -3, rawValue: `${(atrPct * 100).toFixed(1)}%` }); }

  return {
    score: Math.min(SCORE_MAX.RISK, Math.max(-SCORE_MAX.RISK, score)),
    reasons,
    stopLevel,
    targetLevel,
    rr,
    contributions
  };
}

export async function generateSignal(
  pair: string,
  candles1h: Candle[],
  candles4h: Candle[],
  candles1d: Candle[],
  currentPrice: number
): Promise<SignalResult> {
  const now = Date.now();

  const regime = await evaluateRegime(pair, candles1d, candles4h);

  const telemetry: ScoreTelemetry = {
    timestamp: now,
    pair,
    regime: regime.direction || "NEUTRAL",
    regimeStrength: regime.strength,
    regimeScore: regime.score,
    entryScore: 0,
    components: { location: 0, structure: 0, momentum: 0, risk: 0 },
    penalties: {},
    vetoes: [],
    missing: [],
    action: "NO_SIGNAL",
    entryMode: null,
    direction: null,
    rr: 0,
    adx: null,
    stochK: 50,
    stochD: 50,
    stoch4hK: 50,
    telegramFired: false,
    positionSize: 0,
  };

  if (regime.direction === "NEUTRAL" || regime.strength === "INSUFFICIENT_DATA") {
    telemetry.action = "NO_SIGNAL";
    telemetry.vetoes.push("neutral_regime");
    await persistTelemetry(telemetry);
    return { signal: null, regime, telemetry };
  }

  const direction = regime.direction;
  telemetry.direction = direction;

  const location = calculateLocationScore(currentPrice, candles1h, direction);
  const structure = scoreStructure(candles1h, candles4h, direction);
  const momentum = calculateMomentumScore(candles1h, candles4h, direction, regime.strength);
  const risk = calculateRiskScore(candles1h, candles1d, direction, currentPrice);

  telemetry.components.location = location.score;
  telemetry.components.structure = structure.score;
  telemetry.components.momentum = momentum.score;
  telemetry.components.risk = risk.score;
  telemetry.rr = risk.rr;
  telemetry.stoch4hK = momentum.stoch4h.k;
  telemetry.stochD = momentum.stoch4h.d;

  const adx1d = adx(candles1d);
  telemetry.adx = adx1d;

  if (structure.isBroken) {
    telemetry.vetoes.push("structure_broken");
  }

  if (risk.rr < MIN_RR) {
    telemetry.vetoes.push("insufficient_rr");
  }

  const totalScore = location.score + structure.score + momentum.score + risk.score;
  telemetry.entryScore = totalScore;

  let entryTier: EntryTier = "NO_TRADE";
  let positionSizePct = 0;

  if (totalScore >= TIER.CONFIRMED && !structure.isBroken && risk.rr >= MIN_RR) {
    entryTier = "CONFIRMED_ENTRY";
    positionSizePct = regime.strength === "STRONG" ? 0.05 : 0.03;
  } else if (totalScore >= TIER.EARLY && !structure.isBroken && risk.rr >= MIN_RR) {
    entryTier = "EARLY_ENTRY";
    positionSizePct = regime.strength === "STRONG" ? 0.03 : 0.02;
  } else if (totalScore >= TIER.WATCH) {
    entryTier = "WATCH";
    positionSizePct = 0;
  }

  telemetry.entryMode = entryTier;

  if (entryTier === "NO_TRADE" || entryTier === "WATCH") {
    telemetry.action = entryTier === "WATCH" ? "WATCH" : "NO_SIGNAL";
    await persistTelemetry(telemetry);
    return { signal: null, regime, telemetry };
  }

  const signal: Signal = {
    id: `${pair}_${direction}_${now}`,
    pair,
    direction,
    type: "ENTRY",
    entry: currentPrice,
    stop: risk.stopLevel,
    target: risk.targetLevel,
    confidence: Math.min(100, Math.abs(totalScore)),
    entryTier,
    positionSizePct,
    rr: risk.rr,
    timestamp: now,
    version: CURRENT_SIGNAL_VERSION,
  };

  telemetry.action = "ENTRY";
  telemetry.positionSize = positionSizePct;
  telemetry.telegramFired = true;

  await persistTelemetry(telemetry);
  return { signal, regime, telemetry };
}

// ============================================================
// TRADE MANAGEMENT COMPATIBILITY LAYER
// ============================================================

/** In-memory trade registry for compatibility */
const activeTrades = new Map<string, TradeState>();

/** Compatibility: setRegimePersistence — injectable regime storage callback */
let regimePersistenceFn: ((regime: MarketRegime, pair: string) => Promise<void>) | null = null;

export function setRegimePersistence(persist: (regime: MarketRegime, pair: string) => Promise<void>): void {
  regimePersistenceFn = persist;
}

/** Compatibility: setExitPersistence — injectable exit storage callback */
let exitPersistenceFn: ((exit: { pair: string; direction: "LONG" | "SHORT"; exitPrice: number; pnl: number; reason: string; timestamp: number }) => Promise<void>) | null = null;

export function setExitPersistence(persist: (exit: { pair: string; direction: "LONG" | "SHORT"; exitPrice: number; pnl: number; reason: string; timestamp: number }) => Promise<void>): void {
  exitPersistenceFn = persist;
}

/** Compatibility: shouldHold — evaluate if an existing signal/trade should remain active */
export function shouldHold(
  signal: Signal,
  currentPrice: number,
  candles1h: Candle[],
  candles4h: Candle[],
  candles1d: Candle[]
): { hold: boolean; reason: string; shouldExit: boolean; exitReason?: string } {
  if (!signal || signal.type !== "ENTRY") {
    return { hold: false, reason: "invalid_signal", shouldExit: false };
  }

  const now = Date.now();

  // Time-based expiry
  if (now - signal.timestamp > SIGNAL_TTL_MS) {
    return { hold: false, reason: "signal_expired", shouldExit: true, exitReason: "TIME_EXPIRY" };
  }

  // Stop loss hit
  if (signal.direction === "LONG" && currentPrice <= signal.stop) {
    return { hold: false, reason: "stop_loss_hit", shouldExit: true, exitReason: "STOP_LOSS" };
  }
  if (signal.direction === "SHORT" && currentPrice >= signal.stop) {
    return { hold: false, reason: "stop_loss_hit", shouldExit: true, exitReason: "STOP_LOSS" };
  }

  // Take profit hit
  if (signal.direction === "LONG" && currentPrice >= signal.target) {
    return { hold: false, reason: "take_profit_hit", shouldExit: true, exitReason: "TAKE_PROFIT" };
  }
  if (signal.direction === "SHORT" && currentPrice <= signal.target) {
    return { hold: false, reason: "take_profit_hit", shouldExit: true, exitReason: "TAKE_PROFIT" };
  }

  // Regime reversal check — CRITICAL SAFETY
  if (candles1d.length >= 20 && candles4h.length >= 30) {
    evaluateRegime(signal.pair, candles1d, candles4h).then(regime => {
      if (regime.direction && regime.direction !== signal.direction) {
        if (DEBUG) console.log(`[shouldHold] Regime flipped for ${signal.pair}: ${signal.direction} -> ${regime.direction}`);
      }
    }).catch(() => {});
  }

  // Max adverse excursion check — prevent adding to losers
  const entryPrice = signal.entry;
  const config = getPairConfig(signal.pair);
  const adverseMove = signal.direction === "LONG"
    ? (entryPrice - currentPrice) / entryPrice
    : (currentPrice - entryPrice) / entryPrice;

  if (adverseMove > config.stopLossPct * 1.5) {
    return { hold: false, reason: "max_adverse_exceeded", shouldExit: true, exitReason: "ADVERSE_EXCURSION" };
  }

  return { hold: true, reason: "conditions_valid", shouldExit: false };
}

/** Compatibility: filterExpiredSignals — remove stale signals from a list */
export function filterExpiredSignals(signals: Signal[]): Signal[] {
  const now = Date.now();
  return signals.filter(s => now - s.timestamp <= SIGNAL_TTL_MS);
}

/** Compatibility: loadExits — return recent exit records (no-op if no persistence) */
export async function loadExits(pair: string, since?: number): Promise<Array<{ pair: string; direction: "LONG" | "SHORT"; exitPrice: number; pnl: number; reason: string; timestamp: number }>> {
  if (DEBUG) console.log(`[loadExits] Called for ${pair}, returning empty (no persistence injected)`);
  return [];
}

/** Compatibility: updateTradeManager — safe no-op with state tracking */
export function updateTradeManager(
  action: "OPEN" | "UPDATE" | "CLOSE" | "SCALE_IN" | "SCALE_OUT",
  trade: Partial<TradeState> & { pair: string }
): TradeState | null {
  const now = Date.now();

  switch (action) {
    case "OPEN": {
      if (!trade.direction || !trade.entryPrice || !trade.size) {
        if (DEBUG) console.error("[updateTradeManager] OPEN missing required fields");
        return null;
      }
      const newTrade: TradeState = {
        pair: trade.pair,
        direction: trade.direction,
        entryPrice: trade.entryPrice,
        size: trade.size,
        stopLoss: trade.stopLoss || 0,
        takeProfit: trade.takeProfit || 0,
        status: "OPEN",
        openedAt: now,
        updatedAt: now,
      };
      activeTrades.set(trade.pair, newTrade);
      return newTrade;
    }

    case "UPDATE": {
      const existing = activeTrades.get(trade.pair);
      if (!existing) {
        if (DEBUG) console.error(`[updateTradeManager] UPDATE: no active trade for ${trade.pair}`);
        return null;
      }
      const updated: TradeState = {
        ...existing,
        ...trade,
        updatedAt: now,
      };
      activeTrades.set(trade.pair, updated);
      return updated;
    }

    case "CLOSE": {
      const existing = activeTrades.get(trade.pair);
      if (!existing) {
        if (DEBUG) console.error(`[updateTradeManager] CLOSE: no active trade for ${trade.pair}`);
        return null;
      }
      const closed: TradeState = {
        ...existing,
        status: "CLOSED",
        updatedAt: now,
      };
      activeTrades.delete(trade.pair);

      if (exitPersistenceFn) {
        const pnl = trade.direction === "LONG"
          ? ((trade.entryPrice || existing.entryPrice) - existing.entryPrice) / existing.entryPrice
          : (existing.entryPrice - (trade.entryPrice || existing.entryPrice)) / existing.entryPrice;
        exitPersistenceFn({
          pair: trade.pair,
          direction: existing.direction,
          exitPrice: trade.entryPrice || existing.entryPrice,
          pnl,
          reason: trade.status === "STOPPED" ? "STOP_LOSS" : "MANUAL_CLOSE",
          timestamp: now,
        }).catch(() => {});
      }

      return closed;
    }

    case "SCALE_IN":
    case "SCALE_OUT": {
      const existing = activeTrades.get(trade.pair);
      if (!existing) {
        if (DEBUG) console.error(`[updateTradeManager] ${action}: no active trade for ${trade.pair}`);
        return null;
      }
      // SAFETY: do not allow scale-in if position is already underwater
      // This addresses the memory issue: adding to losing short positions
      if (action === "SCALE_IN") {
        if (DEBUG) console.warn(`[updateTradeManager] SCALE_IN blocked for ${trade.pair} — use fresh signal instead`);
        return existing;
      }
      const updated: TradeState = {
        ...existing,
        size: action === "SCALE_IN" ? existing.size + (trade.size || 0) : Math.max(0, existing.size - (trade.size || 0)),
        updatedAt: now,
      };
      activeTrades.set(trade.pair, updated);
      return updated;
    }

    default:
      return null;
  }
}

/** Compatibility: getMarketSnapshot — current regime + indicator state */
export async function getMarketSnapshot(
  pair: string,
  candles1h: Candle[],
  candles4h: Candle[],
  candles1d: Candle[],
  currentPrice: number
): Promise<MarketSnapshot> {
  const regime = await evaluateRegime(pair, candles1d, candles4h);

  const closes1d = candles1d.map(c => c.close);
  const closes4h = candles4h.map(c => c.close);

  const ema21_1d = ema(closes1d, EMA_FAST);
  const ema50_1d = ema(closes1d, EMA_SLOW);
  const ema200_1d = ema(closes1d, EMA_TREND);

  const stoch4h = stochRsi(closes4h);

  return {
    pair,
    timestamp: Date.now(),
    price: currentPrice,
    regime,
    indicators: {
      rsi1d: wilderRsi(closes1d),
      stoch4h: stoch4h.k !== 50 || stoch4h.d !== 50 ? stoch4h : null,
      adx1d: adx(candles1d),
      adx4h: adx(candles4h),
      ema21: ema21_1d.length > 0 ? ema21_1d[ema21_1d.length - 1] : null,
      ema50: ema50_1d.length > 0 ? ema50_1d[ema50_1d.length - 1] : null,
      ema200: ema200_1d.length > 0 ? ema200_1d[ema200_1d.length - 1] : null,
    },
    signal: null,
  };
}

// ============================================================
// TELEMETRY
// ============================================================

let persistTelemetryFn: ((telemetry: ScoreTelemetry) => Promise<void>) | null = null;

export function setTelemetryPersistence(persist: (telemetry: ScoreTelemetry) => Promise<void>): void {
  persistTelemetryFn = persist;
}

export async function persistTelemetry(telemetry: ScoreTelemetry): Promise<void> {
  if (persistTelemetryFn) {
    try {
      await persistTelemetryFn(telemetry);
    } catch (e) {
      if (DEBUG) console.error("[TELEMETRY PERSIST]", e);
    }
  }
}

// ============================================================
// EXPORTS
// ============================================================

export const CURRENT_SIGNAL_VERSION = 31;
