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

/* ---------------- MOMENTUM STRENGTH (FIXED) ---------------- */

function momentumStrength(candles: Candle[]) {
  if (candles.length < 10) return 20;

  let trueRange = 0;
  let directional = 0;

  for (let i = 1; i < candles.length; i++) {
    const up = candles[i].high - candles[i - 1].high;
    const down = candles[i - 1].low - candles[i].low;

    const move = Math.max(Math.abs(up), Math.abs(down));
    trueRange += move;

    directional += up - down;
  }

  return Math.abs(directional) / (trueRange || 1) * 100;
}

/* ---------------- ADX ---------------- */

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

/* ---------------- STOCH ---------------- */

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

  return { k, d, prevK };
}

/* ---------------- VOLUME ---------------- */

function volumeScore(candles: Candle[]) {
  const vols = candles.map(c => c.volume);
  const avg = vols.reduce((a, b) => a + b, 0) / vols.length;

  const last = vols.at(-1)!;
  const ratio = last / (avg || 1);

  return {
    spike: ratio > 1.25,
    ratio,
  };
}

/* ---------------- STRUCTURE BREAK ---------------- */

function BOS(candles: Candle[]) {
  const last = candles.at(-1)!;
  const prev = candles.at(-2)!;
  const prev2 = candles.at(-3)!;

  if (last.high > prev.high && prev.high > prev2.high) return "BULL";
  if (last.low < prev.low && prev.low < prev2.low) return "BEAR";
  return "NEUTRAL";
}

/* ---------------- EMA ---------------- */

function ema(values: number[], period = 21) {
  const k = 2 / (period + 1);

  let emaVal = values[0];

  for (let i = 1; i < values.length; i++) {
    emaVal = values[i] * k + emaVal * (1 - k);
  }

  return emaVal;
}

/* FIXED EMA SLOPE (NO LAG BIAS BUG) */
function emaSlope21(closes: number[]) {
  if (closes.length < 25) return 0;

  const emaNow = ema(closes, 21);
  const emaPrev = ema(closes.slice(-10, -1), 21);

  return emaNow - emaPrev;
}

/* ---------------- COMPRESSION / BREAKOUT / REVERSAL ---------------- */

function marketStructure(closes: number[]) {
  if (closes.length < 20) {
    return { compression: false, breakout: false, reversal: false };
  }

  const recent = closes.slice(-10);
  const prior = closes.slice(-20, -10);

  const recentRange = Math.max(...recent) - Math.min(...recent);
  const priorRange = Math.max(...prior) - Math.min(...prior);

  const avgRange = (recentRange + priorRange) / 2;

  const compression = recentRange < avgRange * 0.75;
  const breakout = recentRange > avgRange * 1.2;

  const reversal =
    compression &&
    Math.abs(closes.at(-1)! - closes.at(-5)!) / closes.at(-5)! > 0.01;

  return { compression, breakout, reversal };
}

/* ---------------- CORE ENGINE ---------------- */

export function generateSignal(
  symbol: Symbol,
  price: number,
  candles15m: Candle[],
  candles1h: Candle[]
): Signal {
  const closes = candles15m.map(c => c.close);
  const closes1h = candles1h.map(c => c.close);

  const r = rsi(closes);
  const { k, d, prevK } = stochKD(closes);
  const a = adx(candles15m);
  const bos = BOS(candles15m);
  const vol = volumeScore(candles15m);
  const ms = marketStructure(closes);

  const emaSlope = emaSlope21(closes);

  /* ---------------- BIAS ---------------- */

  const bias: "LONG" | "SHORT" | "NEUTRAL" =
    emaSlope > 0 ? "LONG"
    : emaSlope < 0 ? "SHORT"
    : "NEUTRAL";

  /* ---------------- 1H ALIGNMENT (FIXED) ---------------- */

  const h1Slope = emaSlope21(closes1h);

  const higherBias =
    h1Slope > 0 ? "LONG"
    : h1Slope < 0 ? "SHORT"
    : "NEUTRAL";

  const aligned = higherBias === bias;

  /* ---------------- REGIME ---------------- */

  const trendStrength =
    a >= 26 ? "TRENDING"
    : a >= 20 ? "TRANSITION"
    : "CHOP";

  const validTrend = a >= 23;

  /* ---------------- STOCH ---------------- */

  const bullishCross = prevK < d && k > d;
  const bearishCross = prevK > d && k < d;

  const stochSignal = bullishCross || bearishCross;

  /* ---------------- EARLY SCORING SYSTEM ---------------- */

  let earlyScore = 0;

  if (validTrend && trendStrength !== "CHOP") earlyScore += 1;
  if (stochSignal) earlyScore += 1;
  if (vol.ratio > 1.05) earlyScore += 1;
  if (aligned) earlyScore += 1;

  if (ms.breakout) earlyScore += 2;
  if (ms.reversal) earlyScore += 2;
  if (ms.compression) earlyScore += 1;

  const early = earlyScore >= 3;

  /* ---------------- SNIPER ---------------- */

  const sniper =
    earlyScore >= 5 &&
    a > 26 &&
    vol.spike &&
    bos !== "NEUTRAL";

  const state: SignalState =
    sniper ? "SNIPER"
    : early ? "EARLY"
    : "WAIT";

  /* ---------------- CONFIDENCE ---------------- */

  const confidence =
    state === "SNIPER"
      ? clamp(82 + earlyScore * 2, 80, 96)
      : state === "EARLY"
      ? clamp(55 + earlyScore * 4, 55, 85)
      : 20;

  /* ---------------- EXPECTED MOVE ---------------- */

  const emaValue =
    closes.reduce((a, b) => a + b, 0) / closes.length;

  const volatility = Math.abs(price - emaValue) / price;

  const expectedMove =
    state === "SNIPER"
      ? clamp(volatility * 2.5, 0.03, 0.06)
      : state === "EARLY"
      ? clamp(volatility * 1.6, 0.02, 0.04)
      : 0.01;

  /* ---------------- SL / TP ---------------- */

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

  return {
    symbol,
    price: round(price),

    state,
    bias,

    confidence: round(confidence),

    adx: round(a, 2),
    stochK: round(k),
    stochD: round(d),
    rsi: round(r),

    reason:
      state === "SNIPER"
        ? "SNIPER (BREAKOUT + STRUCTURE + VOLUME + ALIGNMENT)"
        : state === "EARLY"
        ? "EARLY (COMPRESSION / BREAKOUT / REVERSAL STACK)"
        : "NO STRUCTURE",

    stopLoss: sl ? round(sl, 2) : null,
    takeProfit: tp ? round(tp, 2) : null,
    rr: rr ? round(rr, 2) : null,

    expectedMove: round(expectedMove * 100, 2),

    updatedAt: new Date().toISOString(),
  };
}
