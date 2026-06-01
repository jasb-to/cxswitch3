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
   RANGE HELPERS
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
   COMPRESSION (EARLY)
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
   PRESSURE (SETUP)
========================= */

function detectPressure(c: Candle[]) {
  const last5 = c.slice(-5);

  const lows = last5.map(x => x.low);
  const highs = last5.map(x => x.high);

  let higherLows = true;
  let lowerHighs = true;

  for (let i = 1; i < last5.length; i++) {
    if (lows[i] < lows[i - 1]) higherLows = false;
    if (highs[i] > highs[i - 1]) lowerHighs = false;
  }

  return {
    bullish: higherLows,
    bearish: lowerHighs,
  };
}

/* =========================
   BREAKOUT (SNIPER)
========================= */

function detectBreakout(c: Candle[]) {
  const last20 = c.slice(-20);
  const last = c[c.length - 1];

  const recentHigh = Math.max(...last20.map(x => x.high));
  const recentLow = Math.min(...last20.map(x => x.low));

  return {
    up: last.close > recentHigh,
    down: last.close < recentLow,
  };
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

  // =========================
  // STATES
  // =========================

  const isEarly = compression;

  const isSetup =
    compression && (pressure.bullish || pressure.bearish);

  const isSniper =
    isSetup && (breakout.up || breakout.down);

  // =========================
  // BIAS
  // =========================

  const bias: "Bullish" | "Bearish" | "Neutral" =
    pressure.bullish
      ? "Bullish"
      : pressure.bearish
      ? "Bearish"
      : "Neutral";

  // =========================
  // CONFIDENCE (simple, not over-engineered)
  // =========================

  const confidence = isSniper
    ? 85
    : isSetup
    ? 65
    : isEarly
    ? 45
    : 20;

  // =========================
  // TRADE LEVELS (ONLY SETUP+)
  // =========================

  let stopLoss: number | null = null;
  let takeProfit: number | null = null;
  let rrr: number | null = null;

  if (isSetup) {
    const last10 = c.slice(-10);

    const range =
      Math.max(...last10.map(x => x.high)) -
      Math.min(...last10.map(x => x.low));

    const buffer = range * 0.2;

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

  // =========================
  // OUTPUT
  // =========================

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
