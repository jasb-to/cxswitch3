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

  reason: string;

  stopLoss: number | null;
  takeProfit: number | null;

  updatedAt: string;
}

/* -----------------------------
   UTILITIES
----------------------------- */

function avg(arr: number[]) {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function min(arr: number[]) {
  return Math.min(...arr);
}

function max(arr: number[]) {
  return Math.max(...arr);
}

/* -----------------------------
   CORE STRATEGY
----------------------------- */

export function generateSignal(
  symbol: Symbol,
  price: number
): Signal {
  const now = Date.now();

  // pseudo history simulation (since you don’t pass candles yet)
  const seed = price * 1000;

  const volatility = Math.abs(Math.sin(seed)) * 100;

  const compression = volatility < 25;     // tight range
  const expansion = volatility > 70;       // breakout regime

  // trend bias (fake but stable until real candles plugged in)
  const trendScore = Math.sin(seed / 10000);

  const bias: Signal["bias"] =
    trendScore > 0.3
      ? "LONG"
      : trendScore < -0.3
      ? "SHORT"
      : "NEUTRAL";

  let state: SignalState = "WAIT";

  if (compression) state = "EARLY";
  if (expansion) state = "SNIPER";

  const confidence =
    state === "SNIPER"
      ? 80 + Math.abs(trendScore) * 10
      : state === "EARLY"
      ? 55 + (1 - volatility / 100) * 20
      : 20;

  const adx = 20 + volatility * 0.4;
  const stoch = (volatility * 2) % 100;

  /* -----------------------------
     REALISTIC MOVE TARGETING
     3–5% ONLY WHEN SNIPER
  ----------------------------- */

  let stopLoss: number | null = null;
  let takeProfit: number | null = null;

  if (state === "SNIPER") {
    const move = 0.035; // ~3.5% base target

    if (bias === "LONG") {
      stopLoss = price * 0.985;
      takeProfit = price * (1 + move);
    } else if (bias === "SHORT") {
      stopLoss = price * 1.015;
      takeProfit = price * (1 - move);
    }
  }

  return {
    symbol,
    price,

    state,

    bias,
    confidence: Math.min(100, confidence),

    adx,
    stoch,

    reason:
      state === "SNIPER"
        ? "BREAKOUT MOMENTUM EXPANSION"
        : state === "EARLY"
        ? "COMPRESSION BUILDING FOR MOVE"
        : "NO STRUCTURE",

    stopLoss,
    takeProfit,

    updatedAt: new Date().toISOString(),
  };
}
