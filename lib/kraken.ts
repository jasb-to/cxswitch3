const KRAKEN = "https://api.kraken.com/0/public";

export type Symbol = "BTC" | "ETH" | "SOL";

function pair(symbol: Symbol) {
  switch (symbol) {
    case "BTC":
      return "XXBTZUSD";
    case "ETH":
      return "XETHZUSD";
    case "SOL":
      return "SOLUSD";
  }
}

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

async function fetchJSON(url: string) {
  const res = await fetch(url, { cache: "no-store" });
  const data = await res.json();

  if (data?.error?.length) {
    console.error("[KRAKEN ERROR]", data.error);
    return null;
  }

  return data.result;
}

function parseCandles(raw: any): Candle[] {
  if (!raw) return [];

  const key = Object.keys(raw)[0];
  const arr = raw[key];

  if (!Array.isArray(arr)) return [];

  return arr.map((c: any) => ({
    time: Number(c[0]),
    open: Number(c[1]),
    high: Number(c[2]),
    low: Number(c[3]),
    close: Number(c[4]),
    volume: Number(c[6]),
  }));
}

export async function getCandles(symbol: Symbol, interval: number) {
  const url = `${KRAKEN}/OHLC?pair=${pair(symbol)}&interval=${interval}`;
  const raw = await fetchJSON(url);
  return parseCandles(raw).sort((a, b) => a.time - b.time);
}

export async function getLivePrice(symbol: Symbol) {
  const url = `${KRAKEN}/Ticker?pair=${pair(symbol)}`;
  const raw = await fetchJSON(url);

  if (!raw) return 0;

  const key = Object.keys(raw)[0];
  return Number(raw[key]?.c?.[0] ?? 0);
}
