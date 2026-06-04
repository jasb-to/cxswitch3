export type Symbol = "BTC" | "ETH" | "SOL";
export type SignalState = "EARLY" | "SNIPER" | "WAIT";

export type SetupType = "BREAKOUT" | "PULLBACK" | "REVERSAL" | "NONE";

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
  setup: SetupType;

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

/* ---------------- ATR (REAL VOLATILITY) ---------------- */

function atr(candles: Candle[]) {
  let trSum = 0;

  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const p = candles[i - 1];

    const tr = Math.max(
      c.high - c.low,
      Math.abs(c.high - p.close),
      Math.abs(c.low - p.close)
    );

    trSum += tr;
  }

  return trSum / (candles.length || 1);
}

/* ---------------- IMPROVED ADX (still simplified but usable) ---------------- */

function adx(candles: Candle[]) {
  let plusDM = 0;
  let minusDM = 0;

  for (let i = 1; i < candles.length; i++) {
    const up = candles[i].high - candles[i - 1].high;
    const down = candles[i - 1].low - candles[i].low;

    if (up > down && up > 0) plusDM += up;
    if (down > up && down > 0) minusDM += down;
  }

  const total = plusDM + minusDM || 1;

  return (Math.abs(plusDM - minusDM) / total) * 100;
}

/* ---------------- STRUCTURE (HH / HL / LH / LL) ---------------- */

function structure(candles: Candle[]) {
  const last = candles.slice(-5);

  const highs = last.map(c => c.high);
  const lows = last.map(c => c.low);

  const higherHigh = highs[4] > highs[3] && highs[3] > highs[2];
  const higherLow = lows[4] > lows[3] && lows[3] > lows[2];

  const lowerHigh = highs[4] < highs[3] && highs[3] < highs[2];
  const lowerLow = lows[4] < lows[3] && lows[3] < lows[2];

  if (higherHigh && higherLow) return "BULL";
  if (lowerHigh && lowerLow) return "BEAR";
  return "RANGE";
}

/* ---------------- CONSOLIDATION DETECTOR ---------------- */

function isConsolidating(candles: Candle[], atrValue: number) {
  const last = candles.slice(-10);
  const range =
    Math.max(...last.map(c => c.high)) -
    Math.min(...last.map(c => c.low));

  return range < atrValue * 1.2;
}

/* ---------------- STOCH ---------------- */

function stochKD(closes: number[]) {
  const slice = closes.slice(-14);

  const high = Math.max(...slice);
  const low = Math.min(...slice);

  const k =
    ((closes.at(-1)! - low) / (high - low || 1)) * 100;

  const prevSlice = closes.slice(-17, -3);

  const prevHigh = Math.max(...prevSlice);
  const prevLow = Math.min(...prevSlice);

  const prevK =
    ((prevSlice.at(-1)! - prevLow) / (prevHigh - prevLow || 1)) * 100;

  const d = (k + prevK + prevK) / 3;

  return { k, d };
}

/* ---------------- VOLUME ---------------- */

function volumeScore(candles: Candle[]) {
  const vols = candles.map(c => c.volume);
  const avg = vols.reduce((a, b) => a + b, 0) / vols.length;

  const last = vols.at(-1)!;

  return {
    ratio: last / (avg || 1),
  };
}

/* ---------------- EMA ---------------- */

function ema(values: number[], period = 21) {
  const k = 2 / (period + 1);

  let e = values[0];

  for (let i = 1; i < values.length; i++) {
    e = values[i] * k + e * (1 - k);
  }

  return e;
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
  const a = adx(candles15m);
  const atrValue = atr(candles15m);

  const struct = structure(candles1h);
  const consolidating = isConsolidating(candles15m, atrValue);

  const vol = volumeScore(candles15m);

  /* ---------------- BIAS FROM 1H STRUCTURE ---------------- */

  const bias =
    struct === "BULL" ? "LONG"
    : struct === "BEAR" ? "SHORT"
    : "NEUTRAL";

  /* ---------------- SETUP DETECTION ---------------- */

  let setup: SetupType = "NONE";

  if (!consolidating && struct !== "RANGE") {
    setup = "BREAKOUT";
  }

  if (consolidating && struct !== "RANGE") {
    setup = "PULLBACK";
  }

  if (struct === "RANGE" && !consolidating) {
    setup = "REVERSAL";
  }

  /* ---------------- FILTERS ---------------- */

  const trendOK = a > 22;
  const volOK = vol.ratio > 1.05;
  const rsiOK = r > 35 && r < 70;

  const allowed = !consolidating && trendOK && volOK;

  /* ---------------- STATE ---------------- */

  const state: SignalState =
    allowed && bias !== "NEUTRAL"
      ? "EARLY"
      : "WAIT";

  /* ---------------- CONFIDENCE ---------------- */

  const confidence =
    state === "EARLY"
      ? clamp(60 + a, 55, 85)
      : 20;

  /* ---------------- OUTPUT ---------------- */

  return {
    symbol,
    price: round(price),

    state,
    setup,
    bias,

    confidence: round(confidence),

    adx: round(a, 2),
    stochK: 0,
    stochD: 0,
    rsi: round(r),

    reason:
      state === "EARLY"
        ? `EARLY (${setup})`
        : "NO STRUCTURE",

    stopLoss: null,
    takeProfit: null,
    rr: null,

    expectedMove: consolidating ? 0.5 : 1.5,

    updatedAt: new Date().toISOString(),
  };
}
