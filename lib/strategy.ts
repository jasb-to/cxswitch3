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

function isCompression(candles: Candle[]) {
  const last10 = candles.slice(-10);
  const prev10 = candles.slice(-20, -10);

  if (last10.length < 10 || prev10.length < 10) return false;

  const r1 = getRange(last10);
  const r2 = getRange(prev10);

  const range1 = r1.high - r1.low;
  const range2 = r2.high - r2.low;

  return range1 < range2 * 0.8;
}

/* =========================
   PRESSURE
========================= */

function detectPressure(candles: Candle[]) {
  const last5 = candles.slice(-5);

  let bullish = true;
  let bearish = true;

  for (let i = 1; i < last5.length; i++) {
    if (last5[i].low < last5[i - 1].low) bullish = false;
    if (last5[i].high > last5[i - 1].high) bearish = false;
  }

  return { bullish, bearish };
}

/* =========================
   LIQUIDITY LEVELS
========================= */

function getLiquidityLevels(candles: Candle[]) {
  const last20 = candles.slice(-20);

  return {
    high: Math.max(...last20.map(x => x.high)),
    low: Math.min(...last20.map(x => x.low)),
  };
}

function detectLiquidityPressure(candles: Candle[]) {
  const last = candles[candles.length - 1];
  const levels = getLiquidityLevels(candles);

  return {
    nearHigh: last.close > levels.high * 0.995,
    nearLow: last.close < levels.low * 1.005,
  };
}

/* =========================
   LIQUIDITY SWEEP (NEW EDGE)
========================= */

function detectLiquiditySweep(candles: Candle[]) {
  const last20 = candles.slice(-20);
  const last = candles[candles.length - 1];

  const high = Math.max(...last20.map(x => x.high));
  const low = Math.min(...last20.map(x => x.low));

  const sweepHigh = last.high > high && last.close < high;
  const sweepLow = last.low < low && last.close > low;

  return { sweepHigh, sweepLow };
}

/* =========================
   BREAKOUT
========================= */

function detectBreakout(candles: Candle[]) {
  const last20 = candles.slice(-20);
  const last = candles[candles.length - 1];

  const high = Math.max(...last20.map(x => x.high));
  const low = Math.min(...last20.map(x => x.low));

  return {
    up: last.close > high,
    down: last.close < low,
  };
}

/* =========================
   EARLY SIGNAL
========================= */

function isEarlySignal(candles: Candle[]) {
  return (
    isCompression(candles) &&
    (detectLiquidityPressure(candles).nearHigh ||
      detectLiquidityPressure(candles).nearLow)
  );
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
  const sweep = detectLiquiditySweep(c);

  const isEarly = isEarlySignal(c);

  const isSetup = compression && (pressure.bullish || pressure.bearish);

  const isSniper =
    isSetup &&
    (sweep.sweepHigh ||
      sweep.sweepLow ||
      breakout.up ||
      breakout.down);

  const bias: "Bullish" | "Bearish" | "Neutral" =
    sweep.sweepLow
      ? "Bullish"
      : sweep.sweepHigh
      ? "Bearish"
      : pressure.bullish
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
      ? "LIQUIDITY SWEEP / BREAKOUT"
      : isSetup
      ? "COMPRESSION + PRESSURE"
      : "COMPRESSION",

    stopLoss,
    takeProfit,
    riskRewardRatio: rrr,

    updatedAt: new Date().toISOString(),
  };
}
