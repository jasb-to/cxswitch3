// lib/strategy.ts — v29.1 "Regime + Dual Mode Entry"
// ============================================================
// 2026-07-08: v29.1 FINAL — integrates with existing state/telegram/cron/dashboard
//   - Structural regime invalidation (no time gates)
//   - Three entry modes: PULLBACK (v28), REJECTION (new), BREAKOUT (new)
//   - Transparent confidence scoring with named components
//   - Full backward compatibility with existing UI, state, telegram, cron
//   - Single file: regime + entry hunter + strategy embedded
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
  type: "ENTRY" | "ACCUMULATE" | "BREAKOUT";
  scale: "ENTRY_1" | "ENTRY_2" | null;
  entry: number;
  stop: number;
  target: number;
  confidence: number;
  rr: number;
  adx: number;
  rsi: number;
  stochK: number;
  stochD: number;
  stoch1hK: number;
  stoch1hD: number;
  expectedMove: number;
  reason: string;
  timestamp: number;
  version: number;
  exited?: boolean;
  exitReason?: string;
  exitPrice?: number;
  exitTimestamp?: number;
  tradeState?: "OPEN" | "BREAK_EVEN" | "LOCKED" | "RUNNER" | "EXITED";
  lockedStop?: number | null;
  highestPrice?: number;
  lowestPrice?: number;
  profitLockActive?: boolean;
  // v29.1 new fields (optional for backward compat)
  regimeDirection?: "LONG" | "SHORT";
  regimeSince?: number;
  entryMode?: "PULLBACK" | "REJECTION" | "BREAKOUT";
  confidenceComponents?: Record<string, number>;
  exhaustionWarning?: string;
}

export interface MarketData {
  pair: string;
  price: number;
  timestamp: number;
  phase: "NONE" | "WATCHING" | "READY" | "EARLY_ENTRY" | "EXPANSION";
  trend: string;
  htfBias?: "BULLISH" | "BEARISH" | "MIXED";
  adx: number;
  rsi: number;
  stochK: number;
  stochD: number;
  stoch1hK?: number;
  stoch1hD?: number;
  // v29.1 new
  regime?: MarketRegime;
}

export interface SignalResult {
  signal?: Signal;
  market?: MarketData;
  debug: string[];
}

export const CURRENT_SIGNAL_VERSION = 29;

// ─── Pair Config (unchanged from v28) ───

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

// ─── Indicator Helpers (unchanged) ───

function avg(arr: number[]): number {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function rsi(closes: number[], period: number = 14): number {
  let gains = 0, losses = 0;
  for (let i = 1; i <= period && i < closes.length; i++) {
    const change = closes[closes.length - i] - closes[closes.length - i - 1];
    if (change > 0) gains += change; else losses += Math.abs(change);
  }
  const avgGain = gains / period, avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  return 100 - (100 / (1 + avgGain / avgLoss));
}

function rsiSeries(closes: number[], period: number = 14): number[] {
  const series: number[] = [];
  for (let i = period; i < closes.length; i++) {
    series.push(rsi(closes.slice(i - period + 1, i + 1), period));
  }
  return series;
}

function stochRsi(closes: number[], rsiPeriod: number = 14, stochPeriod: number = 14, kSmooth: number = 3, dSmooth: number = 3): { k: number; d: number } {
  const rsiValues = rsiSeries(closes, rsiPeriod);
  if (rsiValues.length < stochPeriod + kSmooth - 1) return { k: 50, d: 50 };
  const rawK: number[] = [];
  for (let i = stochPeriod - 1; i < rsiValues.length; i++) {
    const window = rsiValues.slice(i - stochPeriod + 1, i + 1);
    const lowest = Math.min(...window), highest = Math.max(...window);
    rawK.push(highest === lowest ? 50 : ((rsiValues[i] - lowest) / (highest - lowest)) * 100);
  }
  const kValues: number[] = [];
  for (let i = kSmooth - 1; i < rawK.length; i++) {
    kValues.push(avg(rawK.slice(i - kSmooth + 1, i + 1)));
  }
  if (kValues.length < dSmooth) return { k: 50, d: 50 };
  return { k: Math.round(kValues[kValues.length - 1] * 10) / 10, d: Math.round(avg(kValues.slice(-dSmooth)) * 10) / 10 };
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
  const trs: number[] = [], plusDMs: number[] = [], minusDMs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
    plusDMs.push(c.high - p.high > p.low - c.low ? Math.max(c.high - p.high, 0) : 0);
    minusDMs.push(p.low - c.low > c.high - p.high ? Math.max(p.low - c.low, 0) : 0);
  }
  const atrSmooth = wilderSmooth(trs, period);
  const plusDISmooth = wilderSmooth(plusDMs, period);
  const minusDISmooth = wilderSmooth(minusDMs, period);
  const dxValues: number[] = [];
  for (let i = 0; i < atrSmooth.length; i++) {
    const pDI = (plusDISmooth[i] / atrSmooth[i]) * 100, mDI = (minusDISmooth[i] / atrSmooth[i]) * 100;
    dxValues.push(pDI + mDI === 0 ? 0 : (Math.abs(pDI - mDI) / (pDI + mDI)) * 100);
  }
  return Math.round(wilderSmooth(dxValues, period).slice(-1)[0] * 10) / 10;
}

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

function ema(closes: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const ema: number[] = [closes[0]];
  for (let i = 1; i < closes.length; i++) ema.push(closes[i] * k + ema[i - 1] * (1 - k));
  return ema;
}

function sma(closes: number[], period: number): number {
  if (closes.length < period) return avg(closes);
  return avg(closes.slice(-period));
}

function vwap(candles: Candle[], period: number = 20): number {
  const recent = candles.slice(-period);
  let cumulativeTPV = 0, cumulativeVol = 0;
  for (const c of recent) {
    const tp = (c.high + c.low + c.close) / 3;
    cumulativeTPV += tp * c.volume;
    cumulativeVol += c.volume;
  }
  return cumulativeVol > 0 ? cumulativeTPV / cumulativeVol : candles[candles.length - 1].close;
}

// ─── REGIME ENGINE (embedded for single-file deployment) ───

