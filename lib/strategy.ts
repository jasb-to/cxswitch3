// ============================================================
// CXSwitch v37 — Trend-Following Trendline Break
//
// Core: Trade WITH the dominant trend
// Bias: 1D trend = 4H trend (must agree)
// Pullback: 4H Stoch RSI extreme + cross (timing only)
// Setup: Trendline break aligned with bias
// Entry: 15m execution (Early > Breakout > Retest)
// Management: Lifecycle-based, trend-expansion focused
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
  exitReason?: string;
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

export const CURRENT_SIGNAL_VERSION = 37;

// ============================================================
// UTILITIES
// ============================================================

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

// ============================================================
// PIVOT DETECTION
// ============================================================

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

// ============================================================
// TRENDLINE CONSTRUCTION
// ============================================================

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

      // For trend-following:
      // LONG bias: look for descending resistance to break (slope <= 0)
      // SHORT bias: look for ascending support to break (slope >= 0)
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
          startIndex: p1.index,
          endIndex: p2.index,
          startPrice: p1.price,
          endPrice: p2.price,
          slope,
          type,
          touches,
          isValid: true,
          isBroken: false,
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
        line.isBroken = true;
        line.brokenAt = current.timestamp;
        line.brokenPrice = current.close;
        return { broken: true, line, breakIndex: currentIndex, breakPrice: current.close };
      }
    } else {
      if (prev.close >= linePrev && current.close < lineCurrent) {
        line.isBroken = true;
        line.brokenAt = current.timestamp;
        line.brokenPrice = current.close;
        return { broken: true, line, breakIndex: currentIndex, breakPrice: current.close };
      }
    }
  }

  return { broken: false };
}

// ============================================================
// MARKET STRUCTURE
// ============================================================

function analyzeStructure(candles: Candle[]): {
  direction: "LONG" | "SHORT" | null;
  strength: number;
} {
  if (candles.length < 20) return { direction: null, strength: 0 };

  const { highs, lows } = findPivots(candles, 3, 2);
  if (highs.length < 3 || lows.length < 3) {
    return { direction: null, strength: 0 };
  }

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

  if (bullishScore > bearishScore + 1) {
    return { direction: "LONG", strength: Math.min(100, bullishScore * 20) };
  }
  if (bearishScore > bullishScore + 1) {
    return { direction: "SHORT", strength: Math.min(100, bearishScore * 20) };
  }

  return { direction: null, strength: 0 };
}

// ============================================================
// TREND DETECTION (v37: Trend-Following, NOT Counter-Trend)
// ============================================================
// STEP 1: Determine dominant trend using 1D + 4H
// Bias valid ONLY when 1D and 4H agree
// ============================================================

