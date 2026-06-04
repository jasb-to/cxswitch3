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
  if (closes.length < 2) return 50;

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

/* ---------------- MOMENTUM STRENGTH (SAFE ADX REPLACEMENT) ---------------- */

function momentumStrength(candles: Candle[]) {
  if (candles.length < 10) return 20;

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

/* ---------------- STOCH (SAFE) ---------------- */

function stochKD(closes: number[], period = 14) {
  if (closes.length < period + 5) {
    return { k: 50, d: 50, prevK: 50 };
  }

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

/* ---------------- STRUCTURE BREAK (REALISTIC) ---------------- */

function BOS(candles: Candle[]) {
  if (candles.length < 4) return "NEUTRAL";

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

function emaSlope21(closes: number[]) {
  if (closes.length < 25) return 0;

  const emaNow = ema(closes, 21);
  const emaPrev = ema(closes.slice(0, -1), 21);

  return emaNow - emaPrev;
}

/* ---------------- COMPRESSION / BREAKOUT ENGINE ---------------- */

function compressionExpansion(closes: number[]) {
  if (closes.length < 20) return { compression: false, breakout: false };

  const rangeNow =
    Math.max(...closes.slice(-10)) - Math.min(...closes.slice(-10));

  const rangePrev =
    Math.max(...closes.slice(-20, -10)) -
    Math.min(...closes.slice(-20, -10));

  return {
    compression: rangeNow < rangePrev * 0.75,
    breakout: rangeNow > rangePrev * 1.25,
  };
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
  const m = momentumStrength(candles15m);
  const bos = BOS(candles15m);
  const vol = volumeScore(candles15m);

  const emaSlope = emaSlope21(closes);

  const { compression, breakout } = compressionExpansion(closes);

  /* ---------------- 1H TREND CONFIRMATION ---------------- */

  const ema1h = ema(closes1h, 21);
  const price1h = closes1h.at(-1)!;

  const higherTimeframeBias: "LONG" | "SHORT" | "NEUTRAL" =
    price1h > ema1h ? "LONG"
    : price1h < ema1h ? "SHORT"
    : "NEUTRAL";

  /* ---------------- BIAS ---------------- */

  const bias: "LONG" | "SHORT" | "NEUTRAL" =
    emaSlope > 0
      ? "LONG"
      : emaSlope < 0
      ? "SHORT"
      : "NEUTRAL";

  /* ---------------- STOCH SIGNAL ---------------- */

  const bullishCross = prevK < d && k > d;
  const bearishCross = prevK > d && k < d;

  const stochSignal = bullishCross || bearishCross;

  /* ---------------- EARLY (NOW INCLUDES ALL 3 REGIMES) ---------------- */

  const earlyPullback =
    bias !== "NEUTRAL" &&
    stochSignal &&
    vol.ratio > 1.05 &&
    r > 35 &&
    r < 70;

  const earlyReversal =
    m > 18 &&
    stochSignal &&
    r < 45 &&
    vol.ratio > 1.1;

  const earlyBreakout =
    compression &&
    breakout &&
    vol.ratio > 1.2 &&
    m > 22;

  const early =
    (earlyPullback || earlyReversal || earlyBreakout) &&
    higherTimeframeBias !== "NEUTRAL";

  /* ---------------- SNIPER ---------------- */

  const sniper =
    early &&
    m > 25 &&
    vol.spike &&
    bos !== "NEUTRAL" &&
    Math.abs(price - closes.reduce((a,b)=>a+b,0)/closes.length) / price > 0.01;

  const state: SignalState =
    sniper ? "SNIPER"
    : early ? "EARLY"
    : "WAIT";

  /* ---------------- CONFIDENCE ---------------- */

  const confidence =
    state === "SNIPER"
      ? clamp(80 + m / 5, 80, 96)
      : state === "EARLY"
      ? clamp(55 + k / 2, 55, 82)
      : 20;

  /* ---------------- EXPECTED MOVE ---------------- */

  const emaValue = closes.reduce((a, b) => a + b, 0) / closes.length;
  const volatility = Math.abs(price - emaValue) / price;

  const expectedMove =
    state === "SNIPER"
      ? clamp(volatility * 2.5, 0.03, 0.06)
      : state === "EARLY"
      ? clamp(volatility * 1.7, 0.02, 0.045)
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

    adx: round(m, 2),
    stochK: round(k),
    stochD: round(d),
    rsi: round(r),

    reason:
      state === "SNIPER"
        ? "SNIPER (STRUCTURE + VOLUME + HTF CONFIRMED)"
        : state === "EARLY"
        ? "EARLY (PULLBACK / REVERSAL / BREAKOUT)"
        : "NO STRUCTURE",

    stopLoss: sl ? round(sl, 2) : null,
    takeProfit: tp ? round(tp, 2) : null,
    rr: rr ? round(rr, 2) : null,

    expectedMove: round(expectedMove * 100, 2),

    updatedAt: new Date().toISOString(),
  };
}