export interface MarketRegime {
  symbol: string;
  direction: "LONG" | "SHORT" | "NEUTRAL" | null;
  confidence: number;
  confidenceComponents: {
    dailyTrend: number;
    dailyStructure: number;
    fourHourConfirmation: number;
    fourHourStrength: number;
    adx: number;
    volume: number;
    total: number;
  };
  detectedAt: number;
  lastUpdated: number;
  strength: "WEAK" | "MEDIUM" | "STRONG";
  invalidated: boolean;
  invalidationReason?: string;
  reason: string[];
}

interface StructureResult {
  valid: boolean;
  higherHighs: boolean;
  higherLows: boolean;
  lowerHighs: boolean;
  lowerLows: boolean;
  emaDirection: "LONG" | "SHORT";
  emaFlipped: boolean;
}

function analyzeStructure(candles: Candle[]): StructureResult {
  const len = candles.length;
  if (len < 25) {
    return { valid: false, higherHighs: false, higherLows: false, lowerHighs: false, lowerLows: false, emaDirection: "LONG", emaFlipped: false };
  }
  const closes = candles.map(c => c.close);
  const ema8 = ema(closes, 8);
  const ema21 = ema(closes, 21);
  const emaDir = ema8[ema8.length - 1] > ema21[ema21.length - 1] ? "LONG" : "SHORT";

  let emaFlipped = false;
  for (let i = Math.max(0, ema8.length - 4); i < ema8.length - 1; i++) {
    const prevDir = ema8[i] > ema21[i] ? "LONG" : "SHORT";
    const currDir = ema8[i + 1] > ema21[i + 1] ? "LONG" : "SHORT";
    if (prevDir !== currDir) emaFlipped = true;
  }

  const recent = candles.slice(-20);
  const highs = recent.map(c => c.high);
  const lows = recent.map(c => c.low);
  const mid = Math.floor(recent.length / 2);
  const firstHalfHigh = Math.max(...highs.slice(0, mid));
  const firstHalfLow = Math.min(...lows.slice(0, mid));
  const secondHalfHigh = Math.max(...highs.slice(mid));
  const secondHalfLow = Math.min(...lows.slice(mid));

  return {
    valid: true,
    higherHighs: secondHalfHigh > firstHalfHigh,
    higherLows: secondHalfLow > firstHalfLow,
    lowerHighs: secondHalfHigh < firstHalfHigh,
    lowerLows: secondHalfLow < firstHalfLow,
    emaDirection: emaDir,
    emaFlipped,
  };
}

function scoreRegimeConfidence(
  structure1d: StructureResult,
  structure4h: StructureResult,
  candles1d: Candle[],
  candles4h: Candle[]
): { confidence: number; components: MarketRegime["confidenceComponents"]; reasons: string[] } {
  const components: MarketRegime["confidenceComponents"] = {
    dailyTrend: 0, dailyStructure: 0, fourHourConfirmation: 0,
    fourHourStrength: 0, adx: 0, volume: 0, total: 0,
  };
  const reasons: string[] = [];

  if (structure1d.emaDirection === "LONG" || structure1d.emaDirection === "SHORT") {
    components.dailyTrend = 30;
    reasons.push(`daily_ema_${structure1d.emaDirection.toLowerCase()}:+30`);
  }

  if (structure1d.higherHighs && structure1d.higherLows && structure1d.emaDirection === "LONG") {
    components.dailyStructure = 20; reasons.push("daily_hh_hl:+20");
  } else if (structure1d.lowerHighs && structure1d.lowerLows && structure1d.emaDirection === "SHORT") {
    components.dailyStructure = 20; reasons.push("daily_lh_ll:+20");
  } else if ((structure1d.higherHighs || structure1d.higherLows) && structure1d.emaDirection === "LONG") {
    components.dailyStructure = 10; reasons.push("daily_mixed_bullish:+10");
  } else if ((structure1d.lowerHighs || structure1d.lowerLows) && structure1d.emaDirection === "SHORT") {
    components.dailyStructure = 10; reasons.push("daily_mixed_bearish:+10");
  } else {
    reasons.push("daily_no_structure:0");
  }

  if (structure4h.emaDirection === structure1d.emaDirection) {
    components.fourHourConfirmation = 20;
    reasons.push(`4h_confirms_${structure4h.emaDirection.toLowerCase()}:+20`);
  } else {
    components.fourHourConfirmation = -10;
    reasons.push(`4h_mismatch_${structure4h.emaDirection.toLowerCase()}:-10`);
  }

  const adx4h = adx(candles4h);
  if (adx4h > 30) { components.fourHourStrength = 15; reasons.push(`4h_adx_strong_${adx4h.toFixed(1)}:+15`); }
  else if (adx4h > 20) { components.fourHourStrength = 10; reasons.push(`4h_adx_medium_${adx4h.toFixed(1)}:+10`); }
  else if (adx4h > 10) { components.fourHourStrength = 5; reasons.push(`4h_adx_weak_${adx4h.toFixed(1)}:+5`); }
  else { reasons.push(`4h_adx_too_weak_${adx4h.toFixed(1)}:0`); }

  const adx1d = adx(candles1d);
  if (adx1d > 25) { components.adx = 10; reasons.push(`1d_adx_strong_${adx1d.toFixed(1)}:+10`); }
  else if (adx1d > 15) { components.adx = 5; reasons.push(`1d_adx_medium_${adx1d.toFixed(1)}:+5`); }
  else { reasons.push(`1d_adx_weak_${adx1d.toFixed(1)}:0`); }

  const vol1d = candles1d.map(c => c.volume);
  const recentVol = avg(vol1d.slice(-5));
  const olderVol = avg(vol1d.slice(-10, -5));
  if (recentVol > olderVol * 1.2) { components.volume = 5; reasons.push("volume_increasing:+5"); }
  else if (recentVol < olderVol * 0.8) { components.volume = -5; reasons.push("volume_decreasing:-5"); }
  else { reasons.push("volume_stable:0"); }

  components.total = Math.min(100, Math.max(0,
    components.dailyTrend + components.dailyStructure + components.fourHourConfirmation +
    components.fourHourStrength + components.adx + components.volume
  ));

  return { confidence: components.total, components, reasons };
}

