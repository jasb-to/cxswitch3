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
   INDICATORS
========================= */

function calculateADX(candles: Candle[], period: number = 14): { adx: number } {
  if (candles.length < period + 1) return { adx: 0 };

  let plusDM = 0, minusDM = 0, trueRange = 0;

  for (let i = Math.max(1, candles.length - period); i < candles.length; i++) {
    const curr = candles[i];
    const prev = candles[i - 1];

    const upMove = curr.high - prev.high;
    const downMove = prev.low - curr.low;

    if (upMove > 0 && upMove > downMove) plusDM += upMove;
    if (downMove > 0 && downMove > upMove) minusDM += downMove;

    const tr = Math.max(
      curr.high - curr.low,
      Math.abs(curr.high - prev.close),
      Math.abs(curr.low - prev.close)
    );

    trueRange += tr;
  }

  const avgTR = trueRange / period;
  const plusDI = (plusDM / avgTR) * 100;
  const minusDI = (minusDM / avgTR) * 100;

  const di = Math.abs(plusDI - minusDI) / (plusDI + minusDI);
  const adx = Math.round(di * 1000) / 10;

  return { adx };
}

function calculateATR(candles: Candle[], period: number = 14): number {
  if (candles.length < period + 1) return 0;

  let trSum = 0;

  for (let i = Math.max(1, candles.length - period); i < candles.length; i++) {
    const curr = candles[i];
    const prev = candles[i - 1];

    const tr = Math.max(
      curr.high - curr.low,
      Math.abs(curr.high - prev.close),
      Math.abs(curr.low - prev.close)
    );

    trSum += tr;
  }

  return trSum / period;
}

function calculateStoch(candles: Candle[], period: number = 14) {
  if (candles.length < period) {
    return { K: 50, D: 50, kCrossAboveD: false, kCrossBelowD: false };
  }

  const slice = candles.slice(-period);
  const low = Math.min(...slice.map(c => c.low));
  const high = Math.max(...slice.map(c => c.high));

  const close = candles[candles.length - 1].close;

  const K =
    high === low ? 50 : ((close - low) / (high - low)) * 100;

  const prevClose = candles[candles.length - 2]?.close ?? close;
  const prevK =
    high === low ? 50 : ((prevClose - low) / (high - low)) * 100;

  const D = K; // simplified smoothing (kept stable intentionally)

  const kCrossAboveD = prevK <= D && K > D;
  const kCrossBelowD = prevK >= D && K < D;

  return {
    K: Math.round(K * 10) / 10,
    D: Math.round(D * 10) / 10,
    kCrossAboveD,
    kCrossBelowD
  };
}

/* =========================
   STRUCTURE
========================= */

function calculate4HBias(candles: Candle[]): "Bullish" | "Bearish" | "Neutral" {
  if (candles.length < 10) return "Neutral";

  const last = candles.slice(-5);

  const highs = last.map(c => c.high);
  const lows = last.map(c => c.low);

  const hh = highs[4] > highs[3] && highs[3] > highs[2];
  const hl = lows[4] > lows[3] && lows[3] > lows[2];

  const lh = highs[4] < highs[3] && highs[3] < highs[2];
  const ll = lows[4] < lows[3] && lows[3] < lows[2];

  const sma = candles.slice(-20).reduce((s, c) => s + c.close, 0) / 20;
  const price = candles[candles.length - 1].close;

  if ((hh && hl) || price > sma) return "Bullish";
  if ((lh && ll) || price < sma) return "Bearish";

  return "Neutral";
}

function calculate1HConfirmation(
  candles: Candle[],
  adx: number
): "Bullish" | "Bearish" | "Neutral" {
  if (adx < 18 || candles.length < 5) return "Neutral";

  const last = candles.slice(-5);

  const highs = last.map(c => c.high);
  const lows = last.map(c => c.low);

  const bullish = highs[4] > highs[3] && lows[4] > lows[3];
  const bearish = highs[4] < highs[3] && lows[4] < lows[3];

  const rising = candles[candles.length - 1].close > candles[candles.length - 2].close;
  const falling = candles[candles.length - 1].close < candles[candles.length - 2].close;

  if (bullish && rising) return "Bullish";
  if (bearish && falling) return "Bearish";

  return "Neutral";
}

/* =========================
   MAIN ENGINE
========================= */

export function generateSignal(
  symbol: Symbol,
  candles4H: Candle[],
  candles1H: Candle[],
  candles15M: Candle[],
  livePrice: number
): Signal {

  const c4H = candles4H.slice().reverse();
  const c1H = candles1H.slice().reverse();
  const c15M = candles15M.slice().reverse();

  if (c4H.length < 5 || c1H.length < 5 || c15M.length < 14) {
    return {
      symbol,
      price: 0,
      isSetupValid: false,
      isSniperCandidate: false,
      isSniper: false,
      bias: "Neutral",
      confidence: 0,
      adx: 0,
      stochK: 0,
      stochD: 0,
      reason: "Insufficient data",
      stopLoss: null,
      takeProfit: null,
      riskRewardRatio: null,
      updatedAt: new Date().toISOString(),
    };
  }

  const price = livePrice;

  const { adx } = calculateADX(c15M);
  const stoch = calculateStoch(c15M);

  const bias4H = calculate4HBias(c4H);
  const bias1H = calculate1HConfirmation(c1H, adx);

  /* =========================
     SETUP (structure only)
  ========================= */

  const isSetupValid =
    (bias4H === "Bullish" && bias1H === "Bullish") ||
    (bias4H === "Bearish" && bias1H === "Bearish");

  const isBullishSetup = bias4H === "Bullish" && bias1H === "Bullish";
  const isBearishSetup = bias4H === "Bearish" && bias1H === "Bearish";

  /* =========================
     TRIGGER (EVENT ONLY)
  ========================= */

  const isSniperCandidate =
    (isBullishSetup && stoch.kCrossAboveD) ||
    (isBearishSetup && stoch.kCrossBelowD);

  /* =========================
     EXECUTION GATE
  ========================= */

  const isSniper = isSetupValid && isSniperCandidate;

  /* =========================
     CONFIDENCE
  ========================= */

  let confidence = 0;
  if (bias4H !== "Neutral") confidence += 30;
  if (bias1H !== "Neutral") confidence += 30;
  if (isSniperCandidate) confidence += 20;
  if (adx >= 20) confidence += 20;

  /* =========================
     RISK (only on trigger)
  ========================= */

  let stopLoss: number | null = null;
  let takeProfit: number | null = null;
  let riskRewardRatio: number | null = null;

  if (isSniper) {
    const atr = calculateATR(c15M, 14);
    const dist = Math.max(atr * 1.5, price * 0.008);

    if (bias4H === "Bullish") {
      stopLoss = price - dist;
      takeProfit = price + dist;
    } else {
      stopLoss = price + dist;
      takeProfit = price - dist;
    }

    riskRewardRatio = 1;
  }

  /* =========================
     OUTPUT
  ========================= */

  return {
    symbol,
    price,
    isSetupValid,
    isSniperCandidate,
    isSniper,
    bias: bias4H,
    confidence,
    adx,
    stochK: stoch.K,
    stochD: stoch.D,
    reason: isSniper
      ? `SNIPER ${bias4H}`
      : isSetupValid
        ? "Setup valid - waiting trigger"
        : "Monitoring",
    stopLoss,
    takeProfit,
    riskRewardRatio,
    updatedAt: new Date().toISOString(),
  };
}
