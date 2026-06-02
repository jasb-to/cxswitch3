export type Symbol = "BTC" | "ETH" | "SOL";

export type SignalState = "EARLY" | "SNIPER" | "WAIT";

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface Signal {
  symbol: Symbol;
  price: number;

  state: SignalState;

  bias: "LONG" | "SHORT" | "NEUTRAL";
  confidence: number;

  adx: number;
  stoch: number;
  rsi: number;

  reason: string;

  stopLoss: number | null;
  takeProfit: number | null;
  rr: number | null;

  expectedMove: number;

  updatedAt: string;
}

/* ---------------- UTILS ---------------- */

const clamp = (n: number, min: number, max: number) =>
  Math.max(min, Math.min(max, n));

const round = (n: number, d = 2) =>
  Math.round(n * Math.pow(10, d)) / Math.pow(10, d);

/* ---------------- INDICATORS ---------------- */

function ema(values: number[], period: number) {
  const k = 2 / (period + 1);
  let ema = values[0];
  for (let i = 1; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
  }
  return ema;
}

function rsi(closes: number[]) {
  let gains = 0;
  let losses = 0;

  for (let i = 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }

  const rs = gains / (losses || 1);
  return 100 - 100 / (1 + rs);
}

function stochK(closes: number[], period = 14) {
  const slice = closes.slice(-period);
  const high = Math.max(...slice);
  const low = Math.min(...slice);
  const close = slice[slice.length - 1];

  return ((close - low) / (high - low || 1)) * 100;
}

/* ---------------- STRUCTURE ---------------- */

function detectBOS(closes: number[]) {
  const last = closes.at(-1)!;
  const prev = closes.at(-2)!;

  if (last > prev) return "BULL";
  if (last < prev) return "BEAR";
  return "NEUTRAL";
}

/* ---------------- CORE ---------------- */

export function generateSignal(
  symbol: Symbol,
  price: number,
  candles15m: Candle[],
  candles1h: Candle[]
): Signal {
  const closes15 = candles15m.map(c => c.close);
  const closes1h = candles1h.map(c => c.close);

  const r = rsi(closes15);
  const st = stochK(closes15);
  const bos = detectBOS(closes15);

  const ema21 = ema(closes15, 21);
  const emaSlope = price > ema21 ? "UP" : "DOWN";

  /* ---------------- STATE ---------------- */

  let state: SignalState = "WAIT";

  const early =
    st < 30 && r > 45 && bos !== "NEUTRAL";

  const sniper =
    st > 70 && r > 50 && bos !== "NEUTRAL" && emaSlope !== "NEUTRAL";

  if (sniper) state = "SNIPER";
  else if (early) state = "EARLY";

  /* ---------------- BIAS ---------------- */

  const bias =
    bos === "BULL" ? "LONG"
    : bos === "BEAR" ? "SHORT"
    : "NEUTRAL";

  /* ---------------- CONFIDENCE ---------------- */

  const confidence =
    state === "SNIPER"
      ? clamp(80 + Math.abs(r - 50), 80, 95)
      : state === "EARLY"
      ? clamp(55 + Math.abs(st - 30), 50, 78)
      : 20;

  /* ---------------- EXPECTED MOVE (REALISTIC) ---------------- */

  const volatility = Math.abs(price - ema21) / price;

  const expectedMove =
    state === "SNIPER"
      ? clamp(volatility * 2.5, 0.025, 0.055)
      : state === "EARLY"
      ? clamp(volatility * 1.8, 0.02, 0.04)
      : 0.01;

  /* ---------------- SL / TP ---------------- */

  let stopLoss = null;
  let takeProfit = null;
  let rr = null;

  if (state !== "WAIT") {
    const risk = expectedMove * (state === "EARLY" ? 0.6 : 0.45);

    if (bias === "LONG") {
      stopLoss = price * (1 - risk);
      takeProfit = price * (1 + expectedMove);
    } else if (bias === "SHORT") {
      stopLoss = price * (1 + risk);
      takeProfit = price * (1 - expectedMove);
    }

    if (stopLoss && takeProfit) {
      rr = Math.abs((takeProfit - price) / (price - stopLoss));
    }
  }

  return {
    symbol,
    price: round(price),

    state,
    bias,
    confidence: round(confidence),

    adx: round(Math.abs(price - ema21) / price * 100, 1),
    stoch: round(st),
    rsi: round(r),

    reason:
      state === "SNIPER"
        ? "BREAKOUT CONFIRMED (BOS + MOMENTUM)"
        : state === "EARLY"
        ? "COMPRESSION + STRUCTURE BUILD"
        : "NO STRUCTURE",

    stopLoss: stopLoss ? round(stopLoss, 2) : null,
    takeProfit: takeProfit ? round(takeProfit, 2) : null,
    rr: rr ? round(rr, 2) : null,

    expectedMove: round(expectedMove * 100, 2),

    updatedAt: new Date().toISOString(),
  };
}