function evaluateRegime(symbol: string, candles1d: Candle[], candles4h: Candle[]): MarketRegime {
  const now = Date.now();
  const structure1d = analyzeStructure(candles1d);
  const structure4h = analyzeStructure(candles4h);
  const { confidence, components, reasons } = scoreRegimeConfidence(structure1d, structure4h, candles1d, candles4h);

  let direction: MarketRegime["direction"] = null;
  let strength: MarketRegime["strength"] = "WEAK";

  if (structure1d.emaFlipped) {
    direction = structure1d.emaDirection;
    strength = "WEAK";
    reasons.push("ema_recently_flipped:weak");
  } else if (structure1d.higherHighs && structure1d.higherLows && structure1d.emaDirection === "LONG") {
    direction = "LONG";
    strength = confidence > 75 ? "STRONG" : confidence > 50 ? "MEDIUM" : "WEAK";
  } else if (structure1d.lowerHighs && structure1d.lowerLows && structure1d.emaDirection === "SHORT") {
    direction = "SHORT";
    strength = confidence > 75 ? "STRONG" : confidence > 50 ? "MEDIUM" : "WEAK";
  } else if (structure1d.emaDirection) {
    direction = structure1d.emaDirection;
    strength = "WEAK";
    reasons.push("mixed_structure:weak");
  } else {
    direction = "NEUTRAL";
  }

  return {
    symbol, direction, confidence, confidenceComponents: components,
    detectedAt: now, lastUpdated: now, strength, invalidated: false, reason: reasons,
  };
}

function shouldInvalidateRegime(
  currentRegime: MarketRegime,
  candles1d: Candle[],
  candles4h: Candle[]
): { invalidated: boolean; reason: string; newRegime?: MarketRegime } {
  if (currentRegime.invalidated) return { invalidated: true, reason: "already_invalidated" };

  const structure1d = analyzeStructure(candles1d);
  const structure4h = analyzeStructure(candles4h);
  const { confidence: newConfidence, components } = scoreRegimeConfidence(structure1d, structure4h, candles1d, candles4h);

  // 1. Daily EMA flipped
  if (currentRegime.direction === "LONG" && structure1d.emaDirection === "SHORT") {
    return { invalidated: true, reason: "daily_ema_flipped_to_short", newRegime: evaluateRegime(currentRegime.symbol, candles1d, candles4h) };
  }
  if (currentRegime.direction === "SHORT" && structure1d.emaDirection === "LONG") {
    return { invalidated: true, reason: "daily_ema_flipped_to_long", newRegime: evaluateRegime(currentRegime.symbol, candles1d, candles4h) };
  }

  // 2. Structure broken + EMA flipped
  if (currentRegime.direction === "LONG" && !structure1d.higherHighs && !structure1d.higherLows && structure1d.emaDirection === "SHORT") {
    return { invalidated: true, reason: "bullish_structure_broken", newRegime: evaluateRegime(currentRegime.symbol, candles1d, candles4h) };
  }
  if (currentRegime.direction === "SHORT" && !structure1d.lowerHighs && !structure1d.lowerLows && structure1d.emaDirection === "LONG") {
    return { invalidated: true, reason: "bearish_structure_broken", newRegime: evaluateRegime(currentRegime.symbol, candles1d, candles4h) };
  }

  // 3. Confidence collapsed
  if (newConfidence < 30 && currentRegime.confidence > 50) {
    return { invalidated: true, reason: `confidence_collapsed_${newConfidence}_from_${currentRegime.confidence}`, newRegime: evaluateRegime(currentRegime.symbol, candles1d, candles4h) };
  }

  // 4. 4H leading reversal confirmed
  if (currentRegime.direction === "LONG" && structure4h.emaDirection === "SHORT" && structure4h.lowerHighs && structure4h.lowerLows) {
    if (components.fourHourConfirmation < 0 && newConfidence < currentRegime.confidence - 30) {
      return { invalidated: true, reason: "4h_leading_reversal_confirmed", newRegime: evaluateRegime(currentRegime.symbol, candles1d, candles4h) };
    }
  }
  if (currentRegime.direction === "SHORT" && structure4h.emaDirection === "LONG" && structure4h.higherHighs && structure4h.higherLows) {
    if (components.fourHourConfirmation < 0 && newConfidence < currentRegime.confidence - 30) {
      return { invalidated: true, reason: "4h_leading_reversal_confirmed", newRegime: evaluateRegime(currentRegime.symbol, candles1d, candles4h) };
    }
  }

  // 5. Major move against regime (>8% daily)
  const last1d = candles1d[candles1d.length - 1];
  const prev1d = candles1d[candles1d.length - 2];
  if (last1d && prev1d) {
    const dailyChange = Math.abs((last1d.close - prev1d.close) / prev1d.close);
    if (dailyChange > 0.08) {
      const againstRegime = (currentRegime.direction === "LONG" && last1d.close < prev1d.close) ||
                            (currentRegime.direction === "SHORT" && last1d.close > prev1d.close);
      if (againstRegime) {
        return { invalidated: true, reason: `major_move_against_regime_${(dailyChange * 100).toFixed(1)}%`, newRegime: evaluateRegime(currentRegime.symbol, candles1d, candles4h) };
      }
    }
  }

  return { invalidated: false, reason: "regime_valid" };
}

// ─── Regime Persistence (hooks set by cron) ───

const regimeCache: Map<string, MarketRegime> = new Map();
let persistRegimeFn: ((regime: MarketRegime) => Promise<void>) | null = null;
let loadRegimeFn: ((symbol: string) => Promise<MarketRegime | null>) | null = null;

export function setRegimePersistence(
  persist: (regime: MarketRegime) => Promise<void>,
  load: (symbol: string) => Promise<MarketRegime | null>
): void {
  persistRegimeFn = persist;
  loadRegimeFn = load;
}

async function persistRegime(regime: MarketRegime): Promise<void> {
  regimeCache.set(regime.symbol, regime);
  if (persistRegimeFn) {
    try { await persistRegimeFn(regime); }
    catch (e) { console.error("[REGIME PERSIST] Failed:", e); }
  }
}

async function loadRegime(symbol: string): Promise<MarketRegime | null> {
  const cached = regimeCache.get(symbol);
  if (cached) return cached;
  if (loadRegimeFn) {
    try {
      const regime = await loadRegimeFn(symbol);
      if (regime) { regimeCache.set(symbol, regime); return regime; }
    } catch (e) { console.error("[REGIME LOAD] Failed:", e); }
  }
  return null;
}

