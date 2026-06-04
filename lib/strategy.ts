export type Symbol = "BTC" | "ETH" | "SOL";

export type SignalState = "EARLY" | "SNIPER" | "WAIT";

export type SetupType =
  | "NONE"
  | "PULLBACK"
  | "BREAKOUT"
  | "REVERSAL";

export type Structure =
  | "UPTREND"
  | "DOWNTREND"
  | "RANGE";

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

/* ---------------- UTILS ---------------- */

const clamp = (n: number, min: number, max: number) =>
  Math.max(min, Math.min(max, n));

const round = (n: number, d = 2) =>
  Math.round(n * 10 ** d) / 10 ** d;

const hasMinimumCandles = (candles: Candle[], min: number) =>
  candles.length >= min;

/* ---------------- ATR (GUARDED) ---------------- */

function atr(candles: Candle[], period = 14): number {
  if (!hasMinimumCandles(candles, period + 1)) return 0;

  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const p = candles[i - 1];
    const tr = Math.max(
      c.high - c.low,
      Math.abs(c.high - p.close),
      Math.abs(c.low - p.close)
    );
    trs.push(tr);
  }

  const slice = trs.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}

/* ---------------- RSI (GUARDED) ---------------- */

function rsi(closes: number[]): number {
  if (closes.length < 2) return 50;

  let gain = 0;
  let loss = 0;

  for (let i = 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gain += diff;
    else loss -= diff;
  }

  const rs = gain / (loss || 1);
  return 100 - 100 / (1 + rs);
}

/* ---------------- SMOOTHED STOCHASTIC ---------------- */

function stoch(
  closes: number[],
  period = 14,
  smoothK = 3,
  smoothD = 3
) {
  const minLen = period + smoothK + smoothD;
  if (closes.length < minLen) {
    return { k: 50, d: 50, prevK: 50, prevD: 50 };
  }

  const rawK: number[] = [];
  for (let i = period - 1; i < closes.length; i++) {
    const slice = closes.slice(i - period + 1, i + 1);
    const high = Math.max(...slice);
    const low = Math.min(...slice);
    rawK.push(((closes[i] - low) / (high - low || 1)) * 100);
  }

  // Smooth K (SMA)
  const smoothKs: number[] = [];
  for (let i = smoothK - 1; i < rawK.length; i++) {
    smoothKs.push(
      rawK.slice(i - smoothK + 1, i + 1).reduce((a, b) => a + b, 0) / smoothK
    );
  }

  // Smooth D (SMA of smoothed K)
  const smoothDs: number[] = [];
  for (let i = smoothD - 1; i < smoothKs.length; i++) {
    smoothDs.push(
      smoothKs.slice(i - smoothD + 1, i + 1).reduce((a, b) => a + b, 0) / smoothD
    );
  }

  return {
    k: smoothKs.at(-1) ?? 50,
    d: smoothDs.at(-1) ?? 50,
    prevK: smoothKs.at(-2) ?? 50,
    prevD: smoothDs.at(-2) ?? 50,
  };
}

/* ---------------- ADX (WILDER'S) ---------------- */

function adx(candles: Candle[], period = 14): number {
  if (!hasMinimumCandles(candles, period * 2)) return 0;

  const trs: number[] = [];
  const plusDMs: number[] = [];
  const minusDMs: number[] = [];

  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const p = candles[i - 1];

    const tr = Math.max(
      c.high - c.low,
      Math.abs(c.high - p.close),
      Math.abs(c.low - p.close)
    );

    const upMove = c.high - p.high;
    const downMove = p.low - c.low;

    trs.push(tr);
    plusDMs.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDMs.push(downMove > upMove && downMove > 0 ? downMove : 0);
  }

  // Wilder's smoothing init
  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  let pDI = plusDMs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  let mDI = minusDMs.slice(0, period).reduce((a, b) => a + b, 0) / period;

  const dxs: number[] = [];

  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
    pDI = (pDI * (period - 1) + plusDMs[i]) / period;
    mDI = (mDI * (period - 1) + minusDMs[i]) / period;

    const p = 100 * pDI / (atr || 1);
    const m = 100 * mDI / (atr || 1);
    dxs.push(100 * Math.abs(p - m) / (p + m || 1));
  }

  if (dxs.length < period) return dxs.at(-1) ?? 0;

  // Smooth DX into ADX
  let adx = dxs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < dxs.length; i++) {
    adx = (adx * (period - 1) + dxs[i]) / period;
  }

  return adx;
}

