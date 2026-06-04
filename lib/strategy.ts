export type Symbol = "BTC" | "ETH" | "SOL";

export type SignalState = "EARLY" | "SNIPER" | "WAIT";

export type SetupType =
  | "NONE"
  | "BREAKOUT"
  | "REVERSAL"
  | "PULLBACK"
  | "COMPRESSION";

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface Structure {
  trend: "BULL" | "BEAR" | "RANGE";
  hh: boolean;
  hl: boolean;
  lh: boolean;
  ll: boolean;
}

export interface Signal {
  symbol: Symbol;
  price: number;

  state: SignalState;
  setup: SetupType;

  bias: "LONG" | "SHORT" | "NEUTRAL";

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

/* ---------------- UTILS ---------------- */

const clamp = (n: number, min: number, max: number) =>
  Math.max(min, Math.min(max, n));

const round = (n: number, d = 2) =>
  Math.round(n * 10 ** d) / 10 ** d;

/* ---------------- RSI (simple but stable) ---------------- */

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

/* ---------------- TRUE ATR (Wilder-style approximation) ---------------- */

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
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}

/* ---------------- ADX (trend strength ONLY proxy, acknowledged) ---------------- */

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

/* ---------------- STRUCTURE ENGINE (REAL HH/HL MODEL) ---------------- */

function structure(candles: Candle[]): Structure {
  const last = candles.slice(-5);

  const highs = last.map(c => c.high);
  const lows = last.map(c => c.low);

  const hh = highs[4] > highs[3] && highs[3] > highs[2];
  const hl = lows[4] > lows[3] && lows[3] > lows[2];

  const lh = highs[4] < highs[3] && highs[3] < highs[2];
  const ll = lows[4] < lows[3] && lows[3] < lows[2];

  let trend: Structure["trend"] = "RANGE";

  if (hh && hl) trend = "BULL";
  if (lh && ll) trend = "BEAR";

  return { trend, hh, hl, lh, ll };
}

/* ---------------- BREAKOUT DETECTION ---------------- */

function breakout(candles: Candle[]) {
  const recent = candles.slice(-20);
  const highs = recent.map(c => c.high);
  const lows = recent.map(c => c.low);

  const rangeHigh = Math.max(...highs.slice(0, -1));
  const rangeLow = Math.min(...lows.slice(0, -1));

  const last = recent.at(-1)!;

  if (last.close > rangeHigh) return "BULL";
  if (last.close < rangeLow) return "BEAR";

  return "NONE";
}

/* ---------------- REVERSAL DETECTION ---------------- */

function reversal(struct: Structure, breakoutSignal: string) {
  if (struct.trend === "BULL" && breakoutSignal === "BEAR") return true;
  if (struct.trend === "BEAR" && breakoutSignal === "BULL") return true;
  return false;
}

/* ---------------- VOLUME ---------------- */

function volumeScore(candles: Candle[]) {
  const vols = candles.map(c => c.volume);
  const avg = vols.reduce((a, b) => a + b, 0) / vols.length;

  const last = vols.at(-1)!;

  return {
    ratio: last / (avg || 1),
    spike: last > avg * 1.2,
  };
}

/* ---------------- STOCH (TIMING ONLY) ---------------- */

function stochKD(closes: number[]) {
  const slice = closes.slice(-14);

  const high = Math.max(...slice);
  const low = Math.min(...slice);

  const k = ((closes.at(-1)! - low) / (high - low || 1)) * 100;

  const prevSlice = closes.slice(-17, -3);
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

/* ---------------- CORE ENGINE ---------------- */

export function generateSignal(
  symbol: Symbol,
  price: number,
  candles15m: Candle[],
  candles1h: Candle[],
  candles4h?: Candle[]
): Signal {
  const closes = candles15m.map(c => c.close);

  const r = rsi(closes);
  const a = adx(candles15m);
  const atrVal = atr(candles15m);
  const vol = volumeScore(candles15m);

  const struct = structure(candles4h ?? candles15m);
  const breakoutSignal = breakout(candles15m);

  const stoch = stochKD(closes);

  /* ---------------- 4H BIAS (ONLY SOURCE OF TRUTH) ---------------- */

  const bias: "LONG" | "SHORT" | "NEUTRAL" =
    struct.trend === "BULL"
      ? "LONG"
      : struct.trend === "BEAR"
      ? "SHORT"
      : "NEUTRAL";

  /* ---------------- VOLATILITY REGIME ---------------- */

  const avgRange = atrVal / price;

  const regime =
    avgRange < 0.003 ? "COMPRESSION"
    : avgRange < 0.01 ? "NORMAL"
    : "EXPANSION";

  /* ---------------- SETUPS ---------------- */

  const isBreakout =
    breakoutSignal !== "NONE" &&
    regime !== "COMPRESSION";

  const isReversal = reversal(struct, breakoutSignal);

  const isCompression =
    regime === "COMPRESSION";

  const setup: SetupType =
    isReversal ? "REVERSAL"
    : isBreakout ? "BREAKOUT"
    : isCompression ? "COMPRESSION"
    : "NONE";

  /* ---------------- EARLY (UNIFIED SETUP LAYER) ---------------- */

  const early =
    bias !== "NEUTRAL" &&
    setup !== "NONE" &&
    a > 18 &&
    r > 40 &&
    r < 70;

  /* ---------------- SNIPER (FULL CONFLUENCE ONLY) ---------------- */

  const sniper =
    early &&
    a > 25 &&
    vol.spike &&
    (stoch.bullishCross || stoch.bearishCross) &&
    regime === "NORMAL";

  const state: SignalState =
    sniper ? "SNIPER"
    : early ? "EARLY"
    : "WAIT";

  /* ---------------- CONFIDENCE ---------------- */

  const confidence =
    state === "SNIPER"
      ? clamp(80 + a / 10, 80, 96)
      : state === "EARLY"
      ? clamp(60 + r / 2, 55, 82)
      : 20;

  /* ---------------- EXPECTED MOVE ---------------- */

  const expectedMove =
    regime === "COMPRESSION"
      ? 0.015
      : regime === "NORMAL"
      ? 0.03
      : 0.05;

  /* ---------------- SL / TP ---------------- */

  let sl: number | null = null;
  let tp: number | null = null;

  if (state !== "WAIT") {
    const risk = expectedMove * 0.5;

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
    setup,
    bias,

    confidence: round(confidence),

    adx: round(a, 2),
    atr: round(atrVal, 4),
    stochK: round(stoch.k),
    stochD: round(stoch.d),
    rsi: round(r),

    reason:
      state === "SNIPER"
        ? "SNIPER (4H STRUCTURE + SETUP + CONFLUENCE)"
        : state === "EARLY"
        ? `EARLY (${setup})`
        : "NO STRUCTURE",

    stopLoss: sl ? round(sl, 2) : null,
    takeProfit: tp ? round(tp, 2) : null,
    rr: rr ? round(rr, 2) : null,

    expectedMove: round(expectedMove * 100, 2),

    updatedAt: new Date().toISOString(),
  };
}
