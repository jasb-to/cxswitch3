// lib/strategy.ts — v28.3 "1H Entry + HTF Direction + HTF Exhaustion Filter + Per-Asset Stops + Lagging EMA Fix + Entry Quality"
// ============================================================
// 2026-07-07: Changes:
//   - v28.3 FIX #1: Recent momentum override for lagging EMAs
//     * If last 6 candles show clear reversal against EMA direction → return MIXED WEAK
//   - v28.3 FIX #2: htfBias "NEUTRAL" → "MIXED" for null directions
//   - v28.3 FIX #3: Entry quality scoring (replaces binary pass/fail)
//     * Cross depth bonus/penalty (cross below 40 = +15, above 70 = -20)
//     * Entry freshness gate (skip if price moved >1% from cross candle close)
//     * Volume direction check (only count volume that aligns with entry direction)
//   - v28.3 FIX #4: 5-tier trend classification (LONG STRONG, LONG, NEUTRAL, SHORT, SHORT STRONG)
//     * Replaces binary LONG/SHORT/MIXED with smoother transitions
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
}

export interface SignalResult {
  signal?: Signal;
  market?: MarketData;
  debug: string[];
}

export const CURRENT_SIGNAL_VERSION = 28;

interface PairConfig {
  minADX: number;
  momentumThreshold: number;
  volumeMultiplier: number;
  stopLossPct: number;
  takeProfitPct: number;
  maxEntryDriftPct: number;
}

const PAIR_CONFIGS: Record<string, PairConfig> = {
  default: { minADX: 20, momentumThreshold: 55, volumeMultiplier: 1.3, stopLossPct: 0.025, takeProfitPct: 0.035, maxEntryDriftPct: 0.01 },
  BTC: { minADX: 20, momentumThreshold: 55, volumeMultiplier: 1.3, stopLossPct: 0.02, takeProfitPct: 0.03, maxEntryDriftPct: 0.01 },
  ETH: { minADX: 20, momentumThreshold: 55, volumeMultiplier: 1.3, stopLossPct: 0.025, takeProfitPct: 0.035, maxEntryDriftPct: 0.01 },
  SOL: { minADX: 18, momentumThreshold: 50, volumeMultiplier: 1.4, stopLossPct: 0.03, takeProfitPct: 0.04, maxEntryDriftPct: 0.012 },
  HYPE: { minADX: 15, momentumThreshold: 50, volumeMultiplier: 1.5, stopLossPct: 0.04, takeProfitPct: 0.05, maxEntryDriftPct: 0.015 },
};

function getPairConfig(pair: string): PairConfig {
  return PAIR_CONFIGS[pair] || PAIR_CONFIGS.default;
}

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

function priceStructure(candles: Candle[], direction: "LONG" | "SHORT", lookback: number = 30): { valid: boolean; reason: string } {
  if (candles.length < lookback + 3) return { valid: false, reason: "insufficient_data" };
  const recent = candles.slice(-lookback);
  const highs = recent.map(c => c.high);
  const lows = recent.map(c => c.low);
  const mid = Math.floor(recent.length / 2);
  const firstHalfHigh = Math.max(...highs.slice(0, mid));
  const firstHalfLow = Math.min(...lows.slice(0, mid));
  const secondHalfHigh = Math.max(...highs.slice(mid));
  const secondHalfLow = Math.min(...lows.slice(mid));
  if (direction === "LONG") {
    const higherHigh = secondHalfHigh > firstHalfHigh;
    const higherLow = secondHalfLow > firstHalfLow;
    if (higherHigh && higherLow) return { valid: true, reason: "hh_hl_structure" };
    if (higherHigh || higherLow) return { valid: true, reason: "mixed_but_trending" };
    return { valid: false, reason: "no_bullish_structure" };
  } else {
    const lowerHigh = secondHalfHigh < firstHalfHigh;
    const lowerLow = secondHalfLow < firstHalfLow;
    if (lowerHigh && lowerLow) return { valid: true, reason: "lh_ll_structure" };
    if (lowerHigh || lowerLow) return { valid: true, reason: "mixed_but_trending" };
    return { valid: false, reason: "no_bearish_structure" };
  }
}

