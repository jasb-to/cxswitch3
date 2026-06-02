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

// deterministic hash (stable across renders)
function hash(n: number) {
  return Math.abs(Math.sin(n) * 10000);
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

export function generateSignal(symbol: Symbol, price: number): Signal {
  const seed = price * 10 + symbol.length * 1337;
  const h = hash(seed);

  const compression = h % 100 < 38;
  const expansion = h % 100 > 78;

  let state: SignalState = "WAIT";

  if (compression) state = "EARLY";
  if (expansion) state = "SNIPER";

  const bias: Signal["bias"] =
    expansion ? "LONG" : compression ? "NEUTRAL" : "NEUTRAL";

  const confidence =
    state === "SNIPER" ? 88 : state === "EARLY" ? 58 : 20;

  const adx = clamp(10 + (h % 50), 5, 60);
  const stoch = clamp(h % 100, 0, 100);

  const isLong = bias === "LONG";

  const stopLoss =
    state === "SNIPER"
      ? isLong
        ? price * 0.99
        : price * 1.01
      : null;

  const takeProfit =
    state === "SNIPER"
      ? isLong
        ? price * 1.025
        : price * 0.975
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
        ? "LIQUIDITY EXPANSION BREAKOUT"
        : state === "EARLY"
        ? "COMPRESSION BUILDUP"
        : "NO STRUCTURE",

    stopLoss,
    takeProfit,

    updatedAt: new Date().toISOString(),
  };
}
