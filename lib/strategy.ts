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

const hasMinimumCandles = (candles: Candle[] | null | undefined, min: number): boolean =>
  Array.isArray(candles) && candles.length >= min;

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

/* ---------------- WILDER SMOOTHED RSI ---------------- */

function wilderRsi(closes: number[], period = 14): number {
  if (closes.length < period + 1) return 50;

  let avgGain = 0;
  let avgLoss = 0;

  // Initial SMA
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) avgGain += diff;
    else avgLoss -= diff;
  }
  avgGain /= period;
  avgLoss /= period;

  // Wilder's smoothing
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;

    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  const rs = avgGain / (avgLoss || 1);
  return 100 - 100 / (1 + rs);
}

/* ---------------- SMOOTHED STOCHASTIC (STRUCTURE-TIED) ---------------- */

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

  const smoothKs: number[] = [];
  for (let i = smoothK - 1; i < rawK.length; i++) {
    smoothKs.push(
      rawK.slice(i - smoothK + 1, i + 1).reduce((a, b) => a + b, 0) / smoothK
    );
  }

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

  let atrWilder = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  let pDI = plusDMs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  let mDI = minusDMs.slice(0, period).reduce((a, b) => a + b, 0) / period;

  const dxs: number[] = [];

  for (let i = period; i < trs.length; i++) {
    atrWilder = (atrWilder * (period - 1) + trs[i]) / period;
    pDI = (pDI * (period - 1) + plusDMs[i]) / period;
    mDI = (mDI * (period - 1) + minusDMs[i]) / period;

    const p = 100 * pDI / (atrWilder || 1);
    const m = 100 * mDI / (atrWilder || 1);
    dxs.push(100 * Math.abs(p - m) / (p + m || 1));
  }

  if (dxs.length < period) return dxs.at(-1) ?? 0;

  let adxValue = dxs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < dxs.length; i++) {
    adxValue = (adxValue * (period - 1) + dxs[i]) / period;
  }

  return adxValue;
}

/* ---------------- VOLUME ENGINE ---------------- */

function volumeConfirmed(
  candles: Candle[],
  minRatio = 1.2
): { confirmed: boolean; ratio: number } {
  if (!hasMinimumCandles(candles, 21)) return { confirmed: false, ratio: 0 };

  const volumes = candles.map((c) => c.volume);
  const avgVol = volumes.slice(-21, -1).reduce((a, b) => a + b, 0) / 20;
  const currentVol = volumes.at(-1) ?? 0;

  const ratio = avgVol > 0 ? currentVol / avgVol : 0;
  return { confirmed: ratio >= minRatio, ratio };
}

/* ---------------- STRUCTURE ENGINE (HARDENED) ---------------- */

function getStructure(
  candles: Candle[],
  minSwings = 8,
  minSwingDistPct = 0.003
): Structure {
  if (!hasMinimumCandles(candles, 10)) return "RANGE";

  const swings: { type: "HIGH" | "LOW"; value: number; idx: number }[] = [];

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

    if (isHigh) swings.push({ type: "HIGH", value: c.high, idx: i });
    if (isLow) swings.push({ type: "LOW", value: c.low, idx: i });
  }

  if (swings.length < minSwings) return "RANGE";

  const filteredSwings: typeof swings = [];
  for (const swing of swings) {
    const lastSame = filteredSwings.filter((s) => s.type === swing.type).at(-1);
    if (!lastSame) {
      filteredSwings.push(swing);
      continue;
    }
    const dist = Math.abs(swing.value - lastSame.value) / swing.value;
    if (dist >= minSwingDistPct) {
      filteredSwings.push(swing);
    }
  }

  const highs = filteredSwings.filter((s) => s.type === "HIGH").map((s) => s.value);
  const lows = filteredSwings.filter((s) => s.type === "LOW").map((s) => s.value);

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

/* ---------------- DIRECTION-PENALIZED STRUCTURE STRENGTH ---------------- */

