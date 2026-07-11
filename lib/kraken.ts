const KRAKEN_API_URL = "https://api.kraken.com";

export interface Candle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

let lastReq = 0;
const MIN_MS = 600;

async function rateFetch(url: string, opts?: RequestInit): Promise<Response> {
  const now = Date.now();
  const elapsed = now - lastReq;
  if (elapsed < MIN_MS) await new Promise(r => setTimeout(r, MIN_MS - elapsed));
  lastReq = Date.now();
  return fetch(url, opts);
}

export async function getCandles(pair: string, interval: number = 60, since?: number): Promise<Candle[]> {
  const url = new URL(`${KRAKEN_API_URL}/0/public/OHLC`);
  url.searchParams.set("pair", pair);
  url.searchParams.set("interval", String(interval));
  if (since) url.searchParams.set("since", String(since));
  const res = await rateFetch(url.toString());
  if (!res.ok) throw new Error(`Kraken OHLC HTTP ${res.status}`);
  const data = await res.json();
  if (data.error?.length > 0) throw new Error(`Kraken OHLC error: ${data.error.join(", ")}`);
  const key = Object.keys(data.result).find(k => k !== "last");
  if (!key) throw new Error("No OHLC data");
  const raw = data.result[key];
  if (!Array.isArray(raw)) throw new Error(`OHLC not array: ${typeof raw}`);
  return raw.map((c: any) => ({
    timestamp: c[0] * 1000,
    open: parseFloat(c[1]),
    high: parseFloat(c[2]),
    low: parseFloat(c[3]),
    close: parseFloat(c[4]),
    volume: parseFloat(c[6]),
  }));
}

export async function getCurrentPrice(pair: string): Promise<number> {
  const url = `${KRAKEN_API_URL}/0/public/Ticker?pair=${encodeURIComponent(pair)}`;
  const res = await rateFetch(url);
  if (!res.ok) throw new Error(`Kraken Ticker HTTP ${res.status}`);
  const data = await res.json();
  if (data.error?.length > 0) throw new Error(`Kraken Ticker error: ${data.error.join(", ")}`);
  const key = Object.keys(data.result)[0];
  return parseFloat(data.result[key].c[0]);
}

export function krakenPairFormat(pair: string): string {
  const map: Record<string, string> = {
    "BTC/USD": "XBTUSD",
    "ETH/USD": "ETHUSD",
    "SOL/USD": "SOLUSD",
    "HYPE/USD": "HYPEUSD",
  };
  return map[pair] || pair.replace("/", "");
}

export function aggregateTo1D(candles4h: Candle[]): Candle[] {
  if (!candles4h?.length) return [];
  const sorted = [...candles4h].sort((a, b) => a.timestamp - b.timestamp);
  const groups = new Map<string, Candle[]>();
  for (const c of sorted) {
    const key = new Date(c.timestamp).toISOString().split("T")[0];
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(c);
  }
  const daily: Candle[] = [];
  for (const [, bars] of groups) {
    if (!bars.length) continue;
    daily.push({
      timestamp: bars[0].timestamp,
      open: bars[0].open,
      high: Math.max(...bars.map(b => b.high)),
      low: Math.min(...bars.map(b => b.low)),
      close: bars[bars.length - 1].close,
      volume: bars.reduce((s, b) => s + b.volume, 0),
    });
  }
  return daily.sort((a, b) => a.timestamp - b.timestamp);
}
