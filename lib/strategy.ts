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
   INDICATORS
-------------------------- */

function ema(values: number[], period: number) {
  const k = 2 / (period + 1);
  let ema = values[0];

  for (let i = 1; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
  }

  return ema;
}

function rsi(closes: number[], period = 14) {
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

function atr(candles: Candle[], period = 14) {
  if (candles.length < period + 1) return 0;

  let trs: number[] = [];

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

  return trs.slice(-period).reduce((a, b) => a + b, 0) / period;
}

function stoch(candles: Candle[]) {
  const period = 14;
  const slice = candles.slice(-period);

  const high = Math.max(...slice.map(c => c.high));
  const low = Math.min(...slice.map(c => c.low));
  const close = slice[slice.length - 1].close;

  if (high === low) return 50;

  return ((close - low) / (high - low)) * 100;
}

/* -------------------------
   CORE STRATEGY
-------------------------- */

export function generateSignal(
  symbol: Symbol,
  candles15m: Candle[],
  candles1h: Candle[],
  price: number
): Signal {
  const closes = candles15m.map(c => c.close);

  const ema21_now = ema(closes.slice(-21), 21);
  const ema21_prev = ema(closes.slice(-22, -1), 21);

  const emaSlope = ema21_now - ema21_prev;

  const rsiVal = rsi(closes);
  const stochVal = stoch(candles15m);
  const atrVal = atr(candles15m);

  /* -------------------------
     STATE LOGIC (REAL)
  -------------------------- */

  const bullishTrend = emaSlope > 0;
  const bearishTrend = emaSlope < 0;

  const oversold = stochVal < 30 && rsiVal > 50;
  const overbought = stochVal > 70 && rsiVal < 50;

  let state: SignalState = "WAIT";

  if (oversold || (bullishTrend && stochVal < 40)) {
    state = "EARLY";
  }

  if (bullishTrend && stochVal > 55 && rsiVal > 55) {
    state = "SNIPER";
  }

  if (bearishTrend && stochVal < 45 && rsiVal < 45) {
    state = "SNIPER";
  }

  /* -------------------------
     BIAS
  -------------------------- */

  const bias: Signal["bias"] =
    bullishTrend ? "LONG" : bearishTrend ? "SHORT" : "NEUTRAL";

  /* -------------------------
     CONFIDENCE
  -------------------------- */

  let confidence =
    state === "SNIPER"
      ? 70 + Math.min(25, Math.abs(emaSlope) * 100)
      : state === "EARLY"
      ? 55 + Math.min(20, Math.abs(emaSlope) * 80)
      : 20;

  confidence = Math.min(95, Math.max(10, confidence));

  /* -------------------------
     EXPECTED MOVE (3–5%)
  -------------------------- */

  const volatilityFactor = atrVal / price;

  const expectedMove =
    state === "SNIPER"
      ? Math.min(0.05, Math.max(0.03, volatilityFactor * 3))
      : state === "EARLY"
      ? Math.min(0.04, Math.max(0.02, volatilityFactor * 2.2))
      : 0.01;

  /* -------------------------
     SL / TP (REAL VOLATILITY BASED)
  -------------------------- */

  let stopLoss: number | null = null;
  let takeProfit: number | null = null;
  let rr: number | null = null;

  if (state !== "WAIT") {
    const slMult = state === "SNIPER" ? 1.2 : 1.6;

    if (bias === "LONG") {
      stopLoss = price - atrVal * slMult;
      takeProfit = price + price * expectedMove;
    }

    if (bias === "SHORT") {
      stopLoss = price + atrVal * slMult;
      takeProfit = price - price * expectedMove;
    }

    if (bias === "NEUTRAL") {
      stopLoss = price - atrVal;
      takeProfit = price + price * expectedMove;
    }

    rr =
      stopLoss && takeProfit
        ? Math.abs((takeProfit - price) / (price - stopLoss))
        : null;
  }

  /* -------------------------
     ADX (proxy, no NaN)
  -------------------------- */

  const adx = Math.min(60, Math.abs(emaSlope) * 5000 + 20);

  return {
    symbol,
    price,

    state,
    bias,
    confidence,

    adx,
    stoch: stochVal,
    rsi: rsiVal,

    reason:
      state === "SNIPER"
        ? "BREAKOUT CONFIRMED"
        : state === "EARLY"
        ? "EARLY COMPRESSION SETUP"
        : "NO STRUCTURE",

    stopLoss,
    takeProfit,
    rr,

    expectedMove,

    updatedAt: new Date().toISOString(),
  };
}
