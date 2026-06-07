export type Symbol = "BTC" | "ETH" | "SOL";

export type SignalState = "PRIMARY" | "CHEEKY" | "WAIT";

export type SetupType = "NONE" | "PULLBACK" | "BREAKDOWN" | "BREAKUP";

export type Structure = "UPTREND" | "DOWNTREND" | "RANGE";

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface Signal {
  symbol: Symbol;
  price: number;
  state: SignalState;
  setup: SetupType;
  structure: Structure;
  bias: "LONG" | "SHORT" | "NEUTRAL";
  confidence: number;
  adx: number;
  atr: number;
  stochK: number;
  stochD: number;
  rsi: number;
  reason: string;
  stopLoss: number | null;
  takeProfit: number | null;
  rr: number | null;
  expectedMove: number;
  updatedAt: string;
  entryTimeframe?: "1H" | "15M" | "NONE";
  higherTimeframeStoch?: string;
}

const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
const ok = (c: Candle[] | null | undefined, min: number) => Array.isArray(c) && c.length >= min;

/* ---------------- ATR ---------------- */
function atr(candles: Candle[], period = 14): number {
  if (!ok(candles, period + 1)) return 0;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
  }
  const slice = trs.slice(-period);
  return slice.length > 0 ? slice.reduce((a, b) => a + b, 0) / slice.length : 0;
}

/* ---------------- RSI ---------------- */
function rsi(closes: number[], period = 14): number {
  if (closes.length < period + 1) return 50;
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) avgGain += diff; else avgLoss -= diff;
  }
  avgGain /= period; avgLoss /= period;
  for (let i = period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(diff, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-diff, 0)) / period;
  }
  const rs = avgGain / (avgLoss || 1);
  return 100 - 100 / (1 + rs);
}

/* ---------------- STOCH ---------------- */
function stoch(closes: number[], period = 14, smoothK = 3, smoothD = 3) {
  const minLen = period + smoothK + smoothD;
  if (closes.length < minLen) return { k: 50, d: 50, prevK: 50, prevD: 50 };
  const rawK: number[] = [];
  for (let i = period - 1; i < closes.length; i++) {
    const slice = closes.slice(i - period + 1, i + 1);
    const high = Math.max(...slice);
    const low = Math.min(...slice);
    const range = high - low;
    rawK.push(range > 0 ? ((closes[i] - low) / range) * 100 : 50);
  }
  const sma = (arr: number[], len: number) => {
    const out: number[] = [];
    for (let i = len - 1; i < arr.length; i++) out.push(arr.slice(i - len + 1, i + 1).reduce((a, b) => a + b, 0) / len);
    return out;
  };
  const k = sma(rawK, smoothK);
  const d = sma(k, smoothD);
  return { k: k.at(-1) ?? 50, d: d.at(-1) ?? 50, prevK: k.at(-2) ?? 50, prevD: d.at(-2) ?? 50 };
}

/* ---------------- ADX ---------------- */
function adx(candles: Candle[], period = 14): number {
  if (!ok(candles, period * 2 + 1)) return 25;
  const trs: number[] = [];
  const plusDMs: number[] = [];
  const minusDMs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
    const upMove = c.high - p.high;
    const downMove = p.low - c.low;
    plusDMs.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDMs.push(downMove > upMove && downMove > 0 ? downMove : 0);
  }
  let atrSmooth = trs.slice(0, period).reduce((a, b) => a + b, 0);
  let plusDISmooth = plusDMs.slice(0, period).reduce((a, b) => a + b, 0);
  let minusDISmooth = minusDMs.slice(0, period).reduce((a, b) => a + b, 0);
  const dxVals: number[] = [];
  for (let i = period; i < trs.length; i++) {
    atrSmooth = (atrSmooth * (period - 1) + trs[i]) / period;
    plusDISmooth = (plusDISmooth * (period - 1) + plusDMs[i]) / period;
    minusDISmooth = (minusDISmooth * (period - 1) + minusDMs[i]) / period;
    const plusDI = 100 * plusDISmooth / (atrSmooth || 1);
    const minusDI = 100 * minusDISmooth / (atrSmooth || 1);
    const dx = Math.abs(plusDI - minusDI) / ((plusDI + minusDI) || 1) * 100;
    dxVals.push(dx);
  }
  if (dxVals.length < period) return 25;
  let adxVal = dxVals.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < dxVals.length; i++) {
    adxVal = (adxVal * (period - 1) + dxVals[i]) / period;
  }
  return adxVal;
}

