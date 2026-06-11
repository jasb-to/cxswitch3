// lib/strategy.ts — v8
// Key fixes: Remove 1H hard block + relaxed break detection + 30min cooldown + soft momentum filters
// ============================================================

export type Structure = "UPTREND" | "DOWNTREND" | "RANGE";
export type Direction = "LONG" | "SHORT";
export type SignalType = "PRIMARY" | "CHEEKY" | "WAIT";

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface MarketData {
  pair: string;
  price: number;
  structure: Structure;
  adx: number;
  rsi: number;
  stochK: number;
  stochD: number;
}

export interface Signal extends MarketData {
  direction: Direction;
  type: SignalType;
  confidence: number;
  entry: number;
  stop: number;
  target: number;
  rr: number;
  reason: string;
  timestamp: number;
  expectedMove: number;
  candles1h: Candle[];
  candles4h: Candle[];
}

// ─── INTERNAL TYPES ───

interface Trendline {
  slope: number;
  intercept: number;
  startIdx: number;
  endIdx: number;
  touches: number[];
  touchTypes: ("wick" | "body" | "close")[];
  isSupport: boolean;
  strength: number;
  lastTouchIdx: number;
  span: number;
}

interface SwingPoint {
  idx: number;
  price: number;
  type: "high" | "low";
}

interface DebugInfo {
  pair: string;
  price: number;
  structure4h: Structure;
  structure1h: Structure;
  adx4h: string;
  rsi1h: string;
  rsi4h: string;
  stochK1h: string;
  stochD1h: string;
  stochK4h: string;
  stochD4h: string;
  chandelierLong: string;
  chandelierShort: string;
  chandelierSlope: string;
  trendlinesFound: { resistance: number; support: number; freshLines: number };
  blocks: string[];
  linesChecked: number;
  breaksDetected: { longSupport: number; longResistance: number; shortSupport: number; shortResistance: number };
  topLines: { support: string; resistance: string };
  softFilters: string[];
}

// ============================================================
// SWING DETECTION
// ============================================================

function swingHighs(candles: Candle[], lookback = 3): SwingPoint[] {
  const highs: SwingPoint[] = [];
  for (let i = lookback; i < candles.length - lookback; i++) {
    const c = candles[i];
    let isHigh = true;
    for (let j = 1; j <= lookback; j++) {
      if (candles[i - j].high >= c.high || candles[i + j].high >= c.high) {
        isHigh = false;
        break;
      }
    }
    if (isHigh) highs.push({ idx: i, price: c.high, type: "high" });
  }
  return highs;
}

function swingLows(candles: Candle[], lookback = 3): SwingPoint[] {
  const lows: SwingPoint[] = [];
  for (let i = lookback; i < candles.length - lookback; i++) {
    const c = candles[i];
    let isLow = true;
    for (let j = 1; j <= lookback; j++) {
      if (candles[i - j].low <= c.low || candles[i + j].low <= c.low) {
        isLow = false;
        break;
      }
    }
    if (isLow) lows.push({ idx: i, price: c.low, type: "low" });
  }
  return lows;
}

// ============================================================
// LINEAR REGRESSION
// ============================================================

function linearRegression(points: { x: number; y: number }[]) {
  const n = points.length;
  if (n < 2) return { slope: 0, intercept: 0, r2: 0 };
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
  for (const p of points) {
    sumX += p.x;
    sumY += p.y;
    sumXY += p.x * p.y;
    sumX2 += p.x * p.x;
  }
  const denom = n * sumX2 - sumX * sumX;
  if (Math.abs(denom) < 1e-10) return { slope: 0, intercept: sumY / n, r2: 0 };
  const slope = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;

  const yMean = sumY / n;
  let ssTot = 0, ssRes = 0;
  for (const p of points) {
    const yPred = slope * p.x + intercept;
    ssTot += Math.pow(p.y - yMean, 2);
    ssRes += Math.pow(p.y - yPred, 2);
  }
  const r2 = ssTot > 0 ? 1 - ssRes / ssTot : 0;

  return { slope, intercept, r2 };
}