function structureStrength(
  candles: Candle[],
  minSwingDistPct = 0.003
): { score: number; direction: "UP" | "DOWN" | "MIXED" } {
  if (!hasMinimumCandles(candles, 10)) return { score: 0, direction: "MIXED" };

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

  const filtered: typeof swings = [];
  for (const swing of swings) {
    const lastSame = filtered.filter((s) => s.type === swing.type).at(-1);
    if (!lastSame) {
      filtered.push(swing);
      continue;
    }
    const dist = Math.abs(swing.value - lastSame.value) / swing.value;
    if (dist >= minSwingDistPct) filtered.push(swing);
  }

  const highs = filtered.filter((s) => s.type === "HIGH").map((s) => s.value);
  const lows = filtered.filter((s) => s.type === "LOW").map((s) => s.value);

  if (highs.length < 4 || lows.length < 4) return { score: 0, direction: "MIXED" };

  let hh = 0, hl = 0, lh = 0, ll = 0;
  for (let i = 1; i < highs.length; i++) {
    if (highs[i] > highs[i - 1]) hh++; else lh++;
  }
  for (let i = 1; i < lows.length; i++) {
    if (lows[i] > lows[i - 1]) hl++; else ll++;
  }

  const upScore = (hh + hl) / (highs.length + lows.length - 2);
  const downScore = (lh + ll) / (highs.length + lows.length - 2);

  // Direction-penalized: mixed chop scores near zero
  const netScore = upScore - downScore;
  const absScore = Math.abs(netScore);

  if (netScore > 0.2) return { score: absScore, direction: "UP" };
  if (netScore < -0.2) return { score: absScore, direction: "DOWN" };
  return { score: Math.max(0, absScore - 0.3), direction: "MIXED" }; // penalize mixed
}

/* ---------------- BREAKOUT (HARDENED) ---------------- */