function detectTrend(
  candles1d: Candle[],
  candles4h: Candle[]
): { direction: "LONG" | "SHORT" | null; strength: number; adx: number | null; debug: string[] } {
  const debug: string[] = [];

  const structure1d = analyzeStructure(candles1d);
  debug.push(`1D Structure: ${structure1d.direction || "NONE"} (strength: ${structure1d.strength})`);

  const structure4h = analyzeStructure(candles4h);
  debug.push(`4H Structure: ${structure4h.direction || "NONE"} (strength: ${structure4h.strength})`);

  const closes4h = candles4h.map(c => c.close);
  const e8 = ema(closes4h, 8);
  const e21 = ema(closes4h, 21);
  const e50 = ema(closes4h, 50);

  let emaTrend: "LONG" | "SHORT" | null = null;
  if (e8.length && e21.length && e50.length) {
    const c0 = closes4h[closes4h.length - 1];
    const e8_0 = e8[e8.length - 1];
    const e21_0 = e21[e21.length - 1];
    const e50_0 = e50[e50.length - 1];

    if (c0 > e8_0 && e8_0 > e21_0 && e21_0 > e50_0) emaTrend = "LONG";
    else if (c0 < e8_0 && e8_0 < e21_0 && e21_0 < e50_0) emaTrend = "SHORT";
    else if (e8_0 > e21_0) emaTrend = "LONG";
    else if (e8_0 < e21_0) emaTrend = "SHORT";
  }
  debug.push(`4H EMA Trend: ${emaTrend || "NONE"}`);

  const adxVal = adx(candles4h);
  debug.push(`4H ADX: ${adxVal !== null ? adxVal.toFixed(1) : "N/A"}`);

  // STEP 1: 1D and 4H must agree
  if (!structure1d.direction || !structure4h.direction) {
    debug.push(`TREND: UNCLEAR — missing structure data`);
    return { direction: null, strength: 0, adx: adxVal, debug };
  }

  if (structure1d.direction !== structure4h.direction) {
    debug.push(`TREND: NO TRADE — 1D(${structure1d.direction}) ≠ 4H(${structure4h.direction})`);
    return { direction: null, strength: 0, adx: adxVal, debug };
  }

  // Both agree — this is our trend direction
  const trendDirection = structure1d.direction;
  const trendStrength = Math.round((structure1d.strength + structure4h.strength) / 2);

  debug.push(`TREND: ${trendDirection} | 1D+4H aligned | Strength: ${trendStrength} | ADX: ${adxVal?.toFixed(1) || "N/A"}`);

  return { direction: trendDirection, strength: trendStrength, adx: adxVal, debug };
}

// ============================================================
// PULLBACK DETECTION (v37: Timing tool, NOT signal generator)
// ============================================================
// LONG: 4H Stoch RSI oversold (K < 35) + K crosses above D
// SHORT: 4H Stoch RSI overbought (K > 65) + K crosses below D
// Stoch is timing only — does NOT create signal by itself
// ============================================================

function checkPullback(
  trendDirection: "LONG" | "SHORT" | null,
  stoch4h: { k: number; d: number },
  prevStoch4h: { k: number; d: number }
): { pullbackActive: boolean; reason: string } {
  if (!trendDirection) {
    return { pullbackActive: false, reason: "No trend — no pullback check" };
  }

  if (trendDirection === "LONG") {
    // LONG trend: pullback = oversold bounce (K crosses above D from below)
    const wasOversold = prevStoch4h.k < 35;
    const crossUp = prevStoch4h.k <= prevStoch4h.d && stoch4h.k > stoch4h.d;

    if (wasOversold && crossUp) {
      return { pullbackActive: true, reason: `LONG pullback: 4H Stoch cross up from oversold (${stoch4h.k})` };
    }
    if (stoch4h.k < 35) {
      return { pullbackActive: false, reason: `LONG pullback forming: 4H Stoch oversold (${stoch4h.k}), waiting for cross` };
    }
    return { pullbackActive: false, reason: `LONG: no pullback — 4H Stoch ${stoch4h.k} (need <35 + cross up)` };
  }

  if (trendDirection === "SHORT") {
    // SHORT trend: pullback = overbought rejection (K crosses below D from above)
    const wasOverbought = prevStoch4h.k > 65;
    const crossDown = prevStoch4h.k >= prevStoch4h.d && stoch4h.k < stoch4h.d;

    if (wasOverbought && crossDown) {
      return { pullbackActive: true, reason: `SHORT pullback: 4H Stoch cross down from overbought (${stoch4h.k})` };
    }
    if (stoch4h.k > 65) {
      return { pullbackActive: false, reason: `SHORT pullback forming: 4H Stoch overbought (${stoch4h.k}), waiting for cross` };
    }
    return { pullbackActive: false, reason: `SHORT: no pullback — 4H Stoch ${stoch4h.k} (need >65 + cross down)` };
  }

  return { pullbackActive: false, reason: "Unknown trend direction" };
}

// ============================================================
// VOLUME CONFIRMATION
// ============================================================

function isVolumeConfirmed(candles: Candle[], lookback = 10): boolean {
  if (candles.length < lookback + 2) return false;
  const volumes = candles.map(c => c.volume);
  const avgVol = avg(volumes.slice(-lookback - 1, -1));
  const currentVol = volumes[volumes.length - 1];
  return currentVol > avgVol * 1.2;
}

