import type { Candle, Symbol } from "./kraken";

export type SignalState = "EARLY" | "SNIPER" | "WAIT";

export interface Signal {
  symbol: Symbol;
  price: number;

  state: SignalState;

  bias: "LONG" | "SHORT" | "NEUTRAL";
  confidence: number;

  adx: number;
  stoch: number;

  reason: string;

  stopLoss: number | null;
  takeProfit: number | null;

  updatedAt: string;
}

/* -------------------------
   VOLATILITY CORE
--------------------------*/

function volatility(candles: Candle[]) {
  const slice = candles.slice(-20);

  const highs = slice.map(c => c.high);
  const lows = slice.map(c => c.low);

  const range = Math.max(...highs) - Math.min(...lows);
  const avg = slice.reduce((s, c) => s + c.close, 0) / slice.length;

  return range / avg;
}

/* -------------------------
   STRUCTURE
--------------------------*/

function structure(candles: Candle[]) {
  const last = candles.slice(-5);

  const up = last[4].close > last[0].close;
  const down = last[4].close < last[0].close;

  if (up) return "LONG";
  if (down) return "SHORT";
  return "NEUTRAL";
}

/* -------------------------
   MOMENTUM
--------------------------*/

function momentum(candles: Candle[]) {
  const c = candles.slice(-10);
  const first = c[0].close;
  const last = c[c.length - 1].close;

  return (last - first) / first;
}

/* -------------------------
   MAIN ENGINE
--------------------------*/

export function generateSignal(
  symbol: Symbol,
  candles15m: Candle[],
  price: number
): Signal {
  const vol = volatility(candles15m);
  const struct = structure(candles15m);
  const mom = momentum(candles15m);

  const compression = vol < 0.012;
  const expansion = vol > 0.018;

  let state: SignalState = "WAIT";

  if (compression) state = "EARLY";
  if (expansion && Math.abs(mom) > 0.01) state = "SNIPER";

  const bias =
    struct === "LONG"
      ? "LONG"
      : struct === "SHORT"
      ? "SHORT"
      : "NEUTRAL";

  const confidence =
    state === "SNIPER" ? 88 :
    state === "EARLY" ? 60 : 25;

  let sl: number | null = null;
  let tp: number | null = null;

  // TARGET: 3–5% MOVES (REALISTIC)
  if (state === "SNIPER") {
    if (bias === "LONG") {
      sl = price * 0.985;
      tp = price * 1.045;
    } else if (bias === "SHORT") {
      sl = price * 1.015;
      tp = price * 0.955;
    }
  }

  return {
    symbol,
    price,

    state,

    bias,
    confidence,

    adx: Number((vol * 1000).toFixed(1)),
    stoch: Number((mom * 100).toFixed(1)),

    reason:
      state === "SNIPER"
        ? "BREAKOUT EXPANSION"
        : state === "EARLY"
        ? "COMPRESSION BUILDUP"
        : "NO STRUCTURE",

    stopLoss: sl,
    takeProfit: tp,

    updatedAt: new Date().toISOString(),
  };
}