async function getRegime(symbol: string, candles1d: Candle[], candles4h: Candle[]): Promise<MarketRegime> {
  const existing = await loadRegime(symbol);
  if (existing && !existing.invalidated) {
    const check = shouldInvalidateRegime(existing, candles1d, candles4h);
    if (check.invalidated && check.newRegime) {
      console.log(`[REGIME] ${symbol} INVALIDATED: ${check.reason}`);
      await persistRegime(check.newRegime);
      return check.newRegime;
    }
    return existing;
  }
  const regime = evaluateRegime(symbol, candles1d, candles4h);
  await persistRegime(regime);
  return regime;
}

// ─── ENTRY HUNTER (embedded — three modes) ───

interface EntryCandidate {
  direction: "LONG" | "SHORT";
  mode: "PULLBACK" | "REJECTION" | "BREAKOUT";
  strength: number;
  finalConfidence: number;
  reasons: string[];
  confidenceComponents: Record<string, number>;
  stochK: number;
  stochD: number;
  entryPrice: number;
  confidencePenalty: number;
  exhaustionWarning: string;
  pullbackLevel?: string;
  rejectionEvidence?: string[];
}

interface PullbackLevel {
  type: "ema21" | "ema50" | "broken_support" | "broken_resistance" | "vwap" | "liquidity" | "none";
  price: number;
  distance: number;
  quality: number;
}

function detectPullbackLevels(candles: Candle[], direction: "LONG" | "SHORT", currentPrice: number): PullbackLevel[] {
  const levels: PullbackLevel[] = [];
  const closes = candles.map(c => c.close);

  const ema21 = ema(closes, 21);
  const ema21Price = ema21[ema21.length - 1];
  const ema21Dist = Math.abs(currentPrice - ema21Price) / currentPrice;
  levels.push({ type: "ema21", price: ema21Price, distance: ema21Dist, quality: ema21Dist < 0.02 ? 80 : ema21Dist < 0.05 ? 60 : 30 });

  const ema50 = ema(closes, 50);
  const ema50Price = ema50[ema50.length - 1];
  const ema50Dist = Math.abs(currentPrice - ema50Price) / currentPrice;
  levels.push({ type: "ema50", price: ema50Price, distance: ema50Dist, quality: ema50Dist < 0.03 ? 70 : ema50Dist < 0.06 ? 50 : 20 });

  const vwapPrice = vwap(candles);
  const vwapDist = Math.abs(currentPrice - vwapPrice) / currentPrice;
  levels.push({ type: "vwap", price: vwapPrice, distance: vwapDist, quality: vwapDist < 0.02 ? 75 : vwapDist < 0.04 ? 55 : 25 });

  const recent20 = candles.slice(-20);
  const highs = recent20.map(c => c.high);
  const lows = recent20.map(c => c.low);
  const recentHigh = Math.max(...highs);
  const recentLow = Math.min(...lows);

  if (direction === "SHORT") {
    const distToResistance = Math.abs(currentPrice - recentLow) / currentPrice;
    if (distToResistance < 0.03) levels.push({ type: "broken_support", price: recentLow, distance: distToResistance, quality: 85 });
  } else {
    const distToSupport = Math.abs(currentPrice - recentHigh) / currentPrice;
    if (distToSupport < 0.03) levels.push({ type: "broken_resistance", price: recentHigh, distance: distToSupport, quality: 85 });
  }

  return levels.sort((a, b) => b.quality - a.quality);
}

function checkExhaustion(stoch4h: { k: number; d: number }, tradeDirection: "LONG" | "SHORT"): { isExhausted: boolean; reason: string; confidencePenalty: number } {
  if (tradeDirection === "LONG") {
    if (stoch4h.k > 90) return { isExhausted: true, reason: `4H extreme overbought K${stoch4h.k}`, confidencePenalty: -20 };
    if (stoch4h.k > 80 && stoch4h.k < stoch4h.d) return { isExhausted: true, reason: `4H overbought exhaustion K${stoch4h.k} < D${stoch4h.d}`, confidencePenalty: -15 };
  } else {
    if (stoch4h.k < 10) return { isExhausted: true, reason: `4H extreme oversold K${stoch4h.k}`, confidencePenalty: -20 };
    if (stoch4h.k < 20 && stoch4h.k > stoch4h.d) return { isExhausted: true, reason: `4H oversold exhaustion K${stoch4h.k} > D${stoch4h.d}`, confidencePenalty: -15 };
  }
  return { isExhausted: false, reason: "", confidencePenalty: 0 };
}

function buildEntryComponents(base: number, setup: number, momentum: number, structure: number, volume: number, riskPenalty: number): Record<string, number> {
  const total = Math.min(100, Math.max(0, base + setup + momentum + structure + volume + riskPenalty));
  return { regimeAlignment: base, setupQuality: setup, momentum, structure, volume, riskPenalty, total };
}

