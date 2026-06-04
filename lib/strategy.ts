export type Symbol = "BTC" | "ETH" | "SOL";
export type SignalState = "EARLY" | "SNIPER" | "WAIT";

export type SetupType =
  | "BREAKOUT"
  | "PULLBACK"
  | "REVERSAL"
  | "NONE";

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

  setup: SetupType;

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

/* ================= UTILS ================= */

const clamp = (n: number, min: number, max: number) =>
  Math.max(min, Math.min(max, n));

const round = (n: number, d = 2) =>
  Math.round(n * 10 ** d) / 10 ** d;

/* ================= RSI ================= */

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

/* ================= ADX (proxy only) ================= */

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
  return (Math.abs(plus - minus) / total) * 100;
}

/* ================= MARKET STRUCTURE (REAL FIX) ================= */

function marketStructure(candles: Candle[]) {
  const last = candles.slice(-10);

  let highs = last.map(c => c.high);
  let lows = last.map(c => c.low);

  const higherHighs = highs[highs.length - 1] > highs[highs.length - 2];
  const higherLows = lows[lows.length - 1] > lows[lows.length - 2];

  const lowerHighs = highs[highs.length - 1] < highs[highs.length - 2];
  const lowerLows = lows[lows.length - 1] < lows[lows.length - 2];

  if (higherHighs && higherLows) return "UPTREND";
  if (lowerHighs && lowerLows) return "DOWNTREND";
  return "RANGE";
}

/* ================= STOCH ================= */

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

  return {
    k,
    d,
    bullishCross: prevK < d && k > d,
    bearishCross: prevK > d && k < d,
  };
}

/* ================= VOLUME ================= */

function volumeScore(candles: Candle[]) {
  const vols = candles.map(c => c.volume);
  const avg = vols.reduce((a, b) => a + b, 0) / vols.length;

  const last = vols.at(-1)!;
  const ratio = last / (avg || 1);

  return {
    spike: ratio > 1.15,
    ratio,
  };
}

/* ================= SETUP CLASSIFICATION (FIXED CORE) ================= */

function classifySetup(
  structure: string,
  price: number,
  recentHigh: number,
  recentLow: number
): SetupType {

  const rangeSize = (recentHigh - recentLow) / price;

  /* breakout */
  if (rangeSize > 0.02) {
    if (price > recentHigh) return "BREAKOUT";
    if (price < recentLow) return "BREAKOUT";
  }

  /* pullback */
  if (structure === "UPTREND" && price < recentHigh && price > recentLow)
    return "PULLBACK";

  if (structure === "DOWNTREND" && price < recentHigh && price > recentLow)
    return "PULLBACK";

  /* reversal */
  if (structure === "RANGE" && rangeSize < 0.015)
    return "REVERSAL";

  return "NONE";
}

/* ================= EMA (bias only) ================= */

function ema(values: number[], period = 21) {
  const k = 2 / (period + 1);

  let emaVal = values[0];

  for (let i = 1; i < values.length; i++) {
    emaVal = values[i] * k + emaVal * (1 - k);
  }

  return emaVal;
}

function emaSlope(closes: number[]) {
  const now = ema(closes, 21);
  const prev = ema(closes.slice(0, -5), 21);

  return now - prev;
}

/* ================= SIGNAL MEMORY (FIXED DEDUP) ================= */

const lastSignalTime = new Map<string, number>();

function canEmit(symbol: Symbol, state: SignalState) {
  const key = `${symbol}-${state}`;
  const now = Date.now();
  const last = lastSignalTime.get(key) || 0;

  if (now - last < 60_000) return false; // 60s lock
  lastSignalTime.set(key, now);
  return true;
}

/* ================= CORE ENGINE ================= */

export function generateSignal(
  symbol: Symbol,
  price: number,
  candles15m: Candle[],
  candles1h: Candle[],
  candles4h: Candle[]
): Signal {

  const closes = candles15m.map(c => c.close);

  const r = rsi(closes);
  const { k, d, bullishCross, bearishCross } = stochKD(closes);
  const a = adx(candles15m);
  const vol = volumeScore(candles15m);

  const structure = marketStructure(candles15m);

  const recentHigh = Math.max(...closes.slice(-20));
  const recentLow = Math.min(...closes.slice(-20));

  const setup = classifySetup(structure, price, recentHigh, recentLow);

  /* ================= BIAS (STRUCTURE BASED FIX) ================= */

  const emaDir = emaSlope(closes);

  const bias: "LONG" | "SHORT" | "NEUTRAL" =
    structure === "UPTREND" && emaDir > 0
      ? "LONG"
      : structure === "DOWNTREND" && emaDir < 0
      ? "SHORT"
      : "NEUTRAL";

  /* ================= REGIME ================= */

  const validTrend = a > 23 && structure !== "RANGE";

  /* ================= EARLY ================= */

  const early =
    bias !== "NEUTRAL" &&
    validTrend &&
    (
      (setup === "PULLBACK") ||
      (setup === "BREAKOUT") ||
      (setup === "REVERSAL")
    ) &&
    vol.ratio > 1.1 &&
    r > 40 &&
    r < 70 &&
    ((bias === "LONG" && bullishCross) ||
     (bias === "SHORT" && bearishCross));

  /* ================= SNIPER ================= */

  const sniper =
    early &&
    a > 26 &&
    vol.spike;

  const state: SignalState =
    sniper ? "SNIPER"
    : early ? "EARLY"
    : "WAIT";

  /* ================= DEDUP GUARD ================= */

  if (!canEmit(symbol, state)) {
    return {
      symbol,
      price: round(price),
      state: "WAIT",
      bias,
      setup: "NONE",
      confidence: 20,
      adx: round(a),
      stochK: round(k),
      stochD: round(d),
      rsi: round(r),
      reason: "COOLDOWN",
      stopLoss: null,
      takeProfit: null,
      rr: null,
      expectedMove: 1,
      updatedAt: new Date().toISOString(),
    };
  }

  /* ================= CONFIDENCE ================= */

  const confidence =
    state === "SNIPER"
      ? clamp(85 + r / 10, 80, 96)
      : state === "EARLY"
      ? clamp(60 + k / 2, 55, 82)
      : 20;

  return {
    symbol,
    price: round(price),

    state,
    bias,

    setup,

    confidence: round(confidence),

    adx: round(a, 2),
    stochK: round(k),
    stochD: round(d),
    rsi: round(r),

    reason:
      state === "SNIPER"
        ? `SNIPER (${setup})`
        : state === "EARLY"
        ? `EARLY (${setup})`
        : "NO STRUCTURE",

    stopLoss: null,
    takeProfit: null,
    rr: null,

    expectedMove: 1,

    updatedAt: new Date().toISOString(),
  };
}
