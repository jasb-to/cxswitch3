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

async function fetchOHLC(symbol: Symbol, interval: number): Promise<Candle[]> {
  try {
    const pair = KRAKEN[symbol];

    const url =
      "https://api.kraken.com/0/public/OHLC?pair=" +
      pair +
      "&interval=" +
      interval;

    const res = await fetch(url, {
      cache: "no-store",
    });

    if (!res.ok) return [];

    const data = await res.json();

    const key = Object.keys(data.result || {}).find((k) => k !== "last");
    if (!key) return [];

    return data.result[key].map((c: any[]) => ({
      time: Number(c[0]),
      open: Number(c[1]),
      high: Number(c[2]),
      low: Number(c[3]),
      close: Number(c[4]),
    }));
  } catch {
    return [];
  }
}

function ema(values: number[], period: number) {
  const k = 2 / (period + 1);
  let prev = values[0];
  const out = [prev];

  for (let i = 1; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out.push(prev);
  }

  return out;
}

function emaCross(closes: number[]) {
  if (closes.length < 30) return "None";

  const e8 = ema(closes, 8);
  const e21 = ema(closes, 21);

  const prev = e8[e8.length - 2] - e21[e21.length - 2];
  const now = e8[e8.length - 1] - e21[e21.length - 1];

  if (prev < 0 && now > 0) return "Bullish";
  if (prev > 0 && now < 0) return "Bearish";

  return "None";
}

function bias(closes: number[]) {
  if (closes.length < 10) return "Neutral";

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

function stoch(closes: number[]) {
  if (closes.length < 15) {
    return { value: 50, direction: "neutral" as const };
  }

  const slice = closes.slice(-14);

  const low = Math.min(...slice);
  const high = Math.max(...slice);

  const current = slice[slice.length - 1];
  const prev = slice[slice.length - 2];

  const value = high === low ? 50 : ((current - low) / (high - low)) * 100;

  let direction: "rising" | "falling" | "neutral" = "neutral";

  if (value > prev) direction = "rising";
  else if (value < prev) direction = "falling";

  return { value: Math.round(value), direction };
}

function momentum(closes: number[]) {
  if (closes.length < 4) return "Flat";

  const a = Math.abs(closes.at(-3)! - closes.at(-4)!);
  const b = Math.abs(closes.at(-2)! - closes.at(-3)!);

  if (b > a * 1.2) return "Accelerating";
  if (b < a * 0.8) return "Decelerating";

  return "Flat";
}

export async function evaluateSignal(symbol: Symbol): Promise<Signal> {
  const [prices, c4h, c1h, c15] = await Promise.all([
    fetchPrices(),
    fetchOHLC(symbol, 240),
    fetchOHLC(symbol, 60),
    fetchOHLC(symbol, 15),
  ]);

  const market = prices[symbol];
  const price = market.price;

  const closes4 = c4h.map((c) => c.close);
  const closes1 = c1h.map((c) => c.close);
  const closes15 = c15.map((c) => c.close);

  const bias4H = bias(closes4);
  const bias1H = bias(closes1);

  const ema = emaCross(closes15);
  const st = stoch(closes15);
  const mom = momentum(closes15);

  let setup: "LONG" | "SHORT" | null = null;

  const bullish =
    bias4H === "Bullish" &&
    bias1H === "Bullish" &&
    ema === "Bullish" &&
    st.value >= 65 &&
    st.direction === "rising";

  const bearish =
    bias4H === "Bearish" &&
    bias1H === "Bearish" &&
    ema === "Bearish" &&
    st.value <= 65 &&
    st.direction === "falling";

  if (bullish) setup = "LONG";
  if (bearish) setup = "SHORT";

  let stopLoss;
  let takeProfit;

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
    strength: setup ? (mom === "Accelerating" ? "A+" : "A") : "C",

    emaCross: ema,

    stochRSI: st.value,
    stochDirection: st.direction,

    entry: setup ? price : undefined,
    stopLoss,
    takeProfit,

    momentum: mom,
    trigger: setup ? "EMA + Bias Alignment" : "Waiting",

    updatedAt: new Date().toISOString(),
  };
}
