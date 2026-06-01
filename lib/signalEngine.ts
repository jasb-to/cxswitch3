import type { Signal } from "./strategy";

export function generateSignal(
  symbol: "BTC" | "ETH" | "SOL",
  candles4H: any[],
  candles1H: any[],
  candles15M: any[],
  livePrice: number
): Signal {
  const structure = "Neutral";

  const adx = 15;
  const stochK = 50;
  const stochD = 50;

  const isEarly = adx > 10 && adx < 50;
  const isSniper = adx > 30 && stochK < 40;

  const bias =
    structure === "Bullish"
      ? "Bullish"
      : structure === "Bearish"
      ? "Bearish"
      : "Neutral";

  const confidence = isSniper ? 85 : isEarly ? 55 : 20;

  const risk = livePrice * 0.01;

  const stopLoss = isSniper ? livePrice - risk : null;
  const takeProfit = isSniper ? livePrice + risk * 2 : null;

  return {
    symbol,
    price: livePrice,

    isEarly,
    isSniper,
    isActive: isEarly || isSniper,

    setupId: `${symbol}-${Date.now()}`,

    bias,
    confidence,

    adx,
    stochK,
    stochD,

    reason: isSniper
      ? "SNIPER BREAKOUT"
      : isEarly
      ? "EARLY COMPRESSION"
      : "WAIT",

    stopLoss,
    takeProfit,
    riskRewardRatio: isSniper ? 2 : null,

    updatedAt: new Date().toISOString(),
  };
}
