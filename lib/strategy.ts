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
  stoch: number;
  rsi: number;

  reason: string;

  stopLoss: number | null;
  takeProfit: number | null;
  rr: number | null;

  expectedMove: number;

  updatedAt: string;
}

/* -------------------------
   UTILS
-------------------------- */

const clamp = (n: number, min: number, max: number) =>
  Math.max(min, Math.min(max, n));

const avg = (arr: number[]) =>
  arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;

/* -------------------------
   INDICATORS
-------------------------- */

function computeRSI(closes: number[], period = 14) {
  if (closes.length < period + 1) return 50;

  let gain = 0;
  let loss = 0;

  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gain += diff;
    else loss += Math.abs(diff);
  }

  if (loss === 0) return 100;

  const rs = gain / loss;
  return 100 - 100 / (1 + rs);
}

function computeStoch(candles: Candle[]) {
  if (candles.length < 5) return { k: 50, d: 50 };

  const recent = candles.slice(-14);

  const highs = recent.map(c => c.high);
  const lows = recent.map(c => c.low);
  const close = recent[recent.length - 1].close;

  const highest = Math.max(...highs);
  const lowest = Math.min(...lows);

  const k = ((close - lowest) / (highest - lowest || 1)) * 100;

  const ks = recent.map((_, i) => {
    const slice = recent.slice(0, i + 1);
    const h = Math.max(...slice.map(c => c.high));
    const l = Math.min(...slice.map(c => c.low));
    const c = slice[slice.length - 1].close;
    return ((c - l) / (h - l || 1)) * 100;
  });

  const d = avg(ks.slice(-3));

  return { k, d };
}

function volumeSpike(candles: Candle[]) {
  if (candles.length < 20) return false;

  const vols = candles.slice(-20).map(c => c.volume);
  const avgVol = avg(vols.slice(0, -1));

  return vols[vols.length - 1] > avgVol * 1.7;
}

function structure(candles: Candle[]) {
  if (candles.length < 20) return { bosUp: false, bosDown: false };

  const highs = candles.slice(-20).map(c => c.high);
  const lows = candles.slice(-20).map(c => c.low);

  const recentHigh = Math.max(...highs.slice(-5));
  const prevHigh = Math.max(...highs.slice(-15, -5));

  const recentLow = Math.min(...lows.slice(-5));
  const prevLow = Math.min(...lows.slice(-15, -5));

  return {
    bosUp: recentHigh > prevHigh,
    bosDown: recentLow < prevLow,
  };
}

/* -------------------------
   CORE ENGINE
-------------------------- */

export function generateSignal(
  symbol: Symbol,
  candles15m: Candle[],
  candles1h: Candle[],
  price: number
): Signal {
  const closes = candles15m.map(c => c.close);

  const rsi = computeRSI(closes);
  const { k, d } = computeStoch(candles15m);
  const volSpike = volumeSpike(candles15m);
  const struct = structure(candles15m);

  const trend = closes.at(-1)! > avg(closes.slice(-5));

  /* -------------------------
     MOMENTUM SHIFT (KEY FIX)
  -------------------------- */

  const stochCrossUp = k > d && k - d > 2;
  const stochCrossDown = d > k && d - k > 2;

  const bullishPressure =
    stochCrossUp || rsi > 48 || trend;

  const bearishPressure =
    stochCrossDown || rsi < 52 || !trend;

  /* -------------------------
     STATE
  -------------------------- */

  let state: SignalState = "WAIT";

  const earlyLong =
    bullishPressure && (struct.bosUp || k > 40);

  const earlyShort =
    bearishPressure && (struct.bosDown || k < 60);

  const sniperLong =
    volSpike && struct.bosUp && bullishPressure;

  const sniperShort =
    volSpike && struct.bosDown && bearishPressure;

  if (sniperLong || sniperShort) state = "SNIPER";
  else if (earlyLong || earlyShort) state = "EARLY";

  /* -------------------------
     BIAS
  -------------------------- */

  let bias: "LONG" | "SHORT" | "NEUTRAL" = "NEUTRAL";

  if (earlyLong || sniperLong) bias = "LONG";
  if (earlyShort || sniperShort) bias = "SHORT";

  /* -------------------------
     CONFIDENCE
  -------------------------- */

  let confidence = 20;

  if (state === "EARLY") confidence = 55 + (volSpike ? 10 : 0);
  if (state === "SNIPER") confidence = 80 + (volSpike ? 10 : 0);

  confidence = clamp(confidence, 20, 95);

  /* -------------------------
     ADX proxy (real momentum filter)
  -------------------------- */

  const adx =
    volSpike
      ? 60
      : struct.bosUp || struct.bosDown
      ? 40
      : 25;

  /* -------------------------
     EXPECTED MOVE (3–5%)
  -------------------------- */

  const expectedMove =
    state === "SNIPER"
      ? 0.045
      : state === "EARLY"
      ? 0.03
      : 0.01;

  /* -------------------------
     SL / TP
  -------------------------- */

  let stopLoss: number | null = null;
  let takeProfit: number | null = null;
  let rr: number | null = null;

  if (state !== "WAIT") {
    const slPct = state === "SNIPER" ? 0.018 : 0.012;

    if (bias === "LONG") {
      stopLoss = price * (1 - slPct);
      takeProfit = price * (1 + expectedMove);
    } else if (bias === "SHORT") {
      stopLoss = price * (1 + slPct);
      takeProfit = price * (1 - expectedMove);
    }

    if (stopLoss && takeProfit) {
      rr = Math.abs((takeProfit - price) / (price - stopLoss));
    }
  }

  /* -------------------------
     REASON
  -------------------------- */

  const reason =
    state === "SNIPER"
      ? "BOS + VOLUME EXPANSION CONFIRMED"
      : state === "EARLY"
      ? "MOMENTUM SHIFT / STRUCTURE BUILD"
      : "NO STRUCTURE";

  return {
    symbol,
    price,

    state,
    bias,
    confidence,

    adx,
    stoch: k,
    rsi,

    reason,

    stopLoss,
    takeProfit,
    rr,

    expectedMove,

    updatedAt: new Date().toISOString(),
  };
}
