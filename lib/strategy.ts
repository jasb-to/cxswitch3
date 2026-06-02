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

const safeMod = (n: number, m: number) => ((n % m) + m) % m;

const round = (n: number | null, d = 2) =>
  n == null ? null : Math.round(n * 10 ** d) / 10 ** d;

/* ---------------- CORE ---------------- */

export function generateSignal(symbol: Symbol, price: number): Signal {
  const seed = price + symbol.length * 97;
  const h = Math.abs(hash(seed));
  const mod = safeMod(h, 100);

  const compression = mod < 38;
  const expansion = mod > 78;

  let state: SignalState = "WAIT";
  if (compression) state = "EARLY";
  if (expansion) state = "SNIPER";

  const bias =
    expansion ? (mod % 2 === 0 ? "LONG" : "SHORT") : "NEUTRAL";

  const confidence =
    state === "SNIPER"
      ? clamp(80 + (mod % 15), 80, 95)
      : state === "EARLY"
      ? clamp(55 + (mod % 20), 50, 78)
      : 20;

  const adx = clamp(10 + (mod % 50), 10, 65);
  const stoch = clamp(mod, 0, 100);

  const volatility = adx / 100;

  const expectedMove =
    state === "SNIPER"
      ? clamp(0.03 + volatility * 0.02, 0.025, 0.06)
      : state === "EARLY"
      ? clamp(0.02 + volatility * 0.015, 0.015, 0.04)
      : 0.01;

  let stopLoss: number | null = null;
  let takeProfit: number | null = null;

  if (state !== "WAIT") {
    const risk = expectedMove * (state === "EARLY" ? 0.6 : 0.45);

    if (bias === "LONG") {
      stopLoss = price * (1 - risk);
      takeProfit = price * (1 + expectedMove);
    } else if (bias === "SHORT") {
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
        ? "COMPRESSION BUILDING"
        : "NO STRUCTURE",

    stopLoss: round(stopLoss),
    takeProfit: round(takeProfit),

    rr: round(rr, 2),
    expectedMove: round(expectedMove, 4),

    updatedAt: new Date().toISOString(),
  };
}
