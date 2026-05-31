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
   BASIC INDICATORS
========================= */

function calculateADX(candles: Candle[], period = 14) {
  if (candles.length < period + 2) return 0;

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

  const dx = Math.abs(plusDI - minusDI) / (plusDI + minusDI || 1);

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
   STRUCTURE ENGINE
========================= */

function getSwingPoints(candles: Candle[]) {
  const swings: { high: number; low: number }[] = [];

  for (let i = 2; i < candles.length - 2; i++) {
    const prev = candles[i - 1];
    const curr = candles[i];
    const next = candles[i + 1];

    // swing high
    if (curr.high > prev.high && curr.high > next.high) {
      swings.push({ high: curr.high, low: 0 });
    }

    // swing low
    if (curr.low < prev.low && curr.low < next.low) {
      swings.push({ high: 0, low: curr.low });
    }
  }

  return swings.slice(-10);
}

/* =========================
   MARKET STRUCTURE
========================= */

function detectStructure(candles: Candle[]) {
  const last = candles.slice(-20);

  let trend: "Bullish" | "Bearish" | "Neutral" = "Neutral";

  let hh = 0,
    hl = 0,
    lh = 0,
    ll = 0;

  for (let i = 1; i < last.length; i++) {
    if (last[i].high > last[i - 1].high) hh++;
    if (last[i].low > last[i - 1].low) hl++;

    if (last[i].high < last[i - 1].high) lh++;
    if (last[i].low < last[i - 1].low) ll++;
  }

  if (hh > lh && hl > ll) trend = "Bullish";
  if (lh > hh && ll > hl) trend = "Bearish";

  return { trend, hh, hl, lh, ll };
}

/* =========================
   EXHAUSTION DETECTOR
========================= */

function detectExhaustion(structure: any, adx: number, stochK: number) {
  const weakeningTrend = adx > 20 && adx < 30;

  const overbought = stochK > 70;
  const oversold = stochK < 30;

  const structureConflict =
    (structure.trend === "Bullish" && structure.lh > structure.hh) ||
    (structure.trend === "Bearish" && structure.hh > structure.lh);

  return weakeningTrend && (overbought || oversold || structureConflict);
}

/* =========================
   CONFIRMATION (short TF)
========================= */

function confirmation(candles: Candle[]) {
  const last = candles.slice(-5);

  const bullish =
    last[4].close > last[3].close && last[4].low >= last[3].low;

  const bearish =
    last[4].close < last[3].close && last[4].high <= last[3].high;

  if (bullish) return "Bullish";
  if (bearish) return "Bearish";

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
  const c4 = [...candles4H].reverse();
  const c1 = [...candles1H].reverse();
  const c15 = [...candles15M].reverse();

  const structure = detectStructure(c4);
  const adx = calculateADX(c15);
  const stoch = calculateStoch(c15);
  const conf = confirmation(c1);

  const isBull = structure.trend === "Bullish";
  const isBear = structure.trend === "Bearish";

  const exhaustion = detectExhaustion(structure, adx, stoch.K);

  /* =========================
     STATE MACHINE
  ========================= */

  let isSetupValid = false;
  let isSniperCandidate = false;
  let isSniper = false;

  let reason = "WAIT";

  /* 🟣 EARLY REVERSAL / CONTINUATION */
  if (exhaustion) {
    isSetupValid = true;
    reason = "EARLY";
  }

  /* 🟡 STRUCTURE ALIGNED SETUP */
  if (
    structure.trend !== "Neutral" &&
    conf === structure.trend
  ) {
    isSetupValid = true;
    reason = exhaustion ? "EARLY+SETUP" : "SETUP";
  }

  /* 🟢 SNIPER ENTRY */
  const trigger =
    stoch.K < 30 || stoch.K > 70;

  if (isSetupValid && trigger) {
    isSniperCandidate = true;
    isSniper = true;
    reason = "SNIPER";
  }

  /* =========================
     CONFIDENCE MODEL
  ========================= */

  let confidence = 25;

  if (reason.includes("EARLY")) confidence = 50;
  if (reason.includes("SETUP")) confidence = 70;
  if (reason === "SNIPER") confidence = 90;

  /* =========================
     RISK MODEL
  ========================= */

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
    }

    if (isBear) {
      stopLoss = livePrice + risk;
      takeProfit = livePrice - risk * 2;
    }

    rrr = 2;
  }

  return {
    symbol,
    price: livePrice,

    isSetupValid,
    isSniperCandidate,
    isSniper,

    setupId: `${symbol}-${structure.trend}`,

    bias: structure.trend,

    confidence,

    adx,
    stochK: stoch.K,
    stochD: stoch.D,

    reason,

    stopLoss,
    takeProfit,
    riskRewardRatio: rrr,

    updatedAt: new Date().toISOString(),
  };
}