// v28.3 FIX #1: Recent momentum override for lagging EMAs
function trendDirection(candles: Candle[]): { direction: "LONG" | "SHORT" | null; strength: string; structureValid: boolean; emaDirection: "LONG" | "SHORT" } {
  const len = candles.length;
  if (len < 25) return { direction: null, strength: "WEAK", structureValid: false, emaDirection: "LONG" };

  const closes = candles.map(c => c.close);
  const ema8 = ema(closes, 8), ema21 = ema(closes, 21);
  const emaDir = ema8[ema8.length - 1] > ema21[ema21.length - 1] ? "LONG" : "SHORT";

  const recent = candles.slice(-6);
  const recentHighs = recent.map(c => c.high);
  const recentLows = recent.map(c => c.low);
  const firstClose = recent[0].close;
  const lastClose = recent[recent.length - 1].close;
  const recentChange = ((lastClose - firstClose) / firstClose) * 100;

  let lowerHighs = 0, lowerLows = 0, higherHighs = 0, higherLows = 0;
  for (let i = 1; i < recent.length; i++) {
    if (recentHighs[i] < recentHighs[i-1]) lowerHighs++;
    if (recentLows[i] < recentLows[i-1]) lowerLows++;
    if (recentHighs[i] > recentHighs[i-1]) higherHighs++;
    if (recentLows[i] > recentLows[i-1]) higherLows++;
  }

  if (emaDir === "LONG") {
    const breakingDown = recentChange < -2.5 && lowerHighs >= 4 && lowerLows >= 3;
    if (breakingDown) {
      return { direction: null, strength: "WEAK", structureValid: false, emaDirection: "LONG" };
    }
  }
  if (emaDir === "SHORT") {
    const breakingUp = recentChange > 2.5 && higherHighs >= 4 && higherLows >= 3;
    if (breakingUp) {
      return { direction: null, strength: "WEAK", structureValid: false, emaDirection: "SHORT" };
    }
  }

  const structure = priceStructure(candles, emaDir as "LONG" | "SHORT");

  if (!structure.valid) return { direction: null, strength: "WEAK", structureValid: false, emaDirection: emaDir as "LONG" | "SHORT" };

  const highs = candles.slice(-20).map(c => c.high), lows = candles.slice(-20).map(c => c.low);
  const hh = highs[highs.length - 1] > Math.max(...highs.slice(0, -1));
  const ll = lows[lows.length - 1] < Math.min(...lows.slice(0, -1));
  const strength = (emaDir === "LONG" && hh) || (emaDir === "SHORT" && ll) ? "STRONG" : "MEDIUM";

  return { direction: emaDir as "LONG" | "SHORT", strength, structureValid: true, emaDirection: emaDir as "LONG" | "SHORT" };
}

// v28.3 FIX #4: 5-tier trend classification
function classifyTrend(trend: { direction: "LONG" | "SHORT" | null; strength: string; structureValid: boolean }): string {
  if (!trend.direction) return "NEUTRAL";
  return `${trend.direction} ${trend.strength}`;
}

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

interface EntryResult {
  hasEntry: boolean;
  direction: "LONG" | "SHORT" | null;
  strength: number;
  reasons: string[];
  stochK: number;
  stochD: number;
  crossCandleClose?: number;
}

