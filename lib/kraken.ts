export interface Candle {
  time: number;   // Unix seconds
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

const KRAKEN_PAIR: Record<string, string> = {
  "BTC/USD": "XBTUSD",
  "ETH/USD": "ETHUSD",
  "SOL/USD": "SOLUSD",
  // Also accept bare symbols as fallback
  "BTC": "XBTUSD",
  "ETH": "ETHUSD",
  "SOL": "SOLUSD",
};

/**
 * Fetch OHLCV candles from Kraken public REST API.
 * interval is in minutes: 5, 15, 240
 * count limits how many candles we request (Kraken returns up to 720).
 * Cache TTL = 75% of the interval to avoid stale data while reducing API calls.
 */
export async function fetchCandles(
  symbol: string,
  intervalMinutes: number,
  count = 200
): Promise<Candle[]> {
  const pair = KRAKEN_PAIR[symbol];
  if (!pair) throw new Error(`Unknown symbol: ${symbol}`);

  const since = Math.floor(Date.now() / 1000) - count * intervalMinutes * 60;
  const url = `https://api.kraken.com/0/public/OHLC?pair=${pair}&interval=${intervalMinutes}&since=${since}`;

  const revalidate = Math.max(30, Math.floor(intervalMinutes * 60 * 0.75));
  const res = await fetch(url, { next: { revalidate } });

  if (!res.ok) throw new Error(`Kraken HTTP ${res.status} for ${symbol} ${intervalMinutes}m`);

  const json = await res.json();
  if (json.error?.length) throw new Error(`Kraken error: ${json.error.join(", ")}`);

  const resultKey = Object.keys(json.result).find((k) => k !== "last");
  if (!resultKey) throw new Error(`No result key for ${symbol}`);

  const raw: unknown[][] = json.result[resultKey];

  return raw.map((r) => ({
    time: Number(r[0]),
    open: parseFloat(r[1] as string),
    high: parseFloat(r[2] as string),
    low: parseFloat(r[3] as string),
    close: parseFloat(r[4] as string),
    volume: parseFloat(r[6] as string),
  }));
}
