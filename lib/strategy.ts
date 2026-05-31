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

  const plusDI = (plusDM / (tr || 1)) * 100;
  const minusDI = (minusDM / (tr || 1)) * 100;

  const dx =
    Math.abs(plusDI - minusDI) / ((plusDI + minusDI) || 1);

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
   STRUCTURE
========================= */

function detectStructure(candles: Candle[]) {
  const last = candles.slice(-5);

  const highs = last.map((c) => c.high);
  const lows = last.map((c) => c.low);

  const hh = highs[4] > highs[3];
  const hl = lows[4] > lows[3];

  const lh = highs[4] < highs[3];
  const ll = lows[4] < lows[3];

  if (hh && hl) return "Bullish";
  if (lh && ll) return "Bearish";

  return "Neutral";
}

/* =========================
   PIVOTS
========================= */

function calculatePivots(candles: Candle[]) {
  const slice = candles.slice(-20);

  let highs: number[] = [];
  let lows: number[] = [];

  for (let i = 1; i < slice.length - 1; i++) {
    const prev = slice[i - 1];
    const curr = slice[i];
    const next = slice[i + 1];

    if (curr.high > prev.high && curr.high > next.high) {
      highs.push(curr.high);
    }

    if (curr.low < prev.low && curr.low < next.low) {
      lows.push(curr.low);
    }
  }

  return {
    resistance: highs.length ? Math.max(...highs) : null,
    support: lows.length ? Math.min(...lows) : null,
  };
}

/* =========================
   ATR (volatility engine)
========================= */

function atr(candles: Candle[]) {
  const slice = candles.slice(-14);
  let sum = 0;

  for (let i = 1; i < slice.length; i++) {
    const c = slice[i];
    const p = slice[i - 1];

    const tr = Math.max(
      c.high - c.low,
      Math.abs(c.high - p.close),
      Math.abs(c.low - p.close)
    );

    sum += tr;
  }

  return sum / slice.length;
}

/* =========================
   SIGNAL CONDITIONS
========================= */

function isEarly(adx: number, stochK: number) {
  return adx > 10 && adx < 50 && stochK > 30 && stochK < 70;
}

function isSniper(structure: string, stochK: number) {
  return (
    (structure === "Bullish" && stochK > 55) ||
    (structure === "Bearish" && stochK < 45)
  );
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

  const adx = calculateADX(c15).adx;
  const stoch = calculateStoch(c15);

  const pivots = calculatePivots(c15);
  const volatility = atr(c15);

  const early = isEarly(adx, stoch.K);
  const sniper = isSniper(structure, stoch.K);

  const bias: Signal["bias"] =
    structure === "Bullish"
      ? "Bullish"
      : structure === "Bearish"
      ? "Bearish"
      : "Neutral";

  const confidence = sniper ? 85 : early ? 55 : 20;

  let stopLoss: number | null = null;
  let takeProfit: number | null = null;
  let rrr: number | null = null;

  /* =========================
     SNIPER LOGIC (HYBRID PIVOT + ATR)
  ========================= */

  if (sniper) {
    const risk = volatility * 1.2;

    const pivotRes = pivots.resistance;
    const pivotSup = pivots.support;

    if (bias === "Bullish") {
      stopLoss = livePrice - risk;

      takeProfit =
        pivotRes && pivotRes > livePrice
          ? pivotRes
          : livePrice + risk * 1.8;

      rrr =
        (takeProfit - livePrice) / (livePrice - stopLoss);
    }

    if (bias === "Bearish") {
      stopLoss = livePrice + risk;

      takeProfit =
        pivotSup && pivotSup < livePrice
          ? pivotSup
          : livePrice - risk * 1.8;

      rrr =
        (livePrice - takeProfit) / (stopLoss - livePrice);
    }
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
