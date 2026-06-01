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
 * 🔥 CORE CHANGE:
 * We STOP relying on ADX/Stoch for timing.
 * We use compression → expansion behavior instead.
 */

export function generateSignal(symbol: string, price: number): Signal {
  // simulate micro structure (replace later with real OHLC)
  const volatilityNoise = Math.random();

  // 🔵 COMPRESSION: low movement environment
  const compression = volatilityNoise < 0.35;

  // ⚡ EXPANSION: sudden move / breakout condition
  const expansion = volatilityNoise > 0.75;

  // 🔁 REJECTION / FAKEOUT BEHAVIOR
  const fakeBreak = volatilityNoise > 0.75 && Math.random() > 0.5;

  let state: SignalState = "WAIT";

  // =========================
  // STATE ENGINE (IMPORTANT)
  // =========================

  if (compression) {
    state = "EARLY";
  }

  if (compression && expansion) {
    state = "SNIPER";
  }

  if (expansion && !fakeBreak) {
    state = "SNIPER";
  }

  // =========================
  // DERIVED VALUES (UI ONLY)
  // =========================

  const adx = 10 + volatilityNoise * 40;
  const stochK = volatilityNoise * 100;
  const stochD = volatilityNoise * 100;

  const isEarly = state === "EARLY";
  const isSniper = state === "SNIPER";

  const confidence =
    state === "SNIPER" ? 85 : state === "EARLY" ? 55 : 20;

  const bias: Signal["bias"] =
    expansion ? "Bearish" : compression ? "Neutral" : "Neutral";

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
        ? "LIQUIDITY BREAKOUT"
        : state === "EARLY"
        ? "COMPRESSION BUILDUP"
        : "NO STRUCTURE",

    stopLoss: state === "SNIPER" ? price * 1.01 : null,
    takeProfit: state === "SNIPER" ? price * 0.98 : null,
    riskRewardRatio: state === "SNIPER" ? 2 : null,

    updatedAt: new Date().toISOString(),
  };
}
