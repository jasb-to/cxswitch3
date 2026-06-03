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

/* =========================================================
   UTILS
========================================================= */

const clamp = (n: number, min: number, max: number) =>
  Math.max(min, Math.min(max, n));

const round = (n: number, d = 2) =>
  Math.round(n * 10 ** d) / 10 ** d;

/* =========================================================
   INDICATORS
========================================================= */

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

/**
 * Realistic trend strength (NOT fake ADX explosion bug)
 */
function adxLike(candles: Candle[]) {
  let up = 0;
  let down = 0;

  for (let i = 1; i < candles.length; i++) {
    const upMove = candles[i].high - candles[i - 1].high;
    const downMove = candles[i - 1].low - candles[i].low;

    if (upMove > downMove && upMove > 0) up += upMove;
    if (downMove > upMove && downMove > 0) down += downMove;
  }

  const total = up + down || 1;
  return (Math.abs(up - down) / total) * 100;
}

/* =========================================================
   STOCHASTIC K / D
========================================================= */

function stochKD(closes: number[], period = 14) {
  const slice = closes.slice(-period);

  const high = Math.max(...slice);
  const low = Math.min(...slice);

  const k =
    ((slice.at(-1)! - low) / (high - low || 1)) * 100;

  const prevSlice = closes.slice(-period - 3, -3);

  const prevHigh = Math.max(...prevSlice);
  const prevLow = Math.min(...prevSlice);

  const prevK =
    ((prevSlice.at(-1)! - prevLow) / (prevHigh - prevLow || 1)) * 100;

  const d = (k + prevK + prevK) / 3;

  return { k, d, prevK };
}

/* =========================================================
   VOLUME Z SCORE (FIXED)
========================================================= */

function volumeScore(candles: Candle[]) {
  const vols = candles.map(c => c.volume);

  const avg = vols.reduce((a, b) => a + b, 0) / vols.length;

  const variance =
    vols.reduce((a, v) => a + Math.pow(v - avg, 2), 0) / vols.length;

  const std = Math.sqrt(variance) || 1;

  const last = vols.at(-1)!;

  return (last - avg) / std;
}

/* =========================================================
   FRACTAL SWINGS (2 LEFT / 2 RIGHT)
========================================================= */

function getSwings(candles: Candle[]) {
  const highs: number[] = [];
  const lows: number[] = [];

  for (let i = 2; i < candles.length - 2; i++) {
    const h = candles[i].high;
    const l = candles[i].low;

    if (
      h > candles[i - 1].high &&
      h > candles[i - 2].high &&
      h > candles[i + 1].high &&
      h > candles[i + 2].high
    ) {
      highs.push(h);
    }

    if (
      l < candles[i - 1].low &&
      l < candles[i - 2].low &&
      l < candles[i + 1].low &&
      l < candles[i + 2].low
    ) {
      lows.push(l);
    }
  }

  return {
    swingHigh: highs.at(-1) ?? null,
    swingLow: lows.at(-1) ?? null,
    prevHigh: highs.at(-2) ?? null,
    prevLow: lows.at(-2) ?? null,
  };
}

/* =========================================================
   BOS + CHoCH
========================================================= */

function structure(
  candles: Candle[],
  price: number
) {
  const swings = getSwings(candles);

  let bos: "BULL" | "BEAR" | "NEUTRAL" = "NEUTRAL";
  let choch: "BULL" | "BEAR" | "NONE" = "NONE";

  if (swings.swingHigh && price > swings.swingHigh) {
    bos = "BULL";
  }

  if (swings.swingLow && price < swings.swingLow) {
    bos = "BEAR";
  }

  if (swings.prevLow && price < swings.prevLow && bos === "BULL") {
    choch = "BEAR";
  }

  if (swings.prevHigh && price > swings.prevHigh && bos === "BEAR") {
    choch = "BULL";
  }

  return { bos, choch };
}

/* =========================================================
   HTF TREND (1H)
========================================================= */