/* ---------------- FRACTAL SWINGS ---------------- */
function getSwings(candles: Candle[], lookback = 2): { highs: { value: number; idx: number }[]; lows: { value: number; idx: number }[] } {
  const highs: { value: number; idx: number }[] = [];
  const lows: { value: number; idx: number }[] = [];
  for (let i = lookback; i < candles.length - lookback; i++) {
    const c = candles[i];
    let isHigh = true, isLow = true;
    for (let j = 1; j <= lookback; j++) {
      if (c.high <= candles[i - j].high || c.high <= candles[i + j].high) isHigh = false;
      if (c.low >= candles[i - j].low || c.low >= candles[i + j].low) isLow = false;
    }
    if (isHigh) highs.push({ value: c.high, idx: i });
    else if (isLow) lows.push({ value: c.low, idx: i });
  }
  return { highs, lows };
}

/* ---------------- STRUCTURE (3-bar fractals, 3 swings) ---------------- */
function getStructure(candles: Candle[]): Structure {
  const { highs, lows } = getSwings(candles, 2);
  const lastH = highs.slice(-3), lastL = lows.slice(-3);
  if (lastH.length < 3 || lastL.length < 3) return "RANGE";
  const hh = lastH[2].value > lastH[1].value && lastH[1].value > lastH[0].value;
  const hl = lastL[2].value > lastL[1].value && lastL[1].value > lastL[0].value;
  const lh = lastH[2].value < lastH[1].value && lastH[1].value < lastH[0].value;
  const ll = lastL[2].value < lastL[1].value && lastL[1].value < lastL[0].value;
  if (hh && hl) return "UPTREND";
  if (lh && ll) return "DOWNTREND";
  return "RANGE";
}

/* ---------------- TRENDLINE FROM SWINGS ---------------- */
interface Trendline {
  slope: number;
  intercept: number;
  startIdx: number;
  endIdx: number;
  touches: number;
  type: "RESISTANCE" | "SUPPORT";
  createdAt: number; // candle index when line was first fitted
}

function fitTrendline(points: { value: number; idx: number }[], createdAt: number): Trendline | null {
  if (points.length < 2) return null;
  const n = points.length;
  let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
  for (const p of points) {
    sumX += p.idx;
    sumY += p.value;
    sumXY += p.idx * p.value;
    sumXX += p.idx * p.idx;
  }
  const denom = n * sumXX - sumX * sumX;
  if (Math.abs(denom) < 1e-10) return null;
  const slope = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;
  return {
    slope, intercept,
    startIdx: points[0].idx,
    endIdx: points[n - 1].idx,
    touches: n,
    type: slope > 0 ? "SUPPORT" : "RESISTANCE",
    createdAt
  };
}

function getTrendlines(candles: Candle[], isHighs: boolean, minTouches = 2, maxLookbackCandles = 50): Trendline[] {
  const { highs, lows } = getSwings(candles, 2);
  const points = isHighs ? highs : lows;
  if (points.length < minTouches) return [];

  const recentPoints = points.filter(p => p.idx >= candles.length - maxLookbackCandles);
  if (recentPoints.length < minTouches) return [];

  const lines: Trendline[] = [];

  for (let i = 0; i < recentPoints.length - 1; i++) {
    for (let j = i + 1; j < recentPoints.length; j++) {
      const subset = recentPoints.slice(i, j + 1);
      const line = fitTrendline(subset, candles.length - maxLookbackCandles);
      if (!line) continue;

      let touches = 0;
      for (const p of points) {
        const expected = line.slope * p.idx + line.intercept;
        const actual = p.value;
        const tolerance = expected * 0.003;
        if (Math.abs(actual - expected) <= tolerance) touches++;
      }

      if (touches >= minTouches) {
        lines.push({ ...line, touches });
      }
    }
  }

  const unique: Trendline[] = [];
  for (const line of lines) {
    const isDup = unique.some(u => 
      Math.abs(u.slope - line.slope) < 0.0001 && 
      Math.abs(u.intercept - line.intercept) < u.intercept * 0.01
    );
    if (!isDup) unique.push(line);
  }

  return unique.sort((a, b) => b.touches - a.touches || b.endIdx - a.endIdx);
}

function getActiveTrendlineValue(line: Trendline, currentIdx: number): number {
  return line.slope * currentIdx + line.intercept;
}

