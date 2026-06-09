export type Structure = "UPTREND" | "DOWNTREND" | "RANGE";
export type Direction = "LONG" | "SHORT";
export type SignalType = "PRIMARY" | "CHEEKY";

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

function findTrendlines(candles: Candle[], swings: SwingPoint[], isSupport: boolean): Trendline[] {
  const lines: Trendline[] = [];
  const minTouches = 2;
  const maxAge = 80;

  for (let i = 0; i < swings.length; i++) {
    for (let j = i + 1; j < swings.length; j++) {
      const p1 = swings[i];
      const p2 = swings[j];
      if (p2.idx - p1.idx < 5) continue;
      if (p2.idx - p1.idx > maxAge) break;

      const points = [{ x: p1.idx, y: p1.price }, { x: p2.idx, y: p2.price }];
      const { slope, intercept, r2 } = linearRegression(points);
      if (r2 < 0.85) continue;

      const touches: number[] = [p1.idx, p2.idx];
      for (let k = p1.idx + 1; k < p2.idx; k++) {
        const expected = slope * k + intercept;
        const wick = isSupport ? candles[k].low : candles[k].high;
        if (Math.abs(wick - expected) / expected < 0.0015) {
          touches.push(k);
        }
      }

      if (touches.length >= minTouches) {
        lines.push({ slope, intercept, startIdx: p1.idx, endIdx: p2.idx, touches, isSupport });
      }
    }
  }

  const unique: Trendline[] = [];
  for (const line of lines) {
    const isDup = unique.some(
      (u) => Math.abs(u.slope - line.slope) < 0.001 && Math.abs(u.intercept - line.intercept) < 0.01 && u.isSupport === line.isSupport
    );
    if (!isDup) unique.push(line);
  }

  return unique.sort((a, b) => b.endIdx - a.endIdx);
}

function isTrendlineExpired(line: Trendline, currentIdx: number): boolean {
  return currentIdx - line.endIdx > 80;
}

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
  return "RANGE";
}

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

function findStopAndTarget(candles: Candle[], direction: Direction, entry: number, structure: Structure) {
  const atr = calcATR(candles, 14);
  let stop: number, target: number;

  if (direction === "LONG") {
    const lows = swingLows(candles, 3);
    const recentLow = lows.length > 0 ? lows[lows.length - 1].price : entry - atr * 2.5;
    stop = Math.min(entry - atr * 2.5, recentLow - atr * 0.5);
    target = entry + (entry - stop) * 2.5;
  } else {
    const highs = swingHighs(candles, 3);
    const recentHigh = highs.length > 0 ? highs[highs.length - 1].price : entry + atr * 2.5;
    stop = Math.max(entry + atr * 2.5, recentHigh + atr * 0.5);
    target = entry - (stop - entry) * 2.5;
  }

  const rr = Math.abs(target - entry) / Math.abs(entry - stop);
  return { stop, target, rr };
}

// ─── NEW: 4H trendline break detection ───
function detect4HTrendlineBreak(
  candles: Candle[],
  direction: Direction
): { broke: boolean; line: Trendline | null; linePrice: number; lineAge: number } {
  const highs = swingHighs(candles, 3);
  const lows = swingLows(candles, 3);
  const resistance = findTrendlines(candles, highs, false);
  const support = findTrendlines(candles, lows, true);
  const currentIdx = candles.length - 1;
  const current = candles[currentIdx];
  const prev = candles[currentIdx - 1];

  if (direction === "LONG") {
    for (const line of support) {
      if (isTrendlineExpired(line, currentIdx)) continue;
      const lineAge = currentIdx - line.endIdx;
      if (lineAge < 5) continue;
      const lp = line.slope * currentIdx + line.intercept;
      if (prev.close < lp && current.close > lp) {
        return { broke: true, line, linePrice: lp, lineAge };
      }
    }
  } else {
    for (const line of resistance) {
      if (isTrendlineExpired(line, currentIdx)) continue;
      const lineAge = currentIdx - line.endIdx;
      if (lineAge < 5) continue;
      const lp = line.slope * currentIdx + line.intercept;
      if (prev.close > lp && current.close < lp) {
        return { broke: true, line, linePrice: lp, lineAge };
      }
    }
  }
  return { broke: false, line: null, linePrice: 0, lineAge: 0 };
}