// ============================================================
// ENTRY LOGIC — Trend-Following Trendline Break
// ============================================================
// STEP 1: Trend (1D = 4H)
// STEP 2: Pullback (4H Stoch timing)
// STEP 3: Trendline setup (aligned with trend)
// STEP 4: 15m execution
// Priority: Retest > Breakout > Early Entry
// ============================================================

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

  // Check for active trade on this pair
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

  // ─── STEP 1: TREND (1D + 4H must agree) ───
  const trend = detectTrend(candles1d, candles4h);
  debug.push(...trend.debug);

  if (!trend.direction) {
    debug.push("No valid trend — waiting for 1D/4H alignment");
    return { debug };
  }

  // ─── STEP 2: PULLBACK (4H Stoch timing) ───
  const closes4h = candles4h.map(c => c.close);
  const stoch4h = stochRsi(closes4h);
  const prevStoch4h = stochRsi(closes4h.slice(0, -1)); // previous candle

  debug.push(`4H Stoch: ${stoch4h.k}/${stoch4h.d}`);

  const pullback = checkPullback(trend.direction, stoch4h, prevStoch4h);
  debug.push(pullback.reason);

  // Pullback is a timing tool — we don't require it to be "active" right now,
  // but we do require that we're in a reasonable zone (not chasing)
  const inPullbackZone = trend.direction === "LONG" ? stoch4h.k < 50 : stoch4h.k > 50;

  if (!inPullbackZone) {
    debug.push(`Not in pullback zone — ${trend.direction} trend, 4H Stoch ${stoch4h.k} (need ${trend.direction === "LONG" ? "<50" : ">50"})`);
    return { debug };
  }

  // ─── STEP 3: TRENDLINE SETUP ───
  // LONG: look for descending resistance to break
  // SHORT: look for ascending support to break
  const pivots4h = findPivots(candles4h, 3, 2);

  let relevantLines: Trendline[] = [];
  let breakType: "RESISTANCE" | "SUPPORT";

  if (trend.direction === "LONG") {
    // LONG trend: descending resistance (pullback within uptrend)
    relevantLines = buildTrendlines(candles4h, pivots4h.highs, "RESISTANCE", 2, 0.3);
    breakType = "RESISTANCE";
    debug.push(`Trendlines: ${relevantLines.length} descending resistance (LONG setup)`);
  } else {
    // SHORT trend: ascending support (pullback within downtrend)
    relevantLines = buildTrendlines(candles4h, pivots4h.lows, "SUPPORT", 2, 0.3);
    breakType = "SUPPORT";
    debug.push(`Trendlines: ${relevantLines.length} ascending support (SHORT setup)`);
  }

  // ─── STEP 4: 15m EXECUTION ───
  const closes15m = candles15m.map(c => c.close);
  const stoch15m = stochRsi(closes15m);
  const prevStoch15m = stochRsi(closes15m.slice(0, -1));

  debug.push(`15M Stoch: ${stoch15m.k}/${stoch15m.d}`);

  // Check 4H trendline break
  const breakEvent = checkTrendlineBreak(candles4h, relevantLines, breakType);

  // Volume check
  const volConfirmed = isVolumeConfirmed(candles4h);
  debug.push(`Volume: ${volConfirmed ? "CONFIRMED (+20%)" : "weak"}`);

  let entryType: "EARLY" | "BREAKOUT" | "RETEST" | null = null;
  let confidence = 50;
  let trendlinePrice = 0;

  // ─── EARLY ENTRY (15m Stoch cross in trend direction, before 4H break) ───
  // Priority: Lowest, but valid for participation
  if (trend.direction === "LONG") {
    const stoch15mCrossUp = prevStoch15m.k <= prevStoch15m.d && stoch15m.k > stoch15m.d;
    const stoch15mOversold = stoch15m.k < 30;

    if (stoch15mCrossUp && stoch15mOversold && !breakEvent.broken) {
      entryType = "EARLY";
      confidence = 65;
      if (volConfirmed) confidence += 5;
      trendlinePrice = relevantLines[0] ? getTrendlinePrice(relevantLines[0], candles4h.length - 1) : price * 1.02;
      debug.push(`EARLY LONG: 15m Stoch cross up from oversold (${stoch15m.k}), awaiting 4H break`);
    }
  } else {
    const stoch15mCrossDown = prevStoch15m.k >= prevStoch15m.d && stoch15m.k < stoch15m.d;
    const stoch15mOverbought = stoch15m.k > 70;

    if (stoch15mCrossDown && stoch15mOverbought && !breakEvent.broken) {
      entryType = "EARLY";
      confidence = 65;
      if (volConfirmed) confidence += 5;
      trendlinePrice = relevantLines[0] ? getTrendlinePrice(relevantLines[0], candles4h.length - 1) : price * 0.98;
      debug.push(`EARLY SHORT: 15m Stoch cross down from overbought (${stoch15m.k}), awaiting 4H break`);
    }
  }

  // ─── BREAKOUT ENTRY (4H trendline break + 15m confirms) ───
  if (!entryType && breakEvent.broken && breakEvent.line) {
    const stoch15mAligns = trend.direction === "LONG"
      ? stoch15m.k > stoch15m.d
      : stoch15m.k < stoch15m.d;

    if (stoch15mAligns) {
      entryType = "BREAKOUT";
      confidence = 80;
      if (volConfirmed) confidence += 5;
      trendlinePrice = getTrendlinePrice(breakEvent.line, candles4h.length - 1);
      debug.push(`BREAKOUT ${trend.direction}: 4H ${breakEvent.line.type} broken, 15m confirms`);
    } else {
      debug.push(`4H break detected but 15m not aligned — waiting`);
    }
  }

  // ─── RETEST ENTRY (best entry — price back at broken trendline + 15m confirms) ───
  if (!entryType && breakEvent.broken && breakEvent.line) {
    const linePrice = getTrendlinePrice(breakEvent.line, candles4h.length - 1);
    const distToLine = Math.abs(price - linePrice) / linePrice;
    const stoch15mAligns = trend.direction === "LONG"
      ? stoch15m.k > stoch15m.d && stoch15m.k < 70
      : stoch15m.k < stoch15m.d && stoch15m.k > 30;

    if (distToLine < 0.008 && stoch15mAligns) {
      entryType = "RETEST";
      confidence = 85;
      if (volConfirmed) confidence += 5;
      trendlinePrice = linePrice;
      debug.push(`RETEST ${trend.direction}: Price at broken trendline, 15m confirms`);
    }
  }

  if (!entryType) {
    debug.push("No entry setup — waiting for 15m signal or 4H trendline break");
    return { debug };
  }

  // ─── CALCULATE STOP AND TARGET ───
  const swingLow = Math.min(...candles4h.slice(-20).map(c => c.low));
  const swingHigh = Math.max(...candles4h.slice(-20).map(c => c.high));
  const atr4h = atr(candles4h, 14);

  let entry = price;
  let stop: number;
  let target: number;

  if (trend.direction === "LONG") {
    // Stop below recent swing low or ATR-based
    stop = Math.min(swingLow * 0.998, entry - atr4h * 1.5);
    // Target: measured move or ATR-based expansion
    const breakToEntry = entry - trendlinePrice;
    target = Math.max(entry + breakToEntry * 2, entry + atr4h * 3, swingHigh);
  } else {
    stop = Math.max(swingHigh * 1.002, entry + atr4h * 1.5);
    const breakToEntry = trendlinePrice - entry;
    target = Math.min(entry - breakToEntry * 2, entry - atr4h * 3, swingLow);
  }

  const risk = Math.abs(entry - stop);
  const reward = Math.abs(target - entry);
  const rr = risk > 0 ? reward / risk : 0;

  if (rr < 1.0) {
    debug.push(`R:R ${rr.toFixed(2)} < 1.0 — skip`);
    return { debug };
  }

  // Confidence boosters
  confidence += Math.min(10, trend.strength / 10);
  if (breakEvent.broken) confidence += 5;
  if (trend.adx !== null && trend.adx >= 25) confidence += 5;
  if (trend.adx !== null && trend.adx >= 30) confidence += 5;
  confidence = Math.min(95, Math.round(confidence));

  // Position sizing
  let positionSizePct = 0.04; // 4% default
  if (entryType === "RETEST") positionSizePct = 0.06; // 6% on best entry
  else if (entryType === "BREAKOUT") positionSizePct = 0.05; // 5% on confirmation
  else if (entryType === "EARLY") positionSizePct = 0.03; // 3% on early

  const signal: Signal = {
    id: `${pair}_${now}`,
    pair,
    direction: trend.direction,
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
    entryTier: entryType === "EARLY" ? "EARLY_ENTRY" : "CONFIRMED_ENTRY",
    entryMode: entryType === "EARLY" ? "PULLBACK" : entryType === "RETEST" ? "RETEST" : "BREAKOUT",
    positionSizePct,
    regimeDirection: trend.direction,
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

  debug.push(`SIGNAL: ${entryType} ${trend.direction} ${pair} @ ${entry.toFixed(2)}, SL ${stop.toFixed(2)}, TP ${target.toFixed(2)}, RR ${rr.toFixed(2)}, Conf ${confidence}%, ADX ${trend.adx?.toFixed(1) || "N/A"}${volConfirmed ? ", VOL+" : ""}`);

  return { signal, debug };
}

