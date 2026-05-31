import { generateSignal, Candle, Symbol } from "./strategy";

export interface EngineInput {
  symbol: Symbol;
  candles4H: Candle[];
  candles1H: Candle[];
  candles15M: Candle[];
  price: number;
}

export interface EngineResult {
  signals: ReturnType<typeof generateSignal>[];
  updatedAt: string;
}

/* =========================
   MARKET QUALITY FILTER
========================= */

function isMarketTradable(adx: number, stochK: number) {
  const strongTrend = adx > 20;

  // avoid dead chop + extreme exhaustion zones
  const notOverbought = stochK < 80;
  const notOversold = stochK > 20;

  return strongTrend && notOverbought && notOversold;
}

/* =========================
   MAIN ENGINE
========================= */

export function runSignalEngine(
  data: EngineInput[]
): EngineResult {
  const signals: ReturnType<typeof generateSignal>[] = [];

  for (const asset of data) {
    const signal = generateSignal(
      asset.symbol,
      asset.candles4H,
      asset.candles1H,
      asset.candles15M,
      asset.price
    );

    /* =========================
       EXECUTION GATE
    ========================= */

    const tradable = isMarketTradable(
      signal.adx,
      signal.stochK
    );

    const allowSniper = signal.isSniper && tradable;
    const allowEarly = signal.isEarly && signal.adx > 10;

    const finalSignal = {
      ...signal,
      isSniper: allowSniper,
      isEarly: allowEarly,
      isActive: allowSniper || allowEarly
    };

    console.log(
      `[ENGINE] ${signal.symbol}: ${
        allowSniper
          ? "SNIPER"
          : allowEarly
          ? "EARLY"
          : "WAIT"
      } | ADX=${signal.adx.toFixed(1)}`
    );

    signals.push(finalSignal);
  }

  return {
    signals,
    updatedAt: new Date().toISOString()
  };
}

/* =========================
   BACKWARD COMPATIBILITY
========================= */

export function generateAndStoreSignals(data: EngineInput[]) {
  return runSignalEngine(data);
}
