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

const round = (n: number, d = 2) =>
  Math.round(n * Math.pow(10, d)) / Math.pow(10, d);

const clamp = (n: number, min: number, max: number) =>
  Math.max(min, Math.min(max, n));

/* ================= EMA ================= */

function ema(values: number[], period: number) {
  if (values.length === 0) return 0;

  const k = 2 / (period + 1);

  let e = values[0];

  for (let i = 1; i < values.length; i++) {
    e = values[i] * k + e * (1 - k);
  }

  return e;
}

/* ================= RSI ================= */

function rsi(closes: number[], period = 14) {
  if (closes.length < period + 1) return 50;

  let gains = 0;
  let losses = 0;

  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];

    if (diff > 0) gains += diff;
    else losses -= diff;
  }

  const rs = gains / (losses || 1);

  return 100 - 100 / (1 + rs);
}

/* ================= STOCH K/D ================= */

function calcK(
  closes: number[],
  index: number,
  period = 14
) {
  const start = Math.max(0, index - period + 1);

  const slice = closes.slice(start, index + 1);

  const high = Math.max(...slice);
  const low = Math.min(...slice);

  return (
    ((closes[index] - low) / (high - low || 1)) *
    100
  );
}

function stochastic(closes: number[]) {
  if (closes.length < 20) {
    return {
      k: 50,
      d: 50,
      prevK: 50,
      prevD: 50,
    };
  }

  const kSeries: number[] = [];

  for (let i = 0; i < closes.length; i++) {
    kSeries.push(calcK(closes, i));
  }

  const k =
    kSeries.slice(-3).reduce((a, b) => a + b, 0) / 3;

  const d =
    kSeries.slice(-6, -3).reduce((a, b) => a + b, 0) / 3;

  const prevK =
    kSeries.slice(-4, -1).reduce((a, b) => a + b, 0) / 3;

  const prevD =
    kSeries.slice(-7, -4).reduce((a, b) => a + b, 0) / 3;

  return {
    k,
    d,
    prevK,
    prevD,
  };
}

/* ================= VOLUME ================= */

function volumeSpike(candles: Candle[]) {
  const vols = candles.map(c => c.volume);

  const avg =
    vols.reduce((a, b) => a + b, 0) / vols.length;

  const current = vols.at(-1) ?? 0;

  return current > avg * 1.5;
}

/* ================= BOS ================= */

function detectBOS(candles: Candle[]) {
  if (candles.length < 6) return "NEUTRAL";

  const highs = candles.slice(-6).map(c => c.high);
  const lows = candles.slice(-6).map(c => c.low);

  const latestHigh = highs.at(-1)!;
  const latestLow = lows.at(-1)!;

  const previousHigh = Math.max(...highs.slice(0, -1));
  const previousLow = Math.min(...lows.slice(0, -1));

  if (latestHigh > previousHigh) return "BULL";

  if (latestLow < previousLow) return "BEAR";

  return "NEUTRAL";
}

/* ================= SIGNAL ================= */

export function generateSignal(
  symbol: Symbol,
  price: number,
  candles15m: Candle[],
  candles1h: Candle[]
): Signal {
  const closes = candles15m.map(c => c.close);

  const r = rsi(closes);

  const {
    k,
    d,
    prevK,
    prevD,
  } = stochastic(closes);

  const bos = detectBOS(candles15m);

  const volumeConfirmed =
    volumeSpike(candles15m);

  const ema21 = ema(closes, 21);

  const volatility =
    Math.abs(price - ema21) / price;

  const bullishCross =
    prevK < prevD &&
    k > d &&
    k < 35;

  const bearishCross =
    prevK > prevD &&
    k < d &&
    k > 65;

  const bias =
    bos === "BULL"
      ? "LONG"
      : bos === "BEAR"
      ? "SHORT"
      : "NEUTRAL";

  let state: SignalState = "WAIT";

  const early =
    bos !== "NEUTRAL" &&
    volumeConfirmed &&
    (bullishCross || bearishCross);

  const sniper =
    bos !== "NEUTRAL" &&
    volumeConfirmed &&
    volatility > 0.01 &&
    (
      (bias === "LONG" && bullishCross) ||
      (bias === "SHORT" && bearishCross)
    );

  if (sniper) state = "SNIPER";
  else if (early) state = "EARLY";

  const confidence =
    state === "SNIPER"
      ? clamp(80 + volatility * 1000, 80, 95)
      : state === "EARLY"
      ? clamp(60 + volatility * 500, 55, 80)
      : 20;

  const expectedMove =
    state === "SNIPER"
      ? clamp(volatility * 3, 0.03, 0.06)
      : state === "EARLY"
      ? clamp(volatility * 2, 0.02, 0.04)
      : 0.01;

  let stopLoss: number | null = null;
  let takeProfit: number | null = null;

  if (state !== "WAIT") {
    const risk = expectedMove * 0.6;

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
      ? Math.abs(
          (takeProfit - price) /
          (price - stopLoss)
        )
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

    stopLoss:
      stopLoss !== null
        ? round(stopLoss, 2)
        : null,

    takeProfit:
      takeProfit !== null
        ? round(takeProfit, 2)
        : null,

    rr:
      rr !== null
        ? round(rr, 2)
        : null,

    expectedMove: round(expectedMove * 100, 2),

    updatedAt: new Date().toISOString(),
  };
}
