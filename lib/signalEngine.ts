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
   EARLY
========================= */
function isEarly(adx: number, k: number) {
  return adx > 10 && adx < 50 && k > 30 && k < 70;
}

/* =========================
   SNIPER
========================= */
function isSniper(structure: string, k: number) {
  return (
    (structure === "Bullish" && k > 55) ||
    (structure === "Bearish" && k < 45)
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
    const sniper = isSniper(structure, stoch.K);

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

    if (sniper) {
      const risk = input.price * 0.0025;

      if (bias === "Bullish") {
        stopLoss = input.price - risk;
        takeProfit = input.price + risk * 2;
      } else if (bias === "Bearish") {
        stopLoss = input.price + risk;
        takeProfit = input.price - risk * 2;
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

    // =========================
    // 🔥 THIS FIXES YOUR SYSTEM
    // =========================
    await storeSignalSnapshot(snapshot);
  }

  return {
    signals,
    updatedAt: new Date().toISOString(),
  };
}
