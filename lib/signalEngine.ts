import { storeSignalSnapshot } from "./persistence";

export interface Signal {
  symbol: string;

  price: number;

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

  setupId: string;
  updatedAt: string;
}

/* =========================
   MAIN ENGINE
========================= */

export async function generateAndStoreSignals() {
  const symbols = ["BTC", "ETH", "SOL"];

  const results: Signal[] = [];

  for (const symbol of symbols) {
    const price =
      symbol === "BTC"
        ? 71000 + Math.random() * 2000
        : symbol === "ETH"
        ? 1950 + Math.random() * 100
        : 80 + Math.random() * 5;

    const adx = 10 + Math.random() * 40;
    const stochK = Math.random() * 100;
    const stochD = Math.random() * 100;

    const isEarly = adx > 12 && adx < 45;
    const isSniper = adx > 30 && stochK < 40;

    const bias: Signal["bias"] =
      adx > 25 ? "Bearish" : "Neutral";

    const confidence = isSniper ? 85 : isEarly ? 55 : 20;

    const signal: Signal = {
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

      setupId: `${symbol}-${Date.now()}`,
      updatedAt: new Date().toISOString(),
    };

    await storeSignalSnapshot(signal);

    results.push(signal);

    console.log("[ENGINE]", symbol, signal.reason);
  }

  return results;
}
