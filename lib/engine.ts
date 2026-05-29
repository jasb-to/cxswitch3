# lib/engine.ts

```ts
import { fetchPrices } from "./coingecko";

export type Symbol = "BTC" | "ETH" | "SOL";

export interface Signal {
  symbol: Symbol;
  price: number;

  change24h: number;
  high24h: number;
  low24h: number;

  bias4H: "Bullish" | "Bearish" | "Neutral";
  bias1H: "Bullish" | "Bearish" | "Neutral";

  setup: "LONG" | "SHORT" | null;

  strength: "A+" | "A" | "B" | "C";

  emaCross: "Bullish" | "Bearish" | "None";

  stochRSI: number;
  stochDirection: "rising" | "falling" | "neutral";

  entry?: number;
  stopLoss?: number;
  takeProfit?: number;

  momentum: "Accelerating" | "Decelerating" | "Flat";

  trigger: string;

  updatedAt: string;
}

interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

const KRAKEN: Record<Symbol, string> = {
  BTC: "XBTUSD",
  ETH: "ETHUSD",
  SOL: "SOLUSD",
};

async function fetchOHLC(
  symbol: Symbol,
  interval: number
): Promise<Candle[]> {
  try {
    const pair = KRAKEN[symbol];

    const res = await fetch(
      `https://api.kraken.com/0/public/OHLC?pair=${pair}&interval=${interval}`,
      { cache: "no-store" }
    );

    const data = await res.json();

    const key = Object.keys(data.result).find((k) => k !== "last");

    if (!key) return [];

    return data.result[key].map((c: any[]) => ({
      time: c[0],
      open: parseFloat(c[1]),
      high: parseFloat(c[2]),
      low: parseFloat(c[3]),
      close: parseFloat(c[4]),
    }));
  } catch {
    return [];
  }
}

function ema(values: number[], period: number) {
  const k = 2 / (period + 1);

  let prev = values[0];

  const result = [prev];

  for (let i = 1; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    result.push(prev);
  }

  return result;
}

function getEMACross(closes: number[]) {
  if (closes.length < 30) return "None";

  const ema8 = ema(closes, 8);
  const ema21 = ema(closes, 21);

  const prev8 = ema8[ema8.length - 2];
  const prev21 = ema21[ema21.length - 2];

  const current8 = ema8[ema8.length - 1];
  const current21 = ema21[ema21.length - 1];

  if (prev8 < prev21 && current8 > current21) {
    return "Bullish";
  }

  if (prev8 > prev21 && current8 < current21) {
    return "Bearish";
  }

  return "None";
}

function computeStochRSI(closes: number[]) {
  if (closes.length < 20) {
    return {
      value: 50,
      direction: "neutral" as const,
    };
  }

  const gains: number[] = [];
  const losses: number[] = [];

  for (let i = 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];

    gains.push(diff > 0 ? diff : 0);
    losses.push(diff < 0 ? Math.abs(diff) : 0);
  }

  const avgGain =
    gains.slice(-14).reduce((a, b) => a + b, 0) / 14;

  const avgLoss =
    losses.slice(-14).reduce((a, b) => a + b, 0) / 14;

  const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;

  const rsi = 100 - 100 / (1 + rs);

  const recent = closes.slice(-14);

  const low = Math.min(...recent);
  const high = Math.max(...recent);

  const stoch =
    high === low
      ? 50
      : ((closes[closes.length - 1] - low) / (high - low)) * 100;

  const prev =
    ((closes[closes.length - 2] - low) / (high - low)) * 100;

  let direction: "rising" | "falling" | "neutral" =
    "neutral";

  if (stoch > prev) direction = "rising";
  else if (stoch < prev) direction = "falling";

  return {
    value: Math.round((stoch + rsi) / 2),
    direction,
  };
}

function getBias(closes: number[]) {
  if (closes.length < 20) return "Neutral";

  const recent = closes.slice(-6);

  let up = 0;
  let down = 0;

  for (let i = 1; i < recent.length; i++) {
    if (recent[i] > recent[i - 1]) up++;
    if (recent[i] < recent[i - 1]) down++;
  }

  if (up >= 4) return "Bullish";
  if (down >= 4) return "Bearish";

  return "Neutral";
}

function getMomentum(closes: number[]) {
  if (closes.length < 4) return "Flat";

  const c1 =
    Math.abs(closes[closes.length - 2] - closes[closes.length - 3]);

  const c2 =
    Math.abs(closes[closes.length - 1] - closes[closes.length - 2]);

  if (c2 > c1 * 1.2) return "Accelerating";
  if (c2 < c1 * 0.8) return "Decelerating";

  return "Flat";
}

export async function evaluateSignal(
  symbol: Symbol
): Promise<Signal> {
  const [prices, candles4H, candles1H, candles15m] =
    await Promise.all([
      fetchPrices(),
      fetchOHLC(symbol, 240),
      fetchOHLC(symbol, 60),
      fetchOHLC(symbol, 15),
    ]);

  const market = prices[symbol];

  const closes4H = candles4H.map((c) => c.close);
  const closes1H = candles1H.map((c) => c.close);
  const closes15m = candles15m.map((c) => c.close);

  const bias4H = getBias(closes4H);
  const bias1H = getBias(closes1H);

  const emaCross = getEMACross(closes15m);

  const stoch = computeStochRSI(closes15m);

  const momentum = getMomentum(closes15m);

  let setup: "LONG" | "SHORT" | null = null;

  let trigger = "Waiting";

  let strength: "A+" | "A" | "B" | "C" = "C";

  const bullish =
    bias4H === "Bullish" &&
    bias1H === "Bullish" &&
    emaCross === "Bullish" &&
    stoch.value >= 35 &&
    stoch.direction === "rising";

  const bearish =
    bias4H === "Bearish" &&
    bias1H === "Bearish" &&
    emaCross === "Bearish" &&
    stoch.value <= 65 &&
    stoch.direction === "falling";

  if (bullish) {
    setup = "LONG";
    trigger = "15m Bullish EMA Cross";
    strength = momentum === "Accelerating" ? "A+" : "A";
  }

  if (bearish) {
    setup = "SHORT";
    trigger = "15m Bearish EMA Cross";
    strength = momentum === "Accelerating" ? "A+" : "A";
  }

  let stopLoss: number | undefined;
  let takeProfit: number | undefined;

  const price = market.price;

  if (setup === "LONG") {
    stopLoss = price * 0.985;
    takeProfit = price * 1.04;
  }

  if (setup === "SHORT") {
    stopLoss = price * 1.015;
    takeProfit = price * 0.96;
  }

  return {
    symbol,

    price,

    change24h: market.change24h,
    high24h: market.high24h,
    low24h: market.low24h,

    bias4H,
    bias1H,

    setup,

    strength,

    emaCross,

    stochRSI: stoch.value,
    stochDirection: stoch.direction,

    entry: setup ? price : undefined,

    stopLoss,
    takeProfit,

    momentum,

    trigger,

    updatedAt: new Date().toISOString(),
  };
}
```
