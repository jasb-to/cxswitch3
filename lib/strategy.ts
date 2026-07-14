// ============================================================
// CXSwitch v37.2 — Strong-Trend Adaptive Pullback
//
// Philosophy: 1D sets the bias. 4H provides the setup. 15m executes.
// In STRONG trends, Stoch at extremes IS the pullback — don't wait
// for a counter-trend bounce that may never come.
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
  entry: number;
  stop: number;
  target: number;
  confidence: number;
  timestamp: number;
  exited: boolean;
  status?: "ACTIVE" | "PENDING_EXIT" | "EXITED";
  exitReason?: string;
  exitRecommendedAt?: number;
  exitRecommendedPrice?: number;
  exitPrice?: number;
  exitTimestamp?: number;
  entryType?: "EARLY" | "BREAKOUT" | "RETEST";
  trendlinePrice?: number;
  volumeConfirmed?: boolean;
  type?: "ACCUMULATE" | "BREAKOUT";
  scale?: "ENTRY_1" | "ENTRY_2" | "ADD" | null;
  entryTier?: string;
  entryMode?: string;
  positionSizePct?: number;
  tradeState?: TradeState;
  regimeDirection?: string;
  conflictEntry?: boolean;
  entryTimeframe?: string;
  rr?: number;
  adx?: number;
  rsi?: number;
  stochK?: number;
  stochD?: number;
  highestPrice?: number;
  lowestPrice?: number;
  lockedStop?: number;
  profitLockActive?: boolean;
  version?: number;
}

export interface SignalResult {
  signal?: Signal;
  market?: any;
  debug: string[];
}

export interface HoldResult {
  shouldHold: boolean;
  reason: string;
  updatedTradeState?: TradeState;
}

export interface Trendline {
  startIndex: number;
  endIndex: number;
  startPrice: number;
  endPrice: number;
  slope: number;
  type: "SUPPORT" | "RESISTANCE";
  touches: number;
  isValid: boolean;
  isBroken: boolean;
  brokenAt?: number;
  brokenPrice?: number;
}

export interface TradeState {
  phase: TradeLifecyclePhase;
  phaseEnteredAt: number;
  highestPrice: number;
  lowestPrice: number;
  entryPrice: number;
  lockedStop: number | null;
  profitLockLevel: number;
  currentR: number;
  entryTimestamp: number;
  lastDecisionTimestamp: number;
}

export type EntryTier = "NO_TRADE" | "WATCH" | "EARLY_ENTRY" | "CONFIRMED_ENTRY";
export type TradeLifecyclePhase = "WATCH" | "ENTRY" | "BUILDING" | "TREND" | "PROFIT_PROTECTION" | "EXIT" | "COOLDOWN";
export type PullbackTier = "DEEP" | "SHALLOW" | "MOMENTUM" | null;

export const CURRENT_SIGNAL_VERSION = 37;

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