/* ---------------- ROBUST STRUCTURE (5-BAR FRACTALS) ---------------- */

function getStructure(candles: Candle[], minSwings = 8): Structure {
  if (!hasMinimumCandles(candles, 10)) return "RANGE";

  const swings: { type: "HIGH" | "LOW"; value: number }[] = [];

  for (let i = 3; i < candles.length - 3; i++) {
    const c = candles[i];
    let isHigh = true;
    let isLow = true;

    for (let j = 1; j <= 3; j++) {
      if (c.high <= candles[i - j].high || c.high <= candles[i + j].high)
        isHigh = false;
      if (c.low >= candles[i - j].low || c.low >= candles[i + j].low)
        isLow = false;
    }

    if (isHigh) swings.push({ type: "HIGH", value: c.high });
    if (isLow) swings.push({ type: "LOW", value: c.low });
  }

  if (swings.length < minSwings) return "RANGE";

  const highs = swings.filter((s) => s.type === "HIGH").map((s) => s.value);
  const lows = swings.filter((s) => s.type === "LOW").map((s) => s.value);

  if (highs.length < 4 || lows.length < 4) return "RANGE";

  const lastHighs = highs.slice(-4);
  const lastLows = lows.slice(-4);

  const higherHighs = lastHighs.every((v, i, arr) => i === 0 || v > arr[i - 1]);
  const higherLows = lastLows.every((v, i, arr) => i === 0 || v > arr[i - 1]);
  const lowerHighs = lastHighs.every((v, i, arr) => i === 0 || v < arr[i - 1]);
  const lowerLows = lastLows.every((v, i, arr) => i === 0 || v < arr[i - 1]);

  if (higherHighs && higherLows) return "UPTREND";
  if (lowerHighs && lowerLows) return "DOWNTREND";
  return "RANGE";
}

/* ---------------- BREAKOUT (STRUCTURE-AWARE) ---------------- */

function breakout(
  candles: Candle[],
  structure4h: Structure,
  bias: "LONG" | "SHORT" | "NEUTRAL"
): "BREAKOUT_UP" | "BREAKOUT_DOWN" | "NONE" {
  if (!hasMinimumCandles(candles, 21)) return "NONE";

  const lookback = 20;
  // Use the 20 candles BEFORE the current candle to set the level
  const window = candles.slice(-lookback - 1, -1);
  const highs = window.map((c) => c.high);
  const lows = window.map((c) => c.low);

  const resistance = Math.max(...highs);
  const support = Math.min(...lows);

  const last = candles.at(-1)!;
  const prev = candles.at(-2)!;

  // Confirmed close beyond level (not just wick)
  const brokeUp = last.close > resistance && prev.close <= resistance;
  const brokeDown = last.close < support && prev.close >= support;

  if (brokeUp) {
    if (bias === "LONG" || structure4h === "RANGE" || bias === "NEUTRAL")
      return "BREAKOUT_UP";
    return "NONE"; // reject counter-trend breakout
  }

  if (brokeDown) {
    if (bias === "SHORT" || structure4h === "RANGE" || bias === "NEUTRAL")
      return "BREAKOUT_DOWN";
    return "NONE";
  }

  return "NONE";
}

/* ---------------- PULLBACK DETECTION ---------------- */

function isPullback(
  candles: Candle[],
  bias: "LONG" | "SHORT" | "NEUTRAL"
): boolean {
  if (!hasMinimumCandles(candles, 15) || bias === "NEUTRAL") return false;

  const recent = candles.slice(-15);
  const last = candles.at(-1)!;

  if (bias === "LONG") {
    const highest = Math.max(...recent.map((c) => c.high));
    const highestIdx = recent.findIndex((c) => c.high === highest);
    // High formed recently and price has pulled back but not broken structure
    if (highestIdx >= 8 && highestIdx < 14) {
      const priorLow = Math.min(
        ...recent.slice(0, highestIdx + 1).map((c) => c.low)
      );
      return last.close < highest && last.close > priorLow * 1.002;
    }
  } else {
    const lowest = Math.min(...recent.map((c) => c.low));
    const lowestIdx = recent.findIndex((c) => c.low === lowest);
    if (lowestIdx >= 8 && lowestIdx < 14) {
      const priorHigh = Math.max(
        ...recent.slice(0, lowestIdx + 1).map((c) => c.high)
      );
      return last.close > lowest && last.close < priorHigh * 0.998;
    }
  }

  return false;
}

