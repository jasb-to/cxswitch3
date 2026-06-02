import type { Symbol } from "./kraken";

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

/* =========================
   HELPERS
========================= */

function avg(arr: number[]) {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function range(candles: any[]) {
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);
  return Math.max(...highs) - Math.min(...lows);
}

/* =========================
   STRUCTURE DETECTION
========================= */

function detectCompression(candles: any[]) {
  const last = candles.slice(-20);
  const avgPrice = avg(last.map(c => c.close));

  const vol = range(last) / avgPrice;

  return vol < 0.012; // tight squeeze for REAL early entries
}

function momentum(candles: any[]) {
  const last = candles.slice(-10);
  const change =
    (last[last.length - 1].close - last[0].close) / last[0].close;

  return change * 100;
}

/* =========================
   MAIN ENGINE
========================= */

export function generateSignal(
  symbol: Symbol,
  candles15m: any[],
  candles1h: any[],
  price: number
): Signal {
  const compression = detectCompression(candles15m);
  const mom = momentum(candles15m);

  const expansion = mom > 1.2;

  let state: SignalState = "WAIT";
  if (compression) state = "EARLY";
  if (!compression && expansion) state = "SNIPER";

  const bias =
    expansion ? "LONG" : compression ? "NEUTRAL" : "NEUTRAL";

  const confidence =
    state === "SNIPER" ? 88 : state === "EARLY" ? 60 : 20;

  const adx = Math.min(50, Math.abs(mom) * 10);
  const stoch = Math.min(100, Math.abs(mom) * 20);

  // 🎯 REALISTIC MOVE TARGET: 3–5%
  const move = state === "SNIPER" ? 0.035 : 0.02;

  const stopLoss =
    state === "SNIPER"
      ? bias === "LONG"
        ? price * (1 - 0.012)
        : price * (1 + 0.012)
      : null;

  const takeProfit =
    state === "SNIPER"
      ? bias === "LONG"
        ? price * (1 + move)
        : price * (1 - move)
      : null;

  return {
    symbol,
    price,

    state,

    bias,
    confidence,

    adx,
    stoch,

    reason:
      state === "SNIPER"
        ? "BREAKOUT EXPANSION (3–5% MOVE)"
        : state === "EARLY"
        ? "LIQUIDITY SQUEEZE BUILDUP"
        : "NO STRUCTURE",

    stopLoss,
    takeProfit,

    updatedAt: new Date().toISOString(),
  };
}
