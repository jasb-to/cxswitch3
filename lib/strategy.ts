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
  trendlineKey: string;
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
  const maxAge = 60; // Reduced from 80 — old lines are unreliable

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
  return currentIdx - line.endIdx > 60;
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

// ─── NEW: Chop-aware targets ───
function findStopAndTarget(candles: Candle[], direction: Direction, entry: number, structure: Structure, adx: number) {
  const atr = calcATR(candles, 14);
  let stop: number, target: number;
  
  // In chop (ADX < 28 + RANGE), use tighter targets
  const isChop = structure === "RANGE" && adx < 28;
  const targetMult = isChop ? 1.5 : 2.5;
  const stopMult = isChop ? 2.0 : 2.5; // Tighter stops in chop too

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

// ─── NEW: Momentum alignment check ───
// For LONG: want stoch rising from below 60, not falling from above 70
// For SHORT: want stoch falling from above 40, not rising from below 30
function isMomentumAligned(direction: Direction, stochK: number, stochD: number, rsi: number): boolean {
  if (direction === "LONG") {
    // Stoch should be rising (K > D) and not deep overbought
    if (stochK < stochD) return false; // falling momentum
    if (stochK > 85 && stochD > 80) return false; // extremely overbought
    if (rsi > 70) return false; // RSI overbought
    return true;
  } else {
    // Stoch should be falling (K < D) and not deep oversold
    if (stochK > stochD) return false; // rising momentum
    if (stochK < 15 && stochD < 20) return false; // extremely oversold
    if (rsi < 30) return false; // RSI oversold
    return true;
  }
}

// ─── NEW: 1H confirmation check ───
// After 4H break, 1H should be moving in same direction
function is1HConfirming(direction: Direction, candles1h: Candle[]): boolean {
  const len = candles1h.length;
  // Check last 3 candles on 1H
  const recent = candles1h.slice(-3);
  if (direction === "LONG") {
    // At least 2 of last 3 candles should be bullish
    const bullish = recent.filter(c => c.close > c.open).length;
    return bullish >= 2;
  } else {
    // At least 2 of last 3 candles should be bearish
    const bearish = recent.filter(c => c.close < c.open).length;
    return bearish >= 2;
  }
}

function getTrendlineKey(pair: string, line: Trendline): string {
  return `${pair}_${line.isSupport ? "S" : "R"}_${line.slope.toFixed(4)}_${line.intercept.toFixed(2)}`;
}

export async function generateSignal(
  pair: string,
  candles1h: Candle[],
  candles4h: Candle[],
  activeTrades: Record<string, { trendlineKey: string; timestamp: number }> = {}
): Promise<{ signal: Signal | null; market: MarketData }> {
  const current4h = candles4h[candles4h.length - 1];
  const prev4h = candles4h[candles4h.length - 2];
  const price = current4h.close;
  const structure4h = getStructure(candles4h);
  const structure1h = getStructure(candles1h);
  const adx4h = calcADX(candles4h, 14);
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

  // ─── CHOP FILTER: No PRIMARY trades in heavy chop ───
  const isChop = structure4h === "RANGE" && adx4h < 25;
  if (isChop) {
    return { 
      signal: null, 
      market 
    };
  }

  const highs4h = swingHighs(candles4h, 3);
  const lows4h = swingLows(candles4h, 3);
  const resistance4h = findTrendlines(candles4h, highs4h, false);
  const support4h = findTrendlines(candles4h, lows4h, true);

  let bestSignal: Signal | null = null;
  let bestScore = 0;

  // ─── 4H RESISTANCE BREAKDOWN → PRIMARY SHORT ───
  for (const line of resistance4h) {
    if (isTrendlineExpired(line, candles4h.length - 1)) continue;
    
    const lineAge = candles4h.length - 1 - line.endIdx;
    if (lineAge < 3) continue; // Too fresh, need confirmation

    const linePrice = line.slope * (candles4h.length - 1) + line.intercept;
    const trendlineKey = getTrendlineKey(pair, line);

    // Check cooldown
    const existing = activeTrades[pair];
    if (existing && existing.trendlineKey === trendlineKey && Date.now() - existing.timestamp < 4 * 60 * 60 * 1000) {
      continue;
    }

    // 4H close confirmation: prev candle above line, current below
    if (prev4h.close > linePrice && current4h.close < linePrice) {
      // 1H confirmation: 1H should be bearish
      if (!is1HConfirming("SHORT", candles1h)) continue;
      
      // Momentum alignment: don't short into rising stoch
      if (!isMomentumAligned("SHORT", stoch.k, stoch.d, rsi)) continue;

      const { stop, target, rr, isChop: chopFlag } = findStopAndTarget(candles4h, "SHORT", price, structure4h, adx4h);
      
      // In chop, only CHEEKY; in trend, PRIMARY
      const type: SignalType = chopFlag ? "CHEEKY" : "PRIMARY";
      const minConf = chopFlag ? 50 : 65;
      const minRR = chopFlag ? 1.2 : 1.5;

      const confidence = Math.min(100, 70 + (line.touches.length * 5) + (adx4h > 25 ? 10 : 0));

      if (confidence >= minConf && rr >= minRR) {
        const score = confidence * rr;
        if (score > bestScore) {
          bestScore = score;
          const expectedMove = ((price - target) / price) * 100;
          bestSignal = {
            pair, direction: "SHORT", type, confidence, entry: price, stop, target, rr,
            reason: `BREAKDOWN SHORT | SRC:4H_${type} | TL(${line.touches.length}touches,RESISTANCE,slope:${line.slope.toFixed(4)},age:${lineAge}bars) | 4H:${structure4h} 1H:${structure1h} | ADX:${adx4h.toFixed(1)} | Stoch:${stoch.k.toFixed(1)}/${stoch.d.toFixed(1)}`,
            timestamp: Date.now(), structure: structure4h, adx: adx4h, rsi, stochK: stoch.k, stochD: stoch.d, expectedMove,
            candles1h, candles4h, trendlineKey,
          };
        }
      }
    }
  }

  // ─── 4H SUPPORT BREAKUP → PRIMARY LONG ───
  for (const line of support4h) {
    if (isTrendlineExpired(line, candles4h.length - 1)) continue;
    
    const lineAge = candles4h.length - 1 - line.endIdx;
    if (lineAge < 3) continue;

    const linePrice = line.slope * (candles4h.length - 1) + line.intercept;
    const trendlineKey = getTrendlineKey(pair, line);

    // Check cooldown
    const existing = activeTrades[pair];
    if (existing && existing.trendlineKey === trendlineKey && Date.now() - existing.timestamp < 4 * 60 * 60 * 1000) {
      continue;
    }

    // 4H close confirmation
    if (prev4h.close < linePrice && current4h.close > linePrice) {
      // 1H confirmation: 1H should be bullish
      if (!is1HConfirming("LONG", candles1h)) continue;
      
      // Momentum alignment: don't long into falling stoch
      if (!isMomentumAligned("LONG", stoch.k, stoch.d, rsi)) continue;

      const { stop, target, rr, isChop: chopFlag } = findStopAndTarget(candles4h, "LONG", price, structure4h, adx4h);
      
      const type: SignalType = chopFlag ? "CHEEKY" : "PRIMARY";
      const minConf = chopFlag ? 50 : 65;
      const minRR = chopFlag ? 1.2 : 1.5;

      const confidence = Math.min(100, 70 + (line.touches.length * 5) + (adx4h > 25 ? 10 : 0));

      if (confidence >= minConf && rr >= minRR) {
        const score = confidence * rr;
        if (score > bestScore) {
          bestScore = score;
          const expectedMove = ((target - price) / price) * 100;
          bestSignal = {
            pair, direction: "LONG", type, confidence, entry: price, stop, target, rr,
            reason: `BREAKUP LONG | SRC:4H_${type} | TL(${line.touches.length}touches,SUPPORT,slope:${line.slope.toFixed(4)},age:${lineAge}bars) | 4H:${structure4h} 1H:${structure1h} | ADX:${adx4h.toFixed(1)} | Stoch:${stoch.k.toFixed(1)}/${stoch.d.toFixed(1)}`,
            timestamp: Date.now(), structure: structure4h, adx: adx4h, rsi, stochK: stoch.k, stochD: stoch.d, expectedMove,
            candles1h, candles4h, trendlineKey,
          };
        }
      }
    }
  }

  return { signal: bestSignal, market };
}
