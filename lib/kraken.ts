// lib/kraken.ts
// ============================================================

export type Symbol = "BTC" | "ETH" | "SOL" | "HYPE";

const PAIRS: Record<Symbol, string> = {
  BTC: "XXBTZUSD",
  ETH: "XETHZUSD",
  SOL: "SOLUSD",
  HYPE: "HYPEUSD",
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
  
  const keys = Object.keys(raw).filter(k => k !== "last");
  if (keys.length === 0) return [];
  const key = keys[0];

  return (raw[key] || []).map((c: any) => ({
    timestamp: Number(c[0]) * 1000,
    open: Number(c[1]),
    high: Number(c[2]),
    low: Number(c[3]),
    close: Number(c[4]),
    volume: Number(c[6]),
  }));
}

export async function getCandles(symbol: Symbol, interval: number) {
  const url = `${BASE}/OHLC?pair=${PAIRS[symbol]}&interval=${interval}`;
  const res = await fetchKraken(url);
  const candles = parseCandles(res);
  return candles.sort((a, b) => a.timestamp - b.timestamp);
}

export async function getCurrentPrice(symbol: Symbol) {
  const url = `${BASE}/Ticker?pair=${PAIRS[symbol]}`;
  const res = await fetchKraken(url);

  if (!res) return 0;

  const key = Object.keys(res)[0];
  return Number(res[key]?.c?.[0] ?? 0);
}