// ============================================================
// EXIT LOGIC — Trend-Following with Profit Protection
// ============================================================
// Primary exits:
// 1. Stop Loss
// 2. Target Hit
// 3. Persistent 4H structure failure
// 4. 1D regime flip
// 5. Profit protection trailing stop
//
// A trade should survive normal pullbacks.
// Goal: capturing trend expansion, not scalping.
// ============================================================

export function shouldHold(
  signal: Signal,
  candles4h: Candle[],
  candles1d: Candle[],
  candles1h: Candle[],
  currentPrice: number
): HoldResult {
  const now = Date.now();
  const ts = signal.tradeState || {
    phase: "TREND",
    phaseEnteredAt: signal.timestamp,
    highestPrice: signal.entry,
    lowestPrice: signal.entry,
    entryPrice: signal.entry,
    lockedStop: null,
    profitLockLevel: 0,
    currentR: 0,
    entryTimestamp: signal.timestamp,
    lastDecisionTimestamp: signal.timestamp,
  };

  // Update highest/lowest tracking
  const newHighest = Math.max(ts.highestPrice, currentPrice);
  const newLowest = Math.min(ts.lowestPrice, currentPrice);
  const currentR = signal.direction === "LONG"
    ? (currentPrice - signal.entry) / (signal.entry - signal.stop)
    : (signal.entry - currentPrice) / (signal.stop - signal.entry);

  const updatedState: TradeState = {
    ...ts,
    highestPrice: newHighest,
    lowestPrice: newLowest,
    currentR,
    lastDecisionTimestamp: now,
  };

  // 1. Hard stop
  if (signal.direction === "LONG" && currentPrice <= signal.stop) {
    return { shouldHold: false, reason: "stop_loss", updatedTradeState: { ...updatedState, phase: "EXIT" } };
  }
  if (signal.direction === "SHORT" && currentPrice >= signal.stop) {
    return { shouldHold: false, reason: "stop_loss", updatedTradeState: { ...updatedState, phase: "EXIT" } };
  }

  // 2. Hard target
  if (signal.direction === "LONG" && currentPrice >= signal.target) {
    return { shouldHold: false, reason: "target_hit", updatedTradeState: { ...updatedState, phase: "EXIT" } };
  }
  if (signal.direction === "SHORT" && currentPrice <= signal.target) {
    return { shouldHold: false, reason: "target_hit", updatedTradeState: { ...updatedState, phase: "EXIT" } };
  }

  // 3. 1D Regime Flip — higher timeframe trend reversal
  if (candles1d && candles1d.length >= 25) {
    const structure1d = analyzeStructure(candles1d);
    if (structure1d.direction && structure1d.direction !== signal.direction) {
      // Only exit on regime flip if we're at least 2 candles in and not deep in profit
      const hoursInTrade = (now - signal.timestamp) / (60 * 60 * 1000);
      if (hoursInTrade > 8 && currentR < 2) {
        return { shouldHold: false, reason: "1d_regime_flip", updatedTradeState: { ...updatedState, phase: "EXIT" } };
      }
    }
  }

  // 4. Persistent 4H structure failure
  if (candles4h && candles4h.length >= 50) {
    const structure4h = analyzeStructure(candles4h);
    const closes4h = candles4h.map(c => c.close);
    const e21 = ema(closes4h, 21);

    if (structure4h.direction && structure4h.direction !== signal.direction) {
      // Structure has flipped against us
      const hoursInTrade = (now - signal.timestamp) / (60 * 60 * 1000);

      if (hoursInTrade > 4) {
        // Check if price is below EMA21 (for LONG) or above EMA21 (for SHORT)
        if (e21.length > 0) {
          const ema21Price = e21[e21.length - 1];
          if (signal.direction === "LONG" && currentPrice < ema21Price * 0.995) {
            return { shouldHold: false, reason: "4h_structure_failure", updatedTradeState: { ...updatedState, phase: "EXIT" } };
          }
          if (signal.direction === "SHORT" && currentPrice > ema21Price * 1.005) {
            return { shouldHold: false, reason: "4h_structure_failure", updatedTradeState: { ...updatedState, phase: "EXIT" } };
          }
        }
      }
    }
  }

  // 5. Profit Protection Trailing Stop
  // Move stop to breakeven at +1R
  // Trail at 50% of gains after +2R
  // Trail at 70% of gains after +3R
  let newLockedStop = ts.lockedStop;
  let newProfitLockLevel = ts.profitLockLevel;
  let newPhase: TradeLifecyclePhase = ts.phase;

  if (currentR >= 3 && newProfitLockLevel < 3) {
    // Lock 70% of gains
    const gain = Math.abs(currentPrice - signal.entry);
    const lockPrice = signal.direction === "LONG"
      ? signal.entry + gain * 0.3
      : signal.entry - gain * 0.3;
    newLockedStop = Math.max(ts.lockedStop || 0, lockPrice);
    newProfitLockLevel = 3;
    newPhase = "PROFIT_PROTECTION";
  } else if (currentR >= 2 && newProfitLockLevel < 2) {
    // Lock 50% of gains
    const gain = Math.abs(currentPrice - signal.entry);
    const lockPrice = signal.direction === "LONG"
      ? signal.entry + gain * 0.5
      : signal.entry - gain * 0.5;
    newLockedStop = Math.max(ts.lockedStop || 0, lockPrice);
    newProfitLockLevel = 2;
    newPhase = "PROFIT_PROTECTION";
  } else if (currentR >= 1 && newProfitLockLevel < 1) {
    // Move to breakeven
    newLockedStop = signal.entry;
    newProfitLockLevel = 1;
    newPhase = "BUILDING";
  }

  // Check if profit protection stop hit
  if (newLockedStop) {
    if (signal.direction === "LONG" && currentPrice <= newLockedStop) {
      return { shouldHold: false, reason: `profit_protection_${newProfitLockLevel}R`, updatedTradeState: { ...updatedState, phase: "EXIT", lockedStop: newLockedStop, profitLockLevel: newProfitLockLevel } };
    }
    if (signal.direction === "SHORT" && currentPrice >= newLockedStop) {
      return { shouldHold: false, reason: `profit_protection_${newProfitLockLevel}R`, updatedTradeState: { ...updatedState, phase: "EXIT", lockedStop: newLockedStop, profitLockLevel: newProfitLockLevel } };
    }
  }

  // Update phase based on R multiple
  if (currentR >= 2 && newPhase === "BUILDING") newPhase = "TREND";
  if (currentR >= 1 && newPhase === "ENTRY") newPhase = "BUILDING";

  const finalState: TradeState = {
    ...updatedState,
    phase: newPhase,
    lockedStop: newLockedStop,
    profitLockLevel: newProfitLockLevel,
  };

  return { shouldHold: true, reason: `holding_${newPhase.toLowerCase()}_R${currentR.toFixed(1)}`, updatedTradeState: finalState };
}

