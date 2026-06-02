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
  rsi: number;

  structure: string;

  entry: number | null;
  stopLoss: number | null;
  takeProfit: number | null;

  rr: number | null;

  expectedMove: number;

  updatedAt: string;
}

/* -------------------------
   INDICATORS
-------------------------- */

function rsi(closes: number[], period = 14) {
  let gain = 0;
  let loss = 0;

  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gain += diff;
    else loss += Math.abs(diff);
  }

  const rs = gain / (loss || 1);
  return 100 - 100 / (1 + rs);
}

function stoch(candles: Candle[], period = 14) {
  const slice = candles.slice(-period);
  const high = Math.max(...slice.map(c => c.high));
  const low = Math.min(...slice.map(c => c.low));
  const close = slice.at(-1)!.close;

  return ((close - low) / (high - low || 1)) * 100;
}

/* -------------------------
   STRUCTURE LOGIC (REAL EDGE)
-------------------------- */

function detectStructure(candles: Candle[]) {
  const highs = candles.slice(-20).map(c => c.high);
  const lows = candles.slice(-20).map(c => c.low);
  const closes = candles.map(c => c.close);

  const resistance = Math.max(...highs);
  const support = Math.min(...lows);

  const last = closes.at(-1)!;

  const sweptLow = last < support * 0.998;
  const sweptHigh = last > resistance * 1.002;

  return {
    resistance,
    support,
    sweptLow,
    sweptHigh,
  };
}

/* -------------------------
   MAIN ENGINE
-------------------------- */

export function generateSignal(
  symbol: Symbol,
  candles15m: Candle[],
  candles1h: Candle[],
  price: number
): Signal {
  const closes = candles15m.map(c => c.close);

  const rsiVal = rsi(closes);
  const stochK = stoch(candles15m);

  const structure = detectStructure(candles15m);

  const emaSlope =
    (closes.at(-1)! - closes.at(closes.length - 10)!) /
    closes.at(-10)!;

  /* -------------------------
     LIQUIDITY CONDITIONS
  -------------------------- */

  const compression =
    stochK < 35 && rsiVal > 45 && Math.abs(emaSlope) < 0.002;

  const sweepReversal =
    (structure.sweptLow && rsiVal > 50) ||
    (structure.sweptHigh && rsiVal < 50);

  const breakout =
    stochK > 65 && rsiVal > 55 && emaSlope > 0.003;

  /* -------------------------
     STATE LOGIC (STRICT)
  -------------------------- */

  let state: SignalState = "WAIT";

  if (compression) state = "EARLY";
  if (breakout && sweepReversal) state = "SNIPER";

  /* -------------------------
     BIAS
  -------------------------- */

  const bias =
    emaSlope > 0 ? "LONG" : emaSlope < 0 ? "SHORT" : "NEUTRAL";

  /* -------------------------
     CONFIDENCE (FILTER HARD)
  -------------------------- */

  const confidence =
    state === "SNIPER"
      ? 85 + (sweepReversal ? 10 : 0)
      : state === "EARLY"
      ? 55 + stochK / 5
      : 20;

  /* -------------------------
     EXPECTED MOVE (REALISTIC 3–5%)
  -------------------------- */

  const expectedMove =
    state === "SNIPER"
      ? 0.035
      : state === "EARLY"
      ? 0.02
      : 0.01;

  /* -------------------------
     ENTRY / SL / TP
  -------------------------- */

  let entry = price;
  let stopLoss: number | null = null;
  let takeProfit: number | null = null;
  let rr: number | null = null;

  if (state !== "WAIT") {
    const risk = expectedMove * (state === "SNIPER" ? 0.4 : 0.6);

    if (bias === "LONG") {
      stopLoss = price * (1 - risk);
      takeProfit = price * (1 + expectedMove);
    } else if (bias === "SHORT") {
      stopLoss = price * (1 + risk);
      takeProfit = price * (1 - expectedMove);
    } else {
      stopLoss = price * (1 - risk);
      takeProfit = price * (1 + expectedMove);
    }

    rr = Math.abs((takeProfit - price) / (price - stopLoss));
  }

  return {
    symbol,
    price,

    state,
    bias,
    confidence,

    adx: Math.abs(emaSlope) * 100,
    stochK,
    rsi: rsiVal,

    structure:
      state === "SNIPER"
        ? "LIQUIDITY SWEEP + BREAKOUT"
        : state === "EARLY"
        ? "COMPRESSION PHASE"
        : "NO STRUCTURE",

    entry,
    stopLoss,
    takeProfit,
    rr,

    expectedMove,

    updatedAt: new Date().toISOString(),
  };
}
