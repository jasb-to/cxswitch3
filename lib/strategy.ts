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

  stage: "EARLY" | "SETUP" | "SNIPER" | "NONE";

  bias: "Bullish" | "Bearish" | "Neutral";

  confidence: number;

  adx: number;
  stochK: number;
  stochD: number;

  compression: boolean;
  breakoutReady: boolean;

  reason: string;

  stopLoss: number | null;
  takeProfit: number | null;
  riskRewardRatio: number | null;

  updatedAt: string;
}

/* =========================
   COMPRESSION (WEDGE / SQUEEZE)
========================= */

function detectCompression(candles: Candle[]) {
  const slice = candles.slice(-20);
  if (slice.length < 20) return false;

  const highs = slice.map(c => c.high);
  const lows = slice.map(c => c.low);

  const range = Math.max(...highs) - Math.min(...lows);

  const avgPrice =
    slice.reduce((sum, c) => sum + c.close, 0) / slice.length;

  const volatility = range / avgPrice;

  // low volatility = compression
  return volatility < 0.02;
}

/* =========================
   TREND BIAS (HH / LL STRUCTURE)
========================= */

function detectBias(candles: Candle[]): "Bullish" | "Bearish" | "Neutral" {
  const last = candles.slice(-5);
  if (last.length < 5) return "Neutral";

  const up = last.every((c, i) =>
    i === 0 ? true : c.close >= last[i - 1].close
  );

  const down = last.every((c, i) =>
    i === 0 ? true : c.close <= last[i - 1].close
  );

  if (up) return "Bullish";
  if (down) return "Bearish";

  return "Neutral";
}

/* =========================
   ADX (trend strength proxy)
========================= */

function calculateADX(candles: Candle[]) {
  const slice = candles.slice(-14);
  if (slice.length < 14) return 0;

  let trSum = 0;

  for (let i = 1; i < slice.length; i++) {
    const curr = slice[i];
    const prev = slice[i - 1];

    const tr = Math.max(
      curr.high - curr.low,
      Math.abs(curr.high - prev.close),
      Math.abs(curr.low - prev.close)
    );

    trSum += tr;
  }

  return trSum / slice.length;
}

/* =========================
   STOCH (momentum positioning)
========================= */

function calculateStoch(candles: Candle[]) {
  const slice = candles.slice(-14);
  if (slice.length < 14) return { K: 50, D: 50 };

  const low = Math.min(...slice.map(c => c.low));
  const high = Math.max(...slice.map(c => c.high));
  const close = slice[slice.length - 1].close;

  const k = ((close - low) / (high - low || 1)) * 100;

  return { K: k, D: k };
}

/* =========================
   MAIN SIGNAL ENGINE (EARLY BREAKOUT FOCUS)
========================= */

export function generateSignal(
  symbol: Symbol,
  candles4H: Candle[],
  candles1H: Candle[],
  candles15M: Candle[],
  livePrice: number
): Signal {
  const c4 = [...candles4H];
  const c15 = [...candles15M];

  const bias = detectBias(c4);
  const compression = detectCompression(c15);

  const adx = calculateADX(c15);
  const stoch = calculateStoch(c15);

  const momentum = stoch.K;
  const breakoutReady =
    (compression && adx > 1.2) ||
    (momentum < 35 || momentum > 65);

  let stage: Signal["stage"] = "NONE";

  if (compression && bias !== "Neutral") {
    stage = "EARLY";
  }

  if (compression && breakoutReady) {
    stage = "SETUP";
  }

  if (!compression && breakoutReady && bias !== "Neutral") {
    stage = "SNIPER";
  }

  let stopLoss = null;
  let takeProfit = null;
  let rrr = null;

  if (stage === "SNIPER") {
    const risk = adx * 1.5;

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
    stage === "SNIPER"
      ? 75
      : stage === "SETUP"
      ? 55
      : stage === "EARLY"
      ? 35
      : 10;

  return {
    symbol,
    price: livePrice,

    stage,
    bias,

    confidence,

    adx,
    stochK: stoch.K,
    stochD: stoch.D,

    compression,
    breakoutReady,

    reason:
      stage === "SNIPER"
        ? "Breakout confirmed"
        : stage === "SETUP"
        ? "Compression + momentum alignment"
        : stage === "EARLY"
        ? "Compression forming"
        : "No structure",

    stopLoss,
    takeProfit,
    riskRewardRatio: rrr,

    updatedAt: new Date().toISOString(),
  };
}