// ============================================================
// HELPERS
// ============================================================

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
        if (!check.valid) {
          exited.push({ signal, reason: check.reason });
          continue;
        }
      }
      active.push(signal);
      continue;
    }
    if (now - signal.timestamp < EXITED_TTL_MS) active.push(signal);
  }
  return { active, exited };
}

// ============================================================
// MARKET SNAPSHOT
// ============================================================

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

  // v37: Trend detection (not counter-trend bias)
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
    .map(l => ({
      type: l.type,
      startPrice: l.startPrice,
      endPrice: l.endPrice,
      touches: l.touches,
      currentPrice: getTrendlinePrice(l, candles4h.length - 1),
    }));

  // Check breaks for readiness
  const longBreak = trend.direction === "LONG"
    ? checkTrendlineBreak(candles4h, resistanceLines, "RESISTANCE")
    : { broken: false };
  const shortBreak = trend.direction === "SHORT"
    ? checkTrendlineBreak(candles4h, supportLines, "SUPPORT")
    : { broken: false };

  // Pullback status
  const closes4h = candles4h.map(c => c.close);
  const prevStoch4h = stochRsi(closes4h.slice(0, -1));
  const pullback = trend.direction ? checkPullback(trend.direction, stoch4h, prevStoch4h) : { pullbackActive: false, reason: "No trend" };

  // v37 backward compat fields
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
  if (trend.direction === "LONG") {
    if (stoch4h.k > 65) phase4h = "EXPANSION";
    else if (stoch4h.k < 35) phase4h = "PULLBACK";
    else phase4h = "BUILDING";
  } else if (trend.direction === "SHORT") {
    if (stoch4h.k < 35) phase4h = "EXPANSION";
    else if (stoch4h.k > 65) phase4h = "PULLBACK";
    else phase4h = "BUILDING";
  }

  let structure15m = "Neutral";
  if (candles15m.length >= 20) {
    const t15m = detectTrendCompat(candles15m);
    if (t15m.direction === trend.direction) {
      structure15m = t15m.strength === "STRONG" ? "Breakout" : "Building";
    } else if (t15m.direction && t15m.direction !== trend.direction) {
      structure15m = "Pullback";
    }
  }

  // Readiness calculation (v37: trend-following)
  let readiness = 0;
  if (trend.direction) readiness += 25; // Valid trend
  if (trend.strength >= 50) readiness += 15;
  if (pullback.pullbackActive) readiness += 25; // Pullback timing
  else if (stoch4h.k < 50 && trend.direction === "LONG") readiness += 10; // In pullback zone
  else if (stoch4h.k > 50 && trend.direction === "SHORT") readiness += 10;
  if (longBreak.broken || shortBreak.broken) readiness += 20; // Trendline break
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
    pair,
    price: Math.round(price * 100) / 100,
    timestamp: Date.now(),
    // v37 fields
    bias: trend.direction ? { direction: trend.direction, strength: trend.strength } : null,
    stoch4h,
    stoch1h,
    stoch15m,
    volumeConfirmed: volConfirmed,
    trendlines: activeTrendlines,
    // Trend-following info
    trendDirection: trend.direction,
    trendStrength: trend.strength,
    isPullback: pullback.pullbackActive,
    pullbackReason: pullback.reason,
    readiness,
    readinessLabel,
    readinessColor,
    adx: Math.round(adxVal * 10) / 10,
    trendStrengthLabel,
    // Backward compat
    trend: trend.direction ? `${trend.direction} ${trend.strength > 50 ? "STRONG" : "MEDIUM"}` : "NONE",
    regime: {
      direction: trend.direction,
      strength: trend.strength > 50 ? "STRONG" : "MEDIUM",
      confidence: trend.direction ? (trend.strength > 50 ? 75 : 50) : 0,
    },
    rsi: Math.round((rsiVal ?? 50) * 10) / 10,
    stochK: stoch4h.k,
    stochD: stoch4h.d,
    stoch1hK: stoch1h.k,
    stoch1hD: stoch1h.d,
    ema21: Math.round(ema21Price * 100) / 100,
    distToEMA21: Math.round(distToEMA21 * 10000) / 100,
    trend1h: t1h.direction ? { direction: t1h.direction, strength: t1h.strength } : null,
    trend4h: t4h.direction ? { direction: t4h.direction, strength: t4h.strength } : null,
    trend1d: t1d.direction ? { direction: t1d.direction, strength: t1d.strength } : null,
    trendStrengthCompat: { adx: adxVal, isStrong: adxVal >= 25 },
    phase4h,
    phase1h: phase4h,
    structure15m,
    recommendedAction: signalResult?.signal ? `${signalResult.signal.direction} ${signalResult.signal.entryType}` : null,
    entryTier: signalResult?.signal ? (signalResult.signal.entryType === "RETEST" ? "CONFIRMED_ENTRY" : "EARLY_ENTRY") : null,
    entryMode: signalResult?.signal ? (signalResult.signal.entryType === "EARLY" ? "PULLBACK" : "BREAKOUT") : null,
    positionSize: signalResult?.signal ? (signalResult.signal.entryType === "RETEST" ? "FULL" : "STARTER") : null,
    signal: signalResult?.signal || null,
    summary: {
      status: signalResult?.signal ? "READY" : "WATCH",
      debug: signalResult?.debug || trend.debug || [],
    },
    activeTrade: null,
    debug: signalResult?.debug || trend.debug || [],
    ...signalResult?.market,
  };
}

