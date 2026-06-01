export type SignalState = "EARLY" | "SETUP" | "SNIPER" | "WAIT";

export interface Signal {
  symbol: string;
  price: number;
  state: SignalState;

  isEarly: boolean;
  isSniper: boolean;

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
}

function volatility(symbol: string) {
  switch (symbol) {
    case "BTC":
      return 0.012;
    case "ETH":
      return 0.018;
    case "SOL":
      return 0.03;
    default:
      return 0.02;
  }
}

export function generateSignal(symbol: string, price: number): Signal {
  const noise = Math.random();

  const compression = noise < 0.35;
  const expansion = noise > 0.75;

  let state: SignalState = "WAIT";

  if (compression) state = "EARLY";
  if (expansion) state = "SNIPER";

  const adx = 10 + noise * 40;
  const stochK = noise * 100;
  const stochD = noise * 100;

  const bias: Signal["bias"] =
    expansion ? "Bearish" : compression ? "Bullish" : "Neutral";

  const vol = volatility(symbol);

  const isBullish = bias === "Bullish";

  const stopLoss = isBullish
    ? price * (1 - vol)
    : price * (1 + vol);

  const takeProfit = isBullish
    ? price * (1 + vol * 2.2)
    : price * (1 - vol * 2.2);

  return {
    symbol,
    price,
    state,

    isEarly: state === "EARLY",
    isSniper: state === "SNIPER",

    bias,
    confidence:
      state === "SNIPER" ? 85 : state === "EARLY" ? 55 : 20,

    adx,
    stochK,
    stochD,

    reason:
      state === "SNIPER"
        ? "LIQUIDITY BREAKOUT"
        : state === "EARLY"
        ? "COMPRESSION"
        : "NO STRUCTURE",

    stopLoss,
    takeProfit,
    riskRewardRatio: 2.2,

    updatedAt: new Date().toISOString(),
  };
}
