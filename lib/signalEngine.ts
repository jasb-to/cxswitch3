export function generateSignal(symbol: string, price: number) {
  const adx = 10 + Math.random() * 40;
  const stochK = Math.random() * 100;
  const stochD = Math.random() * 100;

  const isEarly = adx > 12 && adx < 45;
  const isSniper = adx > 30 && stochK < 40;

  const bias =
    adx > 25 ? "Bearish" : "Neutral";

  const confidence = isSniper ? 85 : isEarly ? 55 : 20;

  return {
    symbol,
    price,

    isEarly,
    isSniper,
    isActive: isEarly || isSniper,

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

    stopLoss: isSniper ? price * 1.01 : null,
    takeProfit: isSniper ? price * 0.98 : null,
    riskRewardRatio: isSniper ? 2 : null,

    updatedAt: new Date().toISOString(),
  };
}
