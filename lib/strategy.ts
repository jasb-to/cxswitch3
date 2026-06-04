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

/* ---------------- ADX (proxy ONLY) ---------------- */

function adx(candles: Candle[]) {
  let plus = 0;
  let minus = 0;

  for (let i = 1; i < candles.length; i++) {
    const upMove = candles[i].high - candles[i - 1].high;
    const downMove = candles[i - 1].low - candles[i].low;

    if (upMove > downMove && upMove > 0) plus += upMove;
    if (downMove > upMove && downMove > 0) minus += downMove;
  }

  const total = plus + minus || 1;
  return (Math.abs(plus - minus) / total) * 100;
}

/* ---------------- STOCH (STABILISED) ---------------- */

function stochKD(closes: number[], period = 14) {
  const slice = closes.slice(-period);

  const high = Math.max(...slice);
  const low = Math.min(...slice);

  const k =
    ((closes.at(-1)! - low) / (high - low || 1)) * 100;

  const prevSlice = closes.slice(-period - 3, -3);

  const prevHigh = Math.max(...prevSlice);
  const prevLow = Math.min(...prevSlice);

  const prevK =
    ((prevSlice.at(-1)! - prevLow) / (prevHigh - prevLow || 1)) * 100;

  const d = (k + prevK + prevK) / 3;

  const bullishCross = prevK < d && k > d;
  const bearishCross = prevK > d && k < d;

  /* 🔥 FIX: reduce micro-noise */
  const stableSignal =
    Math.abs(k - d) > 6;

  return { k, d, prevK, bullishCross, bearishCross, stableSignal };
}

/* ---------------- VOLUME ---------------- */

function volumeScore(candles: Candle[]) {
  const vols = candles.map(c => c.volume);
  const avg = vols.reduce((a, b) => a + b, 0) / vols.length;

  const last = vols.at(-1)!;
  const ratio = last / (avg || 1);

  return {
    spike: ratio > 1.1,
    ratio,
  };
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

/* ---------------- EMA ---------------- */

function ema(values: number[], period = 21) {
  const k = 2 / (period + 1);

  let emaVal = values[0];

  for (let i = 1; i < values.length; i++) {
    emaVal = values[i] * k + emaVal * (1 - k);
  }

  return emaVal;
}

function emaSlope21(closes: number[]) {
  if (closes.length < 30) return 0;

  const emaNow = ema(closes, 21);
  const emaPrev = ema(closes.slice(0, -5), 21);

  return emaNow - emaPrev;
}

/* ---------------- SIGNAL MEMORY (ANTI-FLICKER FIX) ---------------- */

const lastSignalMap = new Map<string, Signal>();

function signalKey(symbol: Symbol, state: SignalState, bias: string) {
  return `${symbol}-${state}-${bias}`;
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
  const {
    k,
    d,
    prevK,
    bullishCross,
    bearishCross,
    stableSignal
  } = stochKD(closes);

  const a = adx(candles15m);
  const bos = BOS(candles15m);
  const vol = volumeScore(candles15m);

  const emaSlope = emaSlope21(closes);

  /* ---------------- BIAS ---------------- */

  const bias: "LONG" | "SHORT" | "NEUTRAL" =
    emaSlope > 0
      ? "LONG"
      : emaSlope < 0
      ? "SHORT"
      : "NEUTRAL";

  /* ---------------- REGIME ---------------- */

  const trendStrength =
    a > 30 ? "TRENDING"
    : a > 22 ? "TRANSITION"
    : "CHOP";

  const validTrend = a >= 23;

  /* ---------------- STOCH FILTER (FIXED) ---------------- */

  const stochSignal =
    stableSignal &&
    ((bias === "LONG" && bullishCross) ||
     (bias === "SHORT" && bearishCross));

  /* ---------------- CONFIRMATION STACK ---------------- */

  const momentumOK = r > 40 && r < 70;
  const stochOK = stochSignal;
  const volumeOK = vol.ratio > 1.1;

  const confirmationCount =
    (momentumOK ? 1 : 0) +
    (stochOK ? 1 : 0) +
    (volumeOK ? 1 : 0);

  /* ---------------- EARLY ---------------- */

  const early =
    bias !== "NEUTRAL" &&
    validTrend &&
    trendStrength !== "CHOP" &&
    confirmationCount >= 2;

  /* ---------------- SNIPER ---------------- */

  const sniper =
    early &&
    a > 26 &&
    vol.spike &&
    bos !== "NEUTRAL" &&
    Math.abs(price - closes.reduce((a,b)=>a+b,0)/closes.length) / price > 0.01;

  const state: SignalState =
    sniper ? "SNIPER"
    : early ? "EARLY"
    : "WAIT";

  /* ---------------- ANTI-FLICKER GUARD ---------------- */

  const key = signalKey(symbol, state, bias);
  const last = lastSignalMap.get(key);

  const signal: Signal = {
    symbol,
    price: round(price),

    state,
    bias,

    confidence: round(
      state === "SNIPER"
        ? clamp(82 + r / 10, 80, 96)
        : state === "EARLY"
        ? clamp(60 + k / 2, 55, 82)
        : 20
    ),

    adx: round(a, 2),
    stochK: round(k),
    stochD: round(d),
    rsi: round(r),

    reason:
      state === "SNIPER"
        ? "SNIPER CONFIRMED"
        : state === "EARLY"
        ? "EARLY (CONFIRMED STACK)"
        : "NO STRUCTURE",

    stopLoss: null,
    takeProfit: null,
    rr: null,

    expectedMove: round(1),

    updatedAt: new Date().toISOString(),
  };

  /* ---------------- DUPLICATE BLOCK (CRITICAL FIX) ---------------- */

  if (
    last &&
    last.price === signal.price &&
    last.state === signal.state &&
    last.bias === signal.bias &&
    Math.abs(last.confidence - signal.confidence) < 2
  ) {
    return last; // prevent UI flicker + duplicate alert
  }

  lastSignalMap.set(key, signal);

  return signal;
}
