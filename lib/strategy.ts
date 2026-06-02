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
   UTIL
-------------------------- */

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function avg(arr: number[]) {
  return arr.reduce((a, b) => a + b, 0) / Math.max(arr.length, 1);
}

/* -------------------------
   INDICATORS (NO LIBS)
-------------------------- */

function computeRSI(closes: number[], period = 14) {
  if (closes.length < period + 1) return 50;

  let gains = 0;
  let losses = 0;

  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses += Math.abs(diff);
  }

  if (losses === 0) return 100;

  const rs = gains / losses;
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

  // simple D = avg of last few K (approx)
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

/* -------------------------
   STRUCTURE (BOS / CHoCH simplified)
-------------------------- */

function detectStructure(candles: Candle[]) {
  if (candles.length < 20) {
    return { bos: false, choch: false };
  }

  const highs = candles.slice(-20).map(c => c.high);
  const lows = candles.slice(-20).map(c => c.low);

  const recentHigh = Math.max(...highs.slice(-5));
  const prevHigh = Math.max(...highs.slice(-15, -5));

  const recentLow = Math.min(...lows.slice(-5));
  const prevLow = Math.min(...lows.slice(-15, -5));

  const bosUp = recentHigh > prevHigh;
  const bosDown = recentLow < prevLow;

  const choch = bosUp && bosDown;

  return {
    bosUp,
    bosDown,
    choch,
  };
}

/* -------------------------
   VOLUME SPIKE
-------------------------- */

function volumeSpike(candles: Candle[]) {
  if (candles.length < 20) return false;

  const vols = candles.slice(-20).map(c => c.volume);
  const avgVol = avg(vols.slice(0, -1));

  const last = vols[vols.length - 1];

  return last > avgVol * 1.8;
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
  const c15 = candles15m;
  const c1h = candles1h;

  const closes = c15.map(c => c.close);

  const rsi = computeRSI(closes);
  const { k, d } = computeStoch(c15);
  const structure = detectStructure(c15);
  const volSpike = volumeSpike(c15);

  /* -------------------------
     STATE LOGIC
  -------------------------- */

  let state: SignalState = "WAIT";

  const earlySetup =
    (k < 30 && k > d && rsi > 45) ||
    (structure.bosUp || structure.bosDown);

  const sniperSetup =
    volSpike &&
    ((structure.bosUp && rsi > 55) || (structure.bosDown && rsi < 45));

  if (sniperSetup) state = "SNIPER";
  else if (earlySetup) state = "EARLY";

  /* -------------------------
     BIAS
  -------------------------- */

  let bias: "LONG" | "SHORT" | "NEUTRAL" = "NEUTRAL";

  if (structure.bosUp && rsi > 50) bias = "LONG";
  if (structure.bosDown && rsi < 50) bias = "SHORT";

  /* -------------------------
     CONFIDENCE
  -------------------------- */

  let confidence = 20;

  if (state === "EARLY") confidence = 55 + (rsi > 50 ? 10 : 0);
  if (state === "SNIPER") confidence = 80 + (volSpike ? 10 : 0);

  confidence = clamp(confidence, 20, 95);

  /* -------------------------
     ADX proxy (momentum strength)
  -------------------------- */

  const adx =
    structure.bosUp || structure.bosDown
      ? 40 + (volSpike ? 15 : 5)
      : 20;

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
     SL / TP (VOL BASED)
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
      ? "CHoCH / COMPRESSION BREAKOUT BUILDING"
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
