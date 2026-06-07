import { getCandles, getCurrentPrice } from "@/lib/kraken";
import type { Candle } from "@/lib/kraken";

export type Structure = "UPTREND" | "DOWNTREND" | "RANGE";
export type Direction = "LONG" | "SHORT";
export type SignalType = "PRIMARY" | "CHEEKY";

export interface Signal {
  pair: string;
  direction: Direction;
  type: SignalType;
  confidence: number; // 0-100
  entry: number;
  stop: number;
  target: number;
  rr: number;
  reason: string;
  timestamp: number;
  structure: Structure;
  adx: number;
  candles1h: Candle[];
  candles4h: Candle[];
}

interface Trendline {
  slope: number;
  intercept: number;
  startIdx: number;
  endIdx: number;
  touches: number[];
  isSupport: boolean;
}

interface SwingPoint {
  idx: number;
  price: number;
  type: "high" | "low";
}

// ─── Helpers ───
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

  // R² calculation
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

function findTrendlines(
  candles: Candle[],
  swings: SwingPoint[],
  isSupport: boolean
): Trendline[] {
  const lines: Trendline[] = [];
  const minTouches = 2;
  const maxAge = 80; // candles

  for (let i = 0; i < swings.length; i++) {
    for (let j = i + 1; j < swings.length; j++) {
      const p1 = swings[i];
      const p2 = swings[j];
      if (p2.idx - p1.idx < 5) continue; // Too close
      if (p2.idx - p1.idx > maxAge) break; // Too old

      const points = [
        { x: p1.idx, y: p1.price },
        { x: p2.idx, y: p2.price },
      ];
      const { slope, intercept, r2 } = linearRegression(points);
      if (r2 < 0.85) continue;

      // Count touches
      const touches: number[] = [p1.idx, p2.idx];
      for (let k = p1.idx + 1; k < p2.idx; k++) {
        const expected = slope * k + intercept;
        const actual = isSupport ? candles[k].low : candles[k].high;
        const wick = isSupport ? candles[k].low : candles[k].high;
        const body = isSupport
          ? Math.min(candles[k].open, candles[k].close)
          : Math.max(candles[k].open, candles[k].close);

        // Touch if wick is within 0.15% of line
        if (Math.abs(wick - expected) / expected < 0.0015) {
          touches.push(k);
        }
      }

      if (touches.length >= minTouches) {
        lines.push({
          slope,
          intercept,
          startIdx: p1.idx,
          endIdx: p2.idx,
          touches,
          isSupport,
        });
      }
    }
  }

  // Deduplicate: keep longest lines
  const unique: Trendline[] = [];
  for (const line of lines) {
    const isDup = unique.some(
      (u) =>
        Math.abs(u.slope - line.slope) < 0.001 &&
        Math.abs(u.intercept - line.intercept) < 0.01 &&
        u.isSupport === line.isSupport
    );
    if (!isDup) unique.push(line);
  }

  return unique.sort((a, b) => b.endIdx - a.endIdx); // Most recent first
}

function isTrendlineExpired(line: Trendline, currentIdx: number): boolean {
  return currentIdx - line.endIdx > 80; // Line is "dead" after 80 candles
}

function getStructure(candles: Candle[]): Structure {
  const highs = swingHighs(candles, 5);
  const lows = swingLows(candles, 5);
  if (highs.length < 2 || lows.length < 2) return "RANGE";

  const recentHighs = highs.slice(-3);
  const recentLows = lows.slice(-3);

  const higherHighs = recentHighs.every((h, i) =>
    i === 0 ? true : h.price > recentHighs[i - 1].price
  );
  const higherLows = recentLows.every((l, i) =>
    i === 0 ? true : l.price > recentLows[i - 1].price
  );
  const lowerHighs = recentHighs.every((h, i) =>
    i === 0 ? true : h.price < recentHighs[i - 1].price
  );
  const lowerLows = recentLows.every((l, i) =>
    i === 0 ? true : l.price < recentLows[i - 1].price
  );

  if (higherHighs && higherLows) return "UPTREND";
  if (lowerHighs && lowerLows) return "DOWNTREND";
  return "RANGE";
}

