// lib/strategy.ts — v4
// ============================================================
// CX Switch — Trendline Break Strategy (Rewrite v4)
// Key fix: Extended break lookback + visual trendline matching
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
  recency: number;
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
  trendlinesFound: { resistance: number; support: number; activeSupport: number; activeResistance: number };
  blocks: string[];
  linesChecked: number;
  breaksDetected: { long: number; short: number };
  topLines: { support: string; resistance: string };
}

// ============================================================
// SWING DETECTION — TUNABLE
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
// TRENDLINE DETECTION v4 — VISUAL MATCHING
// ============================================================

function findTrendlines(candles: Candle[], swings: SwingPoint[], isSupport: boolean): Trendline[] {
  const lines: Trendline[] = [];
  const maxAge = 50; // Slightly tighter
  const tolerance = 0.004;

  for (let i = 0; i < swings.length; i++) {
    for (let j = i + 1; j < swings.length; j++) {
      const p1 = swings[i];
      const p2 = swings[j];
      if (p2.idx - p1.idx < 6) continue;
      if (p2.idx - p1.idx > maxAge) break;

      const points = [{ x: p1.idx, y: p1.price }, { x: p2.idx, y: p2.price }];
      const { slope, intercept, r2 } = linearRegression(points);
      if (r2 < 0.75) continue; // Even looser for visual lines

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
      const recency = candles.length - 1 - p2.idx;
      
      // Visual trendline score: prioritize recent, clean, 2-3 touch lines
      // Your chart lines have 2-3 touches, span ~10-20 candles, recent end
      const recencyBonus = recency < 5 ? 30 : recency < 10 ? 15 : 0;
      const spanScore = span >= 8 && span <= 25 ? 20 : span > 25 ? 10 : 0;
      const touchScore = touches.length === 3 ? 25 : touches.length === 2 ? 15 : touches.length * 8;
      const wickBonus = wickCount >= 2 ? 15 : 0;
      
      const strength = Math.min(100,
        touchScore + spanScore + recencyBonus + wickBonus + (r2 * 10)
      );

      // Accept 2-touch lines if they're recent and have good span
      const hasQuality = touches.length >= 2 && span >= 6 && recency <= 15;
      
      if (hasQuality) {
        lines.push({ 
          slope, intercept, startIdx: p1.idx, endIdx: p2.idx, 
          touches, touchTypes, isSupport, strength, recency, span 
        });
      }
    }
  }

  // Deduplicate
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
  return currentIdx - line.endIdx > 30; // Tighter: 30 candles = 5 days on 4H
}

