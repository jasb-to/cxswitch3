export type Symbol = "BTC" | "ETH" | "SOL";

export type SignalState = "EARLY" | "SNIPER" | "WAIT";

export interface Signal {
  symbol: Symbol;
  price: number;

  state: SignalState;

  bias: "LONG" | "SHORT" | "NEUTRAL";
  confidence: number;

  adx: number;
  stoch: number;

  compression: number;

  reason: string;

  stopLoss: number | null;
  takeProfit: number | null;
  riskReward: number | null;

  updatedAt: string;
}

/* -------------------------
   helpers (safe maths)
--------------------------*/

function avg(arr: number[]) {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

/* -------------------------
   SAFE STRENGTH CALC
--------------------------*/

function calcRange(highs: number[], lows: number[]) {
  return Math.max(...highs) - Math.min(...lows);
}

/* -------------------------
   MAIN ENGINE
--------------------------*/

export function generateSignal(
  symbol: Symbol,
  candles15m: any[],
  candles1h: any[],
  price: number
): Signal {
  const c15 = candles15m.slice(-20);
  const c1h = candles1h.slice(-20);

  const closes = c15.map(c => Number(c.close));
  const highs = c15.map(c => Number(c.high));
  const lows = c15.map(c => Number(c.low));

  if (closes.length < 5 || highs.length < 5 || lows.length < 5) {
    return fallback(symbol, price);
  }

  const range = calcRange(highs, lows);
  const mean = avg(closes);

  const volatility = mean === 0 ? 0 : range / mean;

  /* -------------------------
     STRUCTURE DETECTION
  --------------------------*/

  const trend15 = closes[closes.length - 1] - closes[0];
  const trend1h =
    c1h.length > 1
      ? Number(c1h[c1h.length - 1].close) - Number(c1h[0].close)
      : 0;

  const compression = volatility < 0.012;

  let state: SignalState = "WAIT";

  // EARLY = compression + no momentum
  if (compression && Math.abs(trend15) < price * 0.002) {
    state = "EARLY";
  }

  // SNIPER = breakout AFTER compression
  if (!compression && Math.abs(trend15) > price * 0.008) {
    state = "SNIPER";
  }

  /* -------------------------
     BIAS
  --------------------------*/

  const bias: Signal["bias"] =
    trend1h > 0 && trend15 > 0
      ? "LONG"
      : trend1h < 0 && trend15 < 0
      ? "SHORT"
      : "NEUTRAL";

  /* -------------------------
     CONFIDENCE (stable scaling)
  --------------------------*/

  let confidence = 20;

  if (state === "EARLY") {
    confidence = 50 + (1 - volatility * 50) * 20;
  }

  if (state === "SNIPER") {
    confidence = 75 + Math.min(20, Math.abs(trend15 / price) * 1000);
  }

  confidence = clamp(confidence, 10, 95);

  /* -------------------------
     ADX (proxy but stable)
  --------------------------*/

  const adx = clamp(volatility * 2500, 5, 60);

  /* -------------------------
     STOCH (FIXED - NO NaN EVER)
  --------------------------*/

  const minLow = Math.min(...lows);
  const maxHigh = Math.max(...highs);

  const rangeSafe = maxHigh - minLow;

  const stoch =
    rangeSafe === 0
      ? 50
      : clamp(((price - minLow) / rangeSafe) * 100, 0, 100);

  /* -------------------------
     MOVE MODEL (3–5% TARGET)
  --------------------------*/

  const expectedMove =
    state === "SNIPER"
      ? 0.035 + volatility
      : state === "EARLY"
      ? 0.025 + volatility
      : 0.01;

  /* -------------------------
     SL / TP (FIXED — NEVER ZERO)
  --------------------------*/

  let stopLoss: number | null = null;
  let takeProfit: number | null = null;
  let rr: number | null = null;

  if (state !== "WAIT") {
    const risk = expectedMove * 0.5;

    if (bias === "LONG") {
      stopLoss = price * (1 - risk);
      takeProfit = price * (1 + expectedMove);
    }

    if (bias === "SHORT") {
      stopLoss = price * (1 + risk);
      takeProfit = price * (1 - expectedMove);
    }

    if (stopLoss && takeProfit) {
      rr = Math.abs((takeProfit - price) / (price - stopLoss));
    }
  }

  return {
    symbol,
    price,

    state,

    bias,
    confidence: Number(confidence.toFixed(2)),

    adx: Number(adx.toFixed(2)),
    stoch: Number(stoch.toFixed(2)),

    compression: Number(volatility.toFixed(5)),

    reason:
      state === "SNIPER"
        ? "BREAKOUT MOMENTUM EXPANSION"
        : state === "EARLY"
        ? "COMPRESSION BUILDING FOR MOVE"
        : "NO STRUCTURE",

    stopLoss: stopLoss ? Number(stopLoss.toFixed(2)) : null,
    takeProfit: takeProfit ? Number(takeProfit.toFixed(2)) : null,
    riskReward: rr ? Number(rr.toFixed(2)) : null,

    updatedAt: new Date().toISOString(),
  };
}

/* -------------------------
   SAFE FALLBACK
--------------------------*/

function fallback(symbol: Symbol, price: number): Signal {
  return {
    symbol,
    price,
    state: "WAIT",
    bias: "NEUTRAL",
    confidence: 20,
    adx: 0,
    stoch: 50,
    compression: 0,
    reason: "INSUFFICIENT DATA",
    stopLoss: null,
    takeProfit: null,
    riskReward: null,
    updatedAt: new Date().toISOString(),
  };
}
