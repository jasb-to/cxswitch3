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
  isSetup: boolean;
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
  if (candles.length < period + 1) return 0;

  let plusDM = 0;
  let minusDM = 0;
  let tr = 0;

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
   STOCH
========================= */

function calculateStoch(candles: Candle[]) {
  const slice = candles.slice(-14);

  const low = Math.min(...slice.map(c => c.low));
  const high = Math.max(...slice.map(c => c.high));
  const close = candles[candles.length - 1].close;

  const k = ((close - low) / (high - low || 1)) * 100;

  return { k, d: k };
}

/* =========================
   STRUCTURE
========================= */

function detectStructure(candles: Candle[]) {
  const last = candles.slice(-5);

  const highs = last.map(c => c.high);
  const lows = last.map(c => c.low);

  if (highs[4] > highs[3] && lows[4] > lows[3]) return "Bullish";
  if (highs[4] < highs[3] && lows[4] < lows[3]) return "Bearish";

  return "Neutral";
}

/* =========================
   STATE MACHINE (FIXED)
========================= */

function getStates(adx: number, stochK: number) {
  const isEarly = adx > 10 && adx < 30;

  const isSetup =
    adx >= 25 &&
    adx <= 45 &&
    stochK > 20 &&
    stochK < 80;

  const isSniper =
    isSetup &&
    (stochK > 60 || stochK < 40);

  return { isEarly, isSetup, isSniper };
}

/* =========================
   MAIN ENGINE
========================= */

export function generateSignal(
  symbol: Symbol,
  candles: Candle[],
  livePrice: number
): Signal {
  const c = [...candles].reverse();

  const structure = detectStructure(c);

  const adx = calculateADX(c);
  const stoch = calculateStoch(c);

  const { isEarly, isSetup, isSniper } = getStates(adx, stoch.k);

  const bias =
    structure === "Bullish"
      ? "Bullish"
      : structure === "Bearish"
      ? "Bearish"
      : "Neutral";

  const confidence = isSniper ? 85 : isSetup ? 65 : isEarly ? 45 : 20;

  let stopLoss = null;
  let takeProfit = null;
  let rrr = null;

  /* =========================
     STRUCTURE-BASED RISK MODEL
  ========================= */

  if (isSniper) {
    const lastHigh = Math.max(...c.slice(-10).map(x => x.high));
    const lastLow = Math.min(...c.slice(-10).map(x => x.low));

    const buffer = (lastHigh - lastLow) * 0.1;

    if (bias === "Bullish") {
      stopLoss = lastLow - buffer;
      takeProfit = livePrice + (livePrice - stopLoss) * 2;
    }

    if (bias === "Bearish") {
      stopLoss = lastHigh + buffer;
      takeProfit = livePrice - (stopLoss - livePrice) * 2;
    }

    rrr = 2;
  }

  return {
    symbol,
    price: livePrice,

    isEarly,
    isSetup,
    isSniper,

    setupId: `${symbol}-${structure}-${stoch.k.toFixed(0)}`,

    bias,

    confidence,

    adx,
    stochK: stoch.k,
    stochD: stoch.d,

    reason: isSniper
      ? "SNIPER BREAKOUT"
      : isSetup
      ? "SETUP ACTIVE"
      : isEarly
      ? "EARLY COMPRESSION"
      : "WAIT",

    stopLoss,
    takeProfit,
    riskRewardRatio: rrr,

    updatedAt: new Date().toISOString(),
  };
}