// ============================================================
// TRENDLINE DETECTION v8
// ============================================================

function findTrendlines(candles: Candle[], swings: SwingPoint[], isSupport: boolean): Trendline[] {
  const lines: Trendline[] = [];
  const maxAge = 50;
  const tolerance = 0.004;

  for (let i = 0; i < swings.length; i++) {
    for (let j = i + 1; j < swings.length; j++) {
      const p1 = swings[i];
      const p2 = swings[j];
      if (p2.idx - p1.idx < 5) continue;
      if (p2.idx - p1.idx > maxAge) break;

      const points = [{ x: p1.idx, y: p1.price }, { x: p2.idx, y: p2.price }];
      const { slope, intercept, r2 } = linearRegression(points);
      if (r2 < 0.70) continue;

      const touches: number[] = [p1.idx, p2.idx];
      const touchTypes: ("wick" | "body" | "close")[] = ["wick", "wick"];

      for (let k = p1.idx + 1; k < p2.idx; k++) {
        const expected = slope * k + intercept;
        const candle = candles[k];

        const wick = isSupport ? candle.low : candle.high;
        const wickDiff = Math.abs(wick - expected) / expected;

        const bodyEdge = isSupport 
          ? Math.min(candle.open, candle.close) 
          : Math.max(candle.open, candle.close);
        const bodyDiff = Math.abs(bodyEdge - expected) / expected;

        const closeDiff = Math.abs(candle.close - expected) / expected;

        if (wickDiff < tolerance) {
          touches.push(k);
          touchTypes.push("wick");
        } else if (bodyDiff < tolerance) {
          touches.push(k);
          touchTypes.push("body");
        } else if (closeDiff < tolerance * 0.5) {
          touches.push(k);
          touchTypes.push("close");
        }
      }

      const wickCount = touchTypes.filter(t => t === "wick").length;
      const span = p2.idx - p1.idx;
      const lastTouchIdx = Math.max(...touches);
      const trueRecency = candles.length - 1 - lastTouchIdx;

      const recencyScore = trueRecency <= 2 ? 40 : trueRecency <= 5 ? 25 : trueRecency <= 10 ? 10 : 0;
      const spanScore = span >= 8 && span <= 30 ? 20 : span > 30 ? 10 : span < 8 ? 5 : 0;
      const touchScore = touches.length >= 3 ? 20 : touches.length === 2 ? 10 : touches.length * 5;
      const wickBonus = wickCount >= 2 ? 10 : 0;

      const strength = Math.min(100,
        recencyScore + spanScore + touchScore + wickBonus + (r2 * 8)
      );

      const isFresh = trueRecency <= 10;
      const hasQuality = touches.length >= 2 && span >= 5 && isFresh;

      if (hasQuality) {
        lines.push({ 
          slope, intercept, startIdx: p1.idx, endIdx: p2.idx, 
          touches, touchTypes, isSupport, strength, lastTouchIdx, span 
        });
      }
    }
  }

  const unique: Trendline[] = [];
  for (const line of lines) {
    const isDup = unique.some((u) => {
      const sameType = u.isSupport === line.isSupport;
      const sameSlope = Math.abs(u.slope - line.slope) < 0.002;
      const sameIntercept = Math.abs(u.intercept - line.intercept) / line.intercept < 0.02;
      return sameType && sameSlope && sameIntercept;
    });
    if (!isDup) unique.push(line);
  }

  return unique.sort((a, b) => b.strength - a.strength);
}

function isTrendlineExpired(line: Trendline, currentIdx: number): boolean {
  return currentIdx - line.lastTouchIdx > 12;
}

