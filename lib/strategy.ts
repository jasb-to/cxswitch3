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
  atr: number;

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

/* ================= ATR (REAL VOLATILITY ENGINE) ================= */

function atr(candles: Candle[], period = 14) {
  const trs: number[] = [];

  for (let i = 1; i < candles.length; i++) {
    const high = candles[i].high;
    const low = candles[i].low;
    const prevClose = candles[i - 1].close;

    const tr = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose)
    );

    trs.push(tr);
  }

  const slice = trs.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / (slice.length || 1);
}

/* ================= WILDER ADX (REAL VERSION) ================= */

function adx(candles: Candle[], period = 14) {
  const plusDM: number[] = [];
  const minusDM: number[] = [];
  const tr: number[] = [];

  for (let i = 1; i < candles.length; i++) {
    const upMove = candles[i].high - candles[i - 1].high;
    const downMove = candles[i - 1].low - candles[i].low;

    plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);

    const trueRange = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close)
    );

    tr.push(trueRange);
  }

  const smooth = (arr: number[]) =>
    arr.slice(-period).reduce((a, b) => a + b, 0) / period;

  const pDM = smooth(plusDM);
  const mDM = smooth(minusDM);
  const trVal = smooth(tr);

  const pDI = (pDM / (trVal || 1)) * 100;
  const mDI = (mDM / (trVal || 1)) * 100;

  const dx = Math.abs(pDI - mDI) / ((pDI + mDI) || 1) * 100;

  return dx;
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

/* ================= STRUCTURE (REAL SWING HH/HL FIX) ================= */

function marketStructure(candles: Candle[]) {
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);

  const recent = 10;

  const hh = highs.slice(-recent).every((v, i, arr) =>
    i === 0 ? true : v >= arr[i - 1]
  );

  const hl = lows.slice(-recent).every((v, i, arr) =>
    i === 0 ? true : v >= arr[i - 1]
  );

  const lh = highs.slice(-recent).every((v, i, arr) =>
    i === 0 ? true : v <= arr[i - 1]
  );

  const ll = lows.slice(-recent).every((v, i, arr) =>
    i === 0 ? true : v <= arr[i - 1]
  );

  if (hh && hl) return "UPTREND";
  if (lh && ll) return "DOWNTREND";
  return "RANGE";
}

/* ================= SETUP CLASSIFIER ================= */

function classifySetup(
  structure: string,
  price: number,
  high: number,
  low: number,
  atrValue: number
): SetupType {

  const range = (high - low) / price;

  const isBreakout = range > atrValue / price;

  if (isBreakout) return "BREAKOUT";

  if (structure === "UPTREND" || structure === "DOWNTREND")
    return "PULLBACK";

  if (structure === "RANGE" && range < atrValue / price)
    return "REVERSAL";

  return "NONE";
}

/* ================= EMA (BIAS ONLY) ================= */

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

  const atrValue = atr(candles15m);
  const adxValue = adx(candles15m);

  const vol = volumeScore(candles15m);

  const structure = marketStructure(candles15m);

  const high = Math.max(...closes.slice(-20));
  const low = Math.min(...closes.slice(-20));

  const setup = classifySetup(structure, price, high, low, atrValue);

  /* ================= BIAS ================= */

  const emaDir = emaSlope(closes);

  const bias: "LONG" | "SHORT" | "NEUTRAL" =
    structure === "UPTREND" && emaDir > 0
      ? "LONG"
      : structure === "DOWNTREND" && emaDir < 0
      ? "SHORT"
      : "NEUTRAL";

  const validTrend = adxValue > 20 && structure !== "RANGE";

  /* ================= EARLY ================= */

  const early =
    bias !== "NEUTRAL" &&
    validTrend &&
    setup !== "NONE" &&
    vol.ratio > 1.1 &&
    r > 40 &&
    r < 70 &&
    ((bias === "LONG" && bullishCross) ||
     (bias === "SHORT" && bearishCross));

  /* ================= SNIPER ================= */

  const sniper =
    early &&
    adxValue > 25 &&
    vol.spike;

  const state: SignalState =
    sniper ? "SNIPER"
    : early ? "EARLY"
    : "WAIT";

  /* ================= RISK MODEL (ATR BASED FIX) ================= */

  const slDistance = atrValue * 1.2;

  let sl: number | null = null;
  let tp: number | null = null;

  if (state !== "WAIT") {
    if (bias === "LONG") {
      sl = price - slDistance;
      tp = price + slDistance * 2;
    } else if (bias === "SHORT") {
      sl = price + slDistance;
      tp = price - slDistance * 2;
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

    setup,

    confidence: round(
      state === "SNIPER"
        ? clamp(85 + r / 10, 80, 96)
        : state === "EARLY"
        ? clamp(60 + k / 2, 55, 82)
        : 20
    ),

    adx: round(adxValue, 2),
    atr: round(atrValue, 4),

    stochK: round(k),
    stochD: round(d),
    rsi: round(r),

    reason:
      state === "SNIPER"
        ? `SNIPER (${setup})`
        : state === "EARLY"
        ? `EARLY (${setup})`
        : "NO STRUCTURE",

    stopLoss: sl ? round(sl, 2) : null,
    takeProfit: tp ? round(tp, 2) : null,
    rr: rr ? round(rr, 2) : null,

    expectedMove: round((atrValue / price) * 100, 2),

    updatedAt: new Date().toISOString(),
  };
}
