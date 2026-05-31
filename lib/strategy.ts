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

  // State machine
  isEarly: boolean;        // compression / structure forming
  isSniper: boolean;       // actual entry trigger (breakout)
  isActive: boolean;       // either early or sniper

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
   ADX (trend strength)
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

  const dx = Math.abs(plusDI - minusDI) / ((plusDI + minusDI) || 1);

  return { adx: dx * 100 };
}

/* =========================
   STOCH (momentum pressure)
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
   STRUCTURE DETECTION
   (HL / LL compression logic)
========================= */

function detectStructure(candles: Candle[]) {
  const last = candles.slice(-5);

  const highs = last.map((c) => c.high);
  const lows = last.map((c) => c.low);

  const higherHighs = highs[4] > highs[3];
  const higherLows = lows[4] > lows[3];

  const lowerHighs = highs[4] < highs[3];
  const lowerLows = lows[4] < lows[3];

  if (higherHighs && higherLows) return "Bullish";
  if (lowerHighs && lowerLows) return "Bearish";

  return "Neutral";
}

/* =========================
   EARLY SIGNAL (compression phase)
========================= */

function isEarlySignal(adx: number, stochK: number) {
  // early = market compressing / preparing move
  return adx > 15 && adx < 35 && (stochK < 60 && stochK > 40);
}

/* =========================
   SNIPER ENTRY (breakout trigger)
========================= */

function isSniperEntry(structure: string, stochK: number) {
  const breakoutUp = structure === "Bullish" && stochK > 60;
  const breakoutDown = structure === "Bearish" && stochK < 40;

  return breakoutUp || breakoutDown;
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
  const c15 = [...candles15M].reverse();

  const structure = detectStructure(c4);

  const adx = calculateADX(c15).adx;
  const stoch = calculateStoch(c15);

  const early = isEarlySignal(adx, stoch.K);
  const sniper = isSniperEntry(structure, stoch.K);

  const bias =
    structure === "Bullish"
      ? "Bullish"
      : structure === "Bearish"
      ? "Bearish"
      : "Neutral";

  const confidence =
    sniper ? 80 : early ? 50 : 20;

  let stopLoss = null;
  let takeProfit = null;
  let rrr = null;

  if (sniper) {
    const atr =
      c15.reduce((sum, c, i) => {
        if (i === 0) return 0;
        return sum + Math.abs(c.high - c.low);
      }, 0) / c15.length;

    const risk = atr * 1.5;

    if (bias === "Bullish") {
      stopLoss = livePrice - risk;
      takeProfit = livePrice + risk * 2;
    }

    if (bias === "Bearish") {
      stopLoss = livePrice + risk;
      takeProfit = livePrice - risk * 2;
    }

    rrr = 2;
  }

  return {
    symbol,
    price: livePrice,

    isEarly: early,
    isSniper: sniper,
    isActive: early || sniper,

    setupId: `${symbol}-${structure}`,

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