// ─── NEW: Check if 1H break aligns with 4H context ───
function is4HAligned(direction: Direction, structure4h: Structure, broke4h: boolean): boolean {
  if (broke4h) return true; // 4H trendline break overrides everything
  if (structure4h === "RANGE") return true; // Range = neutral, 1H break is valid
  if (direction === "LONG" && structure4h === "UPTREND") return true;
  if (direction === "SHORT" && structure4h === "DOWNTREND") return true;
  return false;
}

function calcConfidence(
  direction: Direction,
  structure: Structure,
  adx: number,
  rr: number,
  touches: number,
  isBreakout: boolean,
  is4HBreak: boolean,
  isAligned: boolean
): number {
  let score = 50;

  // Structure alignment
  if ((direction === "LONG" && structure === "UPTREND") || (direction === "SHORT" && structure === "DOWNTREND")) {
    score += 20;
  } else if (structure === "RANGE") {
    score += 5;
  } else {
    score -= 15;
  }

  // 4H trendline break is the strongest signal
  if (is4HBreak) score += 25;

  // Counter-trend 1H breaks get heavily penalized
  if (!isAligned && !is4HBreak) score -= 30;

  if (adx > 30) score += 15;
  else if (adx > 20) score += 10;
  else if (adx < 15) score -= 10;

  if (rr >= 3) score += 15;
  else if (rr >= 2) score += 10;
  else if (rr < 1.5) score -= 15;

  if (touches >= 3) score += 10;
  else if (touches >= 2) score += 5;

  if (isBreakout) score += 10;
  else score -= 5;

  return Math.max(0, Math.min(100, score));
}

