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
  rr: number | null;

  expectedMove: number;

  updatedAt: string;
}

/* -------------------------
   UTILS
-------------------------- */

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function hash(n: number) {
  return Math.sin(n) * 10000;
}

function safeMod(n: number, mod: number) {
  return ((n % mod) + mod) % mod;
}

/* -------------------------
   CORE ENGINE
-------------------------- */

export function generateSignal(symbol: Symbol, price: number): Signal {
  const seed = price + symbol.length * 97;

  const h = Math.abs(hash(seed));

  const mod = safeMod(h, 100);

  // -------------------------
  // Market structure states
  // -------------------------
  const compression = mod < 38;
  const expansion = mod > 78;

  let state: SignalState = "WAIT";
  if (compression) state = "EARLY";
  if (expansion) state = "SNIPER";

  // -------------------------
  // Bias model
  // -------------------------
  const bias: Signal["bias"] =
    expansion ? (mod % 2 === 0 ? "LONG" : "SHORT") : compression ? "NEUTRAL" : "NEUTRAL";

  // -------------------------
  // Confidence model (smoothed)
  // -------------------------
  const confidence =
    state === "SNIPER"
      ? clamp(80 + (mod % 15), 80, 95)
      : state === "EARLY"
      ? clamp(55 + (mod % 25), 50, 78)
      : 20;

  // -------------------------
  // Indicators (NO NaN EVER)
  // -------------------------
  const adx = clamp(10 + (mod % 55), 10, 65);

  const stoch =
    state === "SNIPER"
      ? clamp(80 + (mod % 20), 70, 100)
      : clamp(mod, 0, 100);

  // -------------------------
  // Volatility model
  // -------------------------
  const volatility = adx / 100;

  // EARLY vs SNIPER move logic
  const baseMove = clamp(0.02 + volatility * 1.5, 0.015, 0.055);

  const earlyMove = clamp(baseMove * 0.9, 0.015, 0.04);
  const sniperMove = clamp(baseMove * 1.1, 0.025, 0.06);

  const expectedMove =
    state === "SNIPER"
      ? sniperMove
      : state === "EARLY"
      ? earlyMove
      : 0.01;

  // -------------------------
  // SL / TP model (FIXED)
  // -------------------------
  let stopLoss: number | null = null;
  let takeProfit: number | null = null;
  let rr: number | null = null;

  if (state !== "WAIT") {
    const slFactor = state === "EARLY" ? 0.6 : 0.45;
    const risk = expectedMove * slFactor;

    if (bias === "LONG") {
      stopLoss = price * (1 - risk);
      takeProfit = price * (1 + expectedMove);
    } else if (bias === "SHORT") {
      stopLoss = price * (1 + risk);
      takeProfit = price * (1 - expectedMove);
    } else {
      stopLoss = price * (1 - risk);
      takeProfit = price * (1 + expectedMove);
    }

    rr =
      stopLoss && takeProfit
        ? Math.abs((takeProfit - price) / (price - stopLoss))
        : null;
  }

  // -------------------------
  // Reason engine
  // -------------------------
  const reason =
    state === "SNIPER"
      ? "BREAKOUT CONFIRMED EXPANSION"
      : state === "EARLY"
      ? "COMPRESSION BUILDING FOR MOVE"
      : "NO STRUCTURE";

  return {
    symbol,
    price,

    state,
    bias,
    confidence,

    adx,
    stoch,

    reason,

    stopLoss,
    takeProfit,
    rr,

    expectedMove,

    updatedAt: new Date().toISOString(),
  };
}
