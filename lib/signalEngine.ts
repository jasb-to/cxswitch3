export type SignalState = "EARLY" | "SNIPER" | "WAIT";

export interface Signal {
  symbol: string;
  price: number;

  state: SignalState;

  bias: "Bullish" | "Bearish" | "Neutral";
  confidence: number;

  adx: number;
  stochK: number;

  reason: string;

  stopLoss: number | null;
  takeProfit: number | null;

  updatedAt: string;
}

export function generateSignal(symbol: string, price: number): Signal {
  // deterministic pseudo-random (NOT chaotic flicker)
  const seed = (symbol.charCodeAt(0) + Math.floor(price)) % 100;

  const isSniper = seed > 80;
  const isEarly = seed > 55 && seed <= 80;

  const state: SignalState = isSniper
    ? "SNIPER"
    : isEarly
    ? "EARLY"
    : "WAIT";

  const bias =
    isSniper ? "Bullish" : isEarly ? "Neutral" : "Neutral";

  const confidence =
    state === "SNIPER" ? 85 : state === "EARLY" ? 55 : 20;

  return {
    symbol,
    price,

    state,

    bias,
    confidence,

    adx: 20 + (seed % 50),
    stochK: seed,

    reason:
      state === "SNIPER"
        ? "LIQUIDITY BREAKOUT"
        : state === "EARLY"
        ? "COMPRESSION"
        : "NO STRUCTURE",

    stopLoss: state === "SNIPER" ? price * 0.99 : null,
    takeProfit: state === "SNIPER" ? price * 1.02 : null,

    updatedAt: new Date().toISOString(),
  };
}
