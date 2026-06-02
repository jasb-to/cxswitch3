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

// deterministic (NO random flicker)
function hash(n: number) {
  return Math.sin(n) * 10000;
}

export function generateSignal(symbol: Symbol, price: number): Signal {
  const seed = price + symbol.length * 100;

  const h = Math.abs(hash(seed));

  const compression = h % 100 < 35;
  const expansion = h % 100 > 75;

  let state: SignalState = "WAIT";

  if (compression) state = "EARLY";
  if (expansion) state = "SNIPER";

  const bias: Signal["bias"] =
    expansion ? "LONG" : compression ? "NEUTRAL" : "NEUTRAL";

  const confidence =
    state === "SNIPER" ? 85 : state === "EARLY" ? 55 : 20;

  const adx = 10 + (h % 40);
  const stoch = h % 100;

  const stopLoss =
    state === "SNIPER"
      ? bias === "LONG"
        ? price * 0.99
        : price * 1.01
      : null;

  const takeProfit =
    state === "SNIPER"
      ? bias === "LONG"
        ? price * 1.02
        : price * 0.98
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
        ? "LIQUIDITY EXPANSION"
        : state === "EARLY"
        ? "COMPRESSION BUILDUP"
        : "NO STRUCTURE",

    stopLoss,
    takeProfit,

    updatedAt: new Date().toISOString(),
  };
}
