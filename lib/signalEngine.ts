export type SignalState = "EARLY" | "SETUP" | "SNIPER" | "WAIT";

export interface Signal {
  symbol: string;
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
}

export function generateSignal(symbol: string, price: number): Signal {
  const adx = 10 + Math.random() * 40;
  const stochK = Math.random() * 100;
  const stochD = Math.random() * 100;

  const isEarly = adx > 12 && adx < 45;
  const isSniper = adx > 30 && stochK < 40;

  let state: SignalState = "WAIT";

  if (isSniper) state = "SNIPER";
  else if (isEarly) state = "EARLY";

  const bias: Signal["bias"] = adx > 25 ? "Bearish" : "Neutral";

  const confidence = state === "SNIPER" ? 85 : state === "EARLY" ? 55 : 20;

  return {
    symbol,
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

    reason:
      state === "SNIPER"
        ? "SNIPER BREAKOUT"
        : state === "EARLY"
        ? "EARLY COMPRESSION"
        : "WAIT",

    stopLoss: state === "SNIPER" ? price * 1.01 : null,
    takeProfit: state === "SNIPER" ? price * 0.98 : null,
    riskRewardRatio: state === "SNIPER" ? 2 : null,

    updatedAt: new Date().toISOString(),
  };
}