// Get ACTIVE trendlines — price is near them OR recently crossed them
function getActiveTrendlines(lines: Trendline[], candles: Candle[], maxLines: number = 8): Trendline[] {
  const currentIdx = candles.length - 1;
  const currentPrice = candles[currentIdx].close;
  const atr = calcATR(candles, 14);
  
  return lines
    .filter(line => {
      const linePrice = line.slope * currentIdx + line.intercept;
      const distance = Math.abs(currentPrice - linePrice);
      const distancePct = distance / currentPrice;
      
      // Active if:
      // 1. Price is within 4× ATR of line (about to break or just broke)
      // 2. OR price crossed the line in last 6 candles
      // 3. OR line ended very recently (within 3 candles)
      const nearLine = distance < (4 * atr) || distancePct < 0.04;
      
      let recentlyCrossed = false;
      for (let i = currentIdx; i > Math.max(1, currentIdx - 6); i--) {
        const prevPrice = candles[i-1].close;
        const currPrice = candles[i].close;
        const prevLinePrice = line.slope * (i-1) + line.intercept;
        const currLinePrice = line.slope * i + line.intercept;
        
        if (line.isSupport) {
          if (prevPrice < prevLinePrice && currPrice > currLinePrice) recentlyCrossed = true;
        } else {
          if (prevPrice > prevLinePrice && currPrice < currLinePrice) recentlyCrossed = true;
        }
      }
      
      const veryRecent = line.recency <= 3;
      
      return nearLine || recentlyCrossed || veryRecent;
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

// ─── 1H CONFIRMATION ───
function is1HConfirming(direction: Direction, candles1h: Candle[]): boolean {
  const recent = candles1h.slice(-3);
  if (direction === "LONG") {
    const bullish = recent.filter(c => c.close > c.open).length;
    return bullish >= 2;
  } else {
    const bearish = recent.filter(c => c.close < c.open).length;
    return bearish >= 2;
  }
}

// ─── COOLDOWN ───
function isOnCooldown(pair: string, direction: Direction, activeTrades: Record<string, { direction: string; timestamp: number }>): boolean {
  const existing = activeTrades[pair];
  if (!existing) return false;
  if (existing.direction !== direction) return false;
  const hoursSince = (Date.now() - existing.timestamp) / (1000 * 60 * 60);
  return hoursSince < 3;
}

// ─── BREAK DETECTION v4 — EXTENDED LOOKBACK + POST-BREAK ───
function findBreak(
  candles: Candle[],
  line: Trendline,
  direction: "LONG" | "SHORT",
  maxLookback: number = 8
): { found: boolean; crossIdx: number; crossPrice: number; crossLag: number; isPostBreak: boolean } {
  const currentIdx = candles.length - 1;
  
  // First: check for recent cross (within maxLookback)
  for (let i = currentIdx; i > Math.max(1, currentIdx - maxLookback); i--) {
    const candle = candles[i];
    const prevCandle = candles[i - 1];
    const linePrice = line.slope * i + line.intercept;
    const prevLinePrice = line.slope * (i - 1) + line.intercept;
    
    if (direction === "LONG") {
      const prevBelow = prevCandle.close < prevLinePrice;
      const currAbove = candle.close > linePrice;
      const wasNearLine = Math.abs(prevCandle.close - prevLinePrice) / prevLinePrice < 0.01;
      
      if ((prevBelow && currAbove) || (wasNearLine && currAbove)) {
        return { found: true, crossIdx: i, crossPrice: candle.close, crossLag: currentIdx - i, isPostBreak: false };
      }
    } else {
      const prevAbove = prevCandle.close > prevLinePrice;
      const currBelow = candle.close < linePrice;
      const wasNearLine = Math.abs(prevCandle.close - prevLinePrice) / prevLinePrice < 0.01;
      
      if ((prevAbove && currBelow) || (wasNearLine && currBelow)) {
        return { found: true, crossIdx: i, crossPrice: candle.close, crossLag: currentIdx - i, isPostBreak: false };
      }
    }
  }
  
  // Second: check if we're in post-break follow-through
  // Price is on the correct side of line, line is still relevant, break was recent enough
  const currentLinePrice = line.slope * currentIdx + line.intercept;
  const currentPrice = candles[currentIdx].close;
  
  if (direction === "LONG" && currentPrice > currentLinePrice) {
    // Find when price first crossed above
    for (let i = currentIdx - 1; i > Math.max(0, currentIdx - maxLookback - 4); i--) {
      const prevLinePrice = line.slope * (i-1) + line.intercept;
      const currLinePrice = line.slope * i + line.intercept;
      if (candles[i-1].close < prevLinePrice && candles[i].close > currLinePrice) {
        return { found: true, crossIdx: i, crossPrice: candles[i].close, crossLag: currentIdx - i, isPostBreak: true };
      }
    }
  }
  
  if (direction === "SHORT" && currentPrice < currentLinePrice) {
    for (let i = currentIdx - 1; i > Math.max(0, currentIdx - maxLookback - 4); i--) {
      const prevLinePrice = line.slope * (i-1) + line.intercept;
      const currLinePrice = line.slope * i + line.intercept;
      if (candles[i-1].close > prevLinePrice && candles[i].close < currLinePrice) {
        return { found: true, crossIdx: i, crossPrice: candles[i].close, crossLag: currentIdx - i, isPostBreak: true };
      }
    }
  }
  
  return { found: false, crossIdx: -1, crossPrice: 0, crossLag: 0, isPostBreak: false };
}

// ============================================================
// MAIN SIGNAL GENERATOR v4
// ============================================================

export async function generateSignal(
  pair: string,
  candles1h: Candle[],
  candles4h: Candle[],
  activeTrades: Record<string, { direction: string; timestamp: number }> = {}
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
    trendlinesFound: { resistance: 0, support: 0, activeSupport: 0, activeResistance: 0 },
    blocks: [],
    linesChecked: 0,
    breaksDetected: { long: 0, short: 0 },
    topLines: { support: "none", resistance: "none" },
  };

  if (candles1h.length < 50 || candles4h.length < 50) {
    debugInfo.blocks.push("insufficient_candles");
    console.log(`[DEBUG] ${pair}:`, JSON.stringify(debugInfo));
    return { signal: null, market, debug: debugInfo };
  }

  const isDeepChop = structure4h === "RANGE" && adx4h < 15; // Even looser
  
  const highs4h = swingHighs(candles4h, 3); // Back to 3 for more swing points
  const lows4h = swingLows(candles4h, 3);
  const resistance4h = findTrendlines(candles4h, highs4h, false);
  const support4h = findTrendlines(candles4h, lows4h, true);

  debugInfo.trendlinesFound.resistance = resistance4h.length;
  debugInfo.trendlinesFound.support = support4h.length;

  // Get ACTIVE trendlines — near price or recently crossed
  const activeResistance = getActiveTrendlines(resistance4h, candles4h, 8);
  const activeSupport = getActiveTrendlines(support4h, candles4h, 8);
  
  debugInfo.trendlinesFound.activeResistance = activeResistance.length;
  debugInfo.trendlinesFound.activeSupport = activeSupport.length;
  
  if (activeSupport.length > 0) {
    const top = activeSupport[0];
    const linePrice = top.slope * (candles4h.length - 1) + top.intercept;
    debugInfo.topLines.support = `strength:${top.strength.toFixed(0)},touches:${top.touches.length},span:${top.span},recency:${top.recency},price:${linePrice.toFixed(2)},dist:${((price-linePrice)/price*100).toFixed(2)}%`;
  }
  if (activeResistance.length > 0) {
    const top = activeResistance[0];
    const linePrice = top.slope * (candles4h.length - 1) + top.intercept;
    debugInfo.topLines.resistance = `strength:${top.strength.toFixed(0)},touches:${top.touches.length},span:${top.span},recency:${top.recency},price:${linePrice.toFixed(2)},dist:${((price-linePrice)/price*100).toFixed(2)}%`;
  }

  if (isDeepChop && activeResistance.length === 0 && activeSupport.length === 0) {
    debugInfo.blocks.push("deep_chop_no_active_trendlines");
    console.log(`[DEBUG] ${pair}:`, JSON.stringify(debugInfo));
    return { signal: null, market, debug: debugInfo };
  }

  let bestSignal: Signal | null = null;
  let bestScore = 0;

  // ─── 4H RESISTANCE BREAKDOWN → SHORT ───
  for (const line of activeResistance) {
    if (isTrendlineExpired(line, candles4h.length - 1)) continue;

    debugInfo.linesChecked++;

    const breakInfo = findBreak(candles4h, line, "SHORT", 8);
    
    if (!breakInfo.found) {
      debugInfo.blocks.push(`no_cross_resistance(strength:${line.strength.toFixed(0)},recency:${line.recency})`);
      continue;
    }
    
    debugInfo.breaksDetected.short++;

    if (price > chandelier.short) {
      debugInfo.blocks.push(`short_chandelier_block(price:${price.toFixed(2)}>short:${chandelier.short.toFixed(2)})`);
      continue;
    }
    if (chandelier.slope > 0.05) {
      debugInfo.blocks.push(`short_slope_block(${chandelier.slope.toFixed(4)}>0.05)`);
      continue;
    }
    if (isOnCooldown(pair, "SHORT", activeTrades)) {
      debugInfo.blocks.push("cooldown");
      continue;
    }
    if (!is1HConfirming("SHORT", candles1h)) {
      debugInfo.blocks.push("1h_confirm");
      continue;
    }
    if (!isMomentumAligned("SHORT", stoch4h.k, stoch4h.d, rsi4h, true)) {
      debugInfo.blocks.push(`momentum_4h(stoch:${stoch4h.k.toFixed(1)}/${stoch4h.d.toFixed(1)},rsi:${rsi4h.toFixed(1)})`);
      continue;
    }
    if (!wasStochEmbedded("SHORT", candles1h)) {
      debugInfo.blocks.push("stoch_embed");
      continue;
    }

    const { stop, target, rr, isChop: chopFlag } = findStopAndTarget(candles4h, "SHORT", price, structure4h, adx4h);
    const type: SignalType = chopFlag ? "CHEEKY" : "PRIMARY";
    const minConf = chopFlag ? 50 : 60;
    const minRR = chopFlag ? 1.2 : 1.5;
    const confidence = Math.min(100, 70 + (line.touches.length * 5) + (line.strength * 0.1) + (adx4h > 25 ? 10 : 0));

    if (confidence >= minConf && rr >= minRR) {
      const expectedMove = ((price - target) / price) * 100;
      if (expectedMove < 2.5) {
        debugInfo.blocks.push(`expected_move(${expectedMove.toFixed(2)}<2.5)`);
        continue;
      }

      const score = confidence * rr;
      if (score > bestScore) {
        bestScore = score;
        bestSignal = {
          pair, direction: "SHORT", type, confidence, entry: price, stop, target, rr,
          reason: `BREAKDOWN SHORT${breakInfo.isPostBreak ? "_FOLLOW" : ""} | SRC:4H_${type} | TL(${line.touches.length}touches,${line.touchTypes.filter(t=>t==="wick").length}wicks,RESISTANCE,slope:${line.slope.toFixed(4)},span:${line.span},recency:${line.recency},strength:${line.strength.toFixed(0)},crossLag:${breakInfo.crossLag}) | 4H:${structure4h} 1H:${structure1h} | ADX:${adx4h.toFixed(1)} | Stoch4H:${stoch4h.k.toFixed(1)}/${stoch4h.d.toFixed(1)} | Chandelier:${chandelier.short.toFixed(2)}`,
          timestamp: Date.now(), structure: structure4h, adx: adx4h, rsi: rsi1h, stochK: stoch1h.k, stochD: stoch1h.d, expectedMove,
          candles1h, candles4h,
        };
      }
    }
  }

  // ─── 4H SUPPORT BREAKUP → LONG ───
  for (const line of activeSupport) {
    if (isTrendlineExpired(line, candles4h.length - 1)) continue;

    debugInfo.linesChecked++;

    const breakInfo = findBreak(candles4h, line, "LONG", 8);
    
    if (!breakInfo.found) {
      debugInfo.blocks.push(`no_cross_support(strength:${line.strength.toFixed(0)},recency:${line.recency})`);
      continue;
    }
    
    debugInfo.breaksDetected.long++;

    if (price < chandelier.long) {
      debugInfo.blocks.push(`long_chandelier_block(price:${price.toFixed(2)}<long:${chandelier.long.toFixed(2)})`);
      continue;
    }
    if (chandelier.slope < -0.05) {
      debugInfo.blocks.push(`long_slope_block(${chandelier.slope.toFixed(4)}<-0.05)`);
      continue;
    }
    if (isOnCooldown(pair, "LONG", activeTrades)) {
      debugInfo.blocks.push("cooldown");
      continue;
    }
    if (!is1HConfirming("LONG", candles1h)) {
      debugInfo.blocks.push("1h_confirm");
      continue;
    }
    if (!isMomentumAligned("LONG", stoch4h.k, stoch4h.d, rsi4h, true)) {
      debugInfo.blocks.push(`momentum_4h(stoch:${stoch4h.k.toFixed(1)}/${stoch4h.d.toFixed(1)},rsi:${rsi4h.toFixed(1)})`);
      continue;
    }
    if (!wasStochEmbedded("LONG", candles1h)) {
      debugInfo.blocks.push("stoch_embed");
      continue;
    }

    const { stop, target, rr, isChop: chopFlag } = findStopAndTarget(candles4h, "LONG", price, structure4h, adx4h);
    const type: SignalType = chopFlag ? "CHEEKY" : "PRIMARY";
    const minConf = chopFlag ? 50 : 60;
    const minRR = chopFlag ? 1.2 : 1.5;
    const confidence = Math.min(100, 70 + (line.touches.length * 5) + (line.strength * 0.1) + (adx4h > 25 ? 10 : 0));

    if (confidence >= minConf && rr >= minRR) {
      const expectedMove = ((target - price) / price) * 100;
      if (expectedMove < 2.5) {
        debugInfo.blocks.push(`expected_move(${expectedMove.toFixed(2)}<2.5)`);
        continue;
      }

      const score = confidence * rr;
      if (score > bestScore) {
        bestScore = score;
        bestSignal = {
          pair, direction: "LONG", type, confidence, entry: price, stop, target, rr,
          reason: `BREAKUP LONG${breakInfo.isPostBreak ? "_FOLLOW" : ""} | SRC:4H_${type} | TL(${line.touches.length}touches,${line.touchTypes.filter(t=>t==="wick").length}wicks,SUPPORT,slope:${line.slope.toFixed(4)},span:${line.span},recency:${line.recency},strength:${line.strength.toFixed(0)},crossLag:${breakInfo.crossLag}) | 4H:${structure4h} 1H:${structure1h} | ADX:${adx4h.toFixed(1)} | Stoch4H:${stoch4h.k.toFixed(1)}/${stoch4h.d.toFixed(1)} | Chandelier:${chandelier.long.toFixed(2)}`,
          timestamp: Date.now(), structure: structure4h, adx: adx4h, rsi: rsi1h, stochK: stoch1h.k, stochD: stoch1h.d, expectedMove,
          candles1h, candles4h,
        };
      }
    }
  }

  if (!bestSignal) {
    if (bestScore > 0) {
      debugInfo.blocks.push(`score_too_low(${bestScore.toFixed(1)})`);
    } else if (debugInfo.breaksDetected.long === 0 && debugInfo.breaksDetected.short === 0) {
      debugInfo.blocks.push("no_break_detected");
    } else {
      debugInfo.blocks.push("all_breaks_filtered");
    }
  }

  console.log(`[DEBUG] ${pair}:`, JSON.stringify(debugInfo));
  return { signal: bestSignal, market, debug: debugInfo };
}
