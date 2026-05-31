export type Symbol = "BTC" | "ETH" | "SOL";

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

  isSetupValid: boolean;
  isSniperCandidate: boolean;
  isSniper: boolean;

  setupId: string;

  bias: "Bullish" | "Bearish" | "Neutral";

  confidence: number;

  adx: number;
  stochK: number;
  stochD: number;

  reason: string;

  stopLoss: number | null;
  takeProfit: number | null;
  riskRewardRatio: number | null;

  updatedAt: string;
}

/* =========================
   ADX
========================= */

function calculateADX(candles: Candle[], period = 14) {
  if (candles.length < period + 1) return { adx: 0 };

  let plusDM = 0,
    minusDM = 0,
    tr = 0;

  for (let i = candles.length - period; i < candles.length; i++) {
    const curr = candles[i];
    const prev = candles[i - 1];

    const up = curr.high - prev.high;
    const down = prev.low - curr.low;

    if (up > down && up > 0) plusDM += up;
    if (down > up && down > 0) minusDM += down;

    const tr1 = curr.high - curr.low;
    const tr2 = Math.abs(curr.high - prev.close);
    const tr3 = Math.abs(curr.low - prev.close);

    tr += Math.max(tr1, tr2, tr3);
  }

  const plusDI = (plusDM / tr) * 100;
  const minusDI = (minusDM / tr) * 100;

  const dx =
    Math.abs(plusDI - minusDI) / (plusDI + minusDI || 1);

  return { adx: dx * 100 };
}

/* =========================
   STOCH
========================= */

function calculateStoch(candles: Candle[]) {
  const period = 14;
  const slice = candles.slice(-period);

  const low = Math.min(...slice.map((c) => c.low));
  const high = Math.max(...slice.map((c) => c.high));
  const close = candles[candles.length - 1].close;

  const k = ((close - low) / (high - low || 1)) * 100;

  return { K: k, D: k };
}

/* =========================
   4H BIAS
========================= */

function calculate4HBias(candles: Candle[]) {
  if (candles.length < 10) return "Neutral";

  const last = candles.slice(-5);

  const hh = last[4].high > last[3].high;
  const hl = last[4].low > last[3].low;

  const lh = last[4].high < last[3].high;
  const ll = last[4].low < last[3].low;

  if (hh && hl) return "Bullish";
  if (lh && ll) return "Bearish";

  return "Neutral";
}

/* =========================
   1H CONFIRMATION
========================= */

function calculate1HConfirmation(candles: Candle[], adx: number) {
  if (adx < 15) return "Neutral";

  const last = candles.slice(-5);

  const bullish =
    last[4].close > last[3].close &&
    last[4].low > last[3].low;

  const bearish =
    last[4].close < last[3].close &&
    last[4].high < last[3].high;

  if (bullish) return "Bullish";
  if (bearish) return "Bearish";

  return "Neutral";
}

/* =========================
   MAIN SIGNAL
========================= */

export function generateSignal(
  symbol: Symbol,
  candles4H: Candle[],
  candles1H: Candle[],
  candles15M: Candle[],
  livePrice: number
): Signal {
  const c4 = [...candles4H].reverse();
  const c1 = [...candles1H].reverse();
  const c15 = [...candles15M].reverse();

  const bias4H = calculate4HBias(c4);

  const adx = calculateADX(c15).adx;
  const stoch = calculateStoch(c15);

  const confirmation1H = calculate1HConfirmation(c1, adx);

  const isSetupValid =
    (bias4H === "Bullish" && confirmation1H === "Bullish") ||
    (bias4H === "Bearish" && confirmation1H === "Bearish");

  const isBull = bias4H === "Bullish";
  const isBear = bias4H === "Bearish";

  const trigger =
    stoch.K < 30 || stoch.K > 70;

  const isSniperCandidate = isSetupValid && trigger;

  const isSniper = isSniperCandidate;

  const setupId = `${symbol}-${bias4H}-${confirmation1H}`;

  let stopLoss = null;
  let takeProfit = null;
  let rrr = null;

  if (isSniper) {
    const atr =
      c15.reduce((sum, c, i) => {
        if (i === 0) return 0;
        return sum + Math.abs(c.high - c.low);
      }, 0) / c15.length;

    const risk = atr * 1.5;

    if (isBull) {
      stopLoss = livePrice - risk;
      takeProfit = livePrice + risk * 2;
      rrr = 2;
    }

    if (isBear) {
      stopLoss = livePrice + risk;
      takeProfit = livePrice - risk * 2;
      rrr = 2;
    }
  }

  return {
    symbol,
    price: livePrice,

    isSetupValid,
    isSniperCandidate,
    isSniper,

    setupId,

    bias: bias4H,

    confidence: isSetupValid ? 70 : 30,

    adx,
    stochK: stoch.K,
    stochD: stoch.D,

    reason: isSniper
      ? "SNIPER"
      : isSetupValid
      ? "SETUP"
      : "WAIT",

    stopLoss,
    takeProfit,
    riskRewardRatio: rrr,

    updatedAt: new Date().toISOString(),
  };
}