// v28.3 FIX #3: Entry quality scoring
function detect1HEntry(candles1h: Candle[], config: PairConfig): EntryResult {
  const reasons: string[] = [];
  const closes = candles1h.map(c => c.close);
  const volumes = candles1h.map(c => c.volume);
  if (closes.length < 50) return { hasEntry: false, direction: null, strength: 0, reasons: ["insufficient_1h"], stochK: 50, stochD: 50 };

  const stoch = stochRsi(closes);
  const stochPrev = stochRsi(closes.slice(0, -1));
  const avgVol = avg(volumes.slice(-10)), lastVol = volumes[volumes.length - 1];
  const volSurge = lastVol > avgVol * config.volumeMultiplier;
  const crossUp = stochPrev.k <= stochPrev.d && stoch.k > stoch.d;
  const crossDown = stochPrev.k >= stochPrev.d && stoch.k < stoch.d;

  let direction: "LONG" | "SHORT" | null = null;
  let strength = 0;
  let crossCandleClose: number | undefined;

  if (crossUp) { 
    direction = "LONG"; 
    reasons.push("stoch_cross_up"); 
    strength += 40;
    crossCandleClose = candles1h[candles1h.length - 1].close;
  }
  else if (crossDown) { 
    direction = "SHORT"; 
    reasons.push("stoch_cross_down"); 
    strength += 40;
    crossCandleClose = candles1h[candles1h.length - 1].close;
  }

  if (!direction) {
    return { hasEntry: false, direction: null, strength: 0, reasons: ["no_cross"], stochK: stoch.k, stochD: stoch.d };
  }

  // Volume direction check: only count if volume aligns with entry direction
  const lastCandle = candles1h[candles1h.length - 1];
  const volDirection = lastCandle.close > lastCandle.open ? "LONG" : "SHORT";
  if (volSurge && volDirection === direction) { 
    strength += 15; 
    reasons.push("volume_confirms"); 
  } else if (volSurge) {
    strength -= 10;
    reasons.push("volume_opposes");
  }

  const adx1h = adx(candles1h);
  if (adx1h > config.minADX) { strength += 10; reasons.push("adx_ok"); }

  const roc = ((closes[closes.length - 1] - closes[closes.length - 4]) / closes[closes.length - 4]) * 100;
  if (Math.abs(roc) > 1.0) { strength += 5; reasons.push("velocity"); }

  // Cross depth scoring
  if (direction === "LONG") {
    if (stoch.k < 40) { strength += 15; reasons.push("deep_cross"); }
    else if (stoch.k > 70) { strength -= 20; reasons.push("extended_cross"); }
  } else {
    if (stoch.k > 60) { strength += 15; reasons.push("deep_cross"); }
    else if (stoch.k < 30) { strength -= 20; reasons.push("extended_cross"); }
  }

  // Strong rejection wick check
  const body = Math.abs(lastCandle.close - lastCandle.open);
  const upperWick = lastCandle.high - Math.max(lastCandle.open, lastCandle.close);
  const lowerWick = Math.min(lastCandle.open, lastCandle.close) - lastCandle.low;
  const totalRange = lastCandle.high - lastCandle.low;
  if (totalRange > 0) {
    if (direction === "LONG" && upperWick / totalRange > 0.6) { strength -= 15; reasons.push("upper_rejection"); }
    if (direction === "SHORT" && lowerWick / totalRange > 0.6) { strength -= 15; reasons.push("lower_rejection"); }
  }

  strength = Math.min(100, Math.max(0, strength));
  return { hasEntry: strength >= config.momentumThreshold && direction !== null, direction, strength, reasons, stochK: stoch.k, stochD: stoch.d, crossCandleClose };
}

// HTF momentum exhaustion check
function isHTFExhausted(stoch4h: { k: number; d: number }, tradeDirection: "LONG" | "SHORT"): { exhausted: boolean; reason: string } {
  if (tradeDirection === "LONG") {
    if (stoch4h.k > 80 && stoch4h.k < stoch4h.d) {
      return { exhausted: true, reason: `4H StochRSI overbought exhaustion: K${stoch4h.k} < D${stoch4h.d}` };
    }
    if (stoch4h.k > 90) {
      return { exhausted: true, reason: `4H StochRSI extreme overbought: K${stoch4h.k}` };
    }
  } else {
    if (stoch4h.k < 20 && stoch4h.k > stoch4h.d) {
      return { exhausted: true, reason: `4H StochRSI oversold bounce risk: K${stoch4h.k} > D${stoch4h.d}` };
    }
    if (stoch4h.k < 10) {
      return { exhausted: true, reason: `4H StochRSI extreme oversold: K${stoch4h.k}` };
    }
  }
  return { exhausted: false, reason: "" };
}