export function stochRsi(
  values: number[],
  rsiPeriod = 14,
  stochPeriod = 14,
  kSmooth = 3,
  dSmooth = 3
): { k: number; d: number } {
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
  return {
    k: Math.round(kValues[kValues.length - 1] * 10) / 10,
    d: Math.round(avg(kValues.slice(-dSmooth)) * 10) / 10,
  };
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

function findPivots(candles: Candle[], leftBars = 3, rightBars = 2): {
  highs: { index: number; price: number }[];
  lows: { index: number; price: number }[];
} {
  const highs: { index: number; price: number }[] = [];
  const lows: { index: number; price: number }[] = [];
  for (let i = leftBars; i < candles.length - rightBars; i++) {
    const isHigh = candles.slice(i - leftBars, i).every(c => c.high <= candles[i].high) &&
                   candles.slice(i + 1, i + 1 + rightBars).every(c => c.high <= candles[i].high);
    if (isHigh) highs.push({ index: i, price: candles[i].high });
    const isLow = candles.slice(i - leftBars, i).every(c => c.low >= candles[i].low) &&
                  candles.slice(i + 1, i + 1 + rightBars).every(c => c.low >= candles[i].low);
    if (isLow) lows.push({ index: i, price: candles[i].low });
  }
  return { highs, lows };
}

function buildTrendlines(
  candles: Candle[],
  pivots: { index: number; price: number }[],
  type: "SUPPORT" | "RESISTANCE",
  minTouches = 2,
  atrTolerance = 0.3
): Trendline[] {
  const atrVal = atr(candles, 14);
  const tolerance = atrVal * atrTolerance;
  const lines: Trendline[] = [];
  for (let i = 0; i < pivots.length - 1; i++) {
    for (let j = i + 1; j < pivots.length; j++) {
      const p1 = pivots[i];
      const p2 = pivots[j];
      const slope = (p2.price - p1.price) / (p2.index - p1.index);
      if (type === "RESISTANCE" && slope > 0.001) continue;
      if (type === "SUPPORT" && slope < -0.001) continue;
      let touches = 0;
      let valid = true;
      for (let k = p1.index; k <= Math.min(p2.index + 5, candles.length - 1); k++) {
        const expectedPrice = p1.price + slope * (k - p1.index);
        const actualPrice = type === "RESISTANCE" ? candles[k].high : candles[k].low;
        const closePrice = candles[k].close;
        if (type === "RESISTANCE") {
          if (closePrice > expectedPrice + tolerance * 2) { valid = false; break; }
          if (Math.abs(actualPrice - expectedPrice) < tolerance) touches++;
        } else {
          if (closePrice < expectedPrice - tolerance * 2) { valid = false; break; }
          if (Math.abs(actualPrice - expectedPrice) < tolerance) touches++;
        }
      }
      if (valid && touches >= minTouches) {
        lines.push({
          startIndex: p1.index, endIndex: p2.index, startPrice: p1.price, endPrice: p2.price,
          slope, type, touches, isValid: true, isBroken: false,
        });
      }
    }
  }
  lines.sort((a, b) => {
    if (b.touches !== a.touches) return b.touches - a.touches;
    return b.endIndex - a.endIndex;
  });
  return lines.slice(0, 3);
}

function getTrendlinePrice(line: Trendline, index: number): number {
  return line.startPrice + line.slope * (index - line.startIndex);
}

function checkTrendlineBreak(
  candles: Candle[],
  trendlines: Trendline[],
  type: "SUPPORT" | "RESISTANCE"
): { broken: boolean; line?: Trendline; breakIndex?: number; breakPrice?: number } {
  if (candles.length < 3) return { broken: false };
  const currentIndex = candles.length - 1;
  const prevIndex = candles.length - 2;
  const current = candles[currentIndex];
  const prev = candles[prevIndex];
  for (const line of trendlines) {
    if (line.isBroken) continue;
    const lineCurrent = getTrendlinePrice(line, currentIndex);
    const linePrev = getTrendlinePrice(line, prevIndex);
    if (type === "RESISTANCE") {
      if (prev.close <= linePrev && current.close > lineCurrent) {
        line.isBroken = true; line.brokenAt = current.timestamp; line.brokenPrice = current.close;
        return { broken: true, line, breakIndex: currentIndex, breakPrice: current.close };
      }
    } else {
      if (prev.close >= linePrev && current.close < lineCurrent) {
        line.isBroken = true; line.brokenAt = current.timestamp; line.brokenPrice = current.close;
        return { broken: true, line, breakIndex: currentIndex, breakPrice: current.close };
      }
    }
  }
  return { broken: false };
}

function analyzeStructure(candles: Candle[]): {
  direction: "LONG" | "SHORT" | null;
  strength: number;
} {
  if (candles.length < 20) return { direction: null, strength: 0 };
  const { highs, lows } = findPivots(candles, 3, 2);
  if (highs.length < 3 || lows.length < 3) return { direction: null, strength: 0 };
  let hhCount = 0, hlCount = 0, llCount = 0, lhCount = 0;
  for (let i = 1; i < Math.min(highs.length, 5); i++) {
    if (highs[i].price > highs[i-1].price) hhCount++;
    else lhCount++;
  }
  for (let i = 1; i < Math.min(lows.length, 5); i++) {
    if (lows[i].price > lows[i-1].price) hlCount++;
    else llCount++;
  }
  const bullishScore = hhCount + hlCount;
  const bearishScore = llCount + lhCount;
  if (bullishScore > bearishScore + 1) return { direction: "LONG", strength: Math.min(100, bullishScore * 20) };
  if (bearishScore > bullishScore + 1) return { direction: "SHORT", strength: Math.min(100, bearishScore * 20) };
  return { direction: null, strength: 0 };
}

function detectTrend(candles1d: Candle[], candles4h: Candle[]): {
  direction: "LONG" | "SHORT" | null; strength: number; adx: number | null; debug: string[];
} {
  const debug: string[] = [];
  const structure1d = analyzeStructure(candles1d);
  debug.push(`1D Structure: ${structure1d.direction || "NONE"} (strength: ${structure1d.strength})`);
  const structure4h = analyzeStructure(candles4h);
  debug.push(`4H Structure: ${structure4h.direction || "NONE"} (strength: ${structure4h.strength})`);
  const closes4h = candles4h.map(c => c.close);
  const e8 = ema(closes4h, 8), e21 = ema(closes4h, 21), e50 = ema(closes4h, 50);
  let emaTrend: "LONG" | "SHORT" | null = null;
  if (e8.length && e21.length && e50.length) {
    const c0 = closes4h[closes4h.length - 1];
    const e8_0 = e8[e8.length - 1], e21_0 = e21[e21.length - 1], e50_0 = e50[e50.length - 1];
    if (c0 > e8_0 && e8_0 > e21_0 && e21_0 > e50_0) emaTrend = "LONG";
    else if (c0 < e8_0 && e8_0 < e21_0 && e21_0 < e50_0) emaTrend = "SHORT";
    else if (e8_0 > e21_0) emaTrend = "LONG";
    else if (e8_0 < e21_0) emaTrend = "SHORT";
  }
  debug.push(`4H EMA Trend: ${emaTrend || "NONE"}`);
  const adxVal = adx(candles4h);
  debug.push(`4H ADX: ${adxVal !== null ? adxVal.toFixed(1) : "N/A"}`);
  if (!structure1d.direction) {
    debug.push(`BIAS: UNCLEAR — 1D structure missing`);
    return { direction: null, strength: 0, adx: adxVal, debug };
  }
  const biasDirection = structure1d.direction;
  const biasStrength = structure1d.strength;
  const fourHAligned = structure4h.direction === biasDirection;
  const fourHInPullback = structure4h.direction && structure4h.direction !== biasDirection;
  if (fourHAligned) debug.push(`BIAS: ${biasDirection} | 1D+4H aligned | Strength: ${biasStrength} | ADX: ${adxVal?.toFixed(1) || "N/A"}`);
  else if (fourHInPullback) debug.push(`BIAS: ${biasDirection} | 4H in pullback (4H=${structure4h.direction}) | Strength: ${biasStrength} | ADX: ${adxVal?.toFixed(1) || "N/A"}`);
  else debug.push(`BIAS: ${biasDirection} | 4H neutral | Strength: ${biasStrength} | ADX: ${adxVal?.toFixed(1) || "N/A"}`);
  return { direction: biasDirection, strength: biasStrength, adx: adxVal, debug };
}

export interface PullbackResult {
  pullbackActive: boolean;
  tier: PullbackTier;
  reason: string;
  stochZone: "EXTREME" | "ZONE" | "NEUTRAL" | "EXTENDED";
}

function checkPullbackAdaptive(
  biasDirection: "LONG" | "SHORT" | null,
  stoch4h: { k: number; d: number },
  prevStoch4h: { k: number; d: number },
  adx: number | null,
  isStrongTrend: boolean
): PullbackResult {
  if (!biasDirection) {
    return { pullbackActive: false, tier: null, reason: "No bias — no pullback check", stochZone: "NEUTRAL" };
  }

  const crossUp = prevStoch4h.k <= prevStoch4h.d && stoch4h.k > stoch4h.d;
  const crossDown = prevStoch4h.k >= prevStoch4h.d && stoch4h.k < stoch4h.d;

  // ============================================================
  // STRONG TREND LOGIC (ADX >= 25, 1D+4H aligned)
  // In strong trends, deeply oversold Stoch = trend is STRETCHED.
  // The "pullback" is the brief pause, not a counter-trend bounce.
  // ============================================================
  if (isStrongTrend) {
    if (biasDirection === "LONG") {
      if (stoch4h.k < 20) {
        return { pullbackActive: true, tier: "DEEP", reason: `STRONG TREND DEEP: 4H Stoch extreme oversold (${stoch4h.k}) — trend stretched, 15m cross triggers`, stochZone: "EXTREME" };
      }
      if (stoch4h.k < 35) {
        return { pullbackActive: true, tier: "SHALLOW", reason: `STRONG TREND SHALLOW: 4H Stoch oversold (${stoch4h.k}) — 15m cross triggers`, stochZone: "ZONE" };
      }
      if (stoch4h.k < 50) {
        return { pullbackActive: true, tier: "MOMENTUM", reason: `STRONG TREND MOMENTUM: 4H Stoch ${stoch4h.k} (not overbought), 15m cross can trigger`, stochZone: "NEUTRAL" };
      }
      return { pullbackActive: false, tier: null, reason: `STRONG LONG: extended — 4H Stoch ${stoch4h.k} (need <50)`, stochZone: "EXTENDED" };
    }

    if (biasDirection === "SHORT") {
      if (stoch4h.k > 80) {
        return { pullbackActive: true, tier: "DEEP", reason: `STRONG TREND DEEP: 4H Stoch extreme overbought (${stoch4h.k}) — pullback up complete, 15m cross triggers`, stochZone: "EXTREME" };
      }
      if (stoch4h.k > 65) {
        return { pullbackActive: true, tier: "SHALLOW", reason: `STRONG TREND SHALLOW: 4H Stoch overbought (${stoch4h.k}) — pullback up, 15m cross triggers`, stochZone: "ZONE" };
      }
      if (stoch4h.k > 50) {
        return { pullbackActive: true, tier: "MOMENTUM", reason: `STRONG TREND MOMENTUM: 4H Stoch ${stoch4h.k} (not oversold), 15m cross can trigger`, stochZone: "NEUTRAL" };
      }
      return { pullbackActive: false, tier: null, reason: `STRONG SHORT: extended — 4H Stoch ${stoch4h.k} (need >50 for entry)`, stochZone: "EXTENDED" };
    }
  }

  // ============================================================
  // NORMAL (WEAK) TREND LOGIC — Counter-trend bounce required
  // ============================================================
  if (biasDirection === "LONG") {
    if (stoch4h.k < 20) {
      if (crossUp) return { pullbackActive: true, tier: "DEEP", reason: `DEEP pullback: 4H Stoch cross up from extreme oversold (${stoch4h.k})`, stochZone: "EXTREME" };
      return { pullbackActive: false, tier: null, reason: `LONG deep pullback forming: 4H Stoch extreme oversold (${stoch4h.k}), waiting for cross up`, stochZone: "EXTREME" };
    }
    if (stoch4h.k < 35) {
      if (crossUp) return { pullbackActive: true, tier: "SHALLOW", reason: `SHALLOW pullback: 4H Stoch cross up from oversold (${stoch4h.k})`, stochZone: "ZONE" };
      return { pullbackActive: false, tier: null, reason: `LONG shallow pullback forming: 4H Stoch oversold (${stoch4h.k}), waiting for cross up`, stochZone: "ZONE" };
    }
    if (stoch4h.k < 50) {
      return { pullbackActive: true, tier: "MOMENTUM", reason: `MOMENTUM zone: 4H Stoch ${stoch4h.k} (not overbought), 15m cross can trigger entry`, stochZone: "NEUTRAL" };
    }
    return { pullbackActive: false, tier: null, reason: `LONG: extended — 4H Stoch ${stoch4h.k} (need <50 for any entry)`, stochZone: "EXTENDED" };
  }

  if (biasDirection === "SHORT") {
    if (stoch4h.k > 80) {
      if (crossDown) return { pullbackActive: true, tier: "DEEP", reason: `DEEP pullback: 4H Stoch cross down from extreme overbought (${stoch4h.k})`, stochZone: "EXTREME" };
      return { pullbackActive: false, tier: null, reason: `SHORT deep pullback forming: 4H Stoch extreme overbought (${stoch4h.k}), waiting for cross down`, stochZone: "EXTREME" };
    }
    if (stoch4h.k > 65) {
      if (crossDown) return { pullbackActive: true, tier: "SHALLOW", reason: `SHALLOW pullback: 4H Stoch cross down from overbought (${stoch4h.k})`, stochZone: "ZONE" };
      return { pullbackActive: false, tier: null, reason: `SHORT shallow pullback forming: 4H Stoch overbought (${stoch4h.k}), waiting for cross down`, stochZone: "ZONE" };
    }
    if (stoch4h.k > 50) {
      return { pullbackActive: true, tier: "MOMENTUM", reason: `MOMENTUM zone: 4H Stoch ${stoch4h.k} (not oversold), 15m cross can trigger entry`, stochZone: "NEUTRAL" };
    }
    return { pullbackActive: false, tier: null, reason: `SHORT: extended — 4H Stoch ${stoch4h.k} (need >50 for any entry)`, stochZone: "EXTENDED" };
  }

  return { pullbackActive: false, tier: null, reason: "Unknown bias direction", stochZone: "NEUTRAL" };
}

function isVolumeConfirmed(candles: Candle[], lookback = 10): boolean {
  if (candles.length < lookback + 2) return false;
  const volumes = candles.map(c => c.volume);
  const avgVol = avg(volumes.slice(-lookback - 1, -1));
  const currentVol = volumes[volumes.length - 1];
  return currentVol > avgVol * 1.2;
}

export function generateSignal(
  pair: string,
  candles1h: Candle[],
  candles4h: Candle[],
  candles1d: Candle[],
  candles15m: Candle[],
  activeSignals: Signal[],
  currentPrice?: number
): SignalResult {
  const debug: string[] = [];
  const now = Date.now();

  if (!Array.isArray(activeSignals)) {
    console.warn(`[generateSignal] activeSignals is not an array for ${pair}, defaulting to empty`);
    activeSignals = [];
  }

  const active = activeSignals.find((s: any) => s && s.pair === pair && s.exited === false);
  if (active) {
    debug.push(`Already active: ${active.id}`);
    return { debug };
  }

  if (candles4h.length < 50 || candles1h.length < 30 || candles1d.length < 25 || candles15m.length < 20) {
    debug.push("Insufficient data");
    return { debug };
  }

  const price = currentPrice ?? candles4h[candles4h.length - 1].close;

  const trend = detectTrend(candles1d, candles4h);
  debug.push(...trend.debug);

  if (!trend.direction) {
    debug.push("No valid 1D bias — waiting for structure");
    return { debug };
  }

  const biasDirection = trend.direction;
  const isStrongTrend = (trend.adx !== null && trend.adx >= 25) && trend.strength >= 80;

  const closes4h = candles4h.map(c => c.close);
  const stoch4h = stochRsi(closes4h);
  const prevStoch4h = stochRsi(closes4h.slice(0, -1));

  debug.push(`4H Stoch: ${stoch4h.k}/${stoch4h.d}`);

  const pullback = checkPullbackAdaptive(biasDirection, stoch4h, prevStoch4h, trend.adx, isStrongTrend);
  debug.push(pullback.reason);

  if (pullback.stochZone === "EXTENDED") {
    debug.push(`Entry blocked — Stoch extended (${stoch4h.k}), not in valid pullback zone`);
    return { debug };
  }

  const pivots4h = findPivots(candles4h, 3, 2);
  let relevantLines: Trendline[] = [];
  let breakType: "RESISTANCE" | "SUPPORT";

  if (biasDirection === "LONG") {
    relevantLines = buildTrendlines(candles4h, pivots4h.highs, "RESISTANCE", 2, 0.3);
    breakType = "RESISTANCE";
    debug.push(`Trendlines: ${relevantLines.length} descending resistance (LONG setup)`);
  } else {
    relevantLines = buildTrendlines(candles4h, pivots4h.lows, "SUPPORT", 2, 0.3);
    breakType = "SUPPORT";
    debug.push(`Trendlines: ${relevantLines.length} ascending support (SHORT setup)`);
  }

  const closes15m = candles15m.map(c => c.close);
  const stoch15m = stochRsi(closes15m);
  const prevStoch15m = stochRsi(closes15m.slice(0, -1));

  debug.push(`15M Stoch: ${stoch15m.k}/${stoch15m.d}`);

  const breakEvent = checkTrendlineBreak(candles4h, relevantLines, breakType);
  const volConfirmed = isVolumeConfirmed(candles4h);
  debug.push(`Volume: ${volConfirmed ? "CONFIRMED (+20%)" : "weak"}`);

  let entryType: "EARLY" | "BREAKOUT" | "RETEST" | null = null;
  let confidence = 50;
  let trendlinePrice = 0;

  const stoch15mCrossUp = prevStoch15m.k <= prevStoch15m.d && stoch15m.k > stoch15m.d;
  const stoch15mCrossDown = prevStoch15m.k >= prevStoch15m.d && stoch15m.k < stoch15m.d;
  const stoch15mAlignsLong = stoch15m.k > stoch15m.d && stoch15m.k < 80;
  const stoch15mAlignsShort = stoch15m.k < stoch15m.d && stoch15m.k > 65;

  if (biasDirection === "LONG") {
    if (pullback.tier === "DEEP") {
      if (stoch15mAlignsLong || stoch15mCrossUp) {
        entryType = "RETEST"; confidence = 85;
        trendlinePrice = relevantLines[0] ? getTrendlinePrice(relevantLines[0], candles4h.length - 1) : price * 1.02;
        debug.push(`DEEP PULLBACK LONG: 4H Stoch ${stoch4h.k} extreme oversold + 15m aligns`);
      }
    } else if (pullback.tier === "SHALLOW") {
      if (stoch15mCrossUp || stoch15mAlignsLong) {
        entryType = "BREAKOUT"; confidence = 75;
        trendlinePrice = relevantLines[0] ? getTrendlinePrice(relevantLines[0], candles4h.length - 1) : price * 1.02;
        debug.push(`SHALLOW PULLBACK LONG: 4H Stoch ${stoch4h.k} oversold + 15m confirms`);
      }
    } else if (pullback.tier === "MOMENTUM") {
      if (stoch15mCrossUp) {
        entryType = "EARLY"; confidence = 60;
        if (isStrongTrend) confidence += 10;
        trendlinePrice = relevantLines[0] ? getTrendlinePrice(relevantLines[0], candles4h.length - 1) : price * 1.02;
        debug.push(`MOMENTUM LONG: 4H Stoch ${stoch4h.k} neutral + 15m cross up${isStrongTrend ? " (strong trend boost)" : ""}`);
      }
    }
  } else if (biasDirection === "SHORT") {
    if (pullback.tier === "DEEP") {
      if (stoch15mAlignsShort || stoch15mCrossDown) {
        entryType = "RETEST"; confidence = 85;
        trendlinePrice = relevantLines[0] ? getTrendlinePrice(relevantLines[0], candles4h.length - 1) : price * 0.98;
        debug.push(`DEEP PULLBACK SHORT: 4H Stoch ${stoch4h.k} extreme oversold + 15m aligns — trend stretched`);
      }
    } else if (pullback.tier === "SHALLOW") {
      if (stoch15mCrossDown || stoch15mAlignsShort) {
        entryType = "BREAKOUT"; confidence = 75;
        trendlinePrice = relevantLines[0] ? getTrendlinePrice(relevantLines[0], candles4h.length - 1) : price * 0.98;
        debug.push(`SHALLOW PULLBACK SHORT: 4H Stoch ${stoch4h.k} oversold + 15m confirms`);
      }
    } else if (pullback.tier === "MOMENTUM") {
      if (stoch15mCrossDown) {
        entryType = "EARLY"; confidence = 60;
        if (isStrongTrend) confidence += 10;
        trendlinePrice = relevantLines[0] ? getTrendlinePrice(relevantLines[0], candles4h.length - 1) : price * 0.98;
        debug.push(`MOMENTUM SHORT: 4H Stoch ${stoch4h.k} neutral + 15m cross down${isStrongTrend ? " (strong trend boost)" : ""}`);
      }
    }
  }

  if (!entryType && breakEvent.broken && breakEvent.line) {
    const stoch15mAligns = biasDirection === "LONG" ? stoch15mAlignsLong : stoch15mAlignsShort;
    if (stoch15mAligns) {
      entryType = "BREAKOUT"; confidence = 80;
      if (volConfirmed) confidence += 5;
      trendlinePrice = getTrendlinePrice(breakEvent.line, candles4h.length - 1);
      debug.push(`BREAKOUT ${biasDirection}: 4H ${breakEvent.line.type} broken, 15m confirms`);
    }
  }

  if (!entryType) {
    debug.push("No entry setup — waiting for 15m signal or 4H trendline break");
    return { debug };
  }

  const swingLow = Math.min(...candles4h.slice(-20).map(c => c.low));
  const swingHigh = Math.max(...candles4h.slice(-20).map(c => c.high));
  const atr4h = atr(candles4h, 14);

  let entry = price;
  let stop: number;
  let target: number;

  const atrMultiplier = pullback.tier === "DEEP" ? 2.0 : pullback.tier === "SHALLOW" ? 1.5 : 1.0;

  if (biasDirection === "LONG") {
    stop = Math.min(swingLow * 0.998, entry - atr4h * atrMultiplier);
    // Cap target at 3x ATR for strong trends (trendline can give ridiculous targets)
    const atrTarget = entry + atr4h * 3;
    const swingTarget = swingHigh;
    if (isStrongTrend) {
      target = Math.min(atrTarget, swingTarget);
    } else {
      const breakToEntry = Math.max(0, entry - trendlinePrice);
      const tlTarget = entry + breakToEntry * 2;
      target = Math.max(Math.min(tlTarget, atrTarget * 1.5), atrTarget);
      target = Math.min(target, swingTarget);
    }
  } else {
    stop = Math.max(swingHigh * 1.002, entry + atr4h * atrMultiplier);
    // Cap target at 3x ATR for strong trends
    const atrTarget = entry - atr4h * 3;
    const swingTarget = swingLow;
    if (isStrongTrend) {
      target = Math.min(atrTarget, swingTarget);
    } else {
      const breakToEntry = Math.max(0, trendlinePrice - entry);
      const tlTarget = entry - breakToEntry * 2;
      target = Math.min(Math.max(tlTarget, atrTarget * 1.5), atrTarget);
      target = Math.max(target, swingTarget);
    }
  }

  const risk = Math.abs(entry - stop);
  const reward = Math.abs(target - entry);
  const rr = risk > 0 ? reward / risk : 0;

  const minRR = pullback.tier === "DEEP" ? 1.0 : pullback.tier === "SHALLOW" ? 1.5 : 2.0;
  if (rr < minRR) {
    debug.push(`R:R ${rr.toFixed(2)} < ${minRR} (min for ${pullback.tier} tier) — skip`);
    return { debug };
  }

  confidence += Math.min(10, trend.strength / 10);
  if (breakEvent.broken) confidence += 5;
  if (trend.adx !== null && trend.adx >= 25) confidence += 5;
  if (trend.adx !== null && trend.adx >= 30) confidence += 5;
  confidence = Math.min(95, Math.round(confidence));

  let positionSizePct = 0.03;
  if (pullback.tier === "DEEP") positionSizePct = 0.06;
  else if (pullback.tier === "SHALLOW") positionSizePct = 0.05;
  else if (pullback.tier === "MOMENTUM") positionSizePct = 0.03;

  const signal: Signal = {
    id: `${pair}_${now}`,
    pair,
    direction: biasDirection,
    entry: Math.round(entry * 100) / 100,
    stop: Math.round(stop * 100) / 100,
    target: Math.round(target * 100) / 100,
    confidence: Math.round(confidence),
    timestamp: now,
    exited: false,
    entryType,
    trendlinePrice: Math.round(trendlinePrice * 100) / 100,
    volumeConfirmed: volConfirmed,
    type: "ACCUMULATE",
    scale: entryType === "RETEST" ? "ENTRY_1" : entryType === "BREAKOUT" ? "ENTRY_2" : "ENTRY_1",
    entryTier: pullback.tier === "DEEP" ? "CONFIRMED_ENTRY" : pullback.tier === "SHALLOW" ? "CONFIRMED_ENTRY" : "EARLY_ENTRY",
    entryMode: entryType === "EARLY" ? "PULLBACK" : entryType === "RETEST" ? "RETEST" : "BREAKOUT",
    positionSizePct,
    regimeDirection: biasDirection,
    conflictEntry: false,
    entryTimeframe: "15M",
    rr: Math.round(rr * 100) / 100,
    adx: trend.adx !== null ? Math.round(trend.adx * 10) / 10 : undefined,
    version: CURRENT_SIGNAL_VERSION,
    tradeState: {
      phase: "ENTRY",
      phaseEnteredAt: now,
      highestPrice: entry,
      lowestPrice: entry,
      entryPrice: entry,
      lockedStop: null,
      profitLockLevel: 0,
      currentR: 0,
      entryTimestamp: now,
      lastDecisionTimestamp: now,
    },
  };

  setHysteresis(pair, entry, now);

  debug.push(`SIGNAL: ${pullback.tier} ${entryType} ${biasDirection} ${pair} @ ${entry.toFixed(2)}, SL ${stop.toFixed(2)}, TP ${target.toFixed(2)}, RR ${rr.toFixed(2)}, Conf ${confidence}%, Size ${(positionSizePct*100).toFixed(0)}%, ADX ${trend.adx?.toFixed(1) || "N/A"}${volConfirmed ? ", VOL+" : ""}`);

  return { signal, debug };
}

const hysteresisStore = new Map<string, { lastEntryPrice: number; lockUntil: number }>();
const POST_EXIT_COOLDOWN_MS = 30 * 60 * 1000;

function getHysteresis(pair: string, now: number) {
  const s = hysteresisStore.get(pair);
  if (!s || now > s.lockUntil) return null;
  return s;
}

function setHysteresis(pair: string, price: number, now: number) {
  hysteresisStore.set(pair, { lastEntryPrice: price, lockUntil: now + POST_EXIT_COOLDOWN_MS });
}

function isInExhaustionZone(
  pair: string,
  price: number,
  candles4h: Candle[],
  direction: "LONG" | "SHORT"
): boolean {
  const stoch4h = stochRsi(candles4h.map(c => c.close));
  if (direction === "LONG" && stoch4h.k > 75) return true;
  if (direction === "SHORT" && stoch4h.k < 25) return true;
  const hyst = getHysteresis(pair, Date.now());
  if (hyst) {
    const dist = Math.abs(price - hyst.lastEntryPrice) / hyst.lastEntryPrice;
    if (dist < 0.01) return true;
  }
  return false;
}

export function shouldHold(
  signal: Signal,
  candles4h: Candle[],
  candles1d: Candle[],
  candles1h: Candle[],
  currentPrice: number
): HoldResult {
  const now = Date.now();
  const ts = signal.tradeState || {
    phase: "TREND", phaseEnteredAt: signal.timestamp,
    highestPrice: signal.entry, lowestPrice: signal.entry,
    entryPrice: signal.entry, lockedStop: null,
    profitLockLevel: 0, currentR: 0,
    entryTimestamp: signal.timestamp, lastDecisionTimestamp: signal.timestamp,
  };

  const newHighest = Math.max(ts.highestPrice, currentPrice);
  const newLowest = Math.min(ts.lowestPrice, currentPrice);
  const currentR = signal.direction === "LONG"
    ? (currentPrice - signal.entry) / (signal.entry - signal.stop)
    : (signal.entry - currentPrice) / (signal.stop - signal.entry);

  const updatedState: TradeState = {
    ...ts, highestPrice: newHighest, lowestPrice: newLowest,
    currentR, lastDecisionTimestamp: now,
  };

  if (signal.direction === "LONG" && currentPrice <= signal.stop) {
    return { shouldHold: false, reason: "stop_loss", updatedTradeState: { ...updatedState, phase: "EXIT" } };
  }
  if (signal.direction === "SHORT" && currentPrice >= signal.stop) {
    return { shouldHold: false, reason: "stop_loss", updatedTradeState: { ...updatedState, phase: "EXIT" } };
  }
  if (signal.direction === "LONG" && currentPrice >= signal.target) {
    return { shouldHold: false, reason: "target_hit", updatedTradeState: { ...updatedState, phase: "EXIT" } };
  }
  if (signal.direction === "SHORT" && currentPrice <= signal.target) {
    return { shouldHold: false, reason: "target_hit", updatedTradeState: { ...updatedState, phase: "EXIT" } };
  }

  if (candles1d && candles1d.length >= 25) {
    const structure1d = analyzeStructure(candles1d);
    if (structure1d.direction && structure1d.direction !== signal.direction) {
      const hoursInTrade = (now - signal.timestamp) / (60 * 60 * 1000);
      if (currentR < 2 || hoursInTrade < 24) {
        return { shouldHold: false, reason: "1d_regime_flip", updatedTradeState: { ...updatedState, phase: "EXIT" } };
      }
      return { shouldHold: false, reason: "1d_regime_flip_profit", updatedTradeState: { ...updatedState, phase: "EXIT" } };
    }
  }

  if (candles4h && candles4h.length >= 50) {
    const structure4h = analyzeStructure(candles4h);
    const closes4h = candles4h.map(c => c.close);
    const e21 = ema(closes4h, 21);
    if (structure4h.direction && structure4h.direction !== signal.direction) {
      const hoursInTrade = (now - signal.timestamp) / (60 * 60 * 1000);
      if (hoursInTrade > 4 && e21.length > 0) {
        const ema21Price = e21[e21.length - 1];
        if (signal.direction === "LONG" && currentPrice < ema21Price * 0.99) {
          return { shouldHold: false, reason: "4h_structure_failure", updatedTradeState: { ...updatedState, phase: "EXIT" } };
        }
        if (signal.direction === "SHORT" && currentPrice > ema21Price * 1.01) {
          return { shouldHold: false, reason: "4h_structure_failure", updatedTradeState: { ...updatedState, phase: "EXIT" } };
        }
      }
    }
  }

  let newLockedStop = ts.lockedStop;
  let newProfitLockLevel = ts.profitLockLevel;
  let newPhase: TradeLifecyclePhase = ts.phase;

  if (currentR >= 3 && newProfitLockLevel < 3) {
    const gain = Math.abs(currentPrice - signal.entry);
    const lockPrice = signal.direction === "LONG" ? signal.entry + gain * 0.3 : signal.entry - gain * 0.3;
    newLockedStop = Math.max(ts.lockedStop || 0, lockPrice);
    newProfitLockLevel = 3; newPhase = "PROFIT_PROTECTION";
  } else if (currentR >= 2 && newProfitLockLevel < 2) {
    const gain = Math.abs(currentPrice - signal.entry);
    const lockPrice = signal.direction === "LONG" ? signal.entry + gain * 0.5 : signal.entry - gain * 0.5;
    newLockedStop = Math.max(ts.lockedStop || 0, lockPrice);
    newProfitLockLevel = 2; newPhase = "PROFIT_PROTECTION";
  } else if (currentR >= 1 && newProfitLockLevel < 1) {
    newLockedStop = signal.entry; newProfitLockLevel = 1; newPhase = "BUILDING";
  }

  if (newLockedStop) {
    if (signal.direction === "LONG" && currentPrice <= newLockedStop) {
      return { shouldHold: false, reason: `profit_protection_${newProfitLockLevel}R`, updatedTradeState: { ...updatedState, phase: "EXIT", lockedStop: newLockedStop, profitLockLevel: newProfitLockLevel } };
    }
    if (signal.direction === "SHORT" && currentPrice >= newLockedStop) {
      return { shouldHold: false, reason: `profit_protection_${newProfitLockLevel}R`, updatedTradeState: { ...updatedState, phase: "EXIT", lockedStop: newLockedStop, profitLockLevel: newProfitLockLevel } };
    }
  }

  if (currentR >= 2 && newPhase === "BUILDING") newPhase = "TREND";
  if (currentR >= 1 && newPhase === "ENTRY") newPhase = "BUILDING";

  const finalState: TradeState = {
    ...updatedState, phase: newPhase,
    lockedStop: newLockedStop, profitLockLevel: newProfitLockLevel,
  };

  return { shouldHold: true, reason: `holding_${newPhase.toLowerCase()}_R${currentR.toFixed(1)}`, updatedTradeState: finalState };
}

export function isSignalStillValid(signal: Signal, currentPrice: number): { valid: boolean; reason: string; exited: boolean } {
  if (signal.direction === "LONG" && currentPrice <= signal.stop) return { valid: false, reason: "sl_hit", exited: true };
  if (signal.direction === "SHORT" && currentPrice >= signal.stop) return { valid: false, reason: "sl_hit", exited: true };
  if (signal.direction === "LONG" && currentPrice >= signal.target) return { valid: false, reason: "tp_hit", exited: true };
  if (signal.direction === "SHORT" && currentPrice <= signal.target) return { valid: false, reason: "tp_hit", exited: true };
  return { valid: true, reason: "active", exited: false };
}

export function filterExpiredSignals(signals: Signal[], currentPrices?: Record<string, number>) {
  const active: Signal[] = [];
  const exited: { signal: Signal; reason: string }[] = [];
  const now = Date.now();
  const EXITED_TTL_MS = 7 * 24 * 60 * 60 * 1000;
  for (const signal of signals) {
    if (!signal.exited) {
      const price = currentPrices?.[signal.pair];
      if (price !== undefined) {
        const check = isSignalStillValid(signal, price);
        if (!check.valid) { exited.push({ signal, reason: check.reason }); continue; }
      }
      active.push(signal); continue;
    }
    if (now - signal.timestamp < EXITED_TTL_MS) active.push(signal);
  }
  return { active, exited };
}

export function getMarketSnapshot(
  pair: string,
  candles1h: Candle[],
  candles4h: Candle[],
  candles15m: Candle[],
  candles1d: Candle[],
  currentPrice?: number,
  signalResult?: SignalResult
) {
  const price = currentPrice ?? candles4h[candles4h.length - 1]?.close ?? 0;
  const trend = detectTrend(candles1d, candles4h);
  const stoch4h = candles4h.length >= 50 ? stochRsi(candles4h.map(c => c.close)) : { k: 50, d: 50 };
  const stoch1h = candles1h.length >= 30 ? stochRsi(candles1h.map(c => c.close)) : { k: 50, d: 50 };
  const stoch15m = candles15m.length >= 20 ? stochRsi(candles15m.map(c => c.close)) : { k: 50, d: 50 };
  const volConfirmed = isVolumeConfirmed(candles4h);
  const pivots4h = findPivots(candles4h, 3, 2);
  const resistanceLines = buildTrendlines(candles4h, pivots4h.highs, "RESISTANCE", 2, 0.3);
  const supportLines = buildTrendlines(candles4h, pivots4h.lows, "SUPPORT", 2, 0.3);
  const activeTrendlines = [...resistanceLines, ...supportLines]
    .filter(l => l.isValid && !l.isBroken)
    .map(l => ({ type: l.type, startPrice: l.startPrice, endPrice: l.endPrice, touches: l.touches, currentPrice: getTrendlinePrice(l, candles4h.length - 1) }));
  const biasDirection = trend.direction;
  const longBreak = biasDirection === "LONG" ? checkTrendlineBreak(candles4h, resistanceLines, "RESISTANCE") : { broken: false };
  const shortBreak = biasDirection === "SHORT" ? checkTrendlineBreak(candles4h, supportLines, "SUPPORT") : { broken: false };
  const closes4h = candles4h.map(c => c.close);
  const prevStoch4h = stochRsi(closes4h.slice(0, -1));
  const isStrongTrend = (trend.adx !== null && trend.adx >= 25) && trend.strength >= 80;
  const pullback = biasDirection ? checkPullbackAdaptive(biasDirection, stoch4h, prevStoch4h, trend.adx, isStrongTrend) : { pullbackActive: false, reason: "No bias", tier: null, stochZone: "NEUTRAL" };
  const t1h = detectTrendCompat(candles1h);
  const t4h = detectTrendCompat(candles4h);
  const t1d = detectTrendCompat(candles1d);
  const closes4hArr = candles4h.map(c => c.close);
  const e21_4h = ema(closes4hArr, 21);
  const ema21Price = e21_4h.length > 0 ? e21_4h[e21_4h.length - 1] : 0;
  const distToEMA21 = ema21Price > 0 ? (price - ema21Price) / ema21Price : 0;
  const adxVal = adx(candles4h) ?? 0;
  const rsiVal = wilderRsi(closes4hArr);
  let trendStrengthLabel = "WEAK";
  if (adxVal >= 30) trendStrengthLabel = "STRONG";
  else if (adxVal >= 20) trendStrengthLabel = "MEDIUM";
  let phase4h: "EXPANSION" | "PULLBACK" | "BUILDING" | "NEUTRAL" = "NEUTRAL";
  if (biasDirection === "LONG") {
    if (stoch4h.k > 65) phase4h = "EXPANSION";
    else if (stoch4h.k < 35) phase4h = "PULLBACK";
    else phase4h = "BUILDING";
  } else if (biasDirection === "SHORT") {
    if (stoch4h.k < 35) phase4h = "EXPANSION";
    else if (stoch4h.k > 65) phase4h = "PULLBACK";
    else phase4h = "BUILDING";
  }
  let structure15m = "Neutral";
  if (candles15m.length >= 20) {
    const t15m = detectTrendCompat(candles15m);
    if (t15m.direction === biasDirection) structure15m = t15m.strength === "STRONG" ? "Breakout" : "Building";
    else if (t15m.direction && t15m.direction !== biasDirection) structure15m = "Pullback";
  }
  let readiness = 0;
  if (biasDirection) readiness += 25;
  if (trend.strength >= 50) readiness += 15;
  if (pullback.pullbackActive) {
    if (pullback.tier === "DEEP") readiness += 30;
    else if (pullback.tier === "SHALLOW") readiness += 20;
    else if (pullback.tier === "MOMENTUM") readiness += 10;
  }
  if (longBreak.broken || shortBreak.broken) readiness += 20;
  if (adxVal >= 25) readiness += 10;
  if (volConfirmed) readiness += 5;
  if (signalResult?.signal) readiness += 15;
  readiness = Math.min(100, readiness);
  let readinessLabel = "NO TRADE";
  let readinessColor = "text-gray-400";
  if (readiness >= 80) { readinessLabel = "READY"; readinessColor = "text-green-400"; }
  else if (readiness >= 60) { readinessLabel = "WARM"; readinessColor = "text-amber-400"; }
  else if (readiness >= 40) { readinessLabel = "WATCH"; readinessColor = "text-blue-400"; }
  return {
    pair, price: Math.round(price * 100) / 100, timestamp: Date.now(),
    bias: trend.direction ? { direction: trend.direction, strength: trend.strength } : null,
    stoch4h, stoch1h, stoch15m, volumeConfirmed: volConfirmed, trendlines: activeTrendlines,
    trendDirection: trend.direction, trendStrength: trend.strength,
    isPullback: pullback.pullbackActive, pullbackTier: pullback.tier,
    pullbackReason: pullback.reason, stochZone: pullback.stochZone,
    readiness, readinessLabel, readinessColor,
    adx: Math.round(adxVal * 10) / 10, trendStrengthLabel,
    trend: trend.direction ? `${trend.direction} ${trend.strength > 50 ? "STRONG" : "MEDIUM"}` : "NONE",
    regime: { direction: trend.direction, strength: trend.strength > 50 ? "STRONG" : "MEDIUM", confidence: trend.direction ? (trend.strength > 50 ? 75 : 50) : 0 },
    rsi: Math.round((rsiVal ?? 50) * 10) / 10,
    stochK: stoch4h.k, stochD: stoch4h.d, stoch1hK: stoch1h.k, stoch1hD: stoch1h.d,
    ema21: Math.round(ema21Price * 100) / 100, distToEMA21: Math.round(distToEMA21 * 10000) / 100,
    trend1h: t1h.direction ? { direction: t1h.direction, strength: t1h.strength } : null,
    trend4h: t4h.direction ? { direction: t4h.direction, strength: t4h.strength } : null,
    trend1d: t1d.direction ? { direction: t1d.direction, strength: t1d.strength } : null,
    trendStrengthCompat: { adx: adxVal, isStrong: adxVal >= 25 },
    phase4h, phase1h: phase4h, structure15m,
    recommendedAction: signalResult?.signal ? `${signalResult.signal.direction} ${signalResult.signal.entryType}` : null,
    entryTier: signalResult?.signal ? (signalResult.signal.entryType === "RETEST" ? "CONFIRMED_ENTRY" : "EARLY_ENTRY") : null,
    entryMode: signalResult?.signal ? (signalResult.signal.entryType === "EARLY" ? "PULLBACK" : "BREAKOUT") : null,
    positionSize: signalResult?.signal ? (signalResult.signal.positionSizePct ? (signalResult.signal.positionSizePct * 100).toFixed(0) + "%" : null) : null,
    signal: signalResult?.signal || null,
    summary: { status: signalResult?.signal ? "READY" : "WATCH", debug: signalResult?.debug || trend.debug || [] },
    activeTrade: null,
    debug: signalResult?.debug || trend.debug || [],
    ...signalResult?.market,
  };
}

function detectTrendCompat(candles: Candle[]) {
  if (candles.length < 25) return { direction: null as "LONG" | "SHORT" | null, strength: "WEAK" };
  const structure = analyzeStructure(candles);
  if (!structure.direction) {
    const closes = candles.map(c => c.close);
    const e8 = ema(closes, 8), e21 = ema(closes, 21);
    if (!e8.length || !e21.length) return { direction: null as "LONG" | "SHORT" | null, strength: "WEAK" };
    const direction = e8[e8.length - 1] > e21[e21.length - 1] ? "LONG" : "SHORT";
    return { direction, strength: "MEDIUM" as "STRONG" | "MEDIUM" | "WEAK" };
  }
  const strength = structure.strength >= 60 ? "STRONG" : structure.strength >= 30 ? "MEDIUM" : "WEAK";
  return { direction: structure.direction, strength };
}

export function shouldHoldCompat(
  signal: Signal,
  candles4h: Candle[],
  candles1h: Candle[],
  currentPrice: number
): HoldResult {
  return shouldHold(signal, candles4h, aggregateTo1D(candles4h), candles1h, currentPrice);
}

export async function generateSignalAsync(
  pair: string,
  candles1h: Candle[],
  candles4h: Candle[],
  candles15m: Candle[],
  activeSignals?: Signal[],
  currentPrice?: number
): Promise<SignalResult> {
  return generateSignal(pair, candles1h, candles4h, aggregateTo1D(candles4h), candles15m, activeSignals || [], currentPrice);
}

export function migrateV36ToV37(signal: Signal): TradeState {
  return {
    phase: "ENTRY", phaseEnteredAt: signal.timestamp,
    highestPrice: signal.entry, lowestPrice: signal.entry,
    entryPrice: signal.entry, lockedStop: null,
    profitLockLevel: 0, currentR: 0,
    entryTimestamp: signal.timestamp, lastDecisionTimestamp: Date.now(),
  };
}

export function updateTradeManagerCompat(signal: Signal, currentPrice: number): TradeState {
  const currentR = signal.direction === "LONG"
    ? (currentPrice - signal.entry) / (signal.entry - signal.stop)
    : (signal.entry - currentPrice) / (signal.stop - signal.entry);
  return {
    phase: currentR >= 2 ? "TREND" : currentR >= 1 ? "BUILDING" : "ENTRY",
    phaseEnteredAt: signal.timestamp,
    highestPrice: Math.max(signal.entry, currentPrice),
    lowestPrice: Math.min(signal.entry, currentPrice),
    entryPrice: signal.entry, lockedStop: null,
    profitLockLevel: 0, currentR,
    entryTimestamp: signal.timestamp, lastDecisionTimestamp: Date.now(),
  };
}

export function calculateTradeState(signal: Signal, currentPrice: number): TradeState {
  return updateTradeManagerCompat(signal, currentPrice);
}

export async function loadExits(): Promise<any[]> { return []; }
export function setRegimePersistence(): void {}
export function setExitPersistence(): void {}
export function setTelemetryPersistence(): void {}
export async function persistTelemetry(): Promise<void> {}
