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

/* ---------------- utils ---------------- */

const clamp = (n: number, min: number, max: number) =>
  Math.max(min, Math.min(max, n));

const hash = (n: number) => Math.sin(n) * 10000;

const mod = (n: number) => Math.abs(n % 100);

/* ---------------- CORE ---------------- */

export function generateSignal(symbol: Symbol, price: number): Signal {
  const seed = price + symbol.length * 91;
  const h = Math.abs(hash(seed));
  const m = mod(h);

  // ---------------- STRUCTURE ----------------
  const compression = m < 40;
  const expansion = m > 78;

  let state: SignalState = "WAIT";
  if (compression) state = "EARLY";
  if (expansion) state = "SNIPER";

  // ---------------- BIAS ----------------
  let bias: "LONG" | "SHORT" | "NEUTRAL" = "NEUTRAL";

  if (expansion) {
    bias = m % 2 === 0 ? "LONG" : "SHORT";
  } else if (compression) {
    // EARLY now gets directional bias (IMPORTANT FIX)
    bias = m > 50 ? "LONG" : "SHORT";
  }

  // ---------------- CONFIDENCE ----------------
  const confidence =
    state === "SNIPER"
      ? clamp(80 + (m % 15), 80, 95)
      : state === "EARLY"
      ? clamp(60 + (m % 20), 55, 80)
      : 20;

  // ---------------- INDICATORS ----------------
  const adx = clamp(15 + (m % 55), 10, 70);
  const stoch = clamp(m, 0, 100);

  // ---------------- MOVE MODEL ----------------
  const volatility = adx / 100;

  const expectedMove =
    state === "SNIPER"
      ? clamp(0.03 + volatility * 0.02, 0.025, 0.06)
      : state === "EARLY"
      ? clamp(0.02 + volatility * 0.015, 0.018, 0.045)
      : 0.01;

  // ---------------- SL / TP (FIXED LOGIC) ----------------
  const riskFactor = state === "SNIPER" ? 0.45 : 0.6;

  const risk = expectedMove * riskFactor;

  let stopLoss: number | null = null;
  let takeProfit: number | null = null;

  // 🔥 IMPORTANT: EARLY ALSO GETS SL/TP NOW
  if (state === "EARLY" || state === "SNIPER") {
    if (bias === "LONG") {
      stopLoss = price * (1 - risk);
      takeProfit = price * (1 + expectedMove);
    }

    if (bias === "SHORT") {
      stopLoss = price * (1 + risk);
      takeProfit = price * (1 - expectedMove);
    }
  }

  const rr =
    stopLoss && takeProfit
      ? Math.abs((takeProfit - price) / (price - stopLoss))
      : null;

  return {
    symbol,
    price,

    state,
    bias,
    confidence,

    adx,
    stoch,

    reason:
      state === "SNIPER"
        ? "BREAKOUT EXPANSION"
        : state === "EARLY"
        ? "STRUCTURE BUILDING"
        : "NO STRUCTURE",

    stopLoss,
    takeProfit,
    rr,

    expectedMove,

    updatedAt: new Date().toISOString(),
  };
}