// Get fresh trendlines — considers recent breaks, not just recent touches
function getFreshTrendlines(lines: Trendline[], candles: Candle[], maxLines: number = 6): Trendline[] {
  const currentIdx = candles.length - 1;
  const currentPrice = candles[currentIdx].close;
  const atr = calcATR(candles, 14);

  return lines
    .filter(line => {
      const linePrice = line.slope * currentIdx + line.intercept;
      const distance = Math.abs(currentPrice - linePrice);
      const distancePct = distance / currentPrice;

      // Check if recently broken (within last 4 candles = 16h)
      let recentlyBroken = false;
      let breakRecency = 999;

      if (line.isSupport && currentPrice > linePrice) {
        for (let i = currentIdx; i > Math.max(1, currentIdx - 4); i--) {
          const prevLinePrice = line.slope * (i-1) + line.intercept;
          const currLinePrice = line.slope * i + line.intercept;
          if (candles[i-1].close < prevLinePrice && candles[i].close > currLinePrice) {
            recentlyBroken = true;
            breakRecency = currentIdx - i;
            break;
          }
        }
      } else if (!line.isSupport && currentPrice < linePrice) {
        for (let i = currentIdx; i > Math.max(1, currentIdx - 4); i--) {
          const prevLinePrice = line.slope * (i-1) + line.intercept;
          const currLinePrice = line.slope * i + line.intercept;
          if (candles[i-1].close > prevLinePrice && candles[i].close < currLinePrice) {
            recentlyBroken = true;
            breakRecency = currentIdx - i;
            break;
          }
        }
      }

      const nearLine = distance < (3 * atr) || distancePct < 0.03;
      const lastTouchRecent = currentIdx - line.lastTouchIdx <= 8;
      const recentlyCrossed = recentlyBroken && breakRecency <= 3;

      return nearLine || lastTouchRecent || recentlyCrossed;
    })
    .slice(0, maxLines);
}

// ============================================================
// STRUCTURE
// ============================================================

function getStructure(candles: Candle[]): Structure {
  const highs = swingHighs(candles, 5);
  const lows = swingLows(candles, 5);

  if (highs.length < 2 || lows.length < 2) return "RANGE";

  const recentHighs = highs.slice(-3);
  const recentLows = lows.slice(-3);

  const higherHighs = recentHighs.every((h, i) => i === 0 ? true : h.price > recentHighs[i - 1].price);
  const higherLows = recentLows.every((l, i) => i === 0 ? true : l.price > recentLows[i - 1].price);
  const lowerHighs = recentHighs.every((h, i) => i === 0 ? true : h.price < recentHighs[i - 1].price);
  const lowerLows = recentLows.every((l, i) => i === 0 ? true : l.price < recentLows[i - 1].price);

  if (higherHighs && higherLows) return "UPTREND";
  if (lowerHighs && lowerLows) return "DOWNTREND";

  const recent = candles.slice(-20);
  if (recent.length >= 10) {
    const firstHalf = recent.slice(0, 10).reduce((a, c) => a + c.close, 0) / 10;
    const secondHalf = recent.slice(-10).reduce((a, c) => a + c.close, 0) / 10;
    const slope = (secondHalf - firstHalf) / firstHalf;

    if (slope > 0.015) return "UPTREND";
    if (slope < -0.015) return "DOWNTREND";
  }

  return "RANGE";
}

// ============================================================
// INDICATORS
// ============================================================

