import { storeSignalSnapshot } from "@/lib/persistence";

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

/**
 * CORE ENGINE (structure-based simulation)
 */
export function generateSignal(symbol: string, price: number): Signal {
  const momentum = Math.sin(Date.now() / 60000 + price) * 50 + 50;
  const volatility = Math.abs(Math.cos(Date.now() / 45000 + price)) * 100;

  const compression = volatility < 35;
  const expansion = volatility > 70;

  const breakoutImpulse = momentum > 65 && expansion;
  const breakdownImpulse = momentum < 35 && expansion;

  let state: SignalState = "WAIT";

  if (compression) state = "EARLY";
  if (!compression && !expansion) state = "SETUP";

  if (
    (compression && (breakoutImpulse || breakdownImpulse)) ||
    (!compression && expansion && (breakoutImpulse || breakdownImpulse))
  ) {
    state = "SNIPER";
  }

  const adx = Math.min(50, Math.max(8, volatility / 2));
  const stochK = momentum;
  const stochD = momentum * 0.9;

  const isEarly = state === "EARLY";
  const isSniper = state === "SNIPER";

  let confidence = state === "SNIPER" ? 85 : state === "EARLY" ? 55 : 30;

  const bias: Signal["bias"] =
    momentum > 55 ? "Bullish" : momentum < 45 ? "Bearish" : "Neutral";

  return {
    symbol,
    price,

    state,

    isEarly,
    isSniper,
    isActive: isEarly || isSniper,

    bias,
    confidence: Math.round(confidence),

    adx: Number(adx.toFixed(1)),
    stochK: Number(stochK.toFixed(1)),
    stochD: Number(stochD.toFixed(1)),

    reason:
      state === "SNIPER"
        ? "LIQUIDITY EXPANSION BREAKOUT"
        : state === "EARLY"
        ? "COMPRESSION BUILDING"
        : "NO STRUCTURE",

    stopLoss: state === "SNIPER" ? price * 0.99 : null,
    takeProfit: state === "SNIPER" ? price * 1.02 : null,
    riskRewardRatio: state === "SNIPER" ? 2 : null,

    updatedAt: new Date().toISOString(),
  };
}

/**
 * 🔥 CRITICAL FIX:
 * This restores your broken imports everywhere in cron + API
 */
export async function generateAndStoreSignals(
  symbols: string[],
  prices: number[]
) {
  const signals: Signal[] = [];

  for (let i = 0; i < symbols.length; i++) {
    const signal = generateSignal(symbols[i], prices[i]);

    await storeSignalSnapshot({
      symbol: signal.symbol,
      price: signal.price,

      state: signal.state,

      isEarly: signal.isEarly,
      isSniper: signal.isSniper,
      isActive: signal.isActive,

      bias: signal.bias,
      confidence: signal.confidence,

      adx: signal.adx,
      stochK: signal.stochK,
      stochD: signal.stochD,

      reason: signal.reason,

      stopLoss: signal.stopLoss,
      takeProfit: signal.takeProfit,
      riskRewardRatio: signal.riskRewardRatio,

      updatedAt: signal.updatedAt,
    });

    signals.push(signal);
  }

  return signals;
}
