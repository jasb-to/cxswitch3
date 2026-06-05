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

/* ---------------- STRUCTURE (5-bar fractals, 4 swings) ---------------- */
function getStructure(candles: Candle[]): Structure {
  if (!ok(candles, 9)) return "RANGE";
  const highs: number[] = [], lows: number[] = [];
  for (let i = 2; i < candles.length - 2; i++) {
    const c = candles[i], p1 = candles[i - 1], p2 = candles[i - 2], n1 = candles[i + 1], n2 = candles[i + 2];
    const isHigh = c.high > p1.high && c.high > p2.high && c.high > n1.high && c.high > n2.high;
    const isLow = c.low < p1.low && c.low < p2.low && c.low < n1.low && c.low < n2.low;
    if (isHigh) highs.push(c.high);
    else if (isLow) lows.push(c.low);
  }
  const lastH = highs.slice(-4), lastL = lows.slice(-4);
  if (lastH.length < 4 || lastL.length < 4) return "RANGE";
  const hh = lastH[3] > lastH[2] && lastH[2] > lastH[1];
  const hl = lastL[3] > lastL[2] && lastL[2] > lastL[1];
  const lh = lastH[3] < lastH[2] && lastH[2] < lastH[1];
  const ll = lastL[3] < lastL[2] && lastL[2] < lastL[1];
  if (hh && hl) return "UPTREND";
  if (lh && ll) return "DOWNTREND";
  return "RANGE";
}

/* ---------------- LAST SWING LEVELS ---------------- */
function getLastSwingLevels(candles: Candle[]) {
  const highs: { value: number; idx: number }[] = [];
  const lows: { value: number; idx: number }[] = [];
  for (let i = 2; i < candles.length - 2; i++) {
    const c = candles[i], p1 = candles[i - 1], p2 = candles[i - 2], n1 = candles[i + 1], n2 = candles[i + 2];
    const isHigh = c.high > p1.high && c.high > p2.high && c.high > n1.high && c.high > n2.high;
    const isLow = c.low < p1.low && c.low < p2.low && c.low < n1.low && c.low < n2.low;
    if (isHigh) highs.push({ value: c.high, idx: i });
    else if (isLow) lows.push({ value: c.low, idx: i });
  }
  return {
    lastHigh: highs.at(-1),
    lastLow: lows.at(-1),
    priorHigh: highs.at(-2),
    priorLow: lows.at(-2),
  };
}

/* ---------------- VOLATILITY REGIME ---------------- */
function getVolatilityRegime(candles: Candle[], period = 14): { expanding: boolean; compressing: boolean } {
  if (!ok(candles, period * 3 + 1)) return { expanding: false, compressing: false };
  const currentAtr = atr(candles, period);
  const pastAtr = atr(candles.slice(0, -period), period);
  if (pastAtr <= 0) return { expanding: false, compressing: false };
  const ratio = currentAtr / pastAtr;
  return { expanding: ratio > 1.25, compressing: ratio < 0.75 };
}

