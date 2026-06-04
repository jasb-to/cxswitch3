export type Symbol = "BTC" | "ETH" | "SOL";

export type SignalState = "EARLY" | "SNIPER" | "WAIT";

export type SetupType =
  | "NONE"
  | "PULLBACK"
  | "BREAKOUT"
  | "REVERSAL";

export type Structure =
  | "UPTREND"
  | "DOWNTREND"
  | "RANGE";

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
  structure: Structure;

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

/* ---------------- ATR (REAL VOLATILITY) ---------------- */

function atr(candles: Candle[], period = 14) {
  const trs: number[] = [];

  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const p = candles[i - 1];

    const tr = Math.max(
      c.high - c.low,
      Math.abs(c.high - p.close),
      Math.abs(c.low - p.close)
    );

    trs.push(tr);
  }

  const slice = trs.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / (slice.length || 1);
}

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

/* ---------------- STABLE STOCH ---------------- */

function stoch(closes: number[]) {
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

  return { k, d, prevK };
}

/* ---------------- TRUE HH/HL STRUCTURE ---------------- */

function getStructure(candles: Candle[]): Structure {
  const swings = [];

  for (let i = 2; i < candles.length - 2; i++) {
    const prev = candles[i - 1];
    const curr = candles[i];
    const next = candles[i + 1];

    if (curr.high > prev.high && curr.high > next.high) {
      swings.push({ type: "HIGH", value: curr.high });
    }

    if (curr.low < prev.low && curr.low < next.low) {
      swings.push({ type: "LOW", value: curr.low });
    }
  }

  const highs = swings.filter(s => s.type === "HIGH").map(s => s.value);
  const lows = swings.filter(s => s.type === "LOW").map(s => s.value);

  const lastHighs = highs.slice(-3);
  const lastLows = lows.slice(-3);

  const higherHighs = lastHighs.every((v, i, arr) => i === 0 || v > arr[i - 1]);
  const higherLows = lastLows.every((v, i, arr) => i === 0 || v > arr[i - 1]);

  const lowerHighs = lastHighs.every((v, i, arr) => i === 0 || v < arr[i - 1]);
  const lowerLows = lastLows.every((v, i, arr) => i === 0 || v < arr[i - 1]);

  if (higherHighs && higherLows) return "UPTREND";
  if (lowerHighs && lowerLows) return "DOWNTREND";
  return "RANGE";
}

/* ---------------- BREAKOUT ---------------- */

function breakout(candles: Candle[]) {
  const highs = candles.slice(-20).map(c => c.high);
  const lows = candles.slice(-20).map(c => c.low);

  const resistance = Math.max(...highs);
  const support = Math.min(...lows);

  const last = candles.at(-1)!;

  if (last.close > resistance) return "BREAKOUT_UP";
  if (last.close < support) return "BREAKOUT_DOWN";

  return "NONE";
}

/* ---------------- CORE ENGINE ---------------- */

export function generateSignal(
  symbol: Symbol,
  price: number,
  candles15m: Candle[],
  candles1h: Candle[],
  candles4h: Candle[]
): Signal {

  const closes = candles15m.map(c => c.close);

  const structure = getStructure(candles4h);
  const r = rsi(closes);
  const { k, d, prevK } = stoch(closes);
  const a = atr(candles15m);

  const brk = breakout(candles15m);

  /* ---------------- BIAS (ONLY 4H STRUCTURE) ---------------- */

  const bias =
    structure === "UPTREND" ? "LONG"
    : structure === "DOWNTREND" ? "SHORT"
    : "NEUTRAL";

  /* ---------------- SETUP ENGINE ---------------- */

  let setup: SetupType = "NONE";

  if (brk.includes("BREAKOUT")) setup = "BREAKOUT";
  else if (structure !== "RANGE") setup = "PULLBACK";
  else if (brk === "NONE" && structure === "RANGE") setup = "REVERSAL";

  /* ---------------- VOLATILITY REGIME ---------------- */

  const avgRange = a / price;

  const compression = avgRange < 0.003;
  const expansion = avgRange > 0.006;

  /* ---------------- STOCH TRIGGER ---------------- */

  const stochCross = prevK < d && k > d;

  const entryValid =
    r > 40 && r < 70 &&
    stochCross;

  /* ---------------- EARLY (SETUP ONLY) ---------------- */

  const early =
    bias !== "NEUTRAL" &&
    setup !== "NONE" &&
    !compression;

  /* ---------------- SNIPER (FULL STACK) ---------------- */

  const sniper =
    early &&
    expansion &&
    entryValid &&
    structure !== "RANGE";

  const state: SignalState =
    sniper ? "SNIPER"
    : early ? "EARLY"
    : "WAIT";

  /* ---------------- CONFIDENCE ---------------- */

  const confidence =
    state === "SNIPER" ? 85
    : state === "EARLY" ? 65
    : 20;

  /* ---------------- RR MODEL ---------------- */

  const expectedMove =
    state === "SNIPER" ? 0.05
    : state === "EARLY" ? 0.03
    : 0.01;

  let sl = null;
  let tp = null;

  if (bias === "LONG") {
    sl = price * (1 - expectedMove * 0.5);
    tp = price * (1 + expectedMove);
  }

  if (bias === "SHORT") {
    sl = price * (1 + expectedMove * 0.5);
    tp = price * (1 - expectedMove);
  }

  const rr = sl && tp
    ? Math.abs((tp - price) / (price - sl))
    : null;

  return {
    symbol,
    price: round(price),

    state,
    setup,
    structure,

    bias,

    confidence,

    adx: 0, // removed proxy usage
    atr: round(a, 2),

    stochK: round(k),
    stochD: round(d),
    rsi: round(r),

    reason:
      state === "SNIPER"
        ? "SNIPER (4H STRUCTURE + 15M ENTRY + ATR EXPANSION)"
        : state === "EARLY"
        ? "EARLY (SETUP ACTIVE)"
        : "NO STRUCTURE",

    stopLoss: sl ? round(sl, 2) : null,
    takeProfit: tp ? round(tp, 2) : null,
    rr: rr ? round(rr, 2) : null,

    expectedMove: round(expectedMove * 100, 2),

    updatedAt: new Date().toISOString(),
  };
}
