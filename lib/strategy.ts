export type Symbol = "BTC" | "ETH" | "SOL";

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/* =========================
   SIGNAL STAGES (REDEFINED)
========================= */

export type SignalStage =
  | "EARLY"   // compression building
  | "SETUP"   // ENTRY (your sniper entry)
  | "SNIPER"  // continuation / move in progress
  | "NONE";

export interface Signal {
  symbol: Symbol;
  price: number;

  stage: SignalStage;

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
   COMPRESSION (WEDGE BUILDING)
========================= */

function detectCompression(candles: Candle[]) {
  const slice = candles.slice(-20);
  if (slice.length < 20) return false;

  const highs = slice.map(c => c.high);
  const lows = slice.map(c => c.low);

  const range = Math.max(...highs) - Math.min(...lows);
  const avg = slice.reduce((s, c) => s + c.close, 0) / slice.length;

  const volatility = range / avg;

  return volatility < 0.02;
}

/* =========================
   BIAS (STRUCTURE DIRECTION)
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
   ADX (momentum expansion pressure)
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
   STOCH (timing pressure)
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
   MAIN ENGINE LOGIC (REBALANCED)
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

  const breakoutPressure =
    momentum < 35 || momentum > 65 || adx > 1.2;

  /* =========================
     STAGE LOGIC (YOUR MODEL)
  ========================= */

  let stage: SignalStage = "NONE";

  // EARLY = compression forming
  if (compression && bias !== "Neutral") {
    stage = "EARLY";
  }

  // SETUP = ENTRY (YOUR SNIPER ENTRY)
  if (compression && breakoutPressure && bias !== "Neutral") {
    stage = "SETUP";
  }

  // SNIPER = MOVE ALREADY RUNNING
  if (!compression && breakoutPressure && bias !== "Neutral") {
    stage = "SNIPER";
  }

  /* =========================
     RISK MODEL
  ========================= */

  let stopLoss = null;
  let takeProfit = null;
  let rrr = null;

  // ENTRY (SETUP) gets full risk definition
  if (stage === "SETUP") {
    const risk = adx * 1.3;

    if (bias === "Bullish") {
      stopLoss = livePrice - risk;
      takeProfit = livePrice + risk * 2;
    } else if (bias === "Bearish") {
      stopLoss = livePrice + risk;
      takeProfit = livePrice - risk * 2;
    }

    rrr = 2;
  }

  // SNIPER = trailing continuation (wider targets)
  if (stage === "SNIPER") {
    const risk = adx * 2;

    if (bias === "Bullish") {
      stopLoss = livePrice - risk;
      takeProfit = livePrice + risk * 3;
    } else if (bias === "Bearish") {
      stopLoss = livePrice + risk;
      takeProfit = livePrice - risk * 3;
    }

    rrr = 3;
  }

  const confidence =
    stage === "SETUP"
      ? 75
      : stage === "SNIPER"
      ? 60
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
    breakoutReady: breakoutPressure,

    reason:
      stage === "SETUP"
        ? "ENTRY: compression breakout forming"
        : stage === "SNIPER"
        ? "MOVE: breakout in progress"
        : stage === "EARLY"
        ? "BUILDING: compression forming"
        : "NO SETUP",

    stopLoss,
    takeProfit,
    riskRewardRatio: rrr,

    updatedAt: new Date().toISOString(),
  };
}