function calcADX(candles: Candle[], period = 14): number {
  if (candles.length < period + 1) return 0;

  let trSum = 0;
  let plusDMSum = 0;
  let minusDMSum = 0;

  for (let i = 1; i <= period; i++) {
    const prev = candles[i - 1];
    const curr = candles[i];
    const tr = Math.max(
      curr.high - curr.low,
      Math.abs(curr.high - prev.close),
      Math.abs(curr.low - prev.close)
    );
    const plusDM = curr.high - prev.high > prev.low - curr.low
      ? Math.max(curr.high - prev.high, 0)
      : 0;
    const minusDM = prev.low - curr.low > curr.high - prev.high
      ? Math.max(prev.low - curr.low, 0)
      : 0;

    trSum += tr;
    plusDMSum += plusDM;
    minusDMSum += minusDM;
  }

  const atr = trSum / period;
  if (atr === 0) return 0;

  const plusDI = 100 * (plusDMSum / period) / atr;
  const minusDI = 100 * (minusDMSum / period) / atr;
  const dx = Math.abs(plusDI - minusDI) / (plusDI + minusDI) * 100;

  return dx;
}

function findStopAndTarget(
  candles: Candle[],
  direction: Direction,
  entry: number,
  structure: Structure
): { stop: number; target: number; rr: number } {
  const atr = calcATR(candles, 14);
  let stop: number;
  let target: number;

  if (direction === "LONG") {
    // Stop below recent swing low or 1.5 ATR
    const lows = swingLows(candles, 3);
    const recentLow = lows.length > 0 ? lows[lows.length - 1].price : entry - atr * 1.5;
    stop = Math.min(entry - atr * 1.5, recentLow - atr * 0.3);
    // Target: 2:1 RR minimum, or structure-based
    target = entry + (entry - stop) * 2.5;
  } else {
    const highs = swingHighs(candles, 3);
    const recentHigh = highs.length > 0 ? highs[highs.length - 1].price : entry + atr * 1.5;
    stop = Math.max(entry + atr * 1.5, recentHigh + atr * 0.3);
    target = entry - (stop - entry) * 2.5;
  }

  const rr = Math.abs(target - entry) / Math.abs(entry - stop);
  return { stop, target, rr };
}

function calcATR(candles: Candle[], period = 14): number {
  if (candles.length < period + 1) return 0;
  let sum = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const prev = candles[i - 1];
    const curr = candles[i];
    const tr = Math.max(
      curr.high - curr.low,
      Math.abs(curr.high - prev.close),
      Math.abs(curr.low - prev.close)
    );
    sum += tr;
  }
  return sum / period;
}

function calcConfidence(
  direction: Direction,
  structure: Structure,
  adx: number,
  rr: number,
  touches: number,
  isBreakout: boolean
): number {
  let score = 50;

  // Trend alignment
  if (
    (direction === "LONG" && structure === "UPTREND") ||
    (direction === "SHORT" && structure === "DOWNTREND")
  ) {
    score += 20;
  } else if (structure === "RANGE") {
    score += 5;
  } else {
    score -= 15;
  }

  // ADX strength
  if (adx > 30) score += 15;
  else if (adx > 20) score += 10;
  else if (adx < 15) score -= 10;

  // RR quality
  if (rr >= 3) score += 15;
  else if (rr >= 2) score += 10;
  else if (rr < 1.5) score -= 15;

  // Trendline quality
  if (touches >= 3) score += 10;
  else if (touches >= 2) score += 5;

  // Breakout confirmation
  if (isBreakout) score += 10;
  else score -= 5;

  return Math.max(0, Math.min(100, score));
}

