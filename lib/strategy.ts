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

  const plusDI = (plusDM / (tr || 1)) * 100;
  const minusDI = (minusDM / (tr || 1)) * 100;

  const dx =
    Math.abs(plusDI - minusDI) / ((plusDI + minusDI) || 1);

  return { adx: dx * 100 };
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
   STRUCTURE
========================= */

function detectStructure(candles: Candle[]) {
  const last = candles.slice(-10);

  const highs = last.map(c => c.high);
  const lows = last.map(c => c.low);

  const hh = highs[4] > highs[2] && highs[2] > highs[0];
  const hl = lows[4] > lows[2] && lows[2] > lows[0];

  const lh = highs[4] < highs[2] && highs[2] < highs[0];
  const ll = lows[4] < lows[2] && lows[2] < lows[0];

  if (hh && hl) return "Bullish";
  if (lh && ll) return "Bearish";

  return "Neutral";
}

/* =========================
   REGIME FILTER (NEW CORE FIX)
========================= */

function isValidMarket(adx: number) {
  return adx > 15 && adx < 60;
}

/* =========================
   EARLY
========================= */

function isEarlySignal(adx: number, stochK: number) {
  return adx > 10 && adx < 60 && stochK > 25 && stochK < 75;
}

/* =========================
   SNIPER (FIXED)
========================= */

function isSniperEntry(structure: string, stochK: number, adx: number) {
  if (!isValidMarket(adx)) return false;

  const breakoutUp =
    structure === "Bullish" && stochK > 55;

  const breakoutDown =
    structure === "Bearish" && stochK < 45;

  return breakoutUp || breakoutDown;
}

/* =========================
   MAIN
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

  const adx = calculateADX(c15).adx;
  const stoch = calculateStoch(c15);

  const early = isEarlySignal(adx, stoch.K);
  const sniper = isSniperEntry(structure, stoch.K, adx);

  const bias =
    structure === "Bullish"
      ? "Bullish"
      : structure === "Bearish"
      ? "Bearish"
      : "Neutral";

  const confidence = sniper ? 90 : early ? 55 : 20;

  let stopLoss: number | null = null;
  let takeProfit: number | null = null;
  let rrr: number | null = null;

  if (sniper) {
    const atr =
      c15.reduce((sum, c) => sum + Math.abs(c.high - c.low), 0) / c15.length;

    const risk = atr * 2.5;

    stopLoss =
      bias === "Bullish"
        ? livePrice - risk
        : livePrice + risk;

    takeProfit =
      bias === "Bullish"
        ? livePrice + risk * 3
        : livePrice - risk * 3;

    rrr = 3;
  }

  return {
    symbol,
    price: livePrice,

    isEarly: early,
    isSniper: sniper,
    isActive: early || sniper,

    setupId: `${symbol}-${structure}-${Math.floor(stoch.K)}`,

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