// Mode A: Pullback (v28 preserved)
function detectPullbackEntry(candles1h: Candle[], config: PairConfig, pair: string, regimeDirection: "LONG" | "SHORT"): EntryCandidate | null {
  const reasons: string[] = [];
  const closes = candles1h.map(c => c.close);
  const volumes = candles1h.map(c => c.volume);
  if (closes.length < 50) return null;

  const stoch = stochRsi(closes);
  const stochPrev = stochRsi(closes.slice(0, -1));
  const avgVol = avg(volumes.slice(-10));
  const lastVol = volumes[volumes.length - 1];
  const volSurge = lastVol > avgVol * config.volumeMultiplier;
  const crossUp = stochPrev.k <= stochPrev.d && stoch.k > stoch.d;
  const crossDown = stochPrev.k >= stochPrev.d && stoch.k < stoch.d;

  let direction: "LONG" | "SHORT" | null = null;
  if (crossUp) direction = "LONG";
  else if (crossDown) direction = "SHORT";
  if (!direction || direction !== regimeDirection) return null;

  let base = 30; reasons.push("regime_alignment:+30");
  let setup = 0, momentum = 0, structure = 0, volume = 0;

  if (config.isHYPE) {
    if (direction === "LONG") {
      if (stoch.k < (config.deepCrossThresholdLong || 25)) { setup += 20; reasons.push("deep_cross:+20"); }
      else { setup -= 30; reasons.push("shallow_cross:-30"); }
    } else {
      if (stoch.k > (config.deepCrossThresholdShort || 75)) { setup += 20; reasons.push("deep_cross:+20"); }
      else { setup -= 30; reasons.push("shallow_cross:-30"); }
    }
  } else {
    if (direction === "LONG") {
      if (stoch.k < 40) { setup += 15; reasons.push("deep_cross:+15"); }
      else if (stoch.k > 70) { setup -= 20; reasons.push("extended_cross:-20"); }
    } else {
      if (stoch.k > 60) { setup += 15; reasons.push("deep_cross:+15"); }
      else if (stoch.k < 30) { setup -= 20; reasons.push("extended_cross:-20"); }
    }
  }

  const lastCandle = candles1h[candles1h.length - 1];
  const volDirection = lastCandle.close > lastCandle.open ? "LONG" : "SHORT";
  if (volSurge && volDirection === direction) { volume += 10; reasons.push("volume_confirms:+10"); }
  else if (volSurge) { volume -= 5; reasons.push("volume_opposes:-5"); }

  const adx1h = adx(candles1h);
  if (adx1h > config.minADX) { structure += 10; reasons.push(`adx_ok_${adx1h.toFixed(1)}:+10`); }
  else { structure -= 10; reasons.push(`adx_weak_${adx1h.toFixed(1)}:-10`); }

  const roc = ((closes[closes.length - 1] - closes[closes.length - 4]) / closes[closes.length - 4]) * 100;
  if (Math.abs(roc) > 1.0) { momentum += 5; reasons.push("velocity:+5"); }

  const body = Math.abs(lastCandle.close - lastCandle.open);
  const upperWick = lastCandle.high - Math.max(lastCandle.open, lastCandle.close);
  const lowerWick = Math.min(lastCandle.open, lastCandle.close) - lastCandle.low;
  const totalRange = lastCandle.high - lastCandle.low;
  if (totalRange > 0) {
    const wickThreshold = config.isHYPE ? 0.5 : 0.6;
    if (direction === "LONG" && upperWick / totalRange > wickThreshold) { structure -= 15; reasons.push("upper_rejection:-15"); }
    if (direction === "SHORT" && lowerWick / totalRange > wickThreshold) { structure -= 15; reasons.push("lower_rejection:-15"); }
  }

  const components = buildEntryComponents(base, setup, momentum, structure, volume, 0);
  if (components.total < config.momentumThreshold) {
    reasons.push(`below_threshold_${config.momentumThreshold}:blocked`);
    return null;
  }

  return {
    direction, mode: "PULLBACK", strength: components.total, finalConfidence: components.total,
    reasons, confidenceComponents: components, stochK: stoch.k, stochD: stoch.d,
    entryPrice: candles1h[candles1h.length - 1].close, confidencePenalty: 0, exhaustionWarning: "",
  };
}

// Mode B: Rejection (NEW — at pullback levels)
function detectRejectionEntry(candles1h: Candle[], candles15m: Candle[], config: PairConfig, pair: string, regimeDirection: "LONG" | "SHORT"): EntryCandidate | null {
  const reasons: string[] = [];
  const closes1h = candles1h.map(c => c.close);
  const stoch1h = stochRsi(closes1h);
  const currentPrice = closes1h[closes1h.length - 1];
  if (closes1h.length < 50) return null;

  const levels = detectPullbackLevels(candles1h, regimeDirection, currentPrice);
  const bestLevel = levels[0];
  if (!bestLevel || bestLevel.quality < 40) return null;

  const atLevel = bestLevel.distance < 0.015;
  if (!atLevel) return null;

  reasons.push(`pullback_to_${bestLevel.type}:${bestLevel.price.toFixed(2)}(dist ${(bestLevel.distance * 100).toFixed(1)}%)`);

  let base = 30; reasons.push("regime_alignment:+30");
  let setup = 0, momentum = 0, structure = 0, volume = 0;

  setup += Math.min(25, bestLevel.quality / 4);
  reasons.push(`pullback_level_quality_${bestLevel.type}:+${Math.min(25, bestLevel.quality / 4)}`);

  const rejectionEvidence: string[] = [];
  const recent3 = candles1h.slice(-3);

  for (const candle of recent3) {
    const body = Math.abs(candle.close - candle.open);
    if (regimeDirection === "SHORT") {
      const upperWick = candle.high - Math.max(candle.open, candle.close);
      const range = candle.high - candle.low;
      if (range > 0 && upperWick / range > 0.5 && Math.abs(candle.high - bestLevel.price) / bestLevel.price < 0.01) {
        structure += 15; rejectionEvidence.push("upper_wick_at_resistance");
        reasons.push("upper_wick_rejection_at_level:+15"); break;
      }
    } else {
      const lowerWick = Math.min(candle.open, candle.close) - candle.low;
      const range = candle.high - candle.low;
      if (range > 0 && lowerWick / range > 0.5 && Math.abs(candle.low - bestLevel.price) / bestLevel.price < 0.01) {
        structure += 15; rejectionEvidence.push("lower_wick_at_support");
        reasons.push("lower_wick_rejection_at_level:+15"); break;
      }
    }
  }

  if (regimeDirection === "SHORT") {
    if (stoch1h.k > 50 && stoch1h.k < stoch1h.d) { momentum += 15; rejectionEvidence.push("stoch_rolling_over_from_overbought"); reasons.push("stoch_rollover_from_overbought:+15"); }
    if (stoch1h.k < 30) { momentum -= 20; reasons.push("already_oversold:-20"); }
  } else {
    if (stoch1h.k < 50 && stoch1h.k > stoch1h.d) { momentum += 15; rejectionEvidence.push("stoch_rolling_over_from_oversold"); reasons.push("stoch_rollover_from_oversold:+15"); }
    if (stoch1h.k > 70) { momentum -= 20; reasons.push("already_overbought:-20"); }
  }

  if (candles15m && candles15m.length > 20) {
    const closes15m = candles15m.map(c => c.close);
    const stoch15m = stochRsi(closes15m);
    const stoch15mPrev = stochRsi(closes15m.slice(0, -1));
    if (regimeDirection === "SHORT") {
      if (stoch15mPrev.k >= stoch15mPrev.d && stoch15m.k < stoch15m.d && stoch15m.k > 40) {
        momentum += 15; rejectionEvidence.push("15m_cross_down_at_resistance"); reasons.push("15m_cross_down_at_level:+15");
      }
    } else {
      if (stoch15mPrev.k <= stoch15mPrev.d && stoch15m.k > stoch15m.d && stoch15m.k < 60) {
        momentum += 15; rejectionEvidence.push("15m_cross_up_at_support"); reasons.push("15m_cross_up_at_level:+15");
      }
    }
  }

  const ema21_1h = ema(closes1h, 21);
  const ema50_1h = ema(closes1h, 50);
  if (regimeDirection === "SHORT") {
    if (currentPrice < ema21_1h[ema21_1h.length - 1]) { structure += 10; reasons.push("below_1h_ema21:+10"); }
    if (ema21_1h[ema21_1h.length - 1] < ema50_1h[ema50_1h.length - 1]) { structure += 5; reasons.push("1h_ema_bearish_stack:+5"); }
  } else {
    if (currentPrice > ema21_1h[ema21_1h.length - 1]) { structure += 10; reasons.push("above_1h_ema21:+10"); }
    if (ema21_1h[ema21_1h.length - 1] > ema50_1h[ema50_1h.length - 1]) { structure += 5; reasons.push("1h_ema_bullish_stack:+5"); }
  }

  const volumes = candles1h.map(c => c.volume);
  const avgVol = avg(volumes.slice(-10));
  const lastVol = volumes[volumes.length - 1];
  if (lastVol > avgVol * config.volumeMultiplier) { volume += 10; reasons.push("volume_at_level:+10"); }

  const components = buildEntryComponents(base, setup, momentum, structure, volume, 0);
  if (components.total < config.momentumThreshold) {
    reasons.push(`below_threshold_${config.momentumThreshold}:blocked`);
    return null;
  }

  return {
    direction: regimeDirection, mode: "REJECTION", strength: components.total, finalConfidence: components.total,
    reasons, confidenceComponents: components, stochK: stoch1h.k, stochD: stoch1h.d,
    entryPrice: currentPrice, confidencePenalty: 0, exhaustionWarning: "",
    pullbackLevel: bestLevel.type, rejectionEvidence,
  };
}

