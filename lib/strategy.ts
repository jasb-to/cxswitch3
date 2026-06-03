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

/* ---------------- STOCH K / D (FIXED) ---------------- */

function stochKD(closes: number[], period = 14) {
  const slice = closes.slice(-period);

  const high = Math.max(...slice);
  const low = Math.min(...slice);

  const safeRange = high - low || 1;

  const k =
    ((slice.at(-1)! - low) / safeRange) * 100;

  // proper smoothing for D
  const kSeries: number[] = [];

  for (let i = 3; i <= slice.length; i++) {
    const sub = slice.slice(0, i);
    const h = Math.max(...sub);
    const l = Math.min(...sub);
    kSeries.push(((sub.at(-1)! - l) / (h - l || 1)) * 100);
  }

  const d =
    kSeries.length >= 3
      ? kSeries.slice(-3).reduce((a, b) => a + b, 0) / 3
      : k;

  return { k, d };
}

/* ---------------- STRUCTURE ---------------- */

function BOS(closes: number[]) {
  const last = closes.at(-1)!;
  const prev = closes.at(-2)!;
  const prev2 = closes.at(-3)!;

  if (last > prev && prev > prev2) return "BULL";
  if (last < prev && prev < prev2) return "BEAR";
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
  const bos = BOS(closes);

  const ema21 = ema(closes, 21);
  const volatility = Math.abs(price - ema21) / price;

  /* ---------------- BIAS ---------------- */

  const bias =
    bos === "BULL"
      ? "LONG"
      : bos === "BEAR"
      ? "SHORT"
      : "NEUTRAL";

  /* ---------------- CROSS LOGIC ---------------- */

  const bullishCross = k > d && k < 35;
  const bearishCross = k < d && k > 65;

  const volume = candles15m.at(-1)?.volume ?? 0;
  const avgVol =
    candles15m.reduce((a, c) => a + c.volume, 0) /
    (candles15m.length || 1);

  const volSpike = volume > avgVol * 1.3;

  /* ---------------- STATE MACHINE ---------------- */

  let state: SignalState = "WAIT";

  const early =
    bos !== "NEUTRAL" &&
    volSpike &&
    r > 45 &&
    bullishCross;

  const sniper =
    bos !== "NEUTRAL" &&
    volSpike &&
    r > 52 &&
    k > d &&
    volatility > 0.008;

  if (sniper) state = "SNIPER";
  else if (early) state = "EARLY";

  /* ---------------- CONFIDENCE ---------------- */

  const confidence =
    state === "SNIPER"
      ? clamp(80 + r / 10, 80, 97)
      : state === "EARLY"
      ? clamp(55 + k / 2, 50, 78)
      : 20;

  /* ---------------- EXPECTED MOVE ---------------- */

  const expectedMove =
    state === "SNIPER"
      ? clamp(volatility * 2.8, 0.03, 0.06)
      : state === "EARLY"
      ? clamp(volatility * 1.6, 0.02, 0.04)
      : 0.01;

  /* ---------------- SL / TP ---------------- */

  let sl: number | null = null;
  let tp: number | null = null;

  if (state !== "WAIT") {
    const risk = expectedMove * 0.6;

    if (bias === "LONG") {
      sl = price * (1 - risk);
      tp = price * (1 + expectedMove);
    } else if (bias === "SHORT") {
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

    adx: round(volatility * 100, 2),

    stochK: round(k),
    stochD: round(d),
    rsi: round(r),

    reason:
      state === "SNIPER"
        ? "BOS + VOLUME + BREAKOUT"
        : state === "EARLY"
        ? "STRUCTURE BUILD + K/D CONFIRMATION"
        : "NO STRUCTURE",

    stopLoss: sl ? round(sl, 2) : null,
    takeProfit: tp ? round(tp, 2) : null,
    rr: rr ? round(rr, 2) : null,

    expectedMove: round(expectedMove * 100, 2),

    updatedAt: new Date().toISOString(),
  };
}