function isTrendlineBroken(
  candles: Candle[],
  line: Trendline,
  direction: "ABOVE" | "BELOW",
  confirmCandles = 1
): { broken: boolean; breakPrice: number; breakCandle: number } {
  const lastIdx = candles.length - 1;
  const lineValue = getActiveTrendlineValue(line, lastIdx);

  for (let i = 0; i <= confirmCandles && lastIdx - i >= 0; i++) {
    const c = candles[lastIdx - i];
    if (direction === "ABOVE" && c.close > lineValue * 1.001) {
      return { broken: true, breakPrice: c.close, breakCandle: lastIdx - i };
    }
    if (direction === "BELOW" && c.close < lineValue * 0.999) {
      return { broken: true, breakPrice: c.close, breakCandle: lastIdx - i };
    }
  }
  return { broken: false, breakPrice: 0, breakCandle: -1 };
}

function isTrendlineExpired(line: Trendline, currentCandleCount: number, maxAgeCandles = 80): boolean {
  // Trendline expires if it was created too long ago
  const age = currentCandleCount - line.createdAt;
  return age > maxAgeCandles;
}

/* ---------------- SIGNAL DEDUPLICATION (prevent churn) ---------------- */
interface ActiveSignal {
  symbol: Symbol;
  setup: SetupType;
  bias: "LONG" | "SHORT";
  trendlineSlope: number;
  trendlineTouches: number;
  entryPrice: number;
  timestamp: number;
}

const activeSignals: Map<string, ActiveSignal> = new Map();

function getSignalKey(symbol: Symbol, setup: SetupType, bias: string, slope: number): string {
  return `${symbol}:${setup}:${bias}:slope${round(slope, 2)}`;
}

function isChurn(symbol: Symbol, setup: SetupType, bias: "LONG" | "SHORT", line: Trendline | null, price: number): boolean {
  if (!line) return false;

  const key = getSignalKey(symbol, setup, bias, line.slope);
  const existing = activeSignals.get(key);

  if (!existing) return false;

  const priceMove = Math.abs(price - existing.entryPrice) / existing.entryPrice;
  const timeSince = Date.now() - existing.timestamp;
  const minTimeBetween = 4 * 60 * 60 * 1000; // 4 hours minimum

  if (timeSince < minTimeBetween && priceMove < 0.02) {
    return true;
  }

  return false;
}

function recordSignal(symbol: Symbol, setup: SetupType, bias: "LONG" | "SHORT", line: Trendline | null, price: number) {
  if (!line) return;
  const key = getSignalKey(symbol, setup, bias, line.slope);
  activeSignals.set(key, {
    symbol, setup, bias,
    trendlineSlope: line.slope,
    trendlineTouches: line.touches,
    entryPrice: price,
    timestamp: Date.now()
  });
}

function cleanupOldSignals() {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const [key, sig] of activeSignals) {
    if (sig.timestamp < cutoff) activeSignals.delete(key);
  }
}

