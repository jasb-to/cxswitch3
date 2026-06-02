export type Symbol = "BTC" | "ETH" | "SOL";

const PAIRS: Record<Symbol, string> = {
  BTC: "XXBTZUSD",
  ETH: "XETHZUSD",
  SOL: "SOLUSD",
};

const BASE = "https://api.kraken.com/0/public";

async function fetchKraken(url: string) {
  const res = await fetch(url, { cache: "no-store" });
  const data = await res.json();

  if (!data || data.error?.length) return null;
  return data.result;
}

function parseCandles(raw: any) {
  if (!raw) return [];
  const key = Object.keys(raw)[0];
  return (raw[key] || []).map((c: any) => ({
    time: Number(c[0]),
    open: Number(c[1]),
    high: Number(c[2]),
    low: Number(c[3]),
    close: Number(c[4]),
    volume: Number(c[6]),
  }));
}

export async function getCandles(symbol: Symbol, interval: number) {
  const pair = PAIRS[symbol];
  const url = `${BASE}/OHLC?pair=${pair}&interval=${interval}`;
  const res = await fetchKraken(url);
  return parseCandles(res);
}

export async function getCurrentPrice(symbol: Symbol) {
  const pair = PAIRS[symbol];
  const url = `${BASE}/Ticker?pair=${pair}`;

  const res = await fetchKraken(url);
  if (!res) return 0;

  const key = Object.keys(res)[0];
  return Number(res[key]?.c?.[0] ?? 0);
}
