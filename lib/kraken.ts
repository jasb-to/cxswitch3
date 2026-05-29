import { Candle, Symbol } from "./strategy";

const KRAKEN_PAIRS: Record<Symbol, string> = {
  BTC: "XXBTZUSD",
  ETH: "XETHZUSD",
  SOL: "SOLUSD",
};

const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes
const candle_cache = new Map<
  string,
  { candles: Candle[]; timestamp: number }
>();

export async function fetchCandles(
  symbol: Symbol,
  interval: number
): Promise<Candle[]> {
  const cacheKey = `${symbol}_${interval}`;
  const cached = candle_cache.get(cacheKey);
  const now = Date.now();

  // Return cached if still valid
  if (cached && now - cached.timestamp < CACHE_DURATION) {
    console.log(
      `[KRAKEN] Cache hit for ${symbol} ${interval}m (${Math.round((now - cached.timestamp) / 1000)}s old)`
    );
    return cached.candles;
  }

  try {
    const pair = KRAKEN_PAIRS[symbol];
    const url = `https://api.kraken.com/0/public/OHLC?pair=${pair}&interval=${interval}`;

    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) {
      console.error(`[KRAKEN] Error fetching ${pair}: ${res.status}`);
      return [];
    }

    const data = await res.json();

    if (data.error && data.error.length > 0) {
      console.error(`[KRAKEN] API error for ${pair}: ${data.error.join(", ")}`);
      return [];
    }

    // Kraken returns data in format: { pairname: [[time, o, h, l, c, vwap, vol, count], ...], last: N }
    const key = Object.keys(data.result || {}).find((k) => k !== "last");
    if (!key || !Array.isArray(data.result[key])) {
      console.warn(`[KRAKEN] No OHLC data found for ${pair}`);
      return [];
    }

    const candles: Candle[] = data.result[key].map((row: any[]) => ({
      time: Number(row[0]) * 1000,
      open: Number(row[1]),
      high: Number(row[2]),
      low: Number(row[3]),
      close: Number(row[4]),
      volume: Number(row[6]),
    }));

    // Cache it
    candle_cache.set(cacheKey, { candles, timestamp: now });

    console.log(
      `[KRAKEN] Fetched ${candles.length} candles for ${pair} (${interval}m)`
    );

    return candles;
  } catch (err) {
    console.error(`[KRAKEN] Fetch error: ${err}`);
    return [];
  }
}

export async function getCandles4H(symbol: Symbol): Promise<Candle[]> {
  return fetchCandles(symbol, 240);
}

export async function getCandles15M(symbol: Symbol): Promise<Candle[]> {
  return fetchCandles(symbol, 15);
}