export async function generateSignal(
  pair: string,
  candles1h: Candle[],
  candles4h: Candle[]
): Promise<{ signal: Signal | null; market: MarketData }> {
  const current1h = candles1h[candles1h.length - 1];
  const price = current1h.close;
  const structure4h = getStructure(candles4h);
  const structure1h = getStructure(candles1h);
  const adx4h = calcADX(candles4h, 14);
  const adx1h = calcADX(candles1h, 14);
  const rsi = calcRSI(candles1h, 14);
  const stoch = calcStochastic(candles1h, 14, 3);

  const market: MarketData = {
    pair,
    price,
    structure: structure4h,
    adx: adx4h,
    rsi,
    stochK: stoch.k,
    stochD: stoch.d,
  };

  if (candles1h.length < 50 || candles4h.length < 50) {
    return { signal: null, market };
  }

  // ─── Detect 4H trendline breaks first ───
  const break4hLong = detect4HTrendlineBreak(candles4h, "LONG");
  const break4hShort = detect4HTrendlineBreak(candles4h, "SHORT");

  const highs1h = swingHighs(candles1h, 3);
  const lows1h = swingLows(candles1h, 3);
  const resistance1h = findTrendlines(candles1h, highs1h, false);
  const support1h = findTrendlines(candles1h, lows1h, true);

  let bestSignal: Signal | null = null;
  let bestScore = 0;

  // ─── 4H RESISTANCE BREAKDOWN → PRIMARY SHORT ───
  if (break4hShort.broke && break4hShort.line) {
    const line = break4hShort.line;
    const { stop, target, rr } = findStopAndTarget(candles4h, "SHORT", price, structure4h);
    const confidence = calcConfidence("SHORT", structure4h, adx4h, rr, line.touches.length, true, true, true);

    if (confidence >= 65 && rr >= 1.5 && adx4h > 20) {
      const expectedMove = ((price - target) / price) * 100;
      bestSignal = {
        pair, direction: "SHORT", type: "PRIMARY", confidence, entry: price, stop, target, rr,
        reason: `BREAKDOWN SHORT | SRC:4H_PRIMARY | TL(${line.touches.length}touches,RESISTANCE,slope:${line.slope.toFixed(4)},age:${break4hShort.lineAge}bars) | 4H:${structure4h} 1H:${structure1h} | ADX:${adx4h.toFixed(1)}`,
        timestamp: Date.now(), structure: structure4h, adx: adx4h, rsi, stochK: stoch.k, stochD: stoch.d, expectedMove,
        candles1h, candles4h,
      };
      bestScore = confidence * rr;
    }
  }

  // ─── 4H SUPPORT BREAKUP → PRIMARY LONG ───
  if (break4hLong.broke && break4hLong.line) {
    const line = break4hLong.line;
    const { stop, target, rr } = findStopAndTarget(candles4h, "LONG", price, structure4h);
    const confidence = calcConfidence("LONG", structure4h, adx4h, rr, line.touches.length, true, true, true);

    if (confidence >= 65 && rr >= 1.5 && adx4h > 20) {
      const score = confidence * rr;
      if (score > bestScore) {
        const expectedMove = ((target - price) / price) * 100;
        bestSignal = {
          pair, direction: "LONG", type: "PRIMARY", confidence, entry: price, stop, target, rr,
          reason: `BREAKUP LONG | SRC:4H_PRIMARY | TL(${line.touches.length}touches,SUPPORT,slope:${line.slope.toFixed(4)},age:${break4hLong.lineAge}bars) | 4H:${structure4h} 1H:${structure1h} | ADX:${adx4h.toFixed(1)}`,
          timestamp: Date.now(), structure: structure4h, adx: adx4h, rsi, stochK: stoch.k, stochD: stoch.d, expectedMove,
          candles1h, candles4h,
        };
        bestScore = score;
      }
    }
  }

  // ─── 1H RESISTANCE BREAKDOWN ───
  for (const line of resistance1h) {
    if (isTrendlineExpired(line, candles1h.length - 1)) continue;

    const lineAge = candles1h.length - 1 - line.endIdx;
    if (lineAge < 10) continue;

    const linePrice = line.slope * (candles1h.length - 1) + line.intercept;
    const prevCandle = candles1h[candles1h.length - 2];

    if (prevCandle.close > linePrice && current1h.close < linePrice) {
      const aligned = is4HAligned("SHORT", structure4h, break4hShort.broke);
      const { stop, target, rr } = findStopAndTarget(candles1h, "SHORT", price, structure4h);
      const confidence = calcConfidence("SHORT", structure4h, adx4h, rr, line.touches.length, true, break4hShort.broke, aligned);

      // PRIMARY only if 4H aligned OR 4H also breaking
      const isPrimary = aligned && confidence >= 60 && rr >= 1.5 && adx4h > 25;
      const isCheeky = !aligned && confidence >= 45 && rr >= 1.5;

      if (isPrimary || isCheeky) {
        const score = confidence * rr;
        if (score > bestScore) {
          bestScore = score;
          const expectedMove = ((price - target) / price) * 100;
          bestSignal = {
            pair, direction: "SHORT", type: isPrimary ? "PRIMARY" : "CHEEKY", confidence, entry: price, stop, target, rr,
            reason: `${isPrimary ? "BREAKDOWN" : "CHEEKY"} SHORT | SRC:1H_${isPrimary ? "PRIMARY" : "COUNTER"} | TL(${line.touches.length}touches,RESISTANCE,slope:${line.slope.toFixed(4)},age:${lineAge}bars) | 4H:${structure4h} 1H:${structure1h} | ADX:${adx4h.toFixed(1)} | 4H_ALIGN:${aligned}`,
            timestamp: Date.now(), structure: structure4h, adx: adx4h, rsi, stochK: stoch.k, stochD: stoch.d, expectedMove,
            candles1h, candles4h,
          };
        }
      }
    }
  }

  // ─── 1H SUPPORT BREAKUP ───
  for (const line of support1h) {
    if (isTrendlineExpired(line, candles1h.length - 1)) continue;

    const lineAge = candles1h.length - 1 - line.endIdx;
    if (lineAge < 10) continue;

    const linePrice = line.slope * (candles1h.length - 1) + line.intercept;
    const prevCandle = candles1h[candles1h.length - 2];

    if (prevCandle.close < linePrice && current1h.close > linePrice) {
      const aligned = is4HAligned("LONG", structure4h, break4hLong.broke);
      const { stop, target, rr } = findStopAndTarget(candles1h, "LONG", price, structure4h);
      const confidence = calcConfidence("LONG", structure4h, adx4h, rr, line.touches.length, true, break4hLong.broke, aligned);

      // PRIMARY only if 4H aligned OR 4H also breaking
      const isPrimary = aligned && confidence >= 60 && rr >= 1.5 && adx4h > 25;
      const isCheeky = !aligned && confidence >= 45 && rr >= 1.5;

      if (isPrimary || isCheeky) {
        const score = confidence * rr;
        if (score > bestScore) {
          bestScore = score;
          const expectedMove = ((target - price) / price) * 100;
          bestSignal = {
            pair, direction: "LONG", type: isPrimary ? "PRIMARY" : "CHEEKY", confidence, entry: price, stop, target, rr,
            reason: `${isPrimary ? "BREAKUP" : "CHEEKY"} LONG | SRC:1H_${isPrimary ? "PRIMARY" : "COUNTER"} | TL(${line.touches.length}touches,SUPPORT,slope:${line.slope.toFixed(4)},age:${lineAge}bars) | 4H:${structure4h} 1H:${structure1h} | ADX:${adx4h.toFixed(1)} | 4H_ALIGN:${aligned}`,
            timestamp: Date.now(), structure: structure4h, adx: adx4h, rsi, stochK: stoch.k, stochD: stoch.d, expectedMove,
            candles1h, candles4h,
          };
        }
      }
    }
  }

  // ─── RANGE CHEEKY (unchanged logic) ───
  if (!bestSignal && structure4h === "RANGE" && adx4h < 20) {
    const rangeHigh = Math.max(...candles4h.slice(-20).map((c) => c.high));
    const rangeLow = Math.min(...candles4h.slice(-20).map((c) => c.low));

    if (price > rangeHigh - (rangeHigh - rangeLow) * 0.1) {
      const { stop, target, rr } = findStopAndTarget(candles1h, "SHORT", price, structure4h);
      const confidence = calcConfidence("SHORT", structure4h, adx4h, rr, 0, false, false, true);
      if (confidence >= 50 && rr >= 1.5) {
        const expectedMove = ((price - target) / price) * 100;
        bestSignal = {
          pair, direction: "SHORT", type: "CHEEKY", confidence, entry: price, stop, target, rr,
          reason: `CHEEKY SHORT | SRC:RANGE_EXTREME | range:${rangeLow.toFixed(2)}-${rangeHigh.toFixed(2)} | 4H:RANGE 1H:${structure1h} | ADX:${adx4h.toFixed(1)}`,
          timestamp: Date.now(), structure: structure4h, adx: adx4h, rsi, stochK: stoch.k, stochD: stoch.d, expectedMove,
          candles1h, candles4h,
        };
      }
    } else if (price < rangeLow + (rangeHigh - rangeLow) * 0.1) {
      const { stop, target, rr } = findStopAndTarget(candles1h, "LONG", price, structure4h);
      const confidence = calcConfidence("LONG", structure4h, adx4h, rr, 0, false, false, true);
      if (confidence >= 50 && rr >= 1.5) {
        const expectedMove = ((target - price) / price) * 100;
        bestSignal = {
          pair, direction: "LONG", type: "CHEEKY", confidence, entry: price, stop, target, rr,
          reason: `CHEEKY LONG | SRC:RANGE_EXTREME | range:${rangeLow.toFixed(2)}-${rangeHigh.toFixed(2)} | 4H:RANGE 1H:${structure1h} | ADX:${adx4h.toFixed(1)}`,
          timestamp: Date.now(), structure: structure4h, adx: adx4h, rsi, stochK: stoch.k, stochD: stoch.d, expectedMove,
          candles1h, candles4h,
        };
      }
    }
  }

  return { signal: bestSignal, market };
}
