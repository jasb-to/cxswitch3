// strategy.ts

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
   TREND (IMPROVED ADX LOGIC)
========================= */

function calculateADX(candles: Candle[], period = 14): number {
  if (candles.length < period + 2) return 0;

  let trSum = 0;
  let plusDM = 0;
  let minusDM = 0;

  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const p = candles[i - 1];

    const upMove = c.high - p.high;
    const downMove = p.low - c.low;

    if (upMove > downMove && upMove > 0) plusDM += upMove;
    if (downMove > upMove && downMove > 0) minusDM += downMove;

    const tr = Math.max(
      c.high - c.low,
      Math.abs(c.high - p.close),
      Math.abs(c.low - p.close)
    );

    trSum += tr;
  }

  const plusDI = (plusDM / (trSum || 1)) * 100;
  const minusDI = (minusDM / (trSum || 1)) * 100;

  const dx =
    Math.abs(plusDI - minusDI) / ((plusDI + minusDI) || 1);

  return dx * 100;
}

/* =========================
   STOCH
========================= */

function calculateStoch(candles: Candle[]) {
  const slice = candles.slice(-14);

  const low = Math.min(...slice.map(c => c.low));
  const high = Math.max(...slice.map(c => c.high));
  const close = slice[slice.length - 1].close;

  const range = high - low || 1;

  const k = ((close - low) / range) * 100;

  return { k, d: k };
}

/* =========================
   STRUCTURE (IMPORTANT FIX)
========================= */

function marketStructure(candles: Candle[]) {
  const last = candles.slice(-5);

  const higherHighs =
    last[4].high > last[3].high &&
    last[3].high > last[2].high;

  const higherLows =
    last[4].low > last[3].low &&
    last[3].low > last[2].low;

  const lowerHighs =
    last[4].high < last[3].high &&
    last[3].high < last[2].high;

  const lowerLows =
    last[4].low < last[3].low &&
    last[3].low < last[2].low;

  if (higherHighs && higherLows) return "Bullish";
  if (lowerHighs && lowerLows) return "Bearish";

  return "Neutral";
}

/* =========================
   MOMENTUM PHASE ENGINE
========================= */

function momentumPhase(adx: number, stochK: number) {
  const compression = adx < 18;
  const building = adx >= 18 && adx < 25;
  const expansion = adx >= 25;

  const oversold = stochK < 30;
  const overbought = stochK > 70;

  if (compression) return "COMPRESSION";
  if (building && (oversold || overbought)) return "BUILDUP";
  if (expansion) return "EXPANSION";

  return "RANGE";
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
  const c1 = [...candles1H].reverse();
  const c15 = [...candles15M].reverse();

  const adx = calculateADX(c15);
  const stoch = calculateStoch(c15);

  const bias = marketStructure(c4);

  const phase = momentumPhase(adx, stoch.k);

  /* =========================
     STATE ENGINE (EARLY ENTRY FOCUS)
  ========================= */

  let isSetupValid = false;
  let isSniperCandidate = false;
  let isSniper = false;

  // EARLY SETUP = structure + compression/building
  if (bias !== "Neutral" && (phase === "COMPRESSION" || phase === "BUILDUP")) {
    isSetupValid = true;
  }

  // CANDIDATE = expansion starting
  if (isSetupValid && phase === "EXPANSION") {
    isSniperCandidate = true;
  }

  // ENTRY = stoch trigger aligns with expansion
  const trigger =
    (bias === "Bullish" && stoch.k < 25) ||
    (bias === "Bearish" && stoch.k > 75);

  if (isSniperCandidate && trigger) {
    isSniper = true;
  }

  /* =========================
     RISK MODEL
  ========================= */

  let stopLoss: number | null = null;
  let takeProfit: number | null = null;
  let rrr: number | null = null;

  if (isSniper) {
    const atr =
      c15.reduce((sum, c, i) => {
        if (i === 0) return sum;
        return sum + Math.abs(c.high - c.low);
      }, 0) / c15.length;

    const risk = atr * 1.2;

    if (bias === "Bullish") {
      stopLoss = livePrice - risk;
      takeProfit = livePrice + risk * 2;
    } else if (bias === "Bearish") {
      stopLoss = livePrice + risk;
      takeProfit = livePrice - risk * 2;
    }

    rrr = 2;
  }

  const confidence =
    (isSetupValid ? 30 : 0) +
    (phase === "BUILDUP" ? 20 : 0) +
    (phase === "EXPANSION" ? 30 : 0) +
    (trigger ? 20 : 0);

  return {
    symbol,
    price: livePrice,

    isSetupValid,
    isSniperCandidate,
    isSniper,

    setupId: `${symbol}-${bias}-${phase}`,

    bias,

    confidence,

    adx,
    stochK: stoch.k,
    stochD: stoch.d,

    reason: phase,

    stopLoss,
    takeProfit,
    riskRewardRatio: rrr,

    updatedAt: new Date().toISOString(),
  };
}
