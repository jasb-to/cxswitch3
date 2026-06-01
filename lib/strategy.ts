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
   CORE: COMPRESSION ENGINE
========================= */

function detectCompression(candles: Candle[]) {
  const slice = candles.slice(-20);

  const highs = slice.map(c => c.high);
  const lows = slice.map(c => c.low);

  const range = Math.max(...highs) - Math.min(...lows);

  const avgPrice =
    slice.reduce((sum, c) => sum + c.close, 0) / slice.length;

  const volatilityRatio = range / avgPrice;

  return {
    compressed: volatilityRatio < 0.015, // tuned early squeeze
    volatilityRatio,
  };
}

/* =========================
   STRUCTURE (simple + fast)
========================= */

function detectStructure(candles: Candle[]) {
  const last = candles.slice(-5);

  const highs = last.map(c => c.high);
  const lows = last.map(c => c.low);

  const up = highs[4] > highs[3] && lows[4] > lows[3];
  const down = highs[4] < highs[3] && lows[4] < lows[3];

  if (up) return "Bullish";
  if (down) return "Bearish";
  return "Neutral";
}

/* =========================
   MOMENTUM (lightweight, NOT primary)
========================= */

function momentum(candles: Candle[]) {
  const slice = candles.slice(-10);

  const closes = slice.map(c => c.close);

  const change =
    (closes[closes.length - 1] - closes[0]) / closes[0];

  return {
    strength: Math.abs(change * 100),
    direction: change > 0 ? "Bullish" : "Bearish",
  };
}

/* =========================
   EARLY SIGNAL (REAL EARLY)
========================= */

function isEarly(compression: boolean, momentumStrength: number) {
  return compression && momentumStrength < 1.2;
}

/* =========================
   SNIPER (EXPANSION EVENT)
========================= */

function isSniper(
  compression: boolean,
  momentumStrength: number,
  structure: string
) {
  return (
    compression === false &&
    momentumStrength > 1.5 &&
    structure !== "Neutral"
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
  const c = [...candles15M].reverse();

  const structure = detectStructure(c);

  const compression = detectCompression(c);

  const mom = momentum(c);

  const early = isEarly(compression.compressed, mom.strength);

  const sniper = isSniper(
    compression.compressed,
    mom.strength,
    structure
  );

  const bias: Signal["bias"] =
    structure === "Bullish"
      ? "Bullish"
      : structure === "Bearish"
      ? "Bearish"
      : "Neutral";

  const confidence = sniper ? 90 : early ? 65 : 25;

  let stopLoss = null;
  let takeProfit = null;
  let rrr = null;

  if (sniper) {
    const risk = livePrice * 0.01;

    stopLoss =
      bias === "Bullish"
        ? livePrice - risk
        : livePrice + risk;

    takeProfit =
      bias === "Bullish"
        ? livePrice + risk * 2
        : livePrice - risk * 2;

    rrr = 2;
  }

  return {
    symbol,
    price: livePrice,

    isEarly: early,
    isSniper: sniper,
    isActive: early || sniper,

    setupId: `${symbol}-${structure}-${Date.now()}`,

    bias,

    confidence,

    adx: 0,
    stochK: 0,
    stochD: 0,

    reason: sniper
      ? "SNIPER EXPANSION"
      : early
      ? "COMPRESSION BUILDUP"
      : "WAIT",

    stopLoss,
    takeProfit,
    riskRewardRatio: rrr,

    updatedAt: new Date().toISOString(),
  };
}
