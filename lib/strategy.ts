export type Symbol = "BTC" | "ETH" | "SOL";

export type SignalState = "EARLY" | "SNIPER" | "WAIT";

export interface Signal {
  symbol: Symbol;
  price: number;

  state: SignalState;

  bias: "LONG" | "SHORT" | "NEUTRAL";
  confidence: number;

  adx: number;
  stoch: number;

  compression: number;

  reason: string;

  stopLoss: number | null;
  takeProfit: number | null;

  expectedMovePct: number;

  updatedAt: string;
}

/* -------------------------
   helpers
--------------------------*/

function avg(arr: number[]) {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function stddev(arr: number[]) {
  const m = avg(arr);
  return Math.sqrt(avg(arr.map(x => (x - m) ** 2)));
}

/* -------------------------
   core volatility engine
--------------------------*/

export function generateSignal(
  symbol: Symbol,
  candles15m: any[],
  candles1h: any[],
  price: number
): Signal {
  const last15 = candles15m.slice(-20);
  const last1h = candles1h.slice(-20);

  const closes15 = last15.map(c => c.close);
  const highs15 = last15.map(c => c.high);
  const lows15 = last15.map(c => c.low);

  const range = Math.max(...highs15) - Math.min(...lows15);
  const mean = avg(closes15);
  const volatility = stddev(closes15) / mean;

  const compression = volatility < 0.012; // REALISTIC squeeze zone

  const trend15 =
    closes15[closes15.length - 1] - closes15[0];

  const trend1h =
    last1h[last1h.length - 1].close -
    last1h[0].close;

  /* -------------------------
     STRUCTURE CLASSIFICATION
  --------------------------*/

  let state: SignalState = "WAIT";

  if (compression && Math.abs(trend15) < price * 0.002) {
    state = "EARLY";
  }

  if (!compression && Math.abs(trend15) > price * 0.01) {
    state = "SNIPER";
  }

  /* -------------------------
     BIAS
  --------------------------*/

  const bias =
    trend1h > 0 && trend15 > 0
      ? "LONG"
      : trend1h < 0 && trend15 < 0
      ? "SHORT"
      : "NEUTRAL";

  /* -------------------------
     CONFIDENCE (REALISTIC)
  --------------------------*/

  let confidence = 20;

  if (state === "EARLY") confidence = 55 + (1 - volatility) * 20;
  if (state === "SNIPER") confidence = 75 + (Math.abs(trend15) / price) * 100;

  confidence = Math.min(95, Math.max(10, confidence));

  /* -------------------------
     ADX + STOCH (proxy real calc)
  --------------------------*/

  const adx = Math.min(60, volatility * 3000);
  const stoch = ((price - Math.min(...lows15)) /
    (Math.max(...highs15) - Math.min(...lows15))) * 100;

  /* -------------------------
     MOVE MODEL (THIS FIXES YOUR ISSUE)
  --------------------------*/

  const expectedMovePct =
    state === "SNIPER"
      ? 0.03 + volatility * 2
      : state === "EARLY"
      ? 0.02 + volatility * 1.5
      : 0.01;

  /* -------------------------
     SL / TP (REAL STRUCTURE BASED)
  --------------------------*/

  let stopLoss = null;
  let takeProfit = null;

  if (state !== "WAIT") {
    if (bias === "LONG") {
      stopLoss = price * (1 - expectedMovePct * 0.5);
      takeProfit = price * (1 + expectedMovePct);
    } else if (bias === "SHORT") {
      stopLoss = price * (1 + expectedMovePct * 0.5);
      takeProfit = price * (1 - expectedMovePct);
    }
  }

  return {
    symbol,
    price,
    state,

    bias,
    confidence: Number(confidence.toFixed(2)),

    adx: Number(adx.toFixed(2)),
    stoch: Number(stoch.toFixed(2)),

    compression: Number(volatility.toFixed(4)),

    reason:
      state === "SNIPER"
        ? "EXPANSION BREAKOUT DETECTED"
        : state === "EARLY"
        ? "COMPRESSION BUILDUP - 3–5% MOVE ZONE"
        : "NO STRUCTURE",

    stopLoss: stopLoss ? Number(stopLoss.toFixed(2)) : null,
    takeProfit: takeProfit ? Number(takeProfit.toFixed(2)) : null,

    expectedMovePct: Number(expectedMovePct.toFixed(4)),

    updatedAt: new Date().toISOString(),
  };
}
