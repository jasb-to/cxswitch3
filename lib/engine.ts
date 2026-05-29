export type Symbol = "BTC" | "ETH" | "SOL";

export interface Signal {
  symbol: Symbol;
  price: number;

  change24h: number;

  bias4H: "Bullish" | "Bearish" | "Neutral";
  bias1H: "Bullish" | "Bearish" | "Neutral";

  setup: "LONG" | "SHORT" | null;

  stochRSI: number;
  stochDirection: "rising" | "falling" | "neutral";

  emaCross: "Bullish" | "Bearish" | "None";

  momentum: "Accelerating" | "Decelerating" | "Flat";

  entry?: number;
  stopLoss?: number;
  takeProfit?: number;

  trigger: string;
  updatedAt: string;
}

const KRAKEN: Record<Symbol, string> = {
  BTC: "XBTUSD",
  ETH: "ETHUSD",
  SOL: "SOLUSD",
};

async function fetchOHLC(symbol: Symbol, interval: number) {
  const pair = KRAKEN[symbol];

  const url =
    "https://api.kraken.com/0/public/OHLC?pair=" +
    pair +
    "&interval=" +
    interval;

  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) return [];

  const data = await res.json();

  const key = Object.keys(data.result || {}).find((k) => k !== "last");
  if (!key) return [];

  return data.result[key].map((c: any[]) => ({
    close: Number(c[4]),
  }));
}

function emaCross(closes: number[]) {
  if (closes.length < 20) return "None";

  const ema8 = closes.slice(-8).reduce((a, b) => a + b, 0) / 8;
  const ema21 = closes.slice(-21).reduce((a, b) => a + b, 0) / 21;

  if (ema8 > ema21) return "Bullish";
  if (ema8 < ema21) return "Bearish";
  return "None";
}

function bias(closes: number[]) {
  const r = closes.slice(-6);
  let up = 0,
    down = 0;

  for (let i = 1; i < r.length; i++) {
    if (r[i] > r[i - 1]) up++;
    if (r[i] < r[i - 1]) down++;
  }

  if (up >= 4) return "Bullish";
  if (down >= 4) return "Bearish";
  return "Neutral";
}

function stoch(closes: number[]) {
  const slice = closes.slice(-14);
  const low = Math.min(...slice);
  const high = Math.max(...slice);
  const current = slice.at(-1)!;

  const value = high === low ? 50 : ((current - low) / (high - low)) * 100;

  return Math.round(value);
}

function momentum(closes: number[]) {
  const a = Math.abs(closes.at(-3)! - closes.at(-4)!);
  const b = Math.abs(closes.at(-2)! - closes.at(-3)!);

  if (b > a) return "Accelerating";
  if (b < a) return "Decelerating";
  return "Flat";
}

export async function evaluateSignal(symbol: Symbol): Promise<Signal> {
  const [c4, c1, c15] = await Promise.all([
    fetchOHLC(symbol, 240),
    fetchOHLC(symbol, 60),
    fetchOHLC(symbol, 15),
  ]);

  const closes4 = c4.map((c) => c.close);
  const closes1 = c1.map((c) => c.close);
  const closes15 = c15.map((c) => c.close);

  const price = closes15.at(-1) || 0;

  const bias4H = bias(closes4);
  const bias1H = bias(closes1);

  const ema = emaCross(closes15);
  const st = stoch(closes15);
  const mom = momentum(closes15);

  let setup: "LONG" | "SHORT" | null = null;

  if (
    bias4H === "Bullish" &&
    bias1H === "Bullish" &&
    ema === "Bullish" &&
    st >= 65
  ) {
    setup = "LONG";
  }

  if (
    bias4H === "Bearish" &&
    bias1H === "Bearish" &&
    ema === "Bearish" &&
    st <= 65
  ) {
    setup = "SHORT";
  }

  return {
    symbol,

    price,
    change24h: 0,

    bias4H,
    bias1H,

    setup,
    stochRSI: st,
    stochDirection: "neutral",

    emaCross: ema,
    momentum: mom,

    entry: setup ? price : undefined,
    stopLoss: setup ? price * (setup === "LONG" ? 0.985 : 1.015) : undefined,
    takeProfit: setup ? price * (setup === "LONG" ? 1.04 : 0.96) : undefined,

    trigger: setup ? "EMA + Bias + Stoch" : "Waiting",

    updatedAt: new Date().toISOString(),
  };
}
