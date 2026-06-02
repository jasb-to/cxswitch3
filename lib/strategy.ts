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

  bos: boolean;
  choch: boolean;
  volumeSpike: boolean;

  structure: string;

  entry: number | null;
  stopLoss: number | null;
  takeProfit: number | null;

  rr: number | null;

  expectedMove: number;

  updatedAt: string;
}

/* -------------------------
   HELPERS
-------------------------- */

function avg(arr: number[]) {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

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
   STRUCTURE (BOS / CHOCH)
-------------------------- */

function structure(candles: Candle[]) {
  const last = candles.at(-1)!.close;

  const highs = candles.slice(-20).map(c => c.high);
  const lows = candles.slice(-20).map(c => c.low);

  const resistance = Math.max(...highs);
  const support = Math.min(...lows);

  const bos = last > resistance * 0.999; // breakout structure
  const choch = last < support * 1.001;  // breakdown structure

  return { bos, choch };
}

/* -------------------------
   VOLUME SPIKE
-------------------------- */

function volumeSpike(candles: Candle[]) {
  const vols = candles.slice(-20).map(c => c.volume);
  const avgVol = avg(vols);
  const lastVol = vols.at(-1)!;

  return lastVol > avgVol * 1.5;
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
  const { bos, choch } = structure(candles15m);
  const volSpike = volumeSpike(candles15m);

  const emaSlope =
    (closes.at(-1)! - closes.at(-10)!) / closes.at(-10)!;

  /* -------------------------
     STATE LOGIC (LESS RESTRICTIVE)
  -------------------------- */

  const compression = stochK < 40 && rsiVal > 40;

  let state: SignalState = "WAIT";

  if (compression) state = "EARLY";

  // SNIPER does NOT require everything anymore
  if (bos || choch) state = "SNIPER";

  /* -------------------------
     BIAS
  -------------------------- */

  const bias =
    emaSlope > 0 ? "LONG" : emaSlope < 0 ? "SHORT" : "NEUTRAL";

  /* -------------------------
     CONFIDENCE (NOW REALISTIC)
  -------------------------- */

  let confidence = 20;

  if (state === "EARLY") confidence = 50 + stochK / 10;
  if (state === "SNIPER") confidence = 70;

  if (volSpike) confidence += 10;
  if (bos) confidence += 5;
  if (choch) confidence += 5;

  confidence = Math.min(95, confidence);

  /* -------------------------
     MOVE MODEL (3–5% STILL VALID)
  -------------------------- */

  const expectedMove =
    state === "SNIPER"
      ? 0.04
      : state === "EARLY"
      ? 0.025
      : 0.01;

  /* -------------------------
     SL / TP
  -------------------------- */

  let stopLoss = null;
  let takeProfit = null;
  let rr = null;

  if (state !== "WAIT") {
    const risk = expectedMove * (state === "SNIPER" ? 0.45 : 0.6);

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

    bos,
    choch,
    volumeSpike: volSpike,

    structure:
      state === "SNIPER"
        ? "BOS/CHOCH CONFIRMED"
        : state === "EARLY"
        ? "ACCUMULATION"
        : "NO STRUCTURE",

    entry: price,
    stopLoss,
    takeProfit,
    rr,

    expectedMove,

    updatedAt: new Date().toISOString(),
  };
}