// ============================================================
// TREND DETECTION COMPAT (helper for snapshot)
// ============================================================

function detectTrendCompat(candles: Candle[]) {
  if (candles.length < 25) return { direction: null as "LONG" | "SHORT" | null, strength: "WEAK" };
  const closes = candles.map(c => c.close);
  const e8 = ema(closes, 8), e21 = ema(closes, 21);
  if (!e8.length || !e21.length) return { direction: null as "LONG" | "SHORT" | null, strength: "WEAK" };
  const direction = e8[e8.length - 1] > e21[e21.length - 1] ? "LONG" : "SHORT";
  const highs = candles.slice(-20).map(c => c.high), lows = candles.slice(-20).map(c => c.low);
  const hh = highs[highs.length - 1] > Math.max(...highs.slice(0, -1));
  const ll = lows[lows.length - 1] < Math.min(...lows.slice(0, -1));
  const strength = (direction === "LONG" && hh) || (direction === "SHORT" && ll) ? "STRONG" : "MEDIUM";
  return { direction, strength };
}

// ============================================================
// COMPAT / LEGACY
// ============================================================

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
    phase: "ENTRY",
    phaseEnteredAt: signal.timestamp,
    highestPrice: signal.entry,
    lowestPrice: signal.entry,
    entryPrice: signal.entry,
    lockedStop: null,
    profitLockLevel: 0,
    currentR: 0,
    entryTimestamp: signal.timestamp,
    lastDecisionTimestamp: Date.now(),
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
    entryPrice: signal.entry,
    lockedStop: null,
    profitLockLevel: 0,
    currentR,
    entryTimestamp: signal.timestamp,
    lastDecisionTimestamp: Date.now(),
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
