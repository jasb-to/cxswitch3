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
  stochK: number;
  stochD: number;
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

/* ---------------- STOCHASTIC K / D ---------------- */

function stochKD(closes: number[], period = 14) {
  const slice = closes.slice(-period);

  const high = Math.max(...slice);
  const low = Math.min(...slice);

  const k =
    ((slice.at(-1)! - low) / (high - low || 1)) * 100;

  // smoothing for D (simple moving average of K proxy)
  const kSeries = closes.slice(-period).map((_, i, arr) => {
    const sub = arr.slice(0, i + 1);
    const h = Math.max(...sub);
    const l = Math.min(...sub);
    return ((sub.at(-1)! - l) / (h - l || 1)) * 100;
  });

  const d =
    kSeries.slice(-3).reduce((a, b) => a + b, 0) / 3;

  return { k, d };
}

/* ---------------- VOLUME ---------------- */

function volumeSpike(candles: Candle[]) {
  const vols = candles.map(c => c.volume);
  const avg = vols.reduce((a, b) => a + b, 0) / vols.length;
  return vols.at(-1)! > avg * 1.5;
}

/* ---------------- STRUCTURE (light BOS) ---------------- */

function BOS(candles: Candle[]) {
  const last = candles.at(-1)!;
  const prev = candles.at(-2)!;
  const prev2 = candles.at(-3)!;

  if (last.high > prev.high && prev.high > prev2.high) return "BULL";
  if (last.low < prev.low && prev.low < prev2.low) return "BEAR";
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
  const { k, d } = stochKD(closes);
  const bos = BOS(candles15m);
  const vol = volumeSpike(candles15m);

  const ema21 = ema(closes, 21);

  /* ---------------- CROSSOVER LOGIC ---------------- */

  const bullishCross = k > d && k < 30;
  const bearishCross = k < d && k > 70;

  /* ---------------- STATE ---------------- */

  let state: SignalState = "WAIT";

  const early =
    bos !== "NEUTRAL" &&
    vol &&
    r > 40 &&
    bullishCross;

  const sniper =
    bos !== "NEUTRAL" &&
    vol &&
    r > 50 &&
    k > d &&
    Math.abs(price - ema21) / price > 0.01;

  if (sniper) state = "SNIPER";
  else if (early) state = "EARLY";

  /* ---------------- BIAS ---------------- */

  const bias =
    bos === "BULL"
      ? "LONG"
      : bos === "BEAR"
      ? "SHORT"
      : "NEUTRAL";

  /* ---------------- CONFIDENCE ---------------- */

  const confidence =
    state === "SNIPER"
      ? clamp(80 + r / 10, 80, 97)
      : state === "EARLY"
      ? clamp(60 + k / 2, 55, 80)
      : 20;

  /* ---------------- EXPECTED MOVE ---------------- */

  const volatility = Math.abs(price - ema21) / price;

  const expectedMove =
    state === "SNIPER"
      ? clamp(volatility * 2.5, 0.03, 0.055)
      : state === "EARLY"
      ? clamp(volatility * 1.8, 0.02, 0.04)
      : 0.01;

  /* ---------------- SL / TP ---------------- */

  let sl: number | null = null;
  let tp: number | null = null;

  if (state !== "WAIT") {
    const risk = expectedMove * 0.6;

    if (bias === "LONG") {
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
    bias,

    confidence: round(confidence),

    adx: round(volatility * 100, 1),
    stochK: round(k),
    stochD: round(d),
    rsi: round(r),

    reason:
      state === "SNIPER"
        ? "BOS + VOLUME + BREAKOUT"
        : state === "EARLY"
        ? "K/D CROSS + STRUCTURE BUILD"
        : "NO STRUCTURE",

    stopLoss: sl ? round(sl, 2) : null,
    takeProfit: tp ? round(tp, 2) : null,
    rr: rr ? round(rr, 2) : null,

    expectedMove: round(expectedMove * 100, 2),

    updatedAt: new Date().toISOString(),
  };
}
