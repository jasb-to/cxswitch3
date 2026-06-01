export type Symbol = "BTC" | "ETH" | "SOL";

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

  isEarly: boolean;
  isSetup: boolean;
  isSniper: boolean;

  bias: "Bullish" | "Bearish" | "Neutral";

  confidence: number;

  adx: number;
  stochK: number;
  stochD: number;

  reason: string;

  stopLoss: number | null;
  takeProfit: number | null;
  riskRewardRatio: number | null;

  updatedAt: string;
}

/* =========================
   RANGE
========================= */

function getRange(candles: Candle[]) {
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);

  return {
    high: Math.max(...highs),
    low: Math.min(...lows),
  };
}

/* =========================
   COMPRESSION
========================= */

function isCompression(c: Candle[]) {
  const last10 = c.slice(-10);
  const prev10 = c.slice(-20, -10);

  if (last10.length < 10 || prev10.length < 10) return false;

  const r1 = getRange(last10);
  const r2 = getRange(prev10);

  const range1 = r1.high - r1.low;
  const range2 = r2.high - r2.low;

  return range1 < range2 * 0.8;
}

/* =========================
   LIQUIDITY LEVELS
========================= */

function getLiquidityLevels(c: Candle[]) {
  const last20 = c.slice(-20);

  return {
    high: Math.max(...last20.map(x => x.high)),
    low: Math.min(...last20.map(x => x.low)),
  };
}

function detectLiquidityPressure(c: Candle[]) {
  const last5 = c.slice(-5);
  const levels = getLiquidityLevels(c);

  const latest = last5[last5.length - 1];

  return {
    nearHigh: latest.close > levels.high * 0.995,
    nearLow: latest.close < levels.low * 1.005,
  };
}

/* =========================
   PRESSURE
========================= */

function detectPressure(c: Candle[]) {
  const last5 = c.slice(-5);

  const lows = last5.map(x => x.low);
  const highs = last5.map(x => x.high);

  let bullish = true;
  let bearish = true;

  for (let i = 1; i < last5.length; i++) {
    if (lows[i] < lows[i - 1]) bullish = false;
    if (highs[i] > highs[i - 1]) bearish = false;
  }

  return {
    bullish,
    bearish,
  };
}

/* =========================
   BREAKOUT
========================= */

function detectBreakout(c: Candle[]) {
  const last20 = c.slice(-20);
  const last = c[last.length - 1];

  const recentHigh = Math.max(...last20.map(x => x.high));
  const recentLow = Math.min(...last20.map(x => x.low));

  return {
    up: last.close > recentHigh,
    down: last.close < recentLow,
  };
}

/* =========================
   EARLY (UPDATED EDGE)
========================= */

function isEarlySignal(c: Candle[]) {
  return isCompression(c) && detectLiquidityPressure(c).nearHigh
    || isCompression(c) && detectLiquidityPressure(c).nearLow;
}

/* =========================
   MAIN ENGINE
========================= */

export function generateSignal(
  symbol: Symbol,
  candles: Candle[],
  livePrice: number
): Signal {
  const c = [...candles].reverse();

  const compression = isCompression(c);
  const pressure = detectPressure(c);
  const breakout = detectBreakout(c);
  const liquidity = detectLiquidityPressure(c);

  const isEarly = isEarlySignal(c);

  const isSetup =
    compression && (pressure.bullish || pressure.bearish);

  const isSniper =
    isSetup && (breakout.up || breakout.down);

  const bias: "Bullish" | "Bearish" | "Neutral" =
    pressure.bullish
      ? "Bullish"
      : pressure.bearish
      ? "Bearish"
      : "Neutral";

  const confidence = isSniper
    ? 85
    : isSetup
    ? 65
    : isEarly
    ? 45
    : 20;

  let stopLoss: number | null = null;
  let takeProfit: number | null = null;
  let rrr: number | null = null;

  if (isSetup) {
    const last10 = c.slice(-10);

    const range =
      Math.max(...last10.map(x => x.high)) -
      Math.min(...last10.map(x => x.low));

    if (bias === "Bullish") {
      stopLoss = livePrice - range * 0.5;
      takeProfit = livePrice + range;
    }

    if (bias === "Bearish") {
      stopLoss = livePrice + range * 0.5;
      takeProfit = livePrice - range;
    }

    rrr = 2;
  }

  return {
    symbol,
    price: livePrice,

    isEarly,
    isSetup,
    isSniper,

    bias,
    confidence,

    adx: 0,
    stochK: 0,
    stochD: 0,

    reason: isSniper
      ? "BREAKOUT"
      : isSetup
      ? "COMPRESSION + PRESSURE"
      : "COMPRESSION",

    stopLoss,
    takeProfit,
    riskRewardRatio: rrr,

    updatedAt: new Date().toISOString(),
  };
}
