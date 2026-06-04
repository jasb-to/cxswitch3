export type Symbol = "BTC" | "ETH" | "SOL";
export type SignalState = "SNIPER" | "WAIT";
export type SetupType = "NONE" | "PULLBACK";
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
  return trs.slice(-period).reduce((a, b) => a + b, 0) / period;
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
  for (let i = period + 1; i < closes.length; i++) {
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
    rawK.push(((closes[i] - Math.min(...slice)) / (Math.max(...slice) - Math.min(...slice) || 1)) * 100);
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

/* ---------------- STRUCTURE (simple) ---------------- */
function getStructure(candles: Candle[]): Structure {
  if (!ok(candles, 10)) return "RANGE";
  const highs: number[] = [], lows: number[] = [];
  for (let i = 2; i < candles.length - 2; i++) {
    const c = candles[i], p = candles[i - 1], n = candles[i + 1];
    if (c.high > p.high && c.high > n.high) highs.push(c.high);
    if (c.low < p.low && c.low < n.low) lows.push(c.low);
  }
  const lastH = highs.slice(-3), lastL = lows.slice(-3);
  if (lastH.length < 3 || lastL.length < 3) return "RANGE";
  const hh = lastH.every((v, i, a) => i === 0 || v > a[i - 1]);
  const hl = lastL.every((v, i, a) => i === 0 || v > a[i - 1]);
  const lh = lastH.every((v, i, a) => i === 0 || v < a[i - 1]);
  const ll = lastL.every((v, i, a) => i === 0 || v < a[i - 1]);
  if (hh && hl) return "UPTREND";
  if (lh && ll) return "DOWNTREND";
  return "RANGE";
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

  // Hard guard
  if (!ok(candles15m, 30) || !ok(candles1h, 20) || !ok(candles4h, 20)) {
    return {
      symbol, price: round(price ?? 0), state: "WAIT", setup: "NONE", structure: "RANGE",
      bias: "NEUTRAL", confidence: 0, adx: 0, atr: 0, stochK: 50, stochD: 50, rsi: 50,
      reason: "NO DATA", stopLoss: null, takeProfit: null, rr: null, expectedMove: 0, updatedAt: now
    };
  }

  const c15 = candles15m!, c1h = candles1h!, c4h = candles4h!;

  // 4H structure = bias only
  const structure4h = getStructure(c4h);
  const bias = structure4h === "UPTREND" ? "LONG" : structure4h === "DOWNTREND" ? "SHORT" : "NEUTRAL";

  // If no trend, WAIT — no exceptions
  if (bias === "NEUTRAL") {
    return {
      symbol, price: round(price), state: "WAIT", setup: "NONE", structure: "RANGE",
      bias: "NEUTRAL", confidence: 0, adx: 0, atr: 0, stochK: 50, stochD: 50, rsi: 50,
      reason: "4H RANGE — NO TRADE", stopLoss: null, takeProfit: null, rr: null, expectedMove: 0, updatedAt: now
    };
  }

  // Indicators
  const closes15 = c15.map(c => c.close);
  const r15 = rsi(closes15);
  const s15 = stoch(closes15);
  const a15 = atr(c15);

  // PULLBACK DETECTION ONLY
  // Long: price below last 5 candles high, stoch crossed up from below 30
  // Short: price above last 5 candles low, stoch crossed down from above 70
  const recent5 = c15.slice(-5);
  const recentHigh = Math.max(...recent5.map(c => c.high));
  const recentLow = Math.min(...recent5.map(c => c.low));

  let setup: SetupType = "NONE";

  if (bias === "LONG") {
    const priceBelowRecent = price < recentHigh * 0.995; // at least 0.5% off recent high
    const stochCrossUp = s15.prevK < s15.prevD && s15.k > s15.d && s15.k < 50; // crossed up, not overbought
    if (priceBelowRecent && stochCrossUp && r15 > 30 && r15 < 60) {
      setup = "PULLBACK";
    }
  } else {
    const priceAboveRecent = price > recentLow * 1.005;
    const stochCrossDown = s15.prevK > s15.prevD && s15.k < s15.d && s15.k > 50;
    if (priceAboveRecent && stochCrossDown && r15 > 40 && r15 < 70) {
      setup = "PULLBACK";
    }
  }

  // No breakout trades, no reversal trades — only pullback entries in trend
  if (setup === "NONE") {
    return {
      symbol, price: round(price), state: "WAIT", setup: "NONE", structure: structure4h,
      bias, confidence: 0, adx: 0, atr: round(a15, 2), stochK: round(s15.k), stochD: round(s15.d),
      rsi: round(r15), reason: `NO PULLBACK — ${bias} | Stoch:${round(s15.k)}/${round(s15.d)} | RSI:${round(r15)}`,
      stopLoss: null, takeProfit: null, rr: null, expectedMove: 0, updatedAt: now
    };
  }

  // ATR-based sizing — 3% target for 6-8h holds
  const atrPct = a15 / price;
  const expectedMove = Math.max(0.02, Math.min(0.04, atrPct * 2)); // 2-4% based on vol

  const sl = bias === "LONG" ? price * (1 - expectedMove * 0.5) : price * (1 + expectedMove * 0.5);
  const tp = bias === "LONG" ? price * (1 + expectedMove) : price * (1 - expectedMove);
  const rr = Math.abs((tp - price) / (price - sl));

  // Confidence: only high if everything aligns
  let confidence = 70;
  if (r15 > 40 && r15 < 60) confidence += 10; // RSI in sweet spot
  if (Math.abs(s15.k - s15.d) < 15) confidence += 10; // stoch lines close = fresh cross
  if (expectedMove >= 0.03) confidence += 10; // decent vol

  return {
    symbol, price: round(price), state: "SNIPER", setup: "PULLBACK", structure: structure4h, bias,
    confidence: Math.min(confidence, 95), adx: 0, atr: round(a15, 2),
    stochK: round(s15.k), stochD: round(s15.d), rsi: round(r15),
    reason: `SNIPER PULLBACK ${bias} | 4H:${structure4h} | Stoch cross | RSI:${round(r15)}`,
    stopLoss: round(sl, 2), takeProfit: round(tp, 2), rr: round(rr, 2),
    expectedMove: round(expectedMove * 100, 2), updatedAt: now
  };
}
