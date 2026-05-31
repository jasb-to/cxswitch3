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
   TREND STRUCTURE ENGINE
   (HL / LH / compression core)
========================= */

function detectStructure(candles: Candle[]) {
  if (candles.length < 20) {
    return { bias: "Neutral" as const, compression: false };
  }

  const recent = candles.slice(-20);

  let higherHighs = 0;
  let higherLows = 0;
  let lowerHighs = 0;
  let lowerLows = 0;

  for (let i = 1; i < recent.length; i++) {
    const prev = recent[i - 1];
    const curr = recent[i];

    if (curr.high > prev.high) higherHighs++;
    if (curr.low > prev.low) higherLows++;

    if (curr.high < prev.high) lowerHighs++;
    if (curr.low < prev.low) lowerLows++;
  }

  let bias: "Bullish" | "Bearish" | "Neutral" = "Neutral";

  if (higherHighs > lowerHighs && higherLows > lowerLows) {
    bias = "Bullish";
  } else if (lowerHighs > higherHighs && lowerLows > higherLows) {
    bias = "Bearish";
  }

  // compression = range tightening
  const highs = recent.map((c) => c.high);
  const lows = recent.map((c) => c.low);

  const range = Math.max(...highs) - Math.min(...lows);

  const avgBody =
    recent.reduce((sum, c) => sum + Math.abs(c.close - c.open), 0) /
    recent.length;

  const compression = range < avgBody * 12;

  return { bias, compression };
}

/* =========================
   ADX (trend strength)
========================= */

function calculateADX(candles: Candle[], period = 14) {
  if (candles.length < period + 1) return 0;

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

  const plusDI = (plusDM / (tr || 1)) * 100;
  const minusDI = (minusDM / (tr || 1)) * 100;

  const dx = Math.abs(plusDI - minusDI) / ((plusDI + minusDI) || 1);

  return dx * 100;
}

/* =========================
   STOCHASTIC (entry timing)
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
   MAIN SIGNAL ENGINE
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

  const structure = detectStructure(c4);

  const adx = calculateADX(c15);
  const stoch = calculateStoch(c15);

  const isTrending = adx > 15;

  /* =========================
     SETUP LOGIC (EARLY FILTER)
  ========================= */

  const isSetupValid =
    structure.bias !== "Neutral" &&
    isTrending &&
    structure.compression;

  /* =========================
     SNIPER TRIGGER
  ========================= */

  const breakoutTrigger =
    structure.bias === "Bullish"
      ? stoch.K > 60
      : structure.bias === "Bearish"
      ? stoch.K < 40
      : false;

  const isSniperCandidate = isSetupValid && breakoutTrigger;
  const isSniper = isSniperCandidate;

  const setupId = `${symbol}-${structure.bias}`;

  /* =========================
     RISK MODEL (simple + stable)
  ========================= */

  let stopLoss = null;
  let takeProfit = null;
  let rrr = null;

  if (isSniper) {
    const risk = livePrice * 0.008;

    if (structure.bias === "Bullish") {
      stopLoss = livePrice - risk;
      takeProfit = livePrice + risk * 2;
    } else if (structure.bias === "Bearish") {
      stopLoss = livePrice + risk;
      takeProfit = livePrice - risk * 2;
    }

    rrr = 2;
  }

  /* =========================
     CONFIDENCE MODEL
  ========================= */

  let confidence = 30;

  if (structure.compression) confidence += 20;
  if (isTrending) confidence += 20;
  if (structure.bias !== "Neutral") confidence += 20;
  if (isSniper) confidence += 10;

  return {
    symbol,
    price: livePrice,

    isSetupValid,
    isSniperCandidate,
    isSniper,

    setupId,

    bias: structure.bias,

    confidence,

    adx,
    stochK: stoch.K,
    stochD: stoch.D,

    reason: isSniper
      ? "BREAKOUT SNIPER"
      : isSetupValid
      ? "COMPRESSION SETUP"
      : structure.compression
      ? "EARLY COMPRESSION"
      : "NO STRUCTURE",

    stopLoss,
    takeProfit,
    riskRewardRatio: rrr,

    updatedAt: new Date().toISOString(),
  };
}