/* ---------------- MOMENTUM EXHAUSTION CHECK ---------------- */
function checkMomentumExhaustion(
  entryBias: "LONG" | "SHORT",
  entryRsi: number,
  entryStochK: number,
  htfStochK: number
): { blocked: boolean; penalty: number; reason: string } {
  // HARD BLOCKS — do not enter under extreme exhaustion
  if (entryBias === "LONG") {
    if (entryRsi < 15 || entryStochK < 2) {
      return { blocked: true, penalty: 0, reason: "EXTREME OVERSOLD — BOUNCE IMMINENT" };
    }
    if (entryRsi > 85 || entryStochK > 98) {
      return { blocked: true, penalty: 0, reason: "EXTREME OVERBOUGHT — REVERSAL RISK" };
    }
    if (htfStochK > 95) {
      return { blocked: true, penalty: 0, reason: "4H EXTREME OVERBOUGHT — WAIT PULLBACK" };
    }
  } else {
    if (entryRsi > 85 || entryStochK > 98) {
      return { blocked: true, penalty: 0, reason: "EXTREME OVERBOUGHT — DROP IMMINENT" };
    }
    if (entryRsi < 15 || entryStochK < 2) {
      return { blocked: true, penalty: 0, reason: "EXTREME OVERSOLD — BOUNCE RISK" };
    }
    if (htfStochK < 5) {
      return { blocked: true, penalty: 0, reason: "4H EXTREME OVERSOLD — WAIT BOUNCE" };
    }
  }

  // SOFT PENALTIES — near-extreme conditions
  let penalty = 0;
  const reasons: string[] = [];

  if (entryBias === "LONG") {
    if (entryRsi < 25) { penalty += 15; reasons.push("RSI<25"); }
    else if (entryRsi < 35) { penalty += 8; reasons.push("RSI<35"); }
    if (entryStochK < 10) { penalty += 12; reasons.push("STOCH<10"); }
    else if (entryStochK < 20) { penalty += 5; reasons.push("STOCH<20"); }
    if (htfStochK > 85) { penalty += 8; reasons.push("4H STOCH>85"); }
    else if (htfStochK > 75) { penalty += 4; reasons.push("4H STOCH>75"); }
  } else {
    if (entryRsi > 75) { penalty += 15; reasons.push("RSI>75"); }
    else if (entryRsi > 65) { penalty += 8; reasons.push("RSI>65"); }
    if (entryStochK > 90) { penalty += 12; reasons.push("STOCH>90"); }
    else if (entryStochK > 80) { penalty += 5; reasons.push("STOCH>80"); }
    if (htfStochK < 15) { penalty += 8; reasons.push("4H STOCH<15"); }
    else if (htfStochK < 25) { penalty += 4; reasons.push("4H STOCH<25"); }
  }

  return { blocked: false, penalty, reason: reasons.join(", ") };
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

  if (!ok(candles15m, 25) || !ok(candles1h, 30) || !ok(candles4h, 30)) {
    return {
      symbol, price: round(price ?? 0), state: "WAIT", setup: "NONE", structure: "RANGE",
      bias: "NEUTRAL", confidence: 0, adx: 0, atr: 0, stochK: 50, stochD: 50, rsi: 50,
      reason: "INSUFFICIENT DATA", stopLoss: null, takeProfit: null, rr: null, expectedMove: 0,
      updatedAt: now, entryTimeframe: "NONE", higherTimeframeStoch: "N/A"
    };
  }

  const c15 = candles15m!, c1h = candles1h!, c4h = candles4h!;

  const price15 = c15.at(-1)!.close;
  const price1h = c1h.at(-1)!.close;
  const price4h = c4h.at(-1)!.close;

  const structure4h = getStructure(c4h);
  const structure1h = getStructure(c1h);
  const bias = structure4h === "UPTREND" ? "LONG" : structure4h === "DOWNTREND" ? "SHORT" : "NEUTRAL";

  const closes15 = c15.map(c => c.close);
  const closes1h = c1h.map(c => c.close);
  const closes4h = c4h.map(c => c.close);
  const r15 = rsi(closes15);
  const r1h = rsi(closes1h);
  const r4h = rsi(closes4h);
  const s15 = stoch(closes15);
  const s1h = stoch(closes1h);
  const s4h = stoch(closes4h);
  const a15 = atr(c15);
  const a1h = atr(c1h);
  const a4h = atr(c4h);
  const adx1h = adx(c1h);
  const adx4h = adx(c4h);

  const vol1h = getVolatilityRegime(c1h);
  const vol4h = getVolatilityRegime(c4h);

  // 1H stoch signals
  const stoch1hCrossUp = s1h.prevK < s1h.prevD && s1h.k > s1h.d;
  const stoch1hCrossDown = s1h.prevK > s1h.prevD && s1h.k < s1h.d;
  const stoch1hExtremeLong = s1h.k < 25 && s1h.k > s1h.d;
  const stoch1hExtremeShort = s1h.k > 75 && s1h.k < s1h.d;
  const stoch1hDeepLong = s1h.k < 15 && s1h.k < s1h.d;
  const stoch1hDeepShort = s1h.k > 85 && s1h.k > s1h.d;
  const stoch1hOverbought = s1h.k > 80;
  const stoch1hOversold = s1h.k < 20;

  // 15m stoch signals
  const stoch15CrossUp = s15.prevK < s15.prevD && s15.k > s15.d;
  const stoch15CrossDown = s15.prevK > s15.prevD && s15.k < s15.d;
  const stoch15DeepLong = s15.k < 10 && s15.k < s15.d;
  const stoch15DeepShort = s15.k > 90 && s15.k > s15.d;
  const stoch15OversoldBounce = s15.k < 25 && s15.k > s15.d;
  const stoch15OverboughtDrop = s15.k > 75 && s15.k < s15.d;
  const stoch15OversoldCross = s15.k < 30 && stoch15CrossUp;
  const stoch15OverboughtCross = s15.k > 70 && stoch15CrossDown;

  const swings4h = getLastSwingLevels(c4h);
  const swings1h = getLastSwingLevels(c1h);

  let setup: SetupType = "NONE";
  let entryBias: "LONG" | "SHORT" | "NEUTRAL" = bias;
  let entryTimeframe: "1H" | "15M" | "NONE" = "NONE";
  let primaryStochK = 50;
  let primaryStochD = 50;
  let primaryRsi = 50;
  let primaryAdx = 0;

  /* ---- EARLY: 1H trend start / continuation ---- */
  if (bias === "LONG" && structure1h !== "DOWNTREND") {
    if (stoch1hCrossUp && s1h.prevK < 40 && r1h > 40) {
      setup = "PULLBACK"; entryTimeframe = "1H";
      primaryStochK = s1h.k; primaryStochD = s1h.d; primaryRsi = r1h; primaryAdx = adx1h;
    }
    else if ((stoch1hExtremeLong || stoch1hDeepLong) && r1h < 55 && !vol1h.compressing) {
      setup = "PULLBACK"; entryTimeframe = "1H";
      primaryStochK = s1h.k; primaryStochD = s1h.d; primaryRsi = r1h; primaryAdx = adx1h;
    }
    else if (stoch1hOversold && s1h.k > s1h.d && r1h > 40 && r1h < 65) {
      setup = "PULLBACK"; entryTimeframe = "1H";
      primaryStochK = s1h.k; primaryStochD = s1h.d; primaryRsi = r1h; primaryAdx = adx1h;
    }
  } else if (bias === "SHORT" && structure1h !== "UPTREND") {
    if (stoch1hCrossDown && s1h.prevK > 60 && r1h < 60) {
      setup = "PULLBACK"; entryTimeframe = "1H";
      primaryStochK = s1h.k; primaryStochD = s1h.d; primaryRsi = r1h; primaryAdx = adx1h;
    }
    else if ((stoch1hExtremeShort || stoch1hDeepShort) && r1h > 45 && !vol1h.compressing) {
      setup = "PULLBACK"; entryTimeframe = "1H";
      primaryStochK = s1h.k; primaryStochD = s1h.d; primaryRsi = r1h; primaryAdx = adx1h;
    }
    else if (stoch1hOverbought && s1h.k < s1h.d && r1h < 60 && r1h > 35) {
      setup = "PULLBACK"; entryTimeframe = "1H";
      primaryStochK = s1h.k; primaryStochD = s1h.d; primaryRsi = r1h; primaryAdx = adx1h;
    }
  }

  /* ---- SNIPER: 15m pullback in confirmed trend ---- */
  if (setup === "NONE" && bias !== "NEUTRAL") {
    const trendConfirmed1h = (bias === "LONG" && s1h.k > s1h.d && s1h.k > 35) ||
                             (bias === "SHORT" && s1h.k < s1h.d && s1h.k < 65);

    if (trendConfirmed1h) {
      if (bias === "LONG") {
        if (stoch15CrossUp && s15.prevK < 40 && r15 < 65 && r1h > 45) {
          setup = "PULLBACK"; entryTimeframe = "15M";
          primaryStochK = s15.k; primaryStochD = s15.d; primaryRsi = r15; primaryAdx = adx1h;
        }
        else if (stoch15OversoldBounce && r15 < 60 && r1h > 45) {
          setup = "PULLBACK"; entryTimeframe = "15M";
          primaryStochK = s15.k; primaryStochD = s15.d; primaryRsi = r15; primaryAdx = adx1h;
        }
        else if (stoch15OversoldCross && r15 < 55 && r1h > 45) {
          setup = "PULLBACK"; entryTimeframe = "15M";
          primaryStochK = s15.k; primaryStochD = s15.d; primaryRsi = r15; primaryAdx = adx1h;
        }
      } else if (bias === "SHORT") {
        if (stoch15CrossDown && s15.prevK > 60 && r15 > 35 && r1h < 55) {
          setup = "PULLBACK"; entryTimeframe = "15M";
          primaryStochK = s15.k; primaryStochD = s15.d; primaryRsi = r15; primaryAdx = adx1h;
        }
        else if (stoch15OverboughtDrop && r15 > 40 && r1h < 55) {
          setup = "PULLBACK"; entryTimeframe = "15M";
          primaryStochK = s15.k; primaryStochD = s15.d; primaryRsi = r15; primaryAdx = adx1h;
        }
        else if (stoch15OverboughtCross && r15 > 45 && r1h < 55) {
          setup = "PULLBACK"; entryTimeframe = "15M";
          primaryStochK = s15.k; primaryStochD = s15.d; primaryRsi = r15; primaryAdx = adx1h;
        }
      }
    }
  }

  /* ---- BREAKDOWN: 4H structure break with 1H confirmation ---- */
  if (setup === "NONE" && swings4h.lastLow && swings4h.priorLow) {
    const lastLow = swings4h.lastLow.value;
    const priorLow = swings4h.priorLow.value;
    if (price4h < lastLow * 0.998 && lastLow < priorLow) {
      const broke1h = swings1h.lastLow ? price1h < swings1h.lastLow.value : false;
      if ((broke1h || r1h < 45) && structure1h === "DOWNTREND") {
        setup = "BREAKDOWN"; entryBias = "SHORT"; entryTimeframe = "1H";
        primaryStochK = s1h.k; primaryStochD = s1h.d; primaryRsi = r1h; primaryAdx = adx1h;
      }
    }
  }

  /* ---- BREAKUP: 4H structure break with 1H confirmation ---- */
  if (setup === "NONE" && swings4h.lastHigh && swings4h.priorHigh) {
    const lastHigh = swings4h.lastHigh.value;
    const priorHigh = swings4h.priorHigh.value;
    if (price4h > lastHigh * 1.002 && lastHigh > priorHigh) {
      const broke1h = swings1h.lastHigh ? price1h > swings1h.lastHigh.value : false;
      if ((broke1h || r1h > 55) && structure1h === "UPTREND") {
        setup = "BREAKUP"; entryBias = "LONG"; entryTimeframe = "1H";
        primaryStochK = s1h.k; primaryStochD = s1h.d; primaryRsi = r1h; primaryAdx = adx1h;
      }
    }
  }

  /* ---- STATE: SNIPER vs EARLY ---- */
  const state: SignalState = (setup !== "NONE" && entryTimeframe === "15M") ? "SNIPER"
    : (setup !== "NONE") ? "EARLY"
    : "WAIT";

  /* ---- MOMENTUM EXHAUSTION CHECK ---- */
  if (state !== "WAIT") {
    const htfStochK = entryTimeframe === "15M" ? s1h.k : s4h.k;
    const exhaust = checkMomentumExhaustion(entryBias as "LONG" | "SHORT", primaryRsi, primaryStochK, htfStochK);
    if (exhaust.blocked) {
      // Downgrade to WAIT with reason
      const issues: string[] = [exhaust.reason];
      if (vol1h.expanding) issues.push("VOL EXPANDING");
      return {
        symbol, price: round(price), state: "WAIT", setup: "NONE", structure: structure4h, bias: entryBias,
        confidence: 0, adx: round(primaryAdx), atr: round(a15, 2), stochK: round(primaryStochK), stochD: round(primaryStochD),
        rsi: round(primaryRsi), reason: `WAIT (${issues.join(" | ")})`, stopLoss: null, takeProfit: null,
        rr: null, expectedMove: 0, updatedAt: now, entryTimeframe: "NONE",
        higherTimeframeStoch: `1H:${round(s1h.k)}/${round(s1h.d)} | 4H:${round(s4h.k)}/${round(s4h.d)}`
      };
    }
  }

  /* ---- WAIT STATE: Detailed reasoning ---- */
  if (state === "WAIT") {
    const issues: string[] = [];
    if (bias === "NEUTRAL") {
      issues.push("NO TREND");
    } else {
      const trendStrength = adx4h > 25 ? "STRONG" : adx4h > 15 ? "MODERATE" : "WEAK";
      issues.push(`${trendStrength} ${bias} TREND`);

      if (bias === "LONG") {
        if (s1h.k < s1h.d) {
          if (s1h.k < 20) issues.push("1H OVERSOLD — BOUNCE SOON");
          else if (s1h.k < 40) issues.push("1H PULLBACK IN PROGRESS");
          else issues.push("1H BEARISH — WAIT CROSS");
        } else {
          if (s1h.k > 80) issues.push("1H OVERBOUGHT — WAIT 15M PULLBACK");
          else issues.push("1H BULLISH — WAIT 15M CONFIRMATION");
        }
        if (s15.k < s15.d) issues.push("15M BEARISH");
        else issues.push("15M BULLISH");
      } else {
        if (s1h.k > s1h.d) {
          if (s1h.k > 80) issues.push("1H OVERBOUGHT — DROP SOON");
          else if (s1h.k > 60) issues.push("1H PULLBACK IN PROGRESS");
          else issues.push("1H BULLISH — WAIT CROSS");
        } else {
          if (s1h.k < 20) issues.push("1H OVERSOLD — WAIT 15M BOUNCE");
          else issues.push("1H BEARISH — WAIT 15M CONFIRMATION");
        }
        if (s15.k > s15.d) issues.push("15M BULLISH");
        else issues.push("15M BEARISH");
      }

      if (vol1h.compressing) issues.push("VOL COMPRESSING");
      if (vol1h.expanding) issues.push("VOL EXPANDING");
    }
    return {
      symbol, price: round(price), state: "WAIT", setup: "NONE", structure: structure4h, bias,
      confidence: 0, adx: round(adx4h), atr: round(a15, 2), stochK: round(s15.k), stochD: round(s15.d),
      rsi: round(r15), reason: `WAIT (${issues.join(" | ")})`, stopLoss: null, takeProfit: null,
      rr: null, expectedMove: 0, updatedAt: now, entryTimeframe: "NONE",
      higherTimeframeStoch: `1H:${round(s1h.k)}/${round(s1h.d)} | 4H:${round(s4h.k)}/${round(s4h.d)}`
    };
  }

  /* ---- SIZING: ATR-based ---- */
  const priceForSizing = entryTimeframe === "1H" ? price1h : price15;
  const atrForSizing = entryTimeframe === "1H" ? a1h : a15;
  const atrPct = atrForSizing / priceForSizing;

  const atrMultiplier = state === "SNIPER"
    ? Math.max(2.5, Math.min(4.0, vol1h.expanding ? 3.5 : 3.0))
    : Math.max(2.0, Math.min(3.5, vol1h.expanding ? 3.0 : 2.5));

  const expectedMove = Math.max(0.012, Math.min(0.05, atrPct * atrMultiplier));

  // Stop loss: tighter of ATR-based or structural, with min/max bounds
  const minSlPct = 0.003;
  const maxSlPct = 0.02;

  let sl: number;
  if (entryBias === "LONG") {
    const atrSl = priceForSizing * (1 - Math.max(minSlPct, Math.min(maxSlPct, expectedMove * 0.45)));
    const structuralSl = swings1h.lastLow ? swings1h.lastLow.value * 0.998 : atrSl;
    sl = Math.max(atrSl, structuralSl);
    if (sl >= priceForSizing) sl = atrSl;
  } else {
    const atrSl = priceForSizing * (1 + Math.max(minSlPct, Math.min(maxSlPct, expectedMove * 0.45)));
    const structuralSl = swings1h.lastHigh ? swings1h.lastHigh.value * 1.002 : atrSl;
    sl = Math.min(atrSl, structuralSl);
    if (sl <= priceForSizing) sl = atrSl;
  }

  const tp = entryBias === "LONG" ? priceForSizing * (1 + expectedMove) : priceForSizing * (1 - expectedMove);
  const rr = Math.abs((tp - priceForSizing) / (priceForSizing - sl));

  /* ---- CONFIDENCE: Data-driven scoring ---- */
  let confidence = 60;

  confidence += state === "SNIPER" ? 15 : 10;
  if (setup === "BREAKDOWN" || setup === "BREAKUP") confidence += 8;
  else if (setup === "PULLBACK") confidence += 5;

  if (primaryAdx > 30) confidence += 10;
  else if (primaryAdx > 20) confidence += 5;
  else if (primaryAdx < 15) confidence -= 5;

  if (entryBias === "LONG") {
    if (primaryRsi > 50 && primaryRsi < 70) confidence += 5;
    if (primaryRsi > 40 && primaryRsi < 80) confidence += 3;
    if (primaryRsi < 30) confidence += 2;
    if (primaryRsi > 80) confidence -= 8;
  } else {
    if (primaryRsi < 50 && primaryRsi > 30) confidence += 5;
    if (primaryRsi < 60 && primaryRsi > 20) confidence += 3;
    if (primaryRsi > 70) confidence += 2;
    if (primaryRsi < 20) confidence -= 8;
  }

  const stochDiff = Math.abs(primaryStochK - primaryStochD);
  if (stochDiff < 5) confidence += 5;
  else if (stochDiff < 15) confidence += 2;

  if (entryBias === "LONG") {
    if (s4h.k > s4h.d) confidence += 3;
    if (s1h.k > s1h.d) confidence += 3;
    if (r4h > 50) confidence += 2;
  } else {
    if (s4h.k < s4h.d) confidence += 3;
    if (s1h.k < s1h.d) confidence += 3;
    if (r4h < 50) confidence += 2;
  }

  // Anti-chase: entering when lower TF is at extreme opposite
  if (entryTimeframe === "1H") {
    const chasing15m = (entryBias === "LONG" && s15.k > 80) || (entryBias === "SHORT" && s15.k < 20);
    if (chasing15m) confidence -= 15;
  }
  if (entryTimeframe === "15M") {
    const chasing1h = (entryBias === "LONG" && s1h.k > 85) || (entryBias === "SHORT" && s1h.k < 15);
    if (chasing1h) confidence -= 10;
  }

  // Momentum exhaustion penalties
  const htfStochK = entryTimeframe === "15M" ? s1h.k : s4h.k;
  const exhaust = checkMomentumExhaustion(entryBias as "LONG" | "SHORT", primaryRsi, primaryStochK, htfStochK);
  confidence -= exhaust.penalty;

  if (vol1h.compressing) confidence -= 5;

  confidence = Math.max(0, Math.min(100, confidence));

  const htStoch = entryTimeframe === "15M"
    ? `1H:${round(s1h.k)}/${round(s1h.d)} | 4H:${round(s4h.k)}/${round(s4h.d)}`
    : `4H:${round(s4h.k)}/${round(s4h.d)} | 1H:${round(s1h.k)}/${round(s1h.d)}`;

  return {
    symbol, price: round(priceForSizing), state, setup, structure: structure4h, bias: entryBias,
    confidence, adx: round(primaryAdx), atr: round(a15, 2), stochK: round(primaryStochK), stochD: round(primaryStochD),
    rsi: round(primaryRsi), reason: `${state} ${setup} ${entryBias} on ${entryTimeframe} | 4H:${structure4h} 1H:${structure1h} | ADX:${round(primaryAdx)}${exhaust.penalty > 0 ? " | EXHAUST:" + exhaust.reason : ""}`,
    stopLoss: round(sl, 4), takeProfit: round(tp, 4), rr: round(rr, 2), expectedMove: round(expectedMove * 100, 2),
    updatedAt: now, entryTimeframe,
    higherTimeframeStoch: htStoch
  };
}