function calcADX(candles: Candle[], period = 14): number {
  if (candles.length < period * 2 + 1) return 0;

  const tr: number[] = [];
  const plusDM: number[] = [];
  const minusDM: number[] = [];

  for (let i = 1; i < candles.length; i++) {
    const prev = candles[i - 1];
    const curr = candles[i];
    tr.push(Math.max(curr.high - curr.low, Math.abs(curr.high - prev.close), Math.abs(curr.low - prev.close)));
    plusDM.push(curr.high - prev.high > prev.low - curr.low ? Math.max(curr.high - prev.high, 0) : 0);
    minusDM.push(prev.low - curr.low > curr.high - prev.high ? Math.max(prev.low - curr.low, 0) : 0);
  }

  let atr = tr.slice(0, period).reduce((a, b) => a + b, 0);
  let plusDI_sum = plusDM.slice(0, period).reduce((a, b) => a + b, 0);
  let minusDI_sum = minusDM.slice(0, period).reduce((a, b) => a + b, 0);

  let dxValues: number[] = [];

  for (let i = period; i < tr.length; i++) {
    atr = atr - (atr / period) + tr[i];
    plusDI_sum = plusDI_sum - (plusDI_sum / period) + plusDM[i];
    minusDI_sum = minusDI_sum - (minusDI_sum / period) + minusDM[i];

    const plusDI = 100 * (plusDI_sum / atr);
    const minusDI = 100 * (minusDI_sum / atr);
    const dx = (Math.abs(plusDI - minusDI) / (plusDI + minusDI)) * 100;
    dxValues.push(dx);
  }

  if (dxValues.length < period) return 0;

  let adx = dxValues.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < dxValues.length; i++) {
    adx = ((adx * (period - 1)) + dxValues[i]) / period;
  }

  return adx;
}

