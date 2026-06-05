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
  entryTimeframe?: "1H" | "15M" | "NONE";
  higherTimeframeStoch?: string;
}

const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
const ok = (c: Candle[] | null | undefined, min: number) => Array.isArray(c) && c.length >= min;

/* ---------------- ATR (FIXED: divide by actual slice length) ---------------- */
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

/* ---------------- RSI (FIXED: Wilder smoothing starts at index period, not period+1) ---------------- */
function rsi(closes: number[], period = 14): number {
  if (closes.length < period + 1) return 50;
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) avgGain += diff; else avgLoss -= diff;
  }
  avgGain /= period; avgLoss /= period;
  // FIXED: Start at index period (first value after initial SMA)
  for (let i = period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(diff, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-diff, 0)) / period;
  }
  const rs = avgGain / (avgLoss || 1);
  return 100 - 100 / (1 + rs);
}

/* ---------------- STOCH (FIXED: defensive against zero range, default 50) ---------------- */
function stoch(closes: number[], period = 14, smoothK = 3, smoothD = 3) {
  const minLen = period + smoothK + smoothD;
  if (closes.length < minLen) return { k: 50, d: 50, prevK: 50, prevD: 50 };
  const rawK: number[] = [];
  for (let i = period - 1; i < closes.length; i++) {
    const slice = closes.slice(i - period + 1, i + 1);
    const high = Math.max(...slice);
    const low = Math.min(...slice);
    const range = high - low;
    // FIXED: If range is 0 (flat candles), default to 50 instead of 0
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

/* ---------------- STRUCTURE (FIXED: 3 swings, no duplicate high+low at same index) ---------------- */
function getStructure(candles: Candle[]): Structure {
  if (!ok(candles, 7)) return "RANGE";
  const highs: number[] = [], lows: number[] = [];
  for (let i = 2; i < candles.length - 2; i++) {
    const c = candles[i], p1 = candles[i - 1], p2 = candles[i - 2], n1 = candles[i + 1], n2 = candles[i + 2];
    // 3-bar fractal: must be higher/lower than 2 bars each side
    const isHigh = c.high > p1.high && c.high > p2.high && c.high > n1.high && c.high > n2.high;
    const isLow = c.low < p1.low && c.low < p2.low && c.low < n1.low && c.low < n2.low;
    // FIXED: Mutual exclusion — can't be both
    if (isHigh) {
      highs.push(c.high);
    } else if (isLow) {
      lows.push(c.low);
    }
  }
  // FIXED: Require 3 swings minimum (was 2, too noisy)
  const lastH = highs.slice(-3), lastL = lows.slice(-3);
  if (lastH.length < 3 || lastL.length < 3) return "RANGE";
  const hh = lastH[2] > lastH[1] && lastH[1] > lastH[0];
  const hl = lastL[2] > lastL[1] && lastL[1] > lastL[0];
  const lh = lastH[2] < lastH[1] && lastH[1] < lastH[0];
  const ll = lastL[2] < lastL[1] && lastL[1] < lastL[0];
  if (hh && hl) return "UPTREND";
  if (lh && ll) return "DOWNTREND";
  return "RANGE";
}

/* ---------------- LAST SWING LEVELS (FIXED: 3-bar fractals, mutual exclusion) ---------------- */
function getLastSwingLevels(candles: Candle[]) {
  const highs: { value: number; idx: number }[] = [];
  const lows: { value: number; idx: number }[] = [];
  for (let i = 2; i < candles.length - 2; i++) {
    const c = candles[i], p1 = candles[i - 1], p2 = candles[i - 2], n1 = candles[i + 1], n2 = candles[i + 2];
    const isHigh = c.high > p1.high && c.high > p2.high && c.high > n1.high && c.high > n2.high;
    const isLow = c.low < p1.low && c.low < p2.low && c.low < n1.low && c.low < n2.low;
    if (isHigh) {
      highs.push({ value: c.high, idx: i });
    } else if (isLow) {
      lows.push({ value: c.low, idx: i });
    }
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

  if (!ok(candles15m, 25) || !ok(candles1h, 15) || !ok(candles4h, 15)) {
    return {
      symbol, price: round(price ?? 0), state: "WAIT", setup: "NONE", structure: "RANGE",
      bias: "NEUTRAL", confidence: 0, adx: 0, atr: 0, stochK: 50, stochD: 50, rsi: 50,
      reason: "INSUFFICIENT DATA", stopLoss: null, takeProfit: null, rr: null, expectedMove: 0,
      updatedAt: now, entryTimeframe: "NONE", higherTimeframeStoch: "N/A"
    };
  }

  const c15 = candles15m!, c1h = candles1h!, c4h = candles4h!;

  // Use last closed candle price for consistency
  const price15 = c15.at(-1)!.close;
  const price1h = c1h.at(-1)!.close;
  const price4h = c4h.at(-1)!.close;

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
  const compression1h = priorAtr1h > 0 && (a1h / priorAtr1h) < 0.7;

  // 1H stoch conditions (for EARLY)
  const stoch1hCrossUp = s1h.prevK < s1h.prevD && s1h.k > s1h.d;
  const stoch1hCrossDown = s1h.prevK > s1h.prevD && s1h.k < s1h.d;
  // FIXED: Extreme oversold turning UP (K > D)
  const stoch1hExtremeLong = s1h.k < 25 && s1h.k > s1h.d;
  // FIXED: Extreme overbought turning DOWN (K < D)
  const stoch1hExtremeShort = s1h.k > 75 && s1h.k < s1h.d;

  // 15m stoch conditions (for SNIPER)
  const stoch15CrossUp = s15.prevK < s15.prevD && s15.k > s15.d;
  const stoch15CrossDown = s15.prevK > s15.prevD && s15.k < s15.d;

  const swings4h = getLastSwingLevels(c4h);
  const swings1h = getLastSwingLevels(c1h);

  let setup: SetupType = "NONE";
  let entryBias: "LONG" | "SHORT" | "NEUTRAL" = bias;
  let entryTimeframe: "1H" | "15M" | "NONE" = "NONE";
  // FIXED: Neutral fallback (50), not 1H values
  let primaryStochK = 50;
  let primaryStochD = 50;
  let primaryRsi = 50;

  /* ============================================
     EARLY: 1H trend start or extreme reversal
     ============================================ */
  if (bias === "LONG" && structure1h !== "DOWNTREND") {
    // 1H cross up from below 35 = early trend
    if (stoch1hCrossUp && s1h.prevK < 35 && r1h > 45) {
      setup = "PULLBACK";
      entryTimeframe = "1H";
      primaryStochK = s1h.k;
      primaryStochD = s1h.d;
      primaryRsi = r1h;
    }
    // 1H extreme oversold turning up, not compressed
    else if (stoch1hExtremeLong && r1h < 50 && !compression1h) {
      setup = "PULLBACK";
      entryTimeframe = "1H";
      primaryStochK = s1h.k;
      primaryStochD = s1h.d;
      primaryRsi = r1h;
    }
  } else if (bias === "SHORT" && structure1h !== "UPTREND") {
    if (stoch1hCrossDown && s1h.prevK > 65 && r1h < 55) {
      setup = "PULLBACK";
      entryTimeframe = "1H";
      primaryStochK = s1h.k;
      primaryStochD = s1h.d;
      primaryRsi = r1h;
    }
    else if (stoch1hExtremeShort && r1h > 50 && !compression1h) {
      setup = "PULLBACK";
      entryTimeframe = "1H";
      primaryStochK = s1h.k;
      primaryStochD = s1h.d;
      primaryRsi = r1h;
    }
  }

  /* ============================================
     SNIPER: 15m pullback in confirmed 1H trend
     FIXED: Added 1H RSI alignment check
     ============================================ */
  if (setup === "NONE" && bias !== "NEUTRAL") {
    const trendConfirmed1h = (bias === "LONG" && s1h.k > s1h.d && s1h.k > 40) ||
                             (bias === "SHORT" && s1h.k < s1h.d && s1h.k < 60);

    if (trendConfirmed1h) {
      // FIXED: Added r1h alignment check
      if (bias === "LONG" && stoch15CrossUp && s15.prevK < 35 && r15 < 65 && r1h > 50) {
        setup = "PULLBACK";
        entryTimeframe = "15M";
        primaryStochK = s15.k;
        primaryStochD = s15.d;
        primaryRsi = r15;
      } else if (bias === "SHORT" && stoch15CrossDown && s15.prevK > 65 && r15 > 35 && r1h < 50) {
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
     FIXED: Use last 4H close consistently
     FIXED: Require 1H structure alignment
     ============================================ */
  if (setup === "NONE" && swings4h.lastLow && swings4h.priorLow) {
    const lastLow = swings4h.lastLow.value;
    const priorLow = swings4h.priorLow.value;
    if (price4h < lastLow * 0.998 && lastLow > priorLow) {
      const broke1h = swings1h.lastLow ? price1h < swings1h.lastLow.value : false;
      // FIXED: Require 1H DOWNTREND alignment
      if ((broke1h || r1h < 45) && structure1h === "DOWNTREND") {
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
    if (price4h > lastHigh * 1.002 && lastHigh < priorHigh) {
      const broke1h = swings1h.lastHigh ? price1h > swings1h.lastHigh.value : false;
      // FIXED: Require 1H UPTREND alignment
      if ((broke1h || r1h > 55) && structure1h === "UPTREND") {
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
  const state: SignalState = (setup !== "NONE" && entryTimeframe === "15M" && expansion15) ? "SNIPER"
    : (setup !== "NONE") ? "EARLY"
    : "WAIT";

  if (state === "WAIT") {
    const issues: string[] = [];
    if (bias === "NEUTRAL") issues.push("NO TREND");
    else {
      if (setup === "NONE") {
        if (bias === "LONG") {
          if (s1h.k < 25 && s1h.k > s1h.d) issues.push("1H EXTREME WAIT CONFIRM");
          else if (s1h.k > s1h.d) issues.push("1H TRENDING WAIT 15M PULLBACK");
          else issues.push("NO SETUP");
        } else {
          if (s1h.k > 75 && s1h.k < s1h.d) issues.push("1H EXTREME WAIT CONFIRM");
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
     FIXED: Use 1H ATR for 1H entries, 15m ATR for 15m entries
     FIXED: Use consistent price basis (last closed candle)
     ============================================ */
  const priceForSizing = entryTimeframe === "1H" ? price1h : price15;
  const atrForSizing = entryTimeframe === "1H" ? a1h : a15;
  const atrPct = atrForSizing / priceForSizing;
  const expectedMove = state === "SNIPER"
    ? Math.max(0.025, Math.min(0.05, atrPct * 2.5))
    : Math.max(0.02, Math.min(0.04, atrPct * 2));

  const sl = entryBias === "LONG" ? priceForSizing * (1 - expectedMove * 0.5) : priceForSizing * (1 + expectedMove * 0.5);
  const tp = entryBias === "LONG" ? priceForSizing * (1 + expectedMove) : priceForSizing * (1 - expectedMove);
  const rr = Math.abs((tp - priceForSizing) / (priceForSizing - sl));

  /* ============================================
     CONFIDENCE
     FIXED: 15m fighting penalty is now CORRECT
     ============================================ */
  let confidence = state === "SNIPER" ? 85 : 70;
  if (setup === "BREAKDOWN" || setup === "BREAKUP") confidence += 5;
  if (primaryRsi > 45 && primaryRsi < 65) confidence += 5;
  if (Math.abs(primaryStochK - primaryStochD) < 10) confidence += 5;

  // FIXED: Penalize if 15m is extended IN TRADE DIRECTION (chasing)
  if (entryTimeframe === "1H") {
    // For LONG: bad if 15m overbought (>80), good if oversold
    // For SHORT: bad if 15m oversold (<20), good if overbought
    const chasing15m = (entryBias === "LONG" && s15.k > 80) || (entryBias === "SHORT" && s15.k < 20);
    if (chasing15m) confidence -= 10;
  }

  // Clamp 0-100
  confidence = Math.max(0, Math.min(confidence, 100));

  return {
    symbol, price: round(priceForSizing), state, setup, structure: structure4h, bias: entryBias,
    confidence, adx: 0, atr: round(a15, 2),
    stochK: round(primaryStochK), stochD: round(primaryStochD), rsi: round(primaryRsi),
    reason: `${state} ${setup} ${entryBias} | ENTRY:${entryTimeframe} | 4H:${structure4h} | 1H:${structure1h}${expansion15 ? " | 15M_EXP" : ""}${expansion1h ? " | 1H_EXP" : ""}`,
    stopLoss: round(sl, 2), takeProfit: round(tp, 2), rr: round(rr, 2),
    expectedMove: round(expectedMove * 100, 2), updatedAt: now, entryTimeframe,
    higherTimeframeStoch: entryTimeframe === "15M" ? `1H:${round(s1h.k)}/${round(s1h.d)}` : `15M:${round(s15.k)}/${round(s15.d)}`
  };
}