// Mode C: Breakout
function detectBreakoutEntry(candles1h: Candle[], candles15m: Candle[], config: PairConfig, pair: string, regimeDirection: "LONG" | "SHORT"): EntryCandidate | null {
  const reasons: string[] = [];
  const closes1h = candles1h.map(c => c.close);
  const stoch1h = stochRsi(closes1h);
  const currentPrice = closes1h[closes1h.length - 1];
  if (closes1h.length < 50) return null;

  const adx1h = adx(candles1h);
  if (adx1h < 25) return null;

  let base = 30; reasons.push("regime_alignment:+30");
  let setup = 0, momentum = 0, structure = 0, volume = 0;

  const recent20 = candles1h.slice(-20);
  const highs = recent20.map(c => c.high);
  const lows = recent20.map(c => c.low);

  if (regimeDirection === "LONG") {
    const recentHigh = Math.max(...highs.slice(0, -1));
    if (currentPrice > recentHigh * 1.005) { setup += 25; reasons.push("broke_recent_high:+25"); }
    else return null;
    if (stoch1h.k < 80) { momentum += 10; reasons.push("stoch_not_exhausted:+10"); }
  } else {
    const recentLow = Math.min(...lows.slice(0, -1));
    if (currentPrice < recentLow * 0.995) { setup += 25; reasons.push("broke_recent_low:+25"); }
    else return null;
    if (stoch1h.k > 20) { momentum += 10; reasons.push("stoch_not_exhausted:+10"); }
  }

  const volumes = candles1h.map(c => c.volume);
  const avgVol = avg(volumes.slice(-10));
  const lastVol = volumes[volumes.length - 1];
  if (lastVol > avgVol * config.volumeMultiplier * 1.5) { volume += 15; reasons.push("breakout_volume:+15"); }

  if (candles15m && candles15m.length > 20) {
    const closes15m = candles15m.map(c => c.close);
    const stoch15m = stochRsi(closes15m);
    if (regimeDirection === "LONG" && stoch15m.k > 50 && stoch15m.k > stoch15m.d) { momentum += 10; reasons.push("15m_momentum_confirms:+10"); }
    if (regimeDirection === "SHORT" && stoch15m.k < 50 && stoch15m.k < stoch15m.d) { momentum += 10; reasons.push("15m_momentum_confirms:+10"); }
  }

  structure += Math.min(15, adx1h / 2);
  reasons.push(`adx_breakout_${adx1h.toFixed(1)}:+${Math.min(15, adx1h / 2).toFixed(0)}`);

  const components = buildEntryComponents(base, setup, momentum, structure, volume, 0);
  if (components.total < config.momentumThreshold) return null;

  return {
    direction: regimeDirection, mode: "BREAKOUT", strength: components.total, finalConfidence: components.total,
    reasons, confidenceComponents: components, stochK: stoch1h.k, stochD: stoch1h.d,
    entryPrice: currentPrice, confidencePenalty: 0, exhaustionWarning: "",
  };
}

