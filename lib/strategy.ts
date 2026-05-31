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

  isEarly: boolean;
  isSniper: boolean;
  isActive: boolean;

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
   INDICATORS
========================= */

function calculateADX(candles: Candle[], period = 14) {
  if (candles.length < period + 2) return 0;

  let plusDM = 0;
  let minusDM = 0;
  let tr = 0;

  for (let i = candles.length - period; i < candles.length; i++) {
    const curr = candles[i];
    const prev = candles[i - 1];

    const upMove = curr.high - prev.high;
    const downMove = prev.low - curr.low;

    if (upMove > downMove && upMove > 0) plusDM += upMove;
    if (downMove > upMove && downMove > 0) minusDM += downMove;

    const tr1 = curr.high - curr.low;
    const tr2 = Math.abs(curr.high - prev.close);
    const tr3 = Math.abs(curr.low - prev.close);

    tr += Math.max(tr1, tr2, tr3);
  }

  const plusDI = (plusDM / (tr || 1)) * 100;
  const minusDI = (minusDM / (tr || 1)) * 100;

  const dx =
    Math.abs(plusDI - minusDI) / ((plusDI + minusDI) || 1);

  return dx * 100;
}

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
   STRUCTURE ENGINE (IMPORTANT FIX)
========================= */

function getStructureLevels(candles: Candle[]) {
  const slice = candles.slice(-20);

  const swingHigh = Math.max(...slice.map((c) => c.high));
  const swingLow = Math.min(...slice.map((c) => c.low));

  return { swingHigh, swingLow };
}

function detectStructure(candles: Candle[]) {
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
   ENTRY LOGIC
========================= */

function isEarlySignal(adx: number, stochK: number) {
  return adx > 10 && adx < 55 && stochK > 30 && stochK < 70;
}

function isSniperEntry(structure: string, stochK: number) {
  const breakoutUp = structure === "Bullish" && stochK > 55;
  const breakoutDown = structure === "Bearish" && stochK < 45;

  return breakoutUp || breakoutDown;
}

/* =========================
   RISK ENGINE (FIXED PROPERLY)
========================= */

function calculateRisk(
  bias: "Bullish" | "Bearish" | "Neutral",
  livePrice: number,
  swingHigh: number,
  swingLow: number
) {
  const buffer = livePrice * 0.0015; // 0.15% buffer

  let stopLoss = null;
  let takeProfit = null;

  if (bias === "Bullish") {
    stopLoss = swingLow - buffer;
    const risk = livePrice - stopLoss;
    takeProfit = livePrice + risk * 2;
    return { stopLoss, takeProfit, rrr: 2 };
  }

  if (bias === "Bearish") {
    stopLoss = swingHigh + buffer;
    const risk = stopLoss - livePrice;
    takeProfit = livePrice - risk * 2;
    return { stopLoss, takeProfit, rrr: 2 };
  }

  return { stopLoss: null, takeProfit: null, rrr: null };
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
  const c4 = [...candles4H].reverse();
  const c15 = [...candles15M].reverse();

  const structure = detectStructure(c4);

  const adx = calculateADX(c15);
  const stoch = calculateStoch(c15);

  const early = isEarlySignal(adx, stoch.K);
  const sniper = isSniperEntry(structure, stoch.K);

  const bias: Signal["bias"] =
    structure === "Bullish"
      ? "Bullish"
      : structure === "Bearish"
      ? "Bearish"
      : "Neutral";

  const confidence = sniper ? 85 : early ? 55 : 20;

  const { swingHigh, swingLow } = getStructureLevels(c15);

  let stopLoss = null;
  let takeProfit = null;
  let rrr = null;

  if (sniper) {
    const risk = calculateRisk(
      bias,
      livePrice,
      swingHigh,
      swingLow
    );

    stopLoss = risk.stopLoss;
    takeProfit = risk.takeProfit;
    rrr = risk.rrr;
  }

  return {
    symbol,
    price: livePrice,

    isEarly: early,
    isSniper: sniper,
    isActive: early || sniper,

    setupId: `${symbol}-${structure}-${stoch.K.toFixed(0)}`,

    bias,

    confidence,

    adx,
    stochK: stoch.K,
    stochD: stoch.D,

    reason: sniper
      ? "SNIPER BREAKOUT"
      : early
      ? "EARLY COMPRESSION"
      : "WAIT",

    stopLoss,
    takeProfit,
    riskRewardRatio: rrr,

    updatedAt: new Date().toISOString(),
  };
}
