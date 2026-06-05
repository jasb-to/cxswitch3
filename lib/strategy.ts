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
  stochK: number;      // Primary stoch for entry (1H for EARLY, 15m for SNIPER)
  stochD: number;
  rsi: number;         // Primary RSI for entry
  reason: string;
  stopLoss: number | null;
  takeProfit: number | null;
  rr: number | null;
  expectedMove: number;
  updatedAt: string;
  // Extra detail for alerts
  entryTimeframe: "1H" | "15M" | "NONE";
  higherTimeframeStoch: string;
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
      reason: "INSUFFICIENT DATA", stopLoss: null, takeProfit: null, rr: null, expectedMove: 0,
      updatedAt: now, entryTimeframe: "NONE", higherTimeframeStoch: ""
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
  const s1h = stoch(closes1h);
  const a15 = atr(c15);
  const a1h = atr(c1h);

  // Volatility regime
  const priorAtr15 = atr(c15.slice(0, -1), 20);
  const expansion15 = priorAtr15 > 0 && (a15 / priorAtr15) > 1.2;
  const priorAtr1h = atr(c1h.slice(0, -1), 20);
  const expansion1h = priorAtr1h > 0 && (a1h / priorAtr1h) > 1.2;

  // 1H stoch conditions (for EARLY)
  const stoch1hCrossUp = s1h.prevK < s1h.prevD && s1h.k > s1h.d;
  const stoch1hCrossDown = s1h.prevK > s1h.prevD && s1h.k < s1h.d;
  const stoch1hExtremeLong = s1h.k < 20 && s1h.k < s1h.d;
  const stoch1hExtremeShort = s1h.k > 80 && s1h.k > s1h.d;

  // 15m stoch conditions (for SNIPER)
  const stoch15CrossUp = s15.prevK < s15.prevD && s15.k > s15.d;
  const stoch15CrossDown = s15.prevK > s15.prevD && s15.k < s15.d;

  const swings4h = getLastSwingLevels(c4h);
  const swings1h = getLastSwingLevels(c1h);

  let setup: SetupType = "NONE";
  let entryBias: "LONG" | "SHORT" | "NEUTRAL" = bias;
  let entryTimeframe: "1H" | "15M" | "NONE" = "NONE";
  let primaryStochK = 0;
  let primaryStochD = 0;
  let primaryRsi = 0;

  /* ============================================
     EARLY: 1H trend start or extreme reversal
     ============================================ */
  if (bias === "LONG" && structure1h !== "DOWNTREND") {
    // 1H cross up from below 40 = early trend
    if (stoch1hCrossUp && s1h.prevK < 40 && r1h > 45) {
      setup = "PULLBACK";
      entryTimeframe = "1H";
      primaryStochK = s1h.k;
      primaryStochD = s1h.d;
      primaryRsi = r1h;
    }
    // 1H extreme oversold = early reversal (needs some expansion)
    else if (stoch1hExtremeLong && r1h < 50 && expansion1h) {
      setup = "PULLBACK";
      entryTimeframe = "1H";
      primaryStochK = s1h.k;
      primaryStochD = s1h.d;
      primaryRsi = r1h;
    }
  } else if (bias === "SHORT" && structure1h !== "UPTREND") {
    if (stoch1hCrossDown && s1h.prevK > 60 && r1h < 55) {
      setup = "PULLBACK";
      entryTimeframe = "1H";
      primaryStochK = s1h.k;
      primaryStochD = s1h.d;
      primaryRsi = r1h;
    }
    else if (stoch1hExtremeShort && r1h > 50 && expansion1h) {
      setup = "PULLBACK";
      entryTimeframe = "1H";
      primaryStochK = s1h.k;
      primaryStochD = s1h.d;
      primaryRsi = r1h;
    }
  }

  /* ============================================
     SNIPER: 15m pullback in confirmed 1H trend
     ============================================ */
  // Only if 1H trend is already confirmed (stoch aligned with bias)
  if (setup === "NONE" && bias !== "NEUTRAL") {
    const trendConfirmed1h = (bias === "LONG" && s1h.k > s1h.d && s1h.k > 40) ||
                             (bias === "SHORT" && s1h.k < s1h.d && s1h.k < 60);

    if (trendConfirmed1h) {
      if (bias === "LONG" && stoch15CrossUp && s15.prevK < 35 && r15 < 65) {
        setup = "PULLBACK";
        entryTimeframe = "15M";
        primaryStochK = s15.k;
        primaryStochD = s15.d;
        primaryRsi = r15;
      } else if (bias === "SHORT" && stoch15CrossDown && s15.prevK > 65 && r15 > 35) {
        setup = "PULLBACK";
        entryTimeframe = "15M";
        primaryStochK = s15.k;
        primaryStochD = s15.d;
        primaryRsi = r15;
      }
    }
  }

  /* ============================================
     BREAKDOWN/BREAKUP: structure break
     ============================================ */
  if (setup === "NONE" && swings4h.lastLow && swings4h.priorLow) {
    const lastLow = swings4h.lastLow.value;
    const priorLow = swings4h.priorLow.value;
    if (price < lastLow * 0.998 && lastLow > priorLow) {
      const broke1h = swings1h.lastLow ? price < swings1h.lastLow.value : false;
      if (broke1h || r1h < 45) {
        setup = "BREAKDOWN";
        entryBias = "SHORT";
        entryTimeframe = "1H";
        primaryStochK = s1h.k;
        primaryStochD = s1h.d;
        primaryRsi = r1h;
      }
    }
  }

  if (setup === "NONE" && swings4h.lastHigh && swings4h.priorHigh) {
    const lastHigh = swings4h.lastHigh.value;
    const priorHigh = swings4h.priorHigh.value;
    if (price > lastHigh * 1.002 && lastHigh < priorHigh) {
      const broke1h = swings1h.lastHigh ? price > swings1h.lastHigh.value : false;
      if (broke1h || r1h > 55) {
        setup = "BREAKUP";
        entryBias = "LONG";
        entryTimeframe = "1H";
        primaryStochK = s1h.k;
        primaryStochD = s1h.d;
        primaryRsi = r1h;
      }
    }
  }

  /* ============================================
     STATE DETERMINATION
     ============================================ */
  const isEarly = entryTimeframe === "1H";
  const isSniper = entryTimeframe === "15M";

  const state: SignalState = (setup !== "NONE" && isSniper && expansion15) ? "SNIPER"
    : (setup !== "NONE") ? "EARLY"
    : "WAIT";

  if (state === "WAIT") {
    const issues: string[] = [];
    if (bias === "NEUTRAL") issues.push("NO TREND");
    else {
      if (setup === "NONE") {
        if (bias === "LONG") {
          if (s1h.k < 20) issues.push("1H OVERSOLD WAIT CROSS");
          else if (s1h.k > s1h.d) issues.push("1H TRENDING WAIT 15M PULLBACK");
          else issues.push("NO SETUP");
        } else {
          if (s1h.k > 80) issues.push("1H OVERBOUGHT WAIT CROSS");
          else if (s1h.k < s1h.d) issues.push("1H TRENDING WAIT 15M PULLBACK");
          else issues.push("NO SETUP");
        }
      }
    }
    return {
      symbol, price: round(price), state: "WAIT", setup: "NONE", structure: structure4h, bias,
      confidence: 0, adx: 0, atr: round(a15, 2), stochK: round(s15.k), stochD: round(s15.d),
      rsi: round(r15), reason: `WAIT (${issues.join(", ")})`, stopLoss: null, takeProfit: null,
      rr: null, expectedMove: 0, updatedAt: now, entryTimeframe: "NONE",
      higherTimeframeStoch: `1H:${round(s1h.k)}/${round(s1h.d)}`
    };
  }

  /* ============================================
     POSITION SIZING
     ============================================ */
  const atrPct = a15 / price;
  const expectedMove = state === "SNIPER"
    ? Math.max(0.025, Math.min(0.05, atrPct * 2.5))
    : Math.max(0.02, Math.min(0.04, atrPct * 2));

  const sl = entryBias === "LONG" ? price * (1 - expectedMove * 0.5) : price * (1 + expectedMove * 0.5);
  const tp = entryBias === "LONG" ? price * (1 + expectedMove) : price * (1 - expectedMove);
  const rr = Math.abs((tp - price) / (price - sl));

  /* ============================================
     CONFIDENCE
     ============================================ */
  let confidence = state === "SNIPER" ? 85 : 70;
  if (setup === "BREAKDOWN" || setup === "BREAKUP") confidence += 5;
  if (primaryRsi > 45 && primaryRsi < 65) confidence += 5;
  if (Math.abs(primaryStochK - primaryStochD) < 10) confidence += 5;

  return {
    symbol, price: round(price), state, setup, structure: structure4h, bias: entryBias,
    confidence: Math.min(confidence, 95), adx: 0, atr: round(a15, 2),
    stochK: round(primaryStochK), stochD: round(primaryStochD), rsi: round(primaryRsi),
    reason: `${state} ${setup} ${entryBias} | ENTRY:${entryTimeframe} | 4H:${structure4h} | 1H:${structure1h}${expansion15 ? " | EXP" : ""}`,
    stopLoss: round(sl, 2), takeProfit: round(tp, 2), rr: round(rr, 2),
    expectedMove: round(expectedMove * 100, 2), updatedAt: now, entryTimeframe,
    higherTimeframeStoch: entryTimeframe === "15M" ? `1H:${round(s1h.k)}/${round(s1h.d)}` : `15M:${round(s15.k)}/${round(s15.d)}`
  };
}