// ─── Main Signal Generator ───
export async function generateSignal(
  pair: string,
  candles1h: Candle[],
  candles4h: Candle[]
): Promise<Signal | null> {
  if (candles1h.length < 50 || candles4h.length < 50) return null;

  const current1h = candles1h[candles1h.length - 1];
  const current4h = candles4h[candles4h.length - 1];
  const price = current1h.close;

  const structure = getStructure(candles4h);
  const adx = calcADX(candles4h, 14);

  // Find trendlines on 1H
  const highs = swingHighs(candles1h, 3);
  const lows = swingLows(candles1h, 3);
  const resistance = findTrendlines(candles1h, highs, false);
  const support = findTrendlines(candles1h, lows, true);

  let bestSignal: Signal | null = null;
  let bestScore = 0;

  // Check resistance breaks (SHORT)
  for (const line of resistance) {
    if (isTrendlineExpired(line, candles1h.length - 1)) continue;

    const linePrice = line.slope * (candles1h.length - 1) + line.intercept;
    const prevPrice = line.slope * (candles1h.length - 2) + line.intercept;

    // Breakdown: price was above, now below
    const prevCandle = candles1h[candles1h.length - 2];
    if (prevCandle.high > prevPrice && current1h.close < linePrice) {
      const { stop, target, rr } = findStopAndTarget(candles1h, "SHORT", price, structure);
      const confidence = calcConfidence("SHORT", structure, adx, rr, line.touches.length, true);

      if (confidence >= 60 && rr >= 1.5) {
        const score = confidence * rr;
        if (score > bestScore) {
          bestScore = score;
          bestSignal = {
            pair,
            direction: "SHORT",
            type: "PRIMARY",
            confidence,
            entry: price,
            stop,
            target,
            rr,
            reason: `BREAKDOWN below resistance (slope:${line.slope.toFixed(4)}, touches:${line.touches.length})`,
            timestamp: Date.now(),
            structure,
            adx,
            candles1h,
            candles4h,
          };
        }
      }
    }
  }

  // Check support breaks (LONG)
  for (const line of support) {
    if (isTrendlineExpired(line, candles1h.length - 1)) continue;

    const linePrice = line.slope * (candles1h.length - 1) + line.intercept;
    const prevCandle = candles1h[candles1h.length - 2];

    // Breakup: price was below, now above
    if (prevCandle.low < linePrice && current1h.close > linePrice) {
      const { stop, target, rr } = findStopAndTarget(candles1h, "LONG", price, structure);
      const confidence = calcConfidence("LONG", structure, adx, rr, line.touches.length, true);

      if (confidence >= 60 && rr >= 1.5) {
        const score = confidence * rr;
        if (score > bestScore) {
          bestScore = score;
          bestSignal = {
            pair,
            direction: "LONG",
            type: "PRIMARY",
            confidence,
            entry: price,
            stop,
            target,
            rr,
            reason: `BREAKUP above support (slope:${line.slope.toFixed(4)}, touches:${line.touches.length})`,
            timestamp: Date.now(),
            structure,
            adx,
            candles1h,
            candles4h,
          };
        }
      }
    }
  }

  // CHEEKY entries: counter-trend in range, or trend pullback
  if (!bestSignal && structure === "RANGE" && adx < 20) {
    // Range extremes
    const rangeHigh = Math.max(...candles4h.slice(-20).map((c) => c.high));
    const rangeLow = Math.min(...candles4h.slice(-20).map((c) => c.low));
    const rangeMid = (rangeHigh + rangeLow) / 2;

    if (price > rangeHigh - (rangeHigh - rangeLow) * 0.1) {
      // Near top, cheeky short
      const { stop, target, rr } = findStopAndTarget(candles1h, "SHORT", price, structure);
      const confidence = calcConfidence("SHORT", structure, adx, rr, 0, false);
      if (confidence >= 50 && rr >= 1.5) {
        bestSignal = {
          pair,
          direction: "SHORT",
          type: "CHEEKY",
          confidence,
          entry: price,
          stop,
          target,
          rr,
          reason: `CHEEKY SHORT at range high (range: ${rangeLow.toFixed(2)}-${rangeHigh.toFixed(2)})`,
          timestamp: Date.now(),
          structure,
          adx,
          candles1h,
          candles4h,
        };
      }
    } else if (price < rangeLow + (rangeHigh - rangeLow) * 0.1) {
      // Near bottom, cheeky long
      const { stop, target, rr } = findStopAndTarget(candles1h, "LONG", price, structure);
      const confidence = calcConfidence("LONG", structure, adx, rr, 0, false);
      if (confidence >= 50 && rr >= 1.5) {
        bestSignal = {
          pair,
          direction: "LONG",
          type: "CHEEKY",
          confidence,
          entry: price,
          stop,
          target,
          rr,
          reason: `CHEEKY LONG at range low (range: ${rangeLow.toFixed(2)}-${rangeHigh.toFixed(2)})`,
          timestamp: Date.now(),
          structure,
          adx,
          candles1h,
          candles4h,
        };
      }
    }
  }

  return bestSignal;
}
