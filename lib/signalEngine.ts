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
 * CORE IDEA:
 * We stop randomness deciding signals.
 * We simulate STRUCTURE FIRST → then derive state.
 */

export function generateSignal(symbol: string, price: number): Signal {
  // -----------------------------
  // STRUCTURE SIMULATION (lightweight proxy)
  // -----------------------------
  const momentum = Math.sin(Date.now() / 60000 + price) * 50 + 50; // 0–100
  const volatility = Math.abs(Math.cos(Date.now() / 45000 + price)) * 100;

  // -----------------------------
  // MARKET CONDITIONS
  // -----------------------------
  const compression = volatility < 35;
  const expansion = volatility > 70;

  const breakoutImpulse = momentum > 65 && expansion;
  const breakdownImpulse = momentum < 35 && expansion;

  // -----------------------------
  // STATE ENGINE (IMPORTANT)
  // -----------------------------
  let state: SignalState = "WAIT";

  if (compression) {
    state = "EARLY";
  }

  if (compression && (breakoutImpulse || breakdownImpulse)) {
    state = "SNIPER";
  }

  if (!compression && expansion && (breakoutImpulse || breakdownImpulse)) {
    state = "SNIPER";
  }

  if (!compression && !expansion) {
    state = "SETUP";
  }

  // -----------------------------
  // DERIVED INDICATORS (UI ONLY)
  // -----------------------------
  const adx = Math.min(50, Math.max(8, volatility / 2));
  const stochK = momentum;
  const stochD = momentum * 0.9;

  const isEarly = state === "EARLY";
  const isSniper = state === "SNIPER";

  // -----------------------------
  // CONFIDENCE (IMPORTANT FOR ALERTS)
  // -----------------------------
  let confidence = 20;

  if (state === "EARLY") confidence = 55;
  if (state === "SETUP") confidence = 35;
  if (state === "SNIPER") confidence = 85;

  // boost confidence when structure aligns
  if (compression && momentum > 45 && momentum < 55) {
    confidence += 10;
  }

  // -----------------------------
  // BIAS
  // -----------------------------
  const bias: Signal["bias"] =
    momentum > 55 ? "Bullish" : momentum < 45 ? "Bearish" : "Neutral";

  // -----------------------------
  // RISK MODEL (simple but stable)
  // -----------------------------
  const stopLoss =
    state === "SNIPER"
      ? bias === "Bullish"
        ? price * 0.99
        : price * 1.01
      : null;

  const takeProfit =
    state === "SNIPER"
      ? bias === "Bullish"
        ? price * 1.02
        : price * 0.98
      : null;

  const riskRewardRatio =
    state === "SNIPER" ? 2 : null;

  // -----------------------------
  // FINAL OUTPUT
  // -----------------------------
  return {
    symbol,
    price,

    state,

    isEarly,
    isSniper,
    isActive: isEarly || isSniper,

    bias,
    confidence: Math.round(confidence),

    adx: Math.round(adx * 10) / 10,
    stochK: Math.round(stochK * 10) / 10,
    stochD: Math.round(stochD * 10) / 10,

    reason:
      state === "SNIPER"
        ? "LIQUIDITY EXPANSION BREAKOUT"
        : state === "EARLY"
        ? "COMPRESSION BUILDING"
        : "STRUCTURE NEUTRAL",

    stopLoss,
    takeProfit,
    riskRewardRatio,

    updatedAt: new Date().toISOString(),
  };
}