function huntEntries(pair: string, regime: MarketRegime, candles1h: Candle[], candles4h: Candle[], candles15m: Candle[]): { candidates: EntryCandidate[]; debug: string[] } {
  const debug: string[] = [];
  const config = getPairConfig(pair);

  if (!regime.direction || regime.direction === "NEUTRAL") {
    debug.push("Regime is NEUTRAL — no directional bias");
    return { candidates: [], debug };
  }
  if (regime.invalidated) {
    debug.push(`Regime ${regime.direction} INVALIDATED (${regime.invalidationReason}) — no entries`);
    return { candidates: [], debug };
  }

  const regimeDirection = regime.direction;
  debug.push(`Regime: ${regimeDirection} ${regime.strength} (conf ${regime.confidence})`);
  debug.push(`Regime components: dailyTrend=${regime.confidenceComponents.dailyTrend} structure=${regime.confidenceComponents.dailyStructure} 4hConf=${regime.confidenceComponents.fourHourConfirmation} 4hStr=${regime.confidenceComponents.fourHourStrength} adx=${regime.confidenceComponents.adx} vol=${regime.confidenceComponents.volume}`);

  const candidates: EntryCandidate[] = [];

  const pullback = detectPullbackEntry(candles1h, config, pair, regimeDirection);
  if (pullback) {
    debug.push(`MODE A PULLBACK: ${pullback.direction} raw=${pullback.strength} | ${pullback.reasons.slice(0, 5).join(", ")}...`);
    candidates.push(pullback);
  } else {
    debug.push("MODE A: no pullback setup");
  }

  const rejection = detectRejectionEntry(candles1h, candles15m, config, pair, regimeDirection);
  if (rejection) {
    debug.push(`MODE B REJECTION: ${rejection.direction} at ${rejection.pullbackLevel} raw=${rejection.strength} | evidence: ${rejection.rejectionEvidence?.join(", ") || "none"}`);
    candidates.push(rejection);
  } else {
    debug.push("MODE B: no rejection setup");
  }

  const breakout = detectBreakoutEntry(candles1h, candles15m, config, pair, regimeDirection);
  if (breakout) {
    debug.push(`MODE C BREAKOUT: ${breakout.direction} raw=${breakout.strength}`);
    candidates.push(breakout);
  } else {
    debug.push("MODE C: no breakout setup");
  }

  const stoch4h = stochRsi(candles4h.map(c => c.close));
  for (const candidate of candidates) {
    const exhaustion = checkExhaustion(stoch4h, candidate.direction);
    if (exhaustion.isExhausted) {
      candidate.confidencePenalty = exhaustion.confidencePenalty;
      candidate.finalConfidence = Math.min(100, Math.max(0, candidate.strength + exhaustion.confidencePenalty));
      candidate.exhaustionWarning = exhaustion.reason;
      candidate.confidenceComponents.riskPenalty = exhaustion.confidencePenalty;
      candidate.confidenceComponents.total = candidate.finalConfidence;
      debug.push(`EXHAUSTION: ${exhaustion.reason} → ${candidate.strength} → ${candidate.finalConfidence}`);
    } else {
      candidate.finalConfidence = candidate.strength;
    }
  }

  const valid = candidates.filter(c => c.finalConfidence >= config.momentumThreshold);
  valid.sort((a, b) => b.finalConfidence - a.finalConfidence);
  return { candidates: valid, debug };
}

// ─── EXIT STORE (unchanged from v28) ───

interface ExitRecord { signalId: string; pair: string; direction: "LONG" | "SHORT"; exitTimestamp: number; exitReason: string; exitPrice: number; }
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

// ─── MAIN SIGNAL GENERATION (v29.1) ───

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

  // v29.1: Load or evaluate regime
  const regime = await getRegime(pair, candles1d, candles4h);
  debug.push(`REGIME: ${regime.direction || "NEUTRAL"} ${regime.strength} conf=${regime.confidence} (since ${new Date(regime.detectedAt).toISOString().split('T')[0]})`);
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

  // v29.1: Entry Hunter (three modes)
  const { candidates, debug: huntDebug } = huntEntries(pair, regime, candles1h, candles4h, candles15m);
  debug.push(...huntDebug);

  if (candidates.length === 0) {
    const market: MarketData = {
      pair, price: Math.round(price * 100) / 100, timestamp: now,
      phase: "WATCHING", trend: `${regime.direction} ${regime.strength}`,
      htfBias: regime.direction === "LONG" ? "BULLISH" : "BEARISH", regime,
      adx: Math.round(adx4h * 10) / 10, rsi: Math.round(rsi(candles4h.map(c => c.close)) * 10) / 10,
      stochK: stoch4h.k, stochD: stoch4h.d, stoch1hK: stoch1h.k, stoch1hD: stoch1h.d,
    };
    return { market, debug };
  }

  const best = candidates[0];
  debug.push(`SELECTED: ${best.mode} ${best.direction} conf=${best.finalConfidence} (raw=${best.strength} penalty=${best.confidencePenalty})`);

  // Entry freshness gate (only for pullback)
  if (best.mode === "PULLBACK") {
    const drift = 0;
    if (drift > config.maxEntryDriftPct) {
      debug.push(`ENTRY FRESHNESS: price drift too high, skipping`);
      const market: MarketData = {
        pair, price: Math.round(price * 100) / 100, timestamp: now,
        phase: "WATCHING", trend: `${regime.direction} ${regime.strength}`,
        htfBias: regime.direction === "LONG" ? "BULLISH" : "BEARISH", regime,
        adx: Math.round(adx4h * 10) / 10, rsi: Math.round(rsi(candles4h.map(c => c.close)) * 10) / 10,
        stochK: stoch4h.k, stochD: stoch4h.d, stoch1hK: stoch1h.k, stoch1hD: stoch1h.d,
      };
      return { market, debug };
    }
  }

  const entry = price;
  const sl = best.direction === "LONG" ? entry * (1 - config.stopLossPct) : entry * (1 + config.stopLossPct);
  const tp = best.direction === "LONG" ? entry * (1 + config.takeProfitPct) : entry * (1 - config.takeProfitPct);
  const rr = Math.abs(tp - entry) / Math.abs(entry - sl);
  debug.push(`R:R ${rr.toFixed(2)} (${(config.stopLossPct * 100).toFixed(0)}% SL / ${(config.takeProfitPct * 100).toFixed(0)}% TP)`);

  const exhaustionNote = best.exhaustionWarning ? ` | WARNING: ${best.exhaustionWarning}` : "";
  const levelNote = best.pullbackLevel ? ` | Level: ${best.pullbackLevel}` : "";

  const signal: Signal = {
    id: `${pair}_${now}`,
    pair,
    direction: best.direction,
    type: best.mode === "BREAKOUT" ? "BREAKOUT" : "ENTRY",
    scale: "ENTRY_1",
    entry: Math.round(entry * 100) / 100,
    stop: Math.round(sl * 100) / 100,
    target: Math.round(tp * 100) / 100,
    confidence: best.finalConfidence,
    rr: Math.round(rr * 100) / 100,
    adx: Math.round(adx4h * 10) / 10,
    rsi: Math.round(rsi(candles4h.map(c => c.close)) * 10) / 10,
    stochK: stoch4h.k,
    stochD: stoch4h.d,
    stoch1hK: best.stochK,
    stoch1hD: best.stochD,
    expectedMove: Math.round((Math.abs(tp - entry) / entry) * 100 * 10) / 10,
    reason: `${best.direction} ${best.mode} ENTRY | Regime ${regime.direction} ${regime.strength} (since ${new Date(regime.detectedAt).toISOString().split('T')[0]}) | 1H StochRSI K${best.stochK} D${best.stochD} | ${best.reasons.join(", ")} | RR ${rr.toFixed(2)} | SL ${(config.stopLossPct * 100).toFixed(1)}% TP ${(config.takeProfitPct * 100).toFixed(1)}%${exhaustionNote}${levelNote}`,
    timestamp: now,
    version: CURRENT_SIGNAL_VERSION,
    tradeState: "OPEN",
    lockedStop: null,
    highestPrice: entry,
    lowestPrice: entry,
    profitLockActive: false,
    regimeDirection: regime.direction,
    regimeSince: regime.detectedAt,
    entryMode: best.mode,
    confidenceComponents: best.confidenceComponents,
    exhaustionWarning: best.exhaustionWarning || undefined,
  };

  const market: MarketData = {
    pair, price: Math.round(price * 100) / 100, timestamp: now,
    phase: "EARLY_ENTRY",
    trend: `${regime.direction} ${regime.strength}`,
    htfBias: best.direction === "LONG" ? "BULLISH" : "BEARISH",
    regime,
    adx: signal.adx, rsi: signal.rsi,
    stochK: stoch4h.k, stochD: stoch4h.d,
    stoch1hK: stoch1h.k, stoch1hD: stoch1h.d,
  };

  debug.push(`SIGNAL: ${signal.direction} ${signal.type} entry=${signal.entry} TP=${signal.target} SL=${signal.stop} RR=${signal.rr} conf=${signal.confidence}`);
  return { signal, market, debug };
}

