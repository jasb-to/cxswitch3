import {
  storeSignalSnapshot,
  type SignalSnapshot,
} from "@/lib/persistence";

export type Symbol = "BTC" | "ETH" | "SOL";

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface SignalInput {
  symbol: Symbol;
  candles4H: Candle[];
  candles1H: Candle[];
  candles15M: Candle[];
  price: number;
}

export interface EngineResult {
  signals: SignalSnapshot[];
  updatedAt: string;
}

/* =========================
   ADX
========================= */
function calculateADX(candles: Candle[]) {
  if (!candles || candles.length < 15) return 0;

  let plusDM = 0;
  let minusDM = 0;
  let tr = 0;

  for (let i = 1; i < candles.length; i++) {
    const curr = candles[i];
    const prev = candles[i - 1];

    const upMove = curr.high - prev.high;
    const downMove = prev.low - curr.low;

    if (upMove > downMove && upMove > 0) plusDM += upMove;
    if (downMove > upMove && downMove > 0) minusDM += downMove;

    tr += Math.max(
      curr.high - curr.low,
      Math.abs(curr.high - prev.close),
      Math.abs(curr.low - prev.close)
    );
  }

  const plusDI = (plusDM / (tr || 1)) * 100;
  const minusDI = (minusDM / (tr || 1)) * 100;

  const dx =
    Math.abs(plusDI - minusDI) / ((plusDI + minusDI) || 1);

  return dx * 100;
}

/* =========================
   STOCH
========================= */
function calculateStoch(candles: Candle[]) {
  const slice = candles.slice(-14);
  if (slice.length < 2) return { K: 50, D: 50 };

  const low = Math.min(...slice.map((c) => c.low));
  const high = Math.max(...slice.map((c) => c.high));
  const close = slice[slice.length - 1].close;

  const k = ((close - low) / (high - low || 1)) * 100;

  return { K: k, D: k };
}

/* =========================
   STRUCTURE
========================= */
function detectStructure(candles: Candle[]) {
  if (candles.length < 5) return "Neutral";

  const last = candles.slice(-5);

  const highs = last.map((c) => c.high);
  const lows = last.map((c) => c.low);

  if (highs[4] > highs[3] && lows[4] > lows[3]) return "Bullish";
  if (highs[4] < highs[3] && lows[4] < lows[3]) return "Bearish";

  return "Neutral";
}

/* =========================
   PIVOTS (NEW CORE LOGIC)
========================= */
function detectPivots(candles: Candle[]) {
  if (!candles || candles.length < 10) {
    return { high: null, low: null };
  }

  const last = candles.slice(-10);

  let swingHigh = last[0].high;
  let swingLow = last[0].low;

  for (const c of last) {
    if (c.high > swingHigh) swingHigh = c.high;
    if (c.low < swingLow) swingLow = c.low;
  }

  return {
    high: swingHigh,
    low: swingLow,
  };
}

/* =========================
   SIGNAL LOGIC
========================= */
function isEarly(adx: number, k: number) {
  return adx > 8 && adx < 60 && k > 25 && k < 75;
}

function isSniper(structure: string, k: number, adx: number) {
  return (
    adx > 20 &&
    ((structure === "Bullish" && k > 60) ||
      (structure === "Bearish" && k < 40))
  );
}

/* =========================
   MAIN ENGINE
========================= */
export async function generateAndStoreSignals(
  inputs: SignalInput[]
): Promise<EngineResult> {
  const signals: SignalSnapshot[] = [];

  for (const input of inputs ?? []) {
    const structure = detectStructure(input.candles15M || []);

    const adx = calculateADX(input.candles15M || []);
    const stoch = calculateStoch(input.candles15M || []);

    const early = isEarly(adx, stoch.K);
    const sniper = isSniper(structure, stoch.K, adx);

    const bias =
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
       PIVOT-BASED SL/TP LOGIC
    ========================= */
    if (sniper) {
      const pivots = detectPivots(input.candles15M || []);

      const atr =
        (input.candles15M || []).reduce((sum, c, i, arr) => {
          if (i === 0) return 0;
          return sum + Math.abs(c.high - c.low);
        }, 0) / (input.candles15M.length || 1);

      const buffer = atr * 1.2;

      if (bias === "Bullish") {
        stopLoss = pivots.low ?? input.price - buffer;
        takeProfit = pivots.high ?? input.price + buffer * 2;
      }

      if (bias === "Bearish") {
        stopLoss = pivots.high ?? input.price + buffer;
        takeProfit = pivots.low ?? input.price - buffer * 2;
      }

      // safety fallback
      if (stopLoss === takeProfit) {
        stopLoss =
          bias === "Bullish"
            ? input.price - buffer
            : input.price + buffer;

        takeProfit =
          bias === "Bullish"
            ? input.price + buffer * 2
            : input.price - buffer * 2;
      }

      rrr = 2;
    }

    const snapshot: SignalSnapshot = {
      symbol: input.symbol,
      price: input.price,

      isEarly: early,
      isSniper: sniper,
      isActive: early || sniper,

      confidence,

      adx,
      stochK: stoch.K,
      stochD: stoch.D,

      bias,

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

    signals.push(snapshot);

    await storeSignalSnapshot(snapshot);
  }

  return {
    signals,
    updatedAt: new Date().toISOString(),
  };
}