function breakout(
  candles: Candle[],
  structure4h: Structure,
  bias: "LONG" | "SHORT" | "NEUTRAL"
): "BREAKOUT_UP" | "BREAKOUT_DOWN" | "NONE" {
  if (!hasMinimumCandles(candles, 21)) return "NONE";

  const lookback = 20;
  const window = candles.slice(-lookback - 1, -1);
  const highs = window.map((c) => c.high);
  const lows = window.map((c) => c.low);

  const resistance = Math.max(...highs);
  const support = Math.min(...lows);

  const last = candles.at(-1)!;
  const prev = candles.at(-2)!;

  const brokeUp = last.close > resistance && prev.close <= resistance;
  const brokeDown = last.close < support && prev.close >= support;

  const upperWick = last.high - Math.max(last.open, last.close);
  const lowerWick = Math.min(last.open, last.close) - last.low;
  const body = Math.abs(last.close - last.open);

  const { confirmed: volConfirmed } = volumeConfirmed(candles, 1.15);

  if (brokeUp) {
    if (upperWick > body * 2.5) return "NONE";
    if (!volConfirmed && structure4h === "RANGE") return "NONE";

    if (bias === "LONG" || structure4h === "RANGE" || bias === "NEUTRAL")
      return "BREAKOUT_UP";
    return "NONE";
  }

  if (brokeDown) {
    if (lowerWick > body * 2.5) return "NONE";
    if (!volConfirmed && structure4h === "RANGE") return "NONE";

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

/* ---------------- ADAPTIVE VOLATILITY REGIME (DURATION FILTERED) ---------------- */

function getVolatilityRegime(
  candles: Candle[],
  currentAtr: number
): { compression: boolean; expansion: boolean; compressionDuration: number } {
  if (!hasMinimumCandles(candles, 25) || currentAtr <= 0) {
    return { compression: false, expansion: false, compressionDuration: 0 };
  }

  const priorCandles = candles.slice(0, -1);
  const historicalAtr = atr(priorCandles, 20);
  const ratio = historicalAtr > 0 ? currentAtr / historicalAtr : 1;

  let compressionDuration = 0;
  for (let i = candles.length - 1; i >= 1; i--) {
    const c = candles[i];
    const p = candles[i - 1];
    const tr = Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
    const cRatio = historicalAtr > 0 ? tr / historicalAtr : 1;
    if (cRatio < 0.6) compressionDuration++;
    else break;
  }

  return {
    compression: ratio < 0.6 && compressionDuration >= 2,
    expansion: ratio > 1.4,
    compressionDuration,
  };
}

/* ---------------- SYMBOL-NORMALIZED ATR BASELINE ---------------- */

function getSymbolAtrBaseline(symbol: Symbol): number {
  // Approximate historical daily ATR% for each asset
  // Used to normalize expectedMove scaling across BTC/ETH/SOL
  const baselines: Record<Symbol, number> = {
    BTC: 0.025, // ~2.5% daily
    ETH: 0.035, // ~3.5% daily
    SOL: 0.055, // ~5.5% daily
  };
  return baselines[symbol] ?? 0.03;
}

/* ---------------- REGIME-AWARE EXPECTED MOVE ---------------- */

function calculateExpectedMove(
  symbol: Symbol,
  atrPercent: number,
  state: SignalState,
  structure4h: Structure
): number {
  const baseline = getSymbolAtrBaseline(symbol);
  const normalizedAtr = atrPercent / baseline; // 1.0 = average vol for this asset

  // Regime-aware multipliers
  const trendMultiplier = state === "SNIPER" ? 2.5 : 1.5;
  const rangeMultiplier = state === "SNIPER" ? 1.8 : 1.0;

  const multiplier = structure4h !== "RANGE" ? trendMultiplier : rangeMultiplier;

  let expectedMove = atrPercent * multiplier * normalizedAtr;

  // Hard caps
  const maxMove = state === "SNIPER" ? 0.08 : 0.05;
  const minMove = state === "SNIPER" ? 0.012 : 0.006;

  return clamp(expectedMove, minMove, maxMove);
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

  /* ---- DEFENSIVE NULL/UNDEFINED GUARD ---- */
  if (
    !hasMinimumCandles(candles15m, 35) ||
    !hasMinimumCandles(candles1h, 25) ||
    !hasMinimumCandles(candles4h, 25)
  ) {
    return {
      symbol,
      price: round(price ?? 0),
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

  const c15 = candles15m as Candle[];
  const c1h = candles1h as Candle[];
  const c4h = candles4h as Candle[];

  /* ---- MULTI-TIMEFRAME STRUCTURE ---- */
  const structure4h = getStructure(c4h, 8, 0.003);
  const structure1h = getStructure(c1h, 8, 0.003);

  /* ---- BIAS (4H ONLY) ---- */
  const bias =
    structure4h === "UPTREND" ? "LONG"
    : structure4h === "DOWNTREND" ? "SHORT"
    : "NEUTRAL";

  /* ---- INDICATORS ---- */
  const closes15m = c15.map((c) => c.close);
  const closes1h = c1h.map((c) => c.close);

  const r15 = wilderRsi(closes15m);
  const r1h = wilderRsi(closes1h);

  const s15 = stoch(closes15m);
  const s1h = stoch(closes1h);

  const a15 = atr(c15);
  const a1h = atr(c1h);

  const adxValue = adx(c15);

  /* ---- SETUP DETECTION ---- */
  const brk = breakout(c15, structure4h, bias);
  const pullback = isPullback(c15, bias);

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
    const last20 = c15.slice(-20);
    const rangeHigh = Math.max(...last20.map((c) => c.high));
    const rangeLow = Math.min(...last20.map((c) => c.low));
    const rangeMid = (rangeHigh + rangeLow) / 2;
    const distFromMid = Math.abs(c15.at(-1)!.close - rangeMid) / rangeMid;
    if (distFromMid > 0.008) setup = "REVERSAL";
  }

  /* ---- VOLATILITY REGIME ---- */
  const { compression, expansion, compressionDuration } = getVolatilityRegime(c15, a15);

  /* ---- STRUCTURE-TIED STOCHASTIC TRIGGER ---- */
  // Only fire in the direction of the swing structure
  const stochCrossUp = s15.prevK < s15.prevD && s15.k > s15.d;
  const stochCrossDown = s15.prevK > s15.prevD && s15.k < s15.d;

  const stochAlignedLong = stochCrossUp && (structure4h === "UPTREND" || structure1h === "UPTREND");
  const stochAlignedShort = stochCrossDown && (structure4h === "DOWNTREND" || structure1h === "DOWNTREND");

  const entryValidLong =
    bias === "LONG" &&
    r15 > 40 &&
    r15 < 70 &&
    stochAlignedLong &&
    r1h > 50;

  const entryValidShort =
    bias === "SHORT" &&
    r15 > 30 &&
    r15 < 60 &&
    stochAlignedShort &&
    r1h < 50;

  const entryValid = entryValidLong || entryValidShort;

  /* ---- STRICT TIMEFRAME ALIGNMENT ---- */
  const timeframeAligned =
    (bias === "LONG" && structure1h === "UPTREND") ||
    (bias === "SHORT" && structure1h === "DOWNTREND") ||
    bias === "NEUTRAL";

  /* ---- DIRECTION-PENALIZED STRUCTURE STRENGTH ---- */
  const { score: strength4h, direction: strengthDir } = structureStrength(c4h, 0.003);
  const strongStructure = strength4h >= 0.75 && strengthDir !== "MIXED";

  /* ---- VOLUME CONFIRMATION ---- */
  const { confirmed: volConfirmed, ratio: volRatio } = volumeConfirmed(c15, 1.2);

  /* ---- STATE MACHINE ---- */
  const early =
    bias !== "NEUTRAL" &&
    setup !== "NONE" &&
    !compression &&
    timeframeAligned &&
    ((bias === "LONG" && r15 > 35) || (bias === "SHORT" && r15 < 65)) &&
    (structure4h !== "RANGE" || setup === "BREAKOUT");

  const sniper =
    early &&
    expansion &&
    entryValid &&
    structure4h !== "RANGE" &&
    timeframeAligned &&
    adxValue > 15 &&
    strongStructure &&
    volConfirmed &&
    ((setup === "PULLBACK" && pullback) ||
      (setup === "BREAKOUT" && brk !== "NONE"));

  const state: SignalState =
    sniper ? "SNIPER"
    : early ? "EARLY"
    : "WAIT";

  /* ---- REGIME-AWARE, SYMBOL-NORMALIZED EXPECTED MOVE ---- */
  const atrPercent = a15 / price;
  const expectedMove = calculateExpectedMove(symbol, atrPercent, state, structure4h);

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

  /* ---- CONFIDENCE ---- */
  let confidence = state === "SNIPER" ? 85 : state === "EARLY" ? 55 : 10;
  if (timeframeAligned && state !== "WAIT") confidence += 5;
  if (expansion && state !== "WAIT") confidence += 5;
  if (adxValue > 25 && state !== "WAIT") confidence += 5;
  if (strongStructure && state !== "WAIT") confidence += 5;
  if (volConfirmed && state !== "WAIT") confidence += 5;
  confidence = clamp(confidence, 0, 100);

  /* ---- REASON BUILDER ---- */
  let reason = "";
  if (state === "SNIPER") {
    const parts: string[] = [structure4h, setup];
    if (expansion) parts.push("EXPANSION");
    if (timeframeAligned) parts.push("1H-CONFIRM");
    if (strongStructure) parts.push(`STR ${round(strength4h * 100)}% ${strengthDir}`);
    if (volConfirmed) parts.push(`VOL ${round(volRatio, 1)}x`);
    if (adxValue > 15) parts.push(`ADX ${round(adxValue)}`);
    reason = `SNIPER (${parts.join(" | ")})`;
  } else if (state === "EARLY") {
    reason = `EARLY (${setup} FORMING | 4H: ${structure4h} | 1H: ${structure1h})`;
  } else {
    const issues: string[] = [];
    if (bias === "NEUTRAL") issues.push("NO 4H BIAS");
    if (setup === "NONE") issues.push("NO SETUP");
    if (compression) issues.push(`COMPRESSION ${compressionDuration}c`);
    if (!timeframeAligned) issues.push("1H-DIVERGENCE");
    if (!strongStructure) issues.push(`WEAK-STR ${strengthDir}`);
    if (strengthDir === "MIXED") issues.push("CHOP");
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
