export type Symbol = "BTC" | "ETH" | "SOL";

export type SignalState = "EARLY" | "SNIPER" | "WAIT";

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

  bias: "LONG" | "SHORT" | "NEUTRAL";
  confidence: number;

  adx: number;
  stochK: number;
  stochD: number;
  rsi: number;

  reason: string;

  entry: number | null;

  stopLoss: number | null;
  takeProfit: number | null;

  rr: number | null;

  expectedMove: number;

  updatedAt: string;
}

/* -------------------------
   INDICATORS
-------------------------- */

function avg(arr: number[]) {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function ema(values: number[], period: number) {
  const k = 2 / (period + 1);
  let ema = values[0];

  for (let i = 1; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
  }

  return ema;
}

function rsi(closes: number[], period = 14) {
  let gains = 0;
  let losses = 0;

  for (let i = 1; i < period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses += Math.abs(diff);
  }

  const rs = gains / (losses || 1);
  return 100 - 100 / (1 + rs);
}

function stochastic(candles: Candle[], period = 14) {
  const slice = candles.slice(-period);

  const high = Math.max(...slice.map(c => c.high));
  const low = Math.min(...slice.map(c => c.low));
  const close = slice[slice.length - 1].close;

  const k = ((close - low) / (high - low || 1)) * 100;
  return k;
}

/* -------------------------
   CORE STRATEGY
-------------------------- */

export function generateSignal(
  symbol: Symbol,
  candles15m: Candle[],
  candles1h: Candle[],
  price: number
): Signal {
  const closes = candles15m.map(c => c.close);

  const ema21 = ema(closes.slice(-21), 21);
  const slope = (closes.at(-1)! - ema21) / ema21;

  const rsiVal = rsi(closes);
  const stochK = stochastic(candles15m);
  const stochD = avg(closes.slice(-3)); // smoothed proxy

  // -------------------------
  // STRUCTURE LOGIC
  // -------------------------

  const compression =
    stochK < 30 && rsiVal > 45 && Math.abs(slope) < 0.002;

  const breakout =
    stochK > 60 && slope > 0.003 && rsiVal > 50;

  let state: SignalState = "WAIT";
  if (compression) state = "EARLY";
  if (breakout) state = "SNIPER";

  // -------------------------
  // BIAS
  // -------------------------

  const bias: Signal["bias"] =
    slope > 0 ? "LONG" : slope < 0 ? "SHORT" : "NEUTRAL";

  // -------------------------
  // CONFIDENCE
  // -------------------------

  const confidence =
    state === "SNIPER"
      ? 80 + Math.min(15, Math.abs(slope) * 5000)
      : state === "EARLY"
      ? 55 + Math.min(20, stochK / 5)
      : 20;

  // -------------------------
  // EXPECTED MOVE (REALISTIC 3–5%)
  // -------------------------

  const volatility = Math.abs(slope) * 10;

  const expectedMove =
    state === "SNIPER"
      ? 0.03 + volatility
      : state === "EARLY"
      ? 0.02 + volatility / 2
      : 0.01;

  // -------------------------
  // ENTRY / SL / TP
  // -------------------------

  let entry = price;
  let stopLoss: number | null = null;
  let takeProfit: number | null = null;
  let rr: number | null = null;

  if (state !== "WAIT") {
    const risk = expectedMove * (state === "EARLY" ? 0.5 : 0.35);

    if (bias === "LONG") {
      stopLoss = price * (1 - risk);
      takeProfit = price * (1 + expectedMove);
    } else if (bias === "SHORT") {
      stopLoss = price * (1 + risk);
      takeProfit = price * (1 - expectedMove);
    } else {
      stopLoss = price * (1 - risk);
      takeProfit = price * (1 + expectedMove);
    }

    rr = Math.abs((takeProfit - price) / (price - stopLoss));
  }

  return {
    symbol,
    price,

    state,
    bias,
    confidence,

    adx: Math.abs(slope) * 100,
    stochK,
    stochD,
    rsi: rsiVal,

    reason:
      state === "SNIPER"
        ? "BREAKOUT CONFIRMED STRUCTURE"
        : state === "EARLY"
        ? "COMPRESSION → ACCUMULATION"
        : "NO STRUCTURE",

    entry,
    stopLoss,
    takeProfit,
    rr,

    expectedMove,

    updatedAt: new Date().toISOString(),
  };
}