/* ---------------- CORE ENGINE ---------------- */
export function generateSignal(
  symbol: Symbol,
  price: number,
  candles15m: Candle[] | null | undefined,
  candles1h: Candle[] | null | undefined,
  candles4h: Candle[] | null | undefined
): Signal {
  const now = new Date().toISOString();

  if (!ok(candles1h, 50) || !ok(candles4h, 50)) {
    return {
      symbol, price: round(price ?? 0), state: "WAIT", setup: "NONE", structure: "RANGE",
      bias: "NEUTRAL", confidence: 0, adx: 0, atr: 0, stochK: 50, stochD: 50, rsi: 50,
      reason: "INSUFFICIENT DATA (need 1H+4H)", stopLoss: null, takeProfit: null, rr: null, expectedMove: 0,
      updatedAt: now, entryTimeframe: "NONE", higherTimeframeStoch: "N/A"
    };
  }

  const c1h = candles1h!, c4h = candles4h!;

  const price1h = c1h.at(-1)!.close;
  const price4h = c4h.at(-1)!.close;

  const structure4h = getStructure(c4h);
  const structure1h = getStructure(c1h);

  const closes1h = c1h.map(c => c.close);
  const closes4h = c4h.map(c => c.close);
  const r1h = rsi(closes1h);
  const r4h = rsi(closes4h);
  const s1h = stoch(closes1h);
  const s4h = stoch(closes4h);
  const a1h = atr(c1h);
  const a4h = atr(c4h);
  const adx1h = adx(c1h);
  const adx4h = adx(c4h);

  // ========== HARD CHOP FILTER ==========
  if (structure4h === "RANGE" && adx4h < 20) {
    return {
      symbol, price: round(price4h), state: "WAIT", setup: "NONE", structure: "RANGE",
      bias: "NEUTRAL", confidence: 0, adx: round(adx4h), atr: round(a4h, 2),
      stochK: round(s4h.k), stochD: round(s4h.d), rsi: round(r4h),
      reason: `WAIT | 4H RANGING (ADX:${round(adx4h)}) — NO EDGE IN CHOP`,
      stopLoss: null, takeProfit: null, rr: null, expectedMove: 0,
      updatedAt: now, entryTimeframe: "NONE",
      higherTimeframeStoch: `4H:${round(s4h.k)}/${round(s4h.d)} | 1H:${round(s1h.k)}/${round(s1h.d)}`
    };
  }

  // ========== TRENDLINE DETECTION ==========
  const resistance4h = getTrendlines(c4h, true, 2, 60).filter(l => !isTrendlineExpired(l, c4h.length, 80));
  const support4h = getTrendlines(c4h, false, 2, 60).filter(l => !isTrendlineExpired(l, c4h.length, 80));
  const resistance1h = getTrendlines(c1h, true, 2, 40).filter(l => !isTrendlineExpired(l, c1h.length, 60));
  const support1h = getTrendlines(c1h, false, 2, 40).filter(l => !isTrendlineExpired(l, c1h.length, 60));

  // ========== 4H PRIMARY: TRENDLINE BREAK ==========
  let setup: SetupType = "NONE";
  let entryBias: "LONG" | "SHORT" | "NEUTRAL" = "NEUTRAL";
  let entryTimeframe: "1H" | "15M" | "NONE" = "NONE";
  let primaryRsi = r4h;
  let primaryAdx = adx4h;
  let primaryStochK = s4h.k;
  let primaryStochD = s4h.d;
  let breakLine: Trendline | null = null;
  let breakInfo: { broken: boolean; breakPrice: number; breakCandle: number } | null = null;
  let signalSource: "4H_PRIMARY" | "1H_CHEEKY" | "NONE" = "NONE";

  // 4H RESISTANCE BREAK (LONG)
  for (const line of resistance4h) {
    const info = isTrendlineBroken(c4h, line, "ABOVE", 0);
    if (info.broken) {
      const hasMomentum = r4h > 45 || s4h.k > s4h.d;
      const notExhausted = s4h.k < 90 && r4h < 80;
      if (hasMomentum && notExhausted) {
        setup = "BREAKUP";
        entryBias = "LONG";
        entryTimeframe = "1H";
        signalSource = "4H_PRIMARY";
        breakLine = line;
        breakInfo = info;
        break;
      }
    }
  }

  // 4H SUPPORT BREAK (SHORT)
  if (setup === "NONE") {
    for (const line of support4h) {
      const info = isTrendlineBroken(c4h, line, "BELOW", 0);
      if (info.broken) {
        const hasMomentum = r4h < 55 || s4h.k < s4h.d;
        const notExhausted = s4h.k > 10 && r4h > 20;
        if (hasMomentum && notExhausted) {
          setup = "BREAKDOWN";
          entryBias = "SHORT";
          entryTimeframe = "1H";
          signalSource = "4H_PRIMARY";
          breakLine = line;
          breakInfo = info;
          break;
        }
      }
    }
  }

  // ========== 1H CHEEKY: TRENDLINE BREAK (only if no 4H setup) ==========
  if (setup === "NONE") {
    for (const line of resistance1h) {
      const info = isTrendlineBroken(c1h, line, "ABOVE", 0);
      if (info.broken) {
        const fourHourOk = structure4h !== "DOWNTREND" || r4h > 40;
        const notExhausted = s1h.k < 85 && r1h < 75;
        if (fourHourOk && notExhausted) {
          setup = "BREAKUP";
          entryBias = "LONG";
          entryTimeframe = "1H";
          primaryRsi = r1h;
          primaryAdx = adx1h;
          primaryStochK = s1h.k;
          primaryStochD = s1h.d;
          signalSource = "1H_CHEEKY";
          breakLine = line;
          breakInfo = info;
          break;
        }
      }
    }

    if (setup === "NONE") {
      for (const line of support1h) {
        const info = isTrendlineBroken(c1h, line, "BELOW", 0);
        if (info.broken) {
          const fourHourOk = structure4h !== "UPTREND" || r4h < 60;
          const notExhausted = s1h.k > 15 && r1h > 25;
          if (fourHourOk && notExhausted) {
            setup = "BREAKDOWN";
            entryBias = "SHORT";
            entryTimeframe = "1H";
            primaryRsi = r1h;
            primaryAdx = adx1h;
            primaryStochK = s1h.k;
            primaryStochD = s1h.d;
            signalSource = "1H_CHEEKY";
            breakLine = line;
            breakInfo = info;
            break;
          }
        }
      }
    }
  }

  // ========== WAIT STATE ==========
  if (setup === "NONE") {
    const trend4h = structure4h === "UPTREND" ? "BULLISH" : structure4h === "DOWNTREND" ? "BEARISH" : "RANGING";
    const adxDesc = adx4h > 25 ? "STRONG" : adx4h > 15 ? "MODERATE" : "WEAK";

    const has4hRes = resistance4h.length > 0;
    const has4hSup = support4h.length > 0;
    const has1hRes = resistance1h.length > 0;
    const has1hSup = support1h.length > 0;

    const near4hRes = has4hRes ? getActiveTrendlineValue(resistance4h[0], c4h.length - 1) : 0;
    const near4hSup = has4hSup ? getActiveTrendlineValue(support4h[0], c4h.length - 1) : 0;
    const distToRes = has4hRes ? Math.abs(price4h - near4hRes) / price4h * 100 : 999;
    const distToSup = has4hSup ? Math.abs(price4h - near4hSup) / price4h * 100 : 999;

    let waitReason = `WAIT | 4H:${trend4h}(${adxDesc})`;
    if (distToRes < 1.5) waitReason += ` | NEAR 4H RES ${round(near4hRes)}`;
    if (distToSup < 1.5) waitReason += ` | NEAR 4H SUP ${round(near4hSup)}`;
    if (!has4hRes && !has4hSup) waitReason += ` | NO 4H TRENDLINES`;
    if (has1hRes || has1hSup) waitReason += ` | 1H TLs ACTIVE`;

    return {
      symbol, price: round(price4h), state: "WAIT", setup: "NONE", structure: structure4h,
      bias: structure4h === "UPTREND" ? "LONG" : structure4h === "DOWNTREND" ? "SHORT" : "NEUTRAL",
      confidence: 0, adx: round(adx4h), atr: round(a4h, 2),
      stochK: round(s4h.k), stochD: round(s4h.d), rsi: round(r4h),
      reason: waitReason,
      stopLoss: null, takeProfit: null, rr: null, expectedMove: 0,
      updatedAt: now, entryTimeframe: "NONE",
      higherTimeframeStoch: `4H:${round(s4h.k)}/${round(s4h.d)} | 1H:${round(s1h.k)}/${round(s1h.d)}`
    };
  }

  // ========== ANTI-CHURN CHECK ==========
  const priceForSizing = entryTimeframe === "1H" ? price1h : price4h;

  if (isChurn(symbol, setup, entryBias, breakLine, priceForSizing)) {
    return {
      symbol, price: round(price4h), state: "WAIT", setup: "NONE", structure: structure4h,
      bias: entryBias, confidence: 0, adx: round(adx4h), atr: round(a4h, 2),
      stochK: round(s4h.k), stochD: round(s4h.d), rsi: round(r4h),
      reason: `WAIT | SAME TRENDLINE ACTIVE (slope:${breakLine ? round(breakLine.slope, 2) : "N/A"}) — NO CHURN`,
      stopLoss: null, takeProfit: null, rr: null, expectedMove: 0,
      updatedAt: now, entryTimeframe: "NONE",
      higherTimeframeStoch: `4H:${round(s4h.k)}/${round(s4h.d)} | 1H:${round(s1h.k)}/${round(s1h.d)}`
    };
  }

  // Record this signal to prevent future churn
  recordSignal(symbol, setup, entryBias, breakLine, priceForSizing);
  cleanupOldSignals();

  // ========== STATE ASSIGNMENT ==========
  const state: SignalState = signalSource === "4H_PRIMARY" ? "PRIMARY" : "CHEEKY";

  // ========== ADAPTIVE SIZING FOR RANGE MARKETS ==========
  const atrForSizing = entryTimeframe === "1H" ? a1h : a4h;
  const atrPct = atrForSizing / priceForSizing;

  const isRanging = structure4h === "RANGE";
  const adxExpansion = primaryAdx > 50 ? 1.5 : 1.0;
  const rangePenalty = isRanging ? 0.7 : 1.0;
  const atrMultiplier = 2.5;

  // Wider stops in high-ADX range, tighter targets
  const expectedMove = Math.max(0.02, Math.min(0.08, atrPct * atrMultiplier * 1.5 * adxExpansion * rangePenalty));

  const minSlPct = 0.005;
  const maxSlPct = 0.025;

  let sl: number;
  if (entryBias === "LONG") {
    const atrSl = priceForSizing * (1 - Math.max(minSlPct, Math.min(maxSlPct, expectedMove * 0.45)));
    const trendlineSl = breakLine ? getActiveTrendlineValue(breakLine, c1h.length - 1) * 0.997 : atrSl;
    sl = Math.max(atrSl, trendlineSl);
    if (sl >= priceForSizing) sl = atrSl;
  } else {
    const atrSl = priceForSizing * (1 + Math.max(minSlPct, Math.min(maxSlPct, expectedMove * 0.45)));
    const trendlineSl = breakLine ? getActiveTrendlineValue(breakLine, c1h.length - 1) * 1.003 : atrSl;
    sl = Math.min(atrSl, trendlineSl);
    if (sl <= priceForSizing) sl = atrSl;
  }

  const tp = entryBias === "LONG" ? priceForSizing * (1 + expectedMove) : priceForSizing * (1 - expectedMove);
  const rr = Math.abs((tp - priceForSizing) / (priceForSizing - sl));

  // ========== CONFIDENCE ==========
  let confidence = 50;

  if (signalSource === "4H_PRIMARY") confidence += 25;
  else confidence += 10;

  if (setup === "BREAKUP" || setup === "BREAKDOWN") confidence += 10;

  if (primaryAdx > 30) confidence += 15;
  else if (primaryAdx > 20) confidence += 8;
  else if (primaryAdx < 15) confidence -= 15;

  if (entryBias === "LONG" && structure4h === "UPTREND") confidence += 10;
  if (entryBias === "SHORT" && structure4h === "DOWNTREND") confidence += 10;
  if (entryBias === "LONG" && s4h.k > s4h.d) confidence += 5;
  if (entryBias === "SHORT" && s4h.k < s4h.d) confidence += 5;

  if (entryBias === "LONG" && primaryRsi > 45 && primaryRsi < 75) confidence += 5;
  if (entryBias === "SHORT" && primaryRsi < 55 && primaryRsi > 25) confidence += 5;

  if (breakLine && breakLine.touches >= 3) confidence += 8;
  if (breakLine && breakLine.touches >= 4) confidence += 5;

  const stochDiff = Math.abs(primaryStochK - primaryStochD);
  if (stochDiff > 5) confidence += 3;

  if (entryBias === "LONG") {
    if (primaryStochK > 90) confidence -= 20;
    if (primaryRsi > 80) confidence -= 15;
    if (s4h.k > 90 && s4h.k > s4h.d) confidence -= 10;
  } else {
    if (primaryStochK < 10) confidence -= 20;
    if (primaryRsi < 20) confidence -= 15;
    if (s4h.k < 10 && s4h.k < s4h.d) confidence -= 10;
  }

  if (signalSource === "1H_CHEEKY") {
    if (entryBias === "LONG" && structure4h === "DOWNTREND") confidence -= 15;
    if (entryBias === "SHORT" && structure4h === "UPTREND") confidence -= 15;
  }

  confidence = Math.max(0, Math.min(100, confidence));

  // ========== REASON STRING ==========
  const tlInfo = breakLine 
    ? `TL(${breakLine.touches}touches,${breakLine.type},slope:${round(breakLine.slope,4)},age:${c4h.length - breakLine.createdAt}bars)` 
    : "NO_TL";

  return {
    symbol,
    price: round(priceForSizing),
    state,
    setup,
    structure: structure4h,
    bias: entryBias,
    confidence,
    adx: round(primaryAdx),
    atr: round(atrForSizing, 2),
    stochK: round(primaryStochK),
    stochD: round(primaryStochD),
    rsi: round(primaryRsi),
    reason: `${state} ${setup} ${entryBias} | SRC:${signalSource} | ${tlInfo} | 4H:${structure4h} 1H:${structure1h} | ADX:${round(primaryAdx)}`,
    stopLoss: round(sl, 4),
    takeProfit: round(tp, 4),
    rr: round(rr, 2),
    expectedMove: round(expectedMove * 100, 2),
    updatedAt: now,
    entryTimeframe,
    higherTimeframeStoch: `4H:${round(s4h.k)}/${round(s4h.d)} | 1H:${round(s1h.k)}/${round(s1h.d)}`
  };
}