// ─── Market Snapshot (updated with regime) ───

export async function getMarketSnapshot(pair: string, candles1h: Candle[], candles4h: Candle[], candles15m: Candle[]): Promise<MarketData> {
  const candles1d = aggregateTo1D(candles4h);
  const stoch4h = stochRsi(candles4h.map(c => c.close));
  const stoch1h = stochRsi(candles1h.map(c => c.close));
  const price = candles4h[candles4h.length - 1].close;
  const adx4h = adx(candles4h);

  let regime: MarketRegime | undefined;
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

// ─── Trade Manager (UNCHANGED from v28) ───

export interface TradeManagerUpdate {
  signalId: string;
  newState: Signal["tradeState"];
  lockedStop: number | null;
  profitLockActive: boolean;
  highestPrice: number;
  lowestPrice: number;
  exitTriggered?: boolean;
  exitReason?: string;
}

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

export interface ValidityCheck { valid: boolean; reason: string; exited: boolean; }

export function isSignalStillValid(signal: Signal, currentPrice: number, now: number = Date.now()): ValidityCheck {
  if (signal.exited || hasExited(signal.id)) return { valid: false, reason: "already_exited", exited: true };
  if (signal.direction === "LONG" && currentPrice <= (signal.lockedStop || signal.stop)) return { valid: false, reason: "stop_hit", exited: true };
  if (signal.direction === "SHORT" && currentPrice >= (signal.lockedStop || signal.stop)) return { valid: false, reason: "stop_hit", exited: true };
  if (signal.direction === "LONG" && currentPrice >= signal.target) return { valid: false, reason: "tp_hit", exited: true };
  if (signal.direction === "SHORT" && currentPrice <= signal.target) return { valid: false, reason: "tp_hit", exited: true };
  return { valid: true, reason: "active", exited: false };
}

export interface HoldResult { shouldHold: boolean; reason: string; managedStop?: number; }

export async function shouldHold(signal: Signal, candles4h: Candle[], currentPrice: number, now?: number): Promise<HoldResult> {
  if (signal.exited || hasExited(signal.id)) return { shouldHold: false, reason: "already_exited" };

  const tmUpdate = updateTradeManager(signal, currentPrice);
  if (tmUpdate.exitTriggered) {
    if (now) await recordExit(signal.id, signal.pair, signal.direction, currentPrice, tmUpdate.exitReason || "trade_manager_exit", now);
    return { shouldHold: false, reason: tmUpdate.exitReason || "trade_manager_exit", managedStop: tmUpdate.lockedStop || undefined };
  }

  // v29.1: Check regime for trend reversal
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
    // Fallback to old behavior
    const t1d = evaluateTrendLegacy(candles1d);
    const trendReversed = (signal.direction === "LONG" && t1d.direction === "SHORT") || (signal.direction === "SHORT" && t1d.direction === "LONG");
    if (trendReversed) {
      const inProfit = signal.direction === "LONG" ? currentPrice > signal.entry : currentPrice < signal.entry;
      if (!inProfit) {
        if (now) await recordExit(signal.id, signal.pair, signal.direction, currentPrice, "trend_reversed_unprofitable", now);
        return { shouldHold: false, reason: "trend_reversed_unprofitable" };
      }
    }
  }

  return { shouldHold: true, reason: "active", managedStop: tmUpdate.lockedStop || undefined };
}

// Legacy trend eval for fallback
function evaluateTrendLegacy(candles: Candle[]): { direction: "LONG" | "SHORT" | null; strength: string; structureValid: boolean } {
  const len = candles.length;
  if (len < 25) return { direction: null, strength: "WEAK", structureValid: false };
  const closes = candles.map(c => c.close);
  const ema8 = ema(closes, 8), ema21 = ema(closes, 21);
  const emaDir = ema8[ema8.length - 1] > ema21[ema21.length - 1] ? "LONG" : "SHORT";
  return { direction: emaDir as "LONG" | "SHORT", strength: "MEDIUM", structureValid: true };
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

// ─── Backward Compatibility Wrappers ───

export async function generateSignalCompat(pair: string, candles1h: Candle[], candles4h: Candle[], candles15m: Candle[], activeTrades?: Record<string, any>, currentPrice?: number): Promise<SignalResult> {
  return generateSignal(pair, candles1h, candles4h, candles15m, activeTrades, currentPrice);
}

export function isSignalStillValidBool(signal: Signal, currentPrice: number): boolean {
  return isSignalStillValid(signal, currentPrice).valid;
}

export function shouldHoldCompat(signal: Signal, candles4h: Candle[], candles1h: Candle[], currentPrice: number): Promise<HoldResult> {
  return shouldHold(signal, candles4h, currentPrice);
}