/* ---------------- ADAPTIVE VOLATILITY REGIME ---------------- */

function getVolatilityRegime(
  candles: Candle[],
  currentAtr: number
): { compression: boolean; expansion: boolean } {
  if (!hasMinimumCandles(candles, 25) || currentAtr <= 0) {
    return { compression: false, expansion: false };
  }

  const priorCandles = candles.slice(0, -1);
  const historicalAtr = atr(priorCandles, 20);
  const ratio = historicalAtr > 0 ? currentAtr / historicalAtr : 1;

  return {
    compression: ratio < 0.6,
    expansion: ratio > 1.4,
  };
}

/* ---------------- CORE ENGINE ---------------- */

export function generateSignal(
  symbol: Symbol,
  price: number,
  candles15m: Candle[],
  candles1h: Candle[],
  candles4h: Candle[]
): Signal {
  const now = new Date().toISOString();

  /* ---- HARD DATA GUARD ---- */
  if (
    !hasMinimumCandles(candles15m, 35) ||
    !hasMinimumCandles(candles1h, 25) ||
    !hasMinimumCandles(candles4h, 25)
  ) {
    return {
      symbol,
      price: round(price),
      state: "WAIT",
      setup: "NONE",
      structure: "RANGE",
      bias: "NEUTRAL",
      confidence: 0,
      adx: 0,
      atr: 0,
      stochK: 50,
      stochD: 50,
      rsi: 50,
      reason: "INSUFFICIENT CANDLE DATA",
      stopLoss: null,
      takeProfit: null,
      rr: null,
      expectedMove: 0,
      updatedAt: now,
    };
  }

  /* ---- MULTI-TIMEFRAME STRUCTURE ---- */
  const structure4h = getStructure(candles4h, 8);
  const structure1h = getStructure(candles1h, 8);

  /* ---- BIAS (4H ONLY) ---- */
  const bias =
    structure4h === "UPTREND" ? "LONG"
    : structure4h === "DOWNTREND" ? "SHORT"
    : "NEUTRAL";

  /* ---- INDICATORS ---- */
  const closes15m = candles15m.map((c) => c.close);
  const closes1h = candles1h.map((c) => c.close);

  const r15 = rsi(closes15m);
  const r1h = rsi(closes1h);

  const s15 = stoch(closes15m);
  const s1h = stoch(closes1h);

  const a15 = atr(candles15m);
  const a1h = atr(candles1h);

  const adxValue = adx(candles15m);

  /* ---- SETUP DETECTION ---- */
  const brk = breakout(candles15m, structure4h, bias);
  const pullback = isPullback(candles15m, bias);

  let setup: SetupType = "NONE";

  if (brk === "BREAKOUT_UP" && (bias === "LONG" || structure4h === "RANGE")) {
    setup = "BREAKOUT";
  } else if (
    brk === "BREAKOUT_DOWN" &&
    (bias === "SHORT" || structure4h === "RANGE")
  ) {
    setup = "BREAKOUT";
  } else if (pullback && bias !== "NEUTRAL" && structure4h !== "RANGE") {
    setup = "PULLBACK";
  } else if (structure4h === "RANGE" && brk === "NONE") {
    const last20 = candles15m.slice(-20);
    const rangeHigh = Math.max(...last20.map((c) => c.high));
    const rangeLow = Math.min(...last20.map((c) => c.low));
    const rangeMid = (rangeHigh + rangeLow) / 2;
    const distFromMid =
      Math.abs(candles15m.at(-1)!.close - rangeMid) / rangeMid;
    if (distFromMid > 0.008) setup = "REVERSAL";
  }

  /* ---- VOLATILITY REGIME ---- */
  const { compression, expansion } = getVolatilityRegime(candles15m, a15);

  /* ---- ENTRY VALIDATION (MULTI-TIMEFRAME) ---- */
  const stochCrossUp = s15.prevK < s15.prevD && s15.k > s15.d;
  const stochCrossDown = s15.prevK > s15.prevD && s15.k < s15.d;

  // 15m entry trigger + 1h momentum confirmation
  const entryValidLong =
    bias === "LONG" &&
    r15 > 40 &&
    r15 < 70 &&
    stochCrossUp &&
    r1h > 50;

  const entryValidShort =
    bias === "SHORT" &&
    r15 > 30 &&
    r15 < 60 &&
    stochCrossDown &&
    r1h < 50;

  const entryValid = entryValidLong || entryValidShort;

  /* ---- TIMEFRAME ALIGNMENT ---- */
  const timeframeAligned =
    (bias === "LONG" && structure1h !== "DOWNTREND") ||
    (bias === "SHORT" && structure1h !== "UPTREND") ||
    bias === "NEUTRAL";

  /* ---- STATE MACHINE ---- */

  // EARLY: specific setup forming, macro structure clear, not compressed, 1h aligned
  const early =
    bias !== "NEUTRAL" &&
    setup !== "NONE" &&
    !compression &&
    timeframeAligned &&
    ((bias === "LONG" && r15 > 35) || (bias === "SHORT" && r15 < 65));

  // SNIPER: full confluence stack
  const sniper =
    early &&
    expansion &&
    entryValid &&
    structure4h !== "RANGE" &&
    timeframeAligned &&
    adxValue > 15 &&
    ((setup === "PULLBACK" && pullback) ||
      (setup === "BREAKOUT" && brk !== "NONE"));

  const state: SignalState =
    sniper ? "SNIPER"
    : early ? "EARLY"
    : "WAIT";

  /* ---- CONFIDENCE ---- */
  let confidence = state === "SNIPER" ? 85 : state === "EARLY" ? 60 : 15;
  if (timeframeAligned && state !== "WAIT") confidence += 5;
  if (expansion && state !== "WAIT") confidence += 5;
  if (adxValue > 25 && state !== "WAIT") confidence += 5;
  confidence = clamp(confidence, 0, 100);

  /* ---- ATR-SCALED RR MODEL ---- */
  const atrPercent = a15 / price;

  const expectedMove =
    state === "SNIPER" ? Math.max(0.015, atrPercent * 3)
    : state === "EARLY" ? Math.max(0.008, atrPercent * 1.8)
    : 0;

  let sl: number | null = null;
  let tp: number | null = null;

  if (bias === "LONG" && state !== "WAIT") {
    sl = price * (1 - expectedMove * 0.5);
    tp = price * (1 + expectedMove);
  } else if (bias === "SHORT" && state !== "WAIT") {
    sl = price * (1 + expectedMove * 0.5);
    tp = price * (1 - expectedMove);
  }

  const rr = sl && tp ? Math.abs((tp - price) / (price - sl)) : null;

  /* ---- REASON BUILDER ---- */
  let reason = "";
  if (state === "SNIPER") {
    const parts: string[] = [structure4h, setup];
    if (expansion) parts.push("EXPANSION");
    if (timeframeAligned) parts.push("1H-ALIGN");
    if (adxValue > 15) parts.push(`ADX ${round(adxValue)}`);
    reason = `SNIPER (${parts.join(" | ")})`;
  } else if (state === "EARLY") {
    reason = `EARLY (${setup} FORMING | 4H: ${structure4h} | 1H: ${structure1h})`;
  } else {
    const issues: string[] = [];
    if (bias === "NEUTRAL") issues.push("NO 4H BIAS");
    if (setup === "NONE") issues.push("NO SETUP");
    if (compression) issues.push("COMPRESSION");
    if (!timeframeAligned) issues.push("1H-DIVERGENCE");
    reason = issues.length ? `WAIT (${issues.join(", ")})` : "WAIT (NO CONFLUENCE)";
  }

  return {
    symbol,
    price: round(price),

    state,
    setup,
    structure: structure4h,

    bias,

    confidence,

    adx: round(adxValue),
    atr: round(a15, 2),

    stochK: round(s15.k),
    stochD: round(s15.d),
    rsi: round(r15),

    reason,

    stopLoss: sl ? round(sl, 2) : null,
    takeProfit: tp ? round(tp, 2) : null,
    rr: rr ? round(rr, 2) : null,

    expectedMove: round(expectedMove * 100, 2),

    updatedAt: now,
  };
}
