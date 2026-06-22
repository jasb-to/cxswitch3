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
  
  // FIX: Skip "last" key, find actual pair key
  const keys = Object.keys(raw).filter(k => k !== "last");
  if (keys.length === 0) return [];
  const key = keys[0];

  return (raw[key] || []).map((c: any) => ({
    timestamp: Number(c[0]) * 1000,  // FIX: convert to milliseconds for consistency
    open: Number(c[1]),
    high: Number(c[2]),
    low: Number(c[3]),
    close: Number(c[4]),
    volume: Number(c[6]),
  }));
}

// FIX: Add count parameter to fetch more historical candles
export async function getCandles(symbol: Symbol, interval: number, count?: number) {
  let url = `${BASE}/OHLC?pair=${PAIRS[symbol]}&interval=${interval}`;
  
  // If count specified, calculate 'since' to fetch enough history
  // Kraken returns up to 720 candles, so we use 'since' to ensure we get full history
  if (count && count > 720) {
    // Kraken max is 720, so we can't get more than that in one call
    // But we can use 'since' to shift the window if needed
    const since = Math.floor(Date.now() / 1000) - (count * interval * 60);
    url += `&since=${since}`;
  }
  
  const res = await fetchKraken(url);
  const candles = parseCandles(res);
  
  // Sort by timestamp ascending (oldest first) — strategy expects this
  return candles.sort((a, b) => a.timestamp - b.timestamp);
}

export async function getCurrentPrice(symbol: Symbol) {
  const url = `${BASE}/Ticker?pair=${PAIRS[symbol]}`;
  const res = await fetchKraken(url);

  if (!res) return 0;

  const key = Object.keys(res)[0];
  return Number(res[key]?.c?.[0] ?? 0);
}
