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
   CORE IDEA SHIFT
   We detect EARLY MOVE IGNITION:
   - Compression (low ADX)
   - Expansion starting (range break)
   - Stoch turning from extreme
========================= */

/* =========================
   ADX (simplified but stable)
========================= */

function calculateADX(candles: Candle[], period = 14) {
  if (candles.length < period + 2) return 0;

  let trSum = 0;
  let dmPlus = 0;
  let dmMinus = 0;

  for (let i = candles.length - period; i < candles.length; i++) {
    const curr = candles[i];
    const prev = candles[i - 1];

    const upMove = curr.high - prev.high;
    const downMove = prev.low - curr.low;

    if (upMove > downMove && upMove > 0) dmPlus += upMove;
    if (downMove > upMove && downMove > 0) dmMinus += downMove;

    const tr = Math.max(
      curr.high - curr.low,
      Math.abs(curr.high - prev.close),
      Math.abs(curr.low - prev.close)
    );

    trSum += tr;
  }

  const diPlus = (dmPlus / (trSum || 1)) * 100;
  const diMinus = (dmMinus / (trSum || 1)) * 100;

  const dx =
    Math.abs(diPlus - diMinus) / ((diPlus + diMinus) || 1);

  return dx * 100;
}

/* =========================
   STOCHASTIC (fast + responsive)
========================= */

function calculateStoch(candles: Candle[]) {
  const period = 14;
  const slice = candles.slice(-period);

  const low = Math.min(...slice.map(c => c.low));
  const high = Math.max(...slice.map(c => c.high));
  const close = candles[candles.length - 1].close;

  const k = ((close - low) / (high - low || 1)) * 100;

  return { K: k, D: k };
}

/* =========================
   STRUCTURE BIAS (EARLY SHIFT DETECTION)
========================= */

function calculateBias(candles: Candle[]) {
  if (candles.length < 10) return "Neutral";

  const recent = candles.slice(-5);

  const higherHigh = recent[4].high > recent[2].high;
  const higherLow = recent[4].low > recent[2].low;

  const lowerHigh = recent[4].high < recent[2].high;
  const lowerLow = recent[4].low < recent[2].low;

  if (higherHigh && higherLow) return "Bullish";
  if (lowerHigh && lowerLow) return "Bearish";

  return "Neutral";
}

/* =========================
   EARLY ENTRY DETECTOR (KEY CHANGE)
========================= */

function detectEarlyEntry(
  stochK: number,
  adx: number,
  candles: Candle[]
) {
  const last = candles.slice(-3);

  const range = Math.max(...last.map(c => c.high)) -
                Math.min(...last.map(c => c.low));

  const avgRange =
    candles.slice(-20).reduce((sum, c) => sum + (c.high - c.low), 0) / 20;

  const isCompression = adx < 20 && range < avgRange * 0.7;

  const isExpansion =
    range > avgRange * 1.1;

  const stochFromLow = stochK < 35;
  const stochFromHigh = stochK > 65;

  return {
    isCompression,
    isExpansion,
    stochFromLow,
    stochFromHigh
  };
}

/* =========================
   MAIN SIGNAL ENGINE
========================= */

export function generateSignal(
  symbol: Symbol,
  candles4H: Candle[],
  candles1H: Candle[],
  candles15M: Candle[],
  livePrice: number
): Signal {

  const c15 = [...candles15M].reverse();
  const c1 = [...candles1H].reverse();

  const bias = calculateBias(c1);
  const adx = calculateADX(c15);
  const stoch = calculateStoch(c15);

  const early = detectEarlyEntry(stoch.K, adx, c15);

  /* =========================
     EARLY ENTRY LOGIC (NEW CORE)
  ========================= */

  const isSetupValid =
    early.isCompression &&
    bias !== "Neutral";

  const isSniperCandidate =
    isSetupValid &&
    early.isExpansion;

  const isSniper =
    isSniperCandidate &&
    (early.stochFromLow || early.stochFromHigh);

  const setupId = `${symbol}-${bias}-${early.isCompression ? "COMP" : "NO_COMP"}`;

  /* =========================
     RISK MODEL (EARLY MOVE BASED)
  ========================= */

  let stopLoss = null;
  let takeProfit = null;
  let rrr = null;

  if (isSniper) {
    const atr =
      c15.reduce((sum, c, i) => {
        if (i === 0) return sum;
        return sum + Math.abs(c.high - c.low);
      }, 0) / c15.length;

    const risk = atr * 1.2;

    if (bias === "Bullish") {
      stopLoss = livePrice - risk;
      takeProfit = livePrice + risk * 2.5;
    }

    if (bias === "Bearish") {
      stopLoss = livePrice + risk;
      takeProfit = livePrice - risk * 2.5;
    }

    rrr = 2.5;
  }

  /* =========================
     CONFIDENCE (EARLY EDGE WEIGHTED)
  ========================= */

  const confidence =
    isSniper ? 85 :
    isSniperCandidate ? 70 :
    isSetupValid ? 55 :
    25;

  return {
    symbol,
    price: livePrice,

    isSetupValid,
    isSniperCandidate,
    isSniper,

    setupId,

    bias,

    confidence,

    adx,
    stochK: stoch.K,
    stochD: stoch.D,

    reason: isSniper
      ? "EARLY SNIPER ENTRY"
      : isSniperCandidate
      ? "BREAKOUT BUILDING"
      : isSetupValid
      ? "COMPRESSION ZONE"
      : "NO EDGE",

    stopLoss,
    takeProfit,
    riskRewardRatio: rrr,

    updatedAt: new Date().toISOString(),
  };
}