function calcRSI(candles: Candle[], period = 14): number {
  if (candles.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const change = candles[i].close - candles[i - 1].close;
    if (change > 0) gains += change;
    else losses += Math.abs(change);
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

function calcStochastic(candles: Candle[], kPeriod = 14, dPeriod = 3): { k: number; d: number } {
  if (candles.length < kPeriod + dPeriod) return { k: 50, d: 50 };

  const kValues: number[] = [];
  for (let i = candles.length - kPeriod - dPeriod + 1; i <= candles.length - kPeriod; i++) {
    const slice = candles.slice(i, i + kPeriod);
    const lowest = Math.min(...slice.map(c => c.low));
    const highest = Math.max(...slice.map(c => c.high));
    const current = candles[i + kPeriod - 1].close;
    const k = highest === lowest ? 50 : ((current - lowest) / (highest - lowest)) * 100;
    kValues.push(k);
  }

  const k = kValues[kValues.length - 1];
  const d = kValues.reduce((a, b) => a + b, 0) / kValues.length;
  return { k, d };
}

function calcATR(candles: Candle[], period = 14): number {
  if (candles.length < period + 1) return 0;
  let sum = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const prev = candles[i - 1];
    const curr = candles[i];
    const tr = Math.max(curr.high - curr.low, Math.abs(curr.high - prev.close), Math.abs(curr.low - prev.close));
    sum += tr;
  }
  return sum / period;
}

// ─── CHANDELIER EXIT ───
function calcChandelierExit(candles: Candle[], period = 22, atrMult = 3): { long: number; short: number; slope: number } {
  const atr = calcATR(candles, period);
  const highest = Math.max(...candles.slice(-period).map(c => c.high));
  const lowest = Math.min(...candles.slice(-period).map(c => c.low));
  const longExit = highest - atr * atrMult;
  const shortExit = lowest + atr * atrMult;

  const recent = candles.slice(-10);
  const xMean = (recent.length - 1) / 2;
  let num = 0, den = 0;
  for (let i = 0; i < recent.length; i++) {
    num += (i - xMean) * recent[i].close;
    den += Math.pow(i - xMean, 2);
  }
  const slope = den > 0 ? num / den : 0;

  return { long: longExit, short: shortExit, slope };
}

// ─── STOPS & TARGETS ───
function findStopAndTarget(candles: Candle[], direction: Direction, entry: number, structure: Structure, adx: number) {
  const atr = calcATR(candles, 14);
  let stop: number, target: number;

  const isChop = structure === "RANGE" && adx < 25;
  const targetMult = isChop ? 1.5 : 2.5;
  const stopMult = isChop ? 2.0 : 2.5;

  if (direction === "LONG") {
    const lows = swingLows(candles, 3);
    const recentLow = lows.length > 0 ? lows[lows.length - 1].price : entry - atr * stopMult;
    stop = Math.min(entry - atr * stopMult, recentLow - atr * 0.3);
    target = entry + (entry - stop) * targetMult;
  } else {
    const highs = swingHighs(candles, 3);
    const recentHigh = highs.length > 0 ? highs[highs.length - 1].price : entry + atr * stopMult;
    stop = Math.max(entry + atr * stopMult, recentHigh + atr * 0.3);
    target = entry - (stop - entry) * targetMult;
  }

  const rr = Math.abs(target - entry) / Math.abs(entry - stop);
  return { stop, target, rr, isChop };
}

// ─── MOMENTUM — BREAKOUT-AWARE ───
function isMomentumAligned(
  direction: Direction, 
  stochK: number, 
  stochD: number, 
  rsi: number,
  isBreakout: boolean = false
): boolean {
  if (direction === "LONG") {
    if (stochK < stochD - 5) return false;
    if (!isBreakout && stochK > 90 && stochD > 85) return false;
    if (isBreakout && rsi > 80) return false;
    if (!isBreakout && rsi > 70) return false;
    return true;
  } else {
    if (stochK > stochD + 5) return false;
    if (!isBreakout && stochK < 10 && stochD < 15) return false;
    if (isBreakout && rsi < 20) return false;
    if (!isBreakout && rsi < 30) return false;
    return true;
  }
}

// ─── EMBEDDED STOCH — RELAXED ───
function wasStochEmbedded(direction: Direction, candles1h: Candle[]): boolean {
  const recent = candles1h.slice(-8);
  const stochs = recent.map((_, i) => {
    if (i < 13) return null;
    const slice = recent.slice(i - 13, i + 1);
    const lowest = Math.min(...slice.map(c => c.low));
    const highest = Math.max(...slice.map(c => c.high));
    const current = slice[slice.length - 1].close;
    return highest === lowest ? 50 : ((current - lowest) / (highest - lowest)) * 100;
  }).filter((x): x is number => x !== null);

  if (stochs.length < 2) return true;

  if (direction === "SHORT") {
    return stochs.some(k => k > 70);
  } else {
    return stochs.some(k => k < 30);
  }
}

// ─── 1H CONFIRMATION — SOFT FILTER (v8: no longer a hard block) ───
function get1HConfirmScore(direction: Direction, candles1h: Candle[]): number {
  const recent = candles1h.slice(-5);
  if (direction === "LONG") {
    const bullish = recent.filter(c => c.close > c.open).length;
    // 4-5 green = full confidence, 3 = partial, 2 = weak, 0-1 = none
    if (bullish >= 4) return 1.0;
    if (bullish === 3) return 0.7;
    if (bullish === 2) return 0.4;
    return 0.0;
  } else {
    const bearish = recent.filter(c => c.close < c.open).length;
    if (bearish >= 4) return 1.0;
    if (bearish === 3) return 0.7;
    if (bearish === 2) return 0.4;
    return 0.0;
  }
}

// ─── COOLDOWN v8 — 30 MINUTES ───
function isOnCooldown(pair: string, direction: Direction, activeTrades: Record<string, any>): boolean {
  const existing = activeTrades[pair];
  if (!existing) return false;
  if (existing.direction !== direction) return false;
  const minutesSince = (Date.now() - existing.timestamp) / (1000 * 60);
  return minutesSince < 30;
}

// ─── BREAK DETECTION v8 — RELAXED LOOKBACK ───
function findBreak(
  candles: Candle[],
  line: Trendline,
  direction: "LONG" | "SHORT"
): { found: boolean; crossIdx: number; crossPrice: number; crossLag: number } {
  const currentIdx = candles.length - 1;

  // v8: extended lookback from 3 to 5 candles (20h max)
  for (let i = currentIdx; i > Math.max(1, currentIdx - 5); i--) {
    const candle = candles[i];
    const prevCandle = candles[i - 1];
    const linePrice = line.slope * i + line.intercept;
    const prevLinePrice = line.slope * (i - 1) + line.intercept;

    if (direction === "LONG") {
      const prevBelow = prevCandle.close < prevLinePrice;
      const currAbove = candle.close > linePrice;
      const wasNearLine = Math.abs(prevCandle.close - prevLinePrice) / prevLinePrice < 0.02; // v8: 0.015 -> 0.02

      if ((prevBelow && currAbove) || (wasNearLine && currAbove)) {
        return { found: true, crossIdx: i, crossPrice: candle.close, crossLag: currentIdx - i };
      }
    } else {
      const prevAbove = prevCandle.close > prevLinePrice;
      const currBelow = candle.close < linePrice;
      const wasNearLine = Math.abs(prevCandle.close - prevLinePrice) / prevLinePrice < 0.02;

      if ((prevAbove && currBelow) || (wasNearLine && currBelow)) {
        return { found: true, crossIdx: i, crossPrice: candle.close, crossLag: currentIdx - i };
      }
    }
  }

  return { found: false, crossIdx: -1, crossPrice: 0, crossLag: 0 };
}

// ============================================================
// MAIN SIGNAL GENERATOR v8
// ============================================================

export async function generateSignal(
  pair: string,
  candles1h: Candle[],
  candles4h: Candle[],
  activeTrades: Record<string, any> = {}
): Promise<{ signal: Signal | null; market: MarketData; debug?: DebugInfo }> {

  const current4h = candles4h[candles4h.length - 1];
  const prev4h = candles4h[candles4h.length - 2];
  const price = current4h.close;

  const structure4h = getStructure(candles4h);
  const structure1h = getStructure(candles1h);
  const adx4h = calcADX(candles4h, 14);
  const rsi1h = calcRSI(candles1h, 14);
  const rsi4h = calcRSI(candles4h, 14);
  const stoch1h = calcStochastic(candles1h, 14, 3);
  const stoch4h = calcStochastic(candles4h, 14, 3);

  const market: MarketData = {
    pair,
    price,
    structure: structure4h,
    adx: adx4h,
    rsi: rsi1h,
    stochK: stoch1h.k,
    stochD: stoch1h.d,
  };

  const chandelier = calcChandelierExit(candles4h, 22, 3);

  const debugInfo: DebugInfo = {
    pair,
    price,
    structure4h,
    structure1h,
    adx4h: adx4h.toFixed(1),
    rsi1h: rsi1h.toFixed(1),
    rsi4h: rsi4h.toFixed(1),
    stochK1h: stoch1h.k.toFixed(1),
    stochD1h: stoch1h.d.toFixed(1),
    stochK4h: stoch4h.k.toFixed(1),
    stochD4h: stoch4h.d.toFixed(1),
    chandelierLong: chandelier.long.toFixed(2),
    chandelierShort: chandelier.short.toFixed(2),
    chandelierSlope: chandelier.slope.toFixed(4),
    trendlinesFound: { resistance: 0, support: 0, freshLines: 0 },
    blocks: [],
    linesChecked: 0,
    breaksDetected: { longSupport: 0, longResistance: 0, shortSupport: 0, shortResistance: 0 },
    topLines: { support: "none", resistance: "none" },
    softFilters: [],
  };

  if (candles1h.length < 50 || candles4h.length < 50) {
    debugInfo.blocks.push("insufficient_candles");
    console.log(`[DEBUG] ${pair}:`, JSON.stringify(debugInfo));
    return { signal: null, market, debug: debugInfo };
  }

  const isDeepChop = structure4h === "RANGE" && adx4h < 15;

  const highs4h = swingHighs(candles4h, 3);
  const lows4h = swingLows(candles4h, 3);
  const resistance4h = findTrendlines(candles4h, highs4h, false);
  const support4h = findTrendlines(candles4h, lows4h, true);

  debugInfo.trendlinesFound.resistance = resistance4h.length;
  debugInfo.trendlinesFound.support = support4h.length;

  const freshResistance = getFreshTrendlines(resistance4h, candles4h, 6);
  const freshSupport = getFreshTrendlines(support4h, candles4h, 6);
  const allFreshLines = [...freshResistance, ...freshSupport].sort((a, b) => b.strength - a.strength);

  debugInfo.trendlinesFound.freshLines = allFreshLines.length;

  if (freshSupport.length > 0) {
    const top = freshSupport[0];
    const linePrice = top.slope * (candles4h.length - 1) + top.intercept;
    debugInfo.topLines.support = `strength:${top.strength.toFixed(0)},touches:${top.touches.length},span:${top.span},lastTouch:${top.lastTouchIdx},price:${linePrice.toFixed(2)},dist:${((price-linePrice)/price*100).toFixed(2)}%`;
  }
  if (freshResistance.length > 0) {
    const top = freshResistance[0];
    const linePrice = top.slope * (candles4h.length - 1) + top.intercept;
    debugInfo.topLines.resistance = `strength:${top.strength.toFixed(0)},touches:${top.touches.length},span:${top.span},lastTouch:${top.lastTouchIdx},price:${linePrice.toFixed(2)},dist:${((price-linePrice)/price*100).toFixed(2)}%`;
  }

  if (isDeepChop && allFreshLines.length === 0) {
    debugInfo.blocks.push("deep_chop_no_fresh_trendlines");
    console.log(`[DEBUG] ${pair}:`, JSON.stringify(debugInfo));
    return { signal: null, market, debug: debugInfo };
  }

  let bestSignal: Signal | null = null;
  let bestScore = 0;

  for (const line of allFreshLines) {
    if (isTrendlineExpired(line, candles4h.length - 1)) continue;

    debugInfo.linesChecked++;

    const linePrice = line.slope * (candles4h.length - 1) + line.intercept;
    const possibleDirections: Direction[] = [];

    if (line.isSupport) {
      if (price > linePrice) possibleDirections.push("LONG");
      if (price < linePrice) possibleDirections.push("SHORT");
    } else {
      if (price > linePrice) possibleDirections.push("LONG");
      if (price < linePrice) possibleDirections.push("SHORT");
    }

    for (const direction of possibleDirections) {
      const breakInfo = findBreak(candles4h, line, direction);

      if (!breakInfo.found) {
        const lineType = line.isSupport ? "support" : "resistance";
        debugInfo.blocks.push(`no_cross_${direction.toLowerCase()}_${lineType}(strength:${line.strength.toFixed(0)},lastTouch:${line.lastTouchIdx})`);
        continue;
      }

      // v8: extended stale threshold from 2 to 3 candles (12h max)
      if (breakInfo.crossLag > 3) {
        debugInfo.blocks.push(`stale_${direction.toLowerCase()}(crossLag:${breakInfo.crossLag})`);
        continue;
      }

      if (direction === "LONG") {
        if (line.isSupport) debugInfo.breaksDetected.longSupport++;
        else debugInfo.breaksDetected.longResistance++;
      } else {
        if (line.isSupport) debugInfo.breaksDetected.shortSupport++;
        else debugInfo.breaksDetected.shortResistance++;
      }

      if (direction === "LONG" && price < chandelier.long) {
        debugInfo.blocks.push(`long_chandelier_block(price:${price.toFixed(2)}<long:${chandelier.long.toFixed(2)})`);
        continue;
      }
      if (direction === "SHORT" && price > chandelier.short) {
        debugInfo.blocks.push(`short_chandelier_block(price:${price.toFixed(2)}>short:${chandelier.short.toFixed(2)})`);
        continue;
      }

      if (direction === "LONG" && chandelier.slope < -0.05) {
        debugInfo.blocks.push(`long_slope_block(${chandelier.slope.toFixed(4)}<-0.05)`);
        continue;
      }
      if (direction === "SHORT" && chandelier.slope > 0.05) {
        debugInfo.blocks.push(`short_slope_block(${chandelier.slope.toFixed(4)}>0.05)`);
        continue;
      }

      if (isOnCooldown(pair, direction, activeTrades)) {
        debugInfo.blocks.push("cooldown");
        continue;
      }

      // v8: 1H confirmation is now a SOFT filter — reduces confidence, never blocks
      const confirmScore = get1HConfirmScore(direction, candles1h);
      if (confirmScore < 0.4) {
        debugInfo.softFilters.push(`1h_weak(confirm:${confirmScore.toFixed(1)})`);
      }

      // v8: momentum is still a hard filter but with breakout awareness
      if (!isMomentumAligned(direction, stoch4h.k, stoch4h.d, rsi4h, true)) {
        debugInfo.blocks.push(`momentum_4h(stoch:${stoch4h.k.toFixed(1)}/${stoch4h.d.toFixed(1)},rsi:${rsi4h.toFixed(1)})`);
        continue;
      }

      if (!wasStochEmbedded(direction, candles1h)) {
        debugInfo.blocks.push("stoch_embed");
        continue;
      }

      const { stop, target, rr, isChop: chopFlag } = findStopAndTarget(candles4h, direction, price, structure4h, adx4h);
      const type: SignalType = chopFlag ? "CHEEKY" : "PRIMARY";

      const freshnessBonus = breakInfo.crossLag === 0 ? 15 : breakInfo.crossLag === 1 ? 5 : 0;
      const minConf = chopFlag ? 55 : 65;
      const minRR = chopFlag ? 1.2 : 1.5;

      // v8: confidence now includes 1H confirmation score multiplier
      let confidence = Math.min(100, 55 + (line.touches.length * 4) + freshnessBonus + (line.strength * 0.1) + (adx4h > 25 ? 10 : 0));
      confidence = Math.round(confidence * (0.7 + 0.3 * confirmScore)); // soft penalty for weak 1H

      if (confidence >= minConf && rr >= minRR) {
        const expectedMove = direction === "LONG" 
          ? ((target - price) / price) * 100 
          : ((price - target) / price) * 100;

        if (expectedMove < 2.5) {
          debugInfo.blocks.push(`expected_move(${expectedMove.toFixed(2)}<2.5)`);
          continue;
        }

        const score = confidence * rr;
        if (score > bestScore) {
          bestScore = score;
          const lineType = line.isSupport ? "SUPPORT" : "RESISTANCE";
          bestSignal = {
            pair, direction, type, confidence, entry: price, stop, target, rr,
            reason: `${direction === "LONG" ? "BREAKUP" : "BREAKDOWN"} ${direction} | SRC:4H_${type} | FRESH(crossLag:${breakInfo.crossLag}) | TL(${line.touches.length}touches,${line.touchTypes.filter(t=>t==="wick").length}wicks,${lineType},slope:${line.slope.toFixed(4)},span:${line.span},lastTouch:${line.lastTouchIdx},strength:${line.strength.toFixed(0)}) | 4H:${structure4h} 1H:${structure1h} | ADX:${adx4h.toFixed(1)} | Stoch4H:${stoch4h.k.toFixed(1)}/${stoch4h.d.toFixed(1)} | Chandelier:${direction === "LONG" ? chandelier.long.toFixed(2) : chandelier.short.toFixed(2)} | 1HConfirm:${(confirmScore*100).toFixed(0)}%`,
            timestamp: Date.now(), structure: structure4h, adx: adx4h, rsi: rsi1h, stochK: stoch1h.k, stochD: stoch1h.d, expectedMove,
            candles1h, candles4h,
          };
        }
      }
    }
  }

  if (!bestSignal) {
    if (bestScore > 0) {
      debugInfo.blocks.push(`score_too_low(${bestScore.toFixed(1)})`);
    } else if (Object.values(debugInfo.breaksDetected).every(v => v === 0)) {
      debugInfo.blocks.push("no_fresh_break_detected");
    } else {
      debugInfo.blocks.push("all_fresh_breaks_filtered");
    }
  }

  console.log(`[DEBUG] ${pair}:`, JSON.stringify(debugInfo));
  return { signal: bestSignal, market, debug: debugInfo };
}
