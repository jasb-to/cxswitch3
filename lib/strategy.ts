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

/* ---------------- RSI ---------------- */

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

/* ---------------- ADX (NORMALIZED FIX) ---------------- */

function adx(candles: Candle[]) {
  let plus = 0;
  let minus = 0;

  for (let i = 1; i < candles.length; i++) {
    const up = candles[i].high - candles[i - 1].high;
    const down = candles[i - 1].low - candles[i].low;

    if (up > down && up > 0) plus += up;
    if (down > up && down > 0) minus += down;
  }

  const total = plus + minus || 1;

  // FIX: normalize properly (0–100 scale)
  return (Math.abs(plus - minus) / total) * 100;
}

/* ---------------- STOCH K / D ---------------- */

function stochKD(closes: number[], period = 14) {
  const slice = closes.slice(-period);

  const high = Math.max(...slice);
  const low = Math.min(...slice);

  const k = ((slice.at(-1)! - low) / (high - low || 1)) * 100;

  const prevSlice = closes.slice(-period - 3, -3);

  const prevHigh = Math.max(...prevSlice);
  const prevLow = Math.min(...prevSlice);

  const prevK =
    ((prevSlice.at(-1)! - prevLow) / (prevHigh - prevLow || 1)) * 100;

  const d = (k + prevK + prevK) / 3;

  return { k, d, prevK };
}

/* ---------------- VOLUME ---------------- */

function volumeSpike(candles: Candle[]) {
  const vols = candles.map(c => c.volume);
  const avg = vols.reduce((a, b) => a + b, 0) / vols.length;

  return vols.at(-1)! > avg * 1.4;
}

/* ---------------- STRUCTURE ---------------- */

function BOS(candles: Candle[]) {
  const last = candles.at(-1)!;
  const prev = candles.at(-2)!;
  const prev2 = candles.at(-3)!;

  if (last.high > prev.high && prev.high > prev2.high) return "BULL";
  if (last.low < prev.low && prev.low < prev2.low) return "BEAR";
  return "NEUTRAL";
}

/* ---------------- CORE ENGINE ---------------- */

export function generateSignal(
  symbol: Symbol,
  price: number,
  candles15m: Candle[],
  candles1h: Candle[]
): Signal {
  const closes = candles15m.map(c => c.close);

  const r = rsi(closes);
  const { k, d } = stochKD(closes);
  const a = adx(candles15m);
  const bos = BOS(candles15m);
  const vol = volumeSpike(candles15m);

  const ema =
    closes.reduce((sum, c) => sum + c, 0) / closes.length;

  /* ---------------- CROSSOVER ---------------- */

  const bullishCross = k > d;
  const bearishCross = k < d;

  /* ---------------- BIAS FIX (IMPORTANT) ---------------- */

  const structureBias =
    bos === "BULL"
      ? "LONG"
      : bos === "BEAR"
      ? "SHORT"
      : null;

  const momentumBias =
    r > 50
      ? "LONG"
      : r < 45
      ? "SHORT"
      : null;

  const bias =
    structureBias || momentumBias || "NEUTRAL";

  /* ---------------- STATE (AGGRESSIVE EARLY) ---------------- */

  let state: SignalState = "WAIT";

  const early =
    vol &&
    a > 15 &&
    (bullishCross || bearishCross); // ❗ NO BOS REQUIRED

  const sniper =
    vol &&
    a > 25 &&
    bos !== "NEUTRAL" &&
    Math.abs(price - ema) / price > 0.01 &&
    r > 50;

  if (sniper) state = "SNIPER";
  else if (early) state = "EARLY";

  /* ---------------- CONFIDENCE ---------------- */

  const confidence =
    state === "SNIPER"
      ? clamp(75 + r / 10, 75, 95)
      : state === "EARLY"
      ? clamp(55 + a, 50, 80)
      : 20;

  /* ---------------- EXPECTED MOVE ---------------- */

  const volatility = Math.abs(price - ema) / price;

  const expectedMove =
    state === "SNIPER"
      ? clamp(volatility * 2.5, 0.03, 0.06)
      : state === "EARLY"
      ? clamp(volatility * 1.6, 0.02, 0.04)
      : 0.01;

  /* ---------------- SL / TP ---------------- */

  let sl: number | null = null;
  let tp: number | null = null;

  if (state !== "WAIT") {
    const risk = expectedMove * 0.55;

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

    adx: round(a, 2),
    stochK: round(k),
    stochD: round(d),
    rsi: round(r),

    reason:
      state === "SNIPER"
        ? "BREAKOUT CONFIRMED"
        : state === "EARLY"
        ? "AGGRESSIVE EARLY ENTRY"
        : "NO STRUCTURE",

    stopLoss: sl ? round(sl, 2) : null,
    takeProfit: tp ? round(tp, 2) : null,
    rr: rr ? round(rr, 2) : null,

    expectedMove: round(expectedMove * 100, 2),

    updatedAt: new Date().toISOString(),
  };
}
