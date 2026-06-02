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
  Math.round(n * 10 ** d) / 10 ** d;

/* ---------------- INDICATORS ---------------- */

function ema(values: number[], period: number) {
  const k = 2 / (period + 1);
  let e = values[0];

  for (let i = 1; i < values.length; i++) {
    e = values[i] * k + e * (1 - k);
  }

  return e;
}

function rsi(closes: number[]) {
  let gain = 0;
  let loss = 0;

  for (let i = 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gain += diff;
    else loss -= diff;
  }

  const rs = gain / (loss || 1);
  return 100 - 100 / (1 + rs);
}

function stoch(closes: number[], period = 14) {
  const slice = closes.slice(-period);
  const high = Math.max(...slice);
  const low = Math.min(...slice);
  return ((slice.at(-1)! - low) / (high - low || 1)) * 100;
}

/* ---------------- VOLUME SPIKE ---------------- */

function volumeSpike(candles: Candle[]) {
  const vols = candles.map(c => c.volume);
  const avg = vols.reduce((a, b) => a + b, 0) / vols.length;
  const last = vols.at(-1)!;

  return last > avg * 1.5;
}

/* ---------------- STRUCTURE (REAL BOS) ---------------- */

function swingHigh(candles: Candle[]) {
  const last = candles.at(-2);
  const prev = candles.at(-3);
  return last && prev && last.high > prev.high;
}

function swingLow(candles: Candle[]) {
  const last = candles.at(-2);
  const prev = candles.at(-3);
  return last && prev && last.low < prev.low;
}

function BOS(candles: Candle[]) {
  if (swingHigh(candles)) return "BULL";
  if (swingLow(candles)) return "BEAR";
  return "NEUTRAL";
}

/* ---------------- CORE ---------------- */

export function generateSignal(
  symbol: Symbol,
  price: number,
  candles15m: Candle[],
  candles1h: Candle[]
): Signal {
  const closes = candles15m.map(c => c.close);

  const r = rsi(closes);
  const st = stoch(closes);
  const bos = BOS(candles15m);
  const vol = volumeSpike(candles15m);

  const ema21 = ema(closes, 21);

  const trend =
    price > ema21 ? "LONG" : "SHORT";

  /* ---------------- STATE MACHINE ---------------- */

  let state: SignalState = "WAIT";

  const early =
    bos !== "NEUTRAL" &&
    st < 30 &&
    r > 45 &&
    vol;

  const sniper =
    bos !== "NEUTRAL" &&
    vol &&
    st > 60 &&
    r > 50 &&
    Math.abs(price - ema21) / price > 0.01;

  if (sniper) state = "SNIPER";
  else if (early) state = "EARLY";

  /* ---------------- CONFIDENCE ---------------- */

  const confidence =
    state === "SNIPER"
      ? clamp(85 + r / 10, 85, 97)
      : state === "EARLY"
      ? clamp(60 + st / 2, 55, 80)
      : 20;

  /* ---------------- EXPECTED MOVE (REALISTIC 3–5%) ---------------- */

  const expectedMove =
    state === "SNIPER"
      ? clamp(0.035, 0.03, 0.055)
      : state === "EARLY"
      ? clamp(0.025, 0.045)
      : 0.01;

  /* ---------------- SL / TP ---------------- */

  let sl = null;
  let tp = null;

  if (state !== "WAIT") {
    const risk = expectedMove * 0.6;

    if (trend === "LONG") {
      sl = price * (1 - risk);
      tp = price * (1 + expectedMove);
    } else {
      sl = price * (1 + risk);
      tp = price * (1 - expectedMove);
    }
  }

  const rr =
    sl && tp
      ? Math.abs((tp - price) / (price - sl))
      : null;

  return {
    symbol,
    price: round(price),

    state,
    bias: bos === "BULL" ? "LONG" : bos === "BEAR" ? "SHORT" : "NEUTRAL",

    confidence: round(confidence),

    adx: round(Math.abs(price - ema21) / price * 100, 1),
    stoch: round(st),
    rsi: round(r),

    reason:
      state === "SNIPER"
        ? "BOS + VOLUME EXPANSION"
        : state === "EARLY"
        ? "STRUCTURE + MOMENTUM BUILD"
        : "NO STRUCTURE",

    stopLoss: sl ? round(sl, 2) : null,
    takeProfit: tp ? round(tp, 2) : null,
    rr: rr ? round(rr, 2) : null,

    expectedMove: round(expectedMove * 100, 2),

    updatedAt: new Date().toISOString(),
  };
}
