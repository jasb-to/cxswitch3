export type SignalState = "EARLY" | "SETUP" | "SNIPER" | "WAIT";

export interface Signal {
  symbol: string;
  price: number;

  state: SignalState;

  isEarly: boolean;
  isSniper: boolean;
  isActive: boolean;

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
   MOCK PRICE SOURCE (TEMP)
   Replace later with real candles
========================= */
function generateMockPrices(base: number): number[] {
  const points = [];
  let price = base;

  for (let i = 0; i < 10; i++) {
    const drift = (Math.random() - 0.5) * 0.002; // tiny movement
    price = price + price * drift;
    points.push(price);
  }

  return points;
}

/* =========================
   COMPRESSION ENGINE (CORE)
========================= */
function getCompressionScore(prices: number[]): number {
  if (!prices || prices.length < 5) return 0;

  const recent = prices.slice(-5);

  const max = Math.max(...recent);
  const min = Math.min(...recent);

  if (max === 0) return 0;

  const range = (max - min) / max;

  // invert: lower range = higher compression
  return Math.max(0, Math.min(1, 1 - range * 10));
}

/* =========================
   MAIN SIGNAL ENGINE
========================= */
export function generateSignal(symbol: string, price: number): Signal {
  const prices = generateMockPrices(price);

  const compressionScore = getCompressionScore(prices);

  // derived indicators (still UI only)
  const adx = 5 + compressionScore * 50;
  const stochK = compressionScore * 100;
  const stochD = compressionScore * 100;

  let state: SignalState = "WAIT";

  /* =========================
     CORE LOGIC (NO LAG INDICATORS)
  ========================= */

  if (compressionScore > 0.7) {
    state = "EARLY";
  }

  if (compressionScore > 0.85) {
    state = "SNIPER";
  }

  if (compressionScore < 0.4) {
    state = "WAIT";
  }

  /* =========================
     DERIVED VALUES
  ========================= */

  const isEarly = state === "EARLY";
  const isSniper = state === "SNIPER";

  const confidence =
    state === "SNIPER"
      ? 90
      : state === "EARLY"
      ? 60
      : 20;

  const bias: Signal["bias"] =
    compressionScore > 0.6
      ? "Bullish"
      : compressionScore < 0.3
      ? "Bearish"
      : "Neutral";

  const reason =
    state === "SNIPER"
      ? "COMPRESSION BREAKOUT IMMINENT"
      : state === "EARLY"
      ? "VOLATILITY SQUEEZE BUILDING"
      : "NO STRUCTURE";

  return {
    symbol,
    price,

    state,

    isEarly,
    isSniper,
    isActive: isEarly || isSniper,

    bias,
    confidence,

    adx,
    stochK,
    stochD,

    reason,

    stopLoss: isSniper ? price * 0.99 : null,
    takeProfit: isSniper ? price * 1.02 : null,
    riskRewardRatio: isSniper ? 2 : null,

    updatedAt: new Date().toISOString(),
  };
}

/* =========================
   ENGINE ENTRY (CRON)
========================= */
export async function generateAndStoreSignals() {
  const symbols = ["BTC", "ETH", "SOL"];

  const basePrices: Record<string, number> = {
    BTC: 71000,
    ETH: 1950,
    SOL: 80,
  };

  const signals: Signal[] = symbols.map((symbol) =>
    generateSignal(symbol, basePrices[symbol])
  );

  console.log(
    `[ENGINE] Generated ${signals.length} compression-based signals`
  );

  return signals;
}
