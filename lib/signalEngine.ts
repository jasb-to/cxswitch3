export type Symbol = "BTC" | "ETH" | "SOL";

export interface Signal {
  symbol: Symbol;
  price: number;

  state: "EARLY" | "SNIPER" | "WAIT";

  bias: "Bullish" | "Bearish" | "Neutral";
  confidence: number;

  adx: number;
  stoch: number;

  reason: string;

  stopLoss: number | null;
  takeProfit: number | null;

  updatedAt: string;
}

// SAFE MATH
function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

// SIMPLE DETERMINISTIC ENGINE (NO RANDOM)
export function generateSignal(symbol: Symbol, price: number): Signal {
  const hash = price % 100;

  const isEarly = hash < 35;
  const isSniper = hash > 80;

  const state = isSniper ? "SNIPER" : isEarly ? "EARLY" : "WAIT";

  const bias =
    hash > 60 ? "Bullish" : hash < 30 ? "Bearish" : "Neutral";

  const confidence =
    state === "SNIPER" ? 85 : state === "EARLY" ? 55 : 20;

  const adx = clamp(10 + hash * 0.4, 5, 60);
  const stoch = clamp(hash * 1.2, 0, 100);

  const stopLoss =
    state === "SNIPER" ? Number((price * 0.99).toFixed(2)) : null;

  const takeProfit =
    state === "SNIPER" ? Number((price * 1.02).toFixed(2)) : null;

  return {
    symbol,
    price,

    state,

    bias,
    confidence,

    adx: Number(adx.toFixed(1)),
    stoch: Number(stoch.toFixed(1)),

    reason:
      state === "SNIPER"
        ? "LIQUIDITY EXPANSION"
        : state === "EARLY"
        ? "COMPRESSION BUILDUP"
        : "NO STRUCTURE",

    stopLoss,
    takeProfit,

    updatedAt: new Date().toISOString(),
  };
}
