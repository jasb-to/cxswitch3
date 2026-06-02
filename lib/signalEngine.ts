export type SignalState = "EARLY" | "SETUP" | "SNIPER" | "WAIT";

export type Signal = {
  symbol: "BTC" | "ETH" | "SOL";
  price: number;

  state: SignalState;

  isEarly: boolean;
  isSniper: boolean;
  isActive: boolean;

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
};

export function generateSignal(symbol: string, price: number): Signal {
  const noise = Math.random();

  const compression = noise < 0.35;
  const expansion = noise > 0.75;

  let state: SignalState = "WAIT";

  if (compression) state = "EARLY";
  if (expansion) state = "SNIPER";

  const isEarly = state === "EARLY";
  const isSniper = state === "SNIPER";

  const confidence = isSniper ? 85 : isEarly ? 55 : 20;

  const adx = 10 + noise * 40;
  const stochK = noise * 100;
  const stochD = noise * 100;

  const bias =
    expansion ? "Bullish" : compression ? "Neutral" : "Neutral";

  return {
    symbol: symbol as any,
    price,

    state,

    isEarly,
    isSniper,
    isActive: isEarly || isSniper,

    bias,
    confidence,

    adx,
    stochK,
    stochD,

    reason: isSniper
      ? "LIQUIDITY EXPANSION BREAKOUT"
      : isEarly
      ? "COMPRESSION BUILDING"
      : "NO STRUCTURE",

    stopLoss: isSniper ? price * 0.99 : null,
    takeProfit: isSniper ? price * 1.02 : null,
    riskRewardRatio: isSniper ? 2 : null,

    updatedAt: new Date().toISOString(),
  };
}
