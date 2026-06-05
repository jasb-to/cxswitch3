export type Symbol = "BTC" | "ETH" | "SOL";

export type SignalState = "EARLY" | "SNIPER" | "WAIT";

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

/* ---------------- STRUCTURE ---------------- */
function getStructure(candles: Candle[]): Structure {
  if (!ok(candles, 5)) return "RANGE";
  const highs: number[] = [], lows: number[] = [];
  for (let i = 1; i < candles.length - 1; i++) {
    const c = candles[i], p = candles[i - 1], n = candles[i + 1];
    if (c.high > p.high && c.high > n.high) highs.push(c.high);
    if (c.low < p.low && c.low < n.low) lows.push(c.low);
  }
  const lastH = highs.slice(-2), lastL = lows.slice(-2);
  if (lastH.length < 2 || lastL.length < 2) return "RANGE";
  const hh = lastH[1] > lastH[0];
  const hl = lastL[1] > lastL[0];
  const lh = lastH[1] < lastH[0];
  const ll = lastL[1] < lastL[0];
  if (hh && hl) return "UPTREND";
  if (lh && ll) return "DOWNTREND";
  return "RANGE";
}

/* ---------------- LAST SWING LEVELS ---------------- */
function getLastSwingLevels(candles: Candle[]) {
  const highs: { value: number; idx: number }[] = [];
  const lows: { value: number; idx: number }[] = [];
  for (let i = 1; i < candles.length - 1; i++) {
    const c = candles[i], p = candles[i - 1], n = candles[i + 1];
    if (c.high > p.high && c.high > n.high) highs.push({ value: c.high, idx: i });
    if (c.low < p.low && c.low < n.low) lows.push({ value: c.low, idx: i });
  }
  return {
    lastHigh: highs.at(-1),
    lastLow: lows.at(-1),
    priorHigh: highs.at(-2),
    priorLow: lows.at(-2),
  };
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

  if (!ok(candles15m, 20) || !ok(candles1h, 10) || !ok(candles4h, 10)) {
    return {
      symbol, price: round(price ?? 0), state: "WAIT", setup: "NONE", structure: "RANGE",
      bias: "NEUTRAL", confidence: 0, adx: 0, atr: 0, stochK: 50, stochD: 50, rsi: 50,
      reason: "INSUFFICIENT DATA", stopLoss: null, takeProfit: null, rr: null, expectedMove: 0, updatedAt: now
    };
  }

  const c15 = candles15m!, c1h = candles1h!, c4h = candles4h!;

  const structure4h = getStructure(c4h);
  const structure1h = getStructure(c1h);
  const bias = structure4h === "UPTREND" ? "LONG" : structure4h === "DOWNTREND" ? "SHORT" : "NEUTRAL";

  const closes15 = c15.map(c => c.close);
  const closes1h = c1h.map(c => c.close);
  const r15 = rsi(closes15);
  const r1h = rsi(closes1h);
  const s15 = stoch(closes15);
  const a15 = atr(c15);

  // Stoch cross with ZONE VALIDATION — no-man's land crosses rejected
  const stochCrossUp = s15.prevK < s15.prevD && s15.k > s15.d;
  const stochCrossDown = s15.prevK > s15.prevD && s15.k < s15.d;

  const validStochLong = stochCrossUp && (s15.prevK < 35 || s15.k < 40);
  const validStochShort = stochCrossDown && (s15.prevK > 65 || s15.k > 60);

  const swings4h = getLastSwingLevels(c4h);
  const swings1h = getLastSwingLevels(c1h);

  let setup: SetupType = "NONE";
  let entryBias: "LONG" | "SHORT" | "NEUTRAL" = bias;

  /* ---- TREND PULLBACK (zone-validated stoch) ---- */
  if (bias === "LONG") {
    if (structure1h !== "DOWNTREND" && validStochLong && r15 < 65 && r1h > 40) {
      setup = "PULLBACK";
    }
  } else if (bias === "SHORT") {
    if (structure1h !== "UPTREND" && validStochShort && r15 > 35 && r1h < 60) {
      setup = "PULLBACK";
    }
  }

  /* ---- BREAKDOWN: 4H swing low broken ---- */
  if (setup === "NONE" && swings4h.lastLow && swings4h.priorLow) {
    const lastLow = swings4h.lastLow.value;
    const priorLow = swings4h.priorLow.value;
    if (price < lastLow * 0.998 && lastLow > priorLow) {
      const broke1h = swings1h.lastLow ? price < swings1h.lastLow.value : false;
      if (broke1h || r1h < 45) {
        setup = "BREAKDOWN";
        entryBias = "SHORT";
      }
    }
  }

  /* ---- BREAKUP: 4H swing high broken ---- */
  if (setup === "NONE" && swings4h.lastHigh && swings4h.priorHigh) {
    const lastHigh = swings4h.lastHigh.value;
    const priorHigh = swings4h.priorHigh.value;
    if (price > lastHigh * 1.002 && lastHigh < priorHigh) {
      const broke1h = swings1h.lastHigh ? price > swings1h.lastHigh.value : false;
      if (broke1h || r1h > 55) {
        setup = "BREAKUP";
        entryBias = "LONG";
      }
    }
  }

  const priorAtr = atr(c15.slice(0, -1), 20);
  const expansion = priorAtr > 0 && (a15 / priorAtr) > 1.2;

  const state: SignalState = (setup !== "NONE" && expansion) ? "SNIPER" : (setup !== "NONE") ? "EARLY" : "WAIT";

  if (state === "WAIT") {
    const issues: string[] = [];
    if (bias === "NEUTRAL") {
      if (swings4h.lastLow && price < swings4h.lastLow.value * 1.005) issues.push("NEAR BREAKDOWN");
      else if (swings4h.lastHigh && price > swings4h.lastHigh.value * 0.995) issues.push("NEAR BREAKUP");
      else issues.push("NO TREND");
    } else {
      if (setup === "NONE") {
        if (bias === "LONG" && !validStochLong) issues.push(stochCrossUp ? "STOCH NO ZONE" : "NO STOCH UP");
        else if (bias === "SHORT" && !validStochShort) issues.push(stochCrossDown ? "STOCH NO ZONE" : "NO STOCH DOWN");
        else issues.push("NO SETUP");
      }
      if (structure1h === "DOWNTREND" && bias === "LONG") issues.push("1H FIGHTING");
      if (structure1h === "UPTREND" && bias === "SHORT") issues.push("1H FIGHTING");
    }
    return {
      symbol, price: round(price), state: "WAIT", setup: "NONE", structure: structure4h, bias,
      confidence: 0, adx: 0, atr: round(a15, 2), stochK: round(s15.k), stochD: round(s15.d),
      rsi: round(r15), reason: `WAIT (${issues.join(", ")})`, stopLoss: null, takeProfit: null,
      rr: null, expectedMove: 0, updatedAt: now
    };
  }

  const atrPct = a15 / price;
  const expectedMove = state === "SNIPER"
    ? Math.max(0.025, Math.min(0.05, atrPct * 2.5))
    : Math.max(0.015, Math.min(0.035, atrPct * 1.8));

  const sl = entryBias === "LONG" ? price * (1 - expectedMove * 0.5) : price * (1 + expectedMove * 0.5);
  const tp = entryBias === "LONG" ? price * (1 + expectedMove) : price * (1 - expectedMove);
  const rr = Math.abs((tp - price) / (price - sl));

  let confidence = state === "SNIPER" ? 85 : 65;
  if (setup === "BREAKDOWN" || setup === "BREAKUP") confidence += 5;
  if (r15 > 40 && r15 < 60) confidence += 5;
  if (Math.abs(s15.k - s15.d) < 10) confidence += 5;

  return {
    symbol, price: round(price), state, setup, structure: structure4h, bias: entryBias,
    confidence: Math.min(confidence, 95), adx: 0, atr: round(a15, 2),
    stochK: round(s15.k), stochD: round(s15.d), rsi: round(r15),
    reason: `${state} ${setup} ${entryBias} | 4H:${structure4h} | 1H:${structure1h}${expansion ? " | EXP" : ""} | Stoch:${round(s15.k)}/${round(s15.d)}`,
    stopLoss: round(sl, 2), takeProfit: round(tp, 2), rr: round(rr, 2),
    expectedMove: round(expectedMove * 100, 2), updatedAt: now
  };
}