export function generateSignal(pair: string, candles1h: Candle[], candles4h: Candle[], candles15m: Candle[], activeTrades?: Record<string, any>, currentPrice?: number): SignalResult {
  const debug: string[] = [];
  const config = getPairConfig(pair);
  const now = Date.now();

  // Check for existing active trade in same direction
  const activeKey = `${pair}_${activeTrades?.direction}`;
  if (activeTrades && activeTrades.pair === pair) {
    debug.push("Active trade exists, skipping duplicate entry");
    // Still return market data for UI
    const t1dQuick = trendDirection(aggregateTo1D(candles4h));
    const t4hQuick = trendDirection(candles4h);
    const stoch4hQuick = stochRsi(candles4h.map(c => c.close));
    const stoch1hQuick = stochRsi(candles1h.map(c => c.close));
    const price = currentPrice ?? candles1h[candles1h.length - 1].close;
    const market: MarketData = {
      pair, price: Math.round(price * 100) / 100, timestamp: now,
      phase: "WATCHING", trend: classifyTrend(t4hQuick),
      htfBias: t1dQuick.direction === "LONG" ? "BULLISH" : t1dQuick.direction === "SHORT" ? "BEARISH" : "MIXED",
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
  const t1d = trendDirection(candles1d);
  const t4h = trendDirection(candles4h);

  const t1dDisplay = classifyTrend(t1d);
  const t4hDisplay = classifyTrend(t4h);

  debug.push(`1D: ${t1dDisplay} structure=${t1d.structureValid}`);
  debug.push(`4H: ${t4hDisplay} structure=${t4h.structureValid}`);

  const price = currentPrice ?? candles1h[candles1h.length - 1].close;
  const stoch4h = stochRsi(candles4h.map(c => c.close));
  const stoch1h = stochRsi(candles1h.map(c => c.close));
  const adx4h = adx(candles4h);

  let tradeDirection: "LONG" | "SHORT" | null = t1d.direction;
  if (t4h.direction !== t1d.direction) {
    if (t4h.strength === "STRONG" && t1d.strength !== "STRONG") { 
      debug.push(`4H override: 4H=${t4hDisplay} vs 1D=${t1dDisplay}`); 
      tradeDirection = t4h.direction; 
    }
    else { 
      debug.push(`4H/1D mismatch blocked: 4H=${t4hDisplay} vs 1D=${t1dDisplay}`); 
      tradeDirection = null; 
    }
  }
  if (tradeDirection && !t1d.structureValid) { 
    debug.push(`1D structure invalid: ${tradeDirection} without HH/HL or LH/LL`); 
    tradeDirection = null; 
  }

  const htfBias = t1d.direction === "LONG" ? "BULLISH" : t1d.direction === "SHORT" ? "BEARISH" : "MIXED";

  if (!tradeDirection) {
    const market: MarketData = {
      pair, price: Math.round(price * 100) / 100, timestamp: now,
      phase: "WATCHING", trend: t4hDisplay,
      htfBias,
      adx: Math.round(adx4h * 10) / 10, rsi: Math.round(rsi(candles4h.map(c => c.close)) * 10) / 10,
      stochK: stoch4h.k, stochD: stoch4h.d, stoch1hK: stoch1h.k, stoch1hD: stoch1h.d,
    };
    return { market, debug };
  }

  const htfCheck = isHTFExhausted(stoch4h, tradeDirection);
  if (htfCheck.exhausted) {
    debug.push(`HTF EXHAUSTION: ${htfCheck.reason}`);
    const market: MarketData = {
      pair, price: Math.round(price * 100) / 100, timestamp: now,
      phase: "WATCHING", trend: t4hDisplay,
      htfBias: tradeDirection === "LONG" ? "BULLISH" : "BEARISH",
      adx: Math.round(adx4h * 10) / 10, rsi: Math.round(rsi(candles4h.map(c => c.close)) * 10) / 10,
      stochK: stoch4h.k, stochD: stoch4h.d, stoch1hK: stoch1h.k, stoch1hD: stoch1h.d,
    };
    return { market, debug };
  }

  const cooldown = isInCooldown(pair, now, tradeDirection);
  if (cooldown.inCooldown) {
    debug.push(`EXIT COOLDOWN: ${(cooldown.remainingMs / 3600000).toFixed(1)}h remaining`);
    const market: MarketData = {
      pair, price: Math.round(price * 100) / 100, timestamp: now,
      phase: "WATCHING", trend: t4hDisplay,
      htfBias: tradeDirection === "LONG" ? "BULLISH" : "BEARISH",
      adx: Math.round(adx4h * 10) / 10, rsi: Math.round(rsi(candles4h.map(c => c.close)) * 10) / 10,
      stochK: stoch4h.k, stochD: stoch4h.d, stoch1hK: stoch1h.k, stoch1hD: stoch1h.d,
    };
    return { market, debug };
  }

  const entry1h = detect1HEntry(candles1h, config);
  debug.push(`1H StochRSI: K${entry1h.stochK} D${entry1h.stochD}`);
  if (entry1h.hasEntry && entry1h.direction === tradeDirection) {
    debug.push(`1H ENTRY: ${entry1h.direction} strength=${entry1h.strength} | ${entry1h.reasons.join(", ")}`);
  } else {
    debug.push(`1H: ${entry1h.hasEntry ? "wrong direction" : "no cross"} | ${entry1h.reasons.join(", ") || "waiting"}`);
  }

  if (!entry1h.hasEntry || entry1h.direction !== tradeDirection) {
    const market: MarketData = {
      pair, price: Math.round(price * 100) / 100, timestamp: now,
      phase: "WATCHING", trend: t4hDisplay,
      htfBias: tradeDirection === "LONG" ? "BULLISH" : "BEARISH",
      adx: Math.round(adx4h * 10) / 10, rsi: Math.round(rsi(candles4h.map(c => c.close)) * 10) / 10,
      stochK: stoch4h.k, stochD: stoch4h.d, stoch1hK: stoch1h.k, stoch1hD: stoch1h.d,
    };
    return { market, debug };
  }

  // v28.3 FIX #3: Entry freshness gate
  if (entry1h.crossCandleClose) {
    const drift = Math.abs(price - entry1h.crossCandleClose) / entry1h.crossCandleClose;
    if (drift > config.maxEntryDriftPct) {
      debug.push(`ENTRY FRESHNESS: price drift ${(drift * 100).toFixed(2)}% > max ${(config.maxEntryDriftPct * 100).toFixed(1)}%, skipping`);
      const market: MarketData = {
        pair, price: Math.round(price * 100) / 100, timestamp: now,
        phase: "WATCHING", trend: t4hDisplay,
        htfBias: tradeDirection === "LONG" ? "BULLISH" : "BEARISH",
        adx: Math.round(adx4h * 10) / 10, rsi: Math.round(rsi(candles4h.map(c => c.close)) * 10) / 10,
        stochK: stoch4h.k, stochD: stoch4h.d, stoch1hK: stoch1h.k, stoch1hD: stoch1h.d,
      };
      return { market, debug };
    }
  }

  const entry = price;
  const sl = entry1h.direction === "LONG" ? entry * (1 - config.stopLossPct) : entry * (1 + config.stopLossPct);
  const tp = entry1h.direction === "LONG" ? entry * (1 + config.takeProfitPct) : entry * (1 - config.takeProfitPct);
  const rr = Math.abs(tp - entry) / Math.abs(entry - sl);
  debug.push(`R:R ${rr.toFixed(2)} (informational, no gate)`);

  const signal: Signal = {
    id: `${pair}_${now}`, pair, direction: entry1h.direction, type: "ENTRY", scale: "ENTRY_1",
    entry: Math.round(entry * 100) / 100, stop: Math.round(sl * 100) / 100, target: Math.round(tp * 100) / 100,
    confidence: entry1h.strength, rr: Math.round(rr * 100) / 100,
    adx: Math.round(adx4h * 10) / 10, rsi: Math.round(rsi(candles4h.map(c => c.close)) * 10) / 10,
    stochK: stoch4h.k, stochD: stoch4h.d, stoch1hK: entry1h.stochK, stoch1hD: entry1h.stochD,
    expectedMove: Math.round((Math.abs(tp - entry) / entry) * 100 * 10) / 10,
    reason: `${entry1h.direction} 1H ENTRY | 1D ${t1dDisplay} | 4H ${t4hDisplay} | 1H StochRSI K${entry1h.stochK} D${entry1h.stochD} cross | ${entry1h.reasons.join(", ")} | RR ${rr.toFixed(2)} | SL ${(config.stopLossPct * 100).toFixed(1)}% TP ${(config.takeProfitPct * 100).toFixed(1)}%`,
    timestamp: now, version: CURRENT_SIGNAL_VERSION,
    tradeState: "OPEN", lockedStop: null, highestPrice: entry, lowestPrice: entry, profitLockActive: false,
  };

  const market: MarketData = {
    pair, price: Math.round(price * 100) / 100, timestamp: now,
    phase: "EARLY_ENTRY", trend: t4hDisplay,
    htfBias: entry1h.direction === "LONG" ? "BULLISH" : "BEARISH",
    adx: signal.adx, rsi: signal.rsi, stochK: stoch4h.k, stochD: stoch4h.d, stoch1hK: stoch1h.k, stoch1hD: stoch1h.d,
  };

  debug.push(`SIGNAL: ${signal.direction} entry=${signal.entry} TP=${signal.target} SL=${signal.stop} RR=${signal.rr}`);
  return { signal, market, debug };
}

export function getMarketSnapshot(pair: string, candles1h: Candle[], candles4h: Candle[], candles15m: Candle[]): MarketData {
  const candles1d = aggregateTo1D(candles4h);
  const t1d = trendDirection(candles1d);
  const t4h = trendDirection(candles4h);
  const stoch4h = stochRsi(candles4h.map(c => c.close));
  const stoch1h = stochRsi(candles1h.map(c => c.close));
  const price = candles4h[candles4h.length - 1].close;
  const adx4h = adx(candles4h);

  const t1dDisplay = classifyTrend(t1d);

  const htfBias = t1d.direction === "LONG" ? "BULLISH" : t1d.direction === "SHORT" ? "BEARISH" : "MIXED";

  return {
    pair, price: Math.round(price * 100) / 100, timestamp: Date.now(),
    phase: "WATCHING", trend: classifyTrend(t4h),
    htfBias,
    adx: Math.round(adx4h * 10) / 10, rsi: Math.round(rsi(candles4h.map(c => c.close)) * 10) / 10,
    stochK: stoch4h.k, stochD: stoch4h.d, stoch1hK: stoch1h.k, stoch1hD: stoch1h.d,
  };
}

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
  if (pnlPct >= 0.015 && state === "OPEN") { state = "BREAK_EVEN"; locked = signal.entry; }
  if (pnlPct >= 0.03 && state === "BREAK_EVEN") { state = "LOCKED"; profitLock = true; locked = signal.direction === "LONG" ? signal.entry * 1.015 : signal.entry * 0.985; }
  if (pnlPct >= 0.05 && state === "LOCKED") {
    state = "RUNNER";
    const trailDistance = signal.direction === "LONG" ? (highest - signal.entry) * 0.5 : (signal.entry - lowest) * 0.5;
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
  const candles1d = aggregateTo1D(candles4h);
  const t1d = trendDirection(candles1d);
  const trendReversed = (signal.direction === "LONG" && t1d.direction === "SHORT") || (signal.direction === "SHORT" && t1d.direction === "LONG");
  if (trendReversed) {
    const inProfit = signal.direction === "LONG" ? currentPrice > signal.entry : currentPrice < signal.entry;
    if (!inProfit) {
      if (now) await recordExit(signal.id, signal.pair, signal.direction, currentPrice, "trend_reversed_unprofitable", now);
      return { shouldHold: false, reason: "trend_reversed_unprofitable" };
    }
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

export async function generateSignalCompat(pair: string, candles1h: Candle[], candles4h: Candle[], candles15m: Candle[], activeTrades?: Record<string, any>, currentPrice?: number): Promise<SignalResult> {
  return generateSignal(pair, candles1h, candles4h, candles15m, activeTrades, currentPrice);
}
export function isSignalStillValidBool(signal: Signal, currentPrice: number): boolean { return isSignalStillValid(signal, currentPrice).valid; }
export function shouldHoldCompat(signal: Signal, candles4h: Candle[], candles1h: Candle[], currentPrice: number): Promise<HoldResult> { return shouldHold(signal, candles4h, currentPrice); }
