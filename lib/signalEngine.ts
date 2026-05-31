import { generateSignal, Candle, Symbol } from "./strategy";

export interface EngineResult {
  signals: ReturnType<typeof generateSignal>[];
  updatedAt: string;
}

/* =========================
   MARKET QUALITY FILTER
   (THIS IS THE REAL UPGRADE)
========================= */

function isMarketTradable(adx: number, stochK: number) {
  // prevents chop trading
  const strongTrend = adx > 20;

  // avoid extreme exhaustion zones
  const notOverbought = stochK < 80;
  const notOversold = stochK > 20;

  return strongTrend && notOverbought && notOversold;
}

/* =========================
   MAIN ENGINE
========================= */

export function runSignalEngine(
  data: {
    symbol: Symbol;
    candles4H: Candle[];
    candles1H: Candle[];
    candles15M: Candle[];
    price: number;
  }[]
): EngineResult {
  const signals = [];

  for (const asset of data) {
    const signal = generateSignal(
      asset.symbol,
      asset.candles4H,
      asset.candles1H,
      asset.candles15M,
      asset.price
    );

    /* =========================
       EXECUTION GATE (NEW)
    ========================= */

    const tradable = isMarketTradable(
      signal.adx,
      signal.stochK
    );

    // HARD FILTER: blocks weak SNIPERs
    const allowSniper =
      signal.isSniper && tradable;

    const allowEarly =
      signal.isEarly && signal.adx > 10;

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