function trend1H(candles: Candle[]) {
  const closes = candles.map(c => c.close);

  const first = closes[0];
  const last = closes.at(-1)!;

  if (last > first * 1.01) return "BULL";
  if (last < first * 0.99) return "BEAR";

  return "RANGE";
}

/* =========================================================
   CORE SIGNAL ENGINE
========================================================= */

export function generateSignal(
  symbol: Symbol,
  price: number,
  candles15m: Candle[],
  candles1h: Candle[]
): Signal {
  const closes = candles15m.map(c => c.close);

  const r = rsi(closes);
  const { k, d, prevK } = stochKD(closes);
  const volZ = volumeScore(candles15m);

  const { bos, choch } = structure(candles15m, price);
  const htf = trend1H(candles1h);

  const adx = adxLike(candles15m);

  const bullishCross = prevK < d && k > d;
  const bearishCross = prevK > d && k < d;

  /* =========================================================
     BIAS
  ========================================================= */

  let bias: "LONG" | "SHORT" | "NEUTRAL" = "NEUTRAL";

  if (bos === "BULL" || choch === "BULL") bias = "LONG";
  if (bos === "BEAR" || choch === "BEAR") bias = "SHORT";

  /* =========================================================
     STATE MACHINE
  ========================================================= */

  let state: SignalState = "WAIT";

  const htfAlignLong = htf === "BULL" && bias === "LONG";
  const htfAlignShort = htf === "BEAR" && bias === "SHORT";

  const early =
    Math.abs(volZ) > 0.5 &&
    adx > 15 &&
    bullishCross &&
    r > 40;

  const sniper =
    Math.abs(volZ) > 1 &&
    adx > 25 &&
    bos !== "NEUTRAL" &&
    k > d &&
    ((htfAlignLong && bias === "LONG") ||
      (htfAlignShort && bias === "SHORT"));

  if (sniper) state = "SNIPER";
  else if (early) state = "EARLY";

  /* =========================================================
     CONFIDENCE (REAL SCORING MODEL)
  ========================================================= */

  const structureScore =
    bos !== "NEUTRAL" ? 30 : 10;

  const htfScore =
    htfAlignLong || htfAlignShort ? 25 : 5;

  const momentumScore =
    r > 45 && r < 70 ? 20 : 10;

  const volumeScoreFinal =
    Math.abs(volZ) > 1 ? 15 : 5;

  const trendScore =
    adx > 20 ? 10 : 5;

  const confidence =
    state === "SNIPER" || state === "EARLY"
      ? clamp(
          structureScore +
          htfScore +
          momentumScore +
          volumeScoreFinal +
          trendScore,
          20,
          95
        )
      : 20;

  /* =========================================================
     EXPECTED MOVE
  ========================================================= */

  const volatility =
    Math.abs(price - closes.at(-1)!) / price;

  const expectedMove =
    state === "SNIPER"
      ? clamp(volatility * 2.5, 0.03, 0.06)
      : state === "EARLY"
      ? clamp(volatility * 1.7, 0.02, 0.04)
      : 0.01;

  /* =========================================================
     SL / TP
  ========================================================= */

  let sl: number | null = null;
  let tp: number | null = null;

  if (state !== "WAIT") {
    const risk = expectedMove * 0.55;

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

  /* =========================================================
     OUTPUT
  ========================================================= */

  return {
    symbol,
    price: round(price),

    state,
    bias,

    confidence: round(confidence),

    adx: round(adx, 2),
    stochK: round(k),
    stochD: round(d),
    rsi: round(r),

    reason:
      state === "SNIPER"
        ? "HTF ALIGN + BOS + VOLUME BREAKOUT"
        : state === "EARLY"
        ? "STRUCTURE + MOMENTUM BUILD"
        : "NO STRUCTURE",

    stopLoss: sl ? round(sl, 2) : null,
    takeProfit: tp ? round(tp, 2) : null,
    rr: rr ? round(rr, 2) : null,

    expectedMove: round(expectedMove * 100, 2),

    updatedAt: new Date().toISOString(),
  };
}
