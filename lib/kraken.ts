export interface Candle {
  time: number;   // Unix seconds
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface CandleWithSource {
  candles: Candle[];
  source: "KRAKEN" | "COINGECKO";
  timestamp: number;
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

const COINGECKO_ID: Record<string, string> = {
  "BTC": "bitcoin",
  "ETH": "ethereum",
  "SOL": "solana",
};

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 500;

/**
 * Fetch with automatic retry logic and rate limit handling.
 * Implements exponential backoff: 500ms, 1000ms, 2000ms
 * Respects Retry-After header for 429 responses.
 */
async function fetchWithRetry(url: string, retries = 0): Promise<Response> {
  try {
    const res = await fetch(url);

    // Handle rate limiting specially
    if (res.status === 429) {
      const retryAfter = res.headers.get("Retry-After");
      const delay = retryAfter ? parseInt(retryAfter) * 1000 : BASE_DELAY_MS * Math.pow(2, retries);

      if (retries < MAX_RETRIES) {
        console.log(
          `[KRAKEN] 429 rate limit — waiting ${delay}ms before retry ${retries + 1}/${MAX_RETRIES}`
        );
        await new Promise((r) => setTimeout(r, delay));
        return fetchWithRetry(url, retries + 1);
      }
      console.error(`[KRAKEN] ✗ Rate limited after ${MAX_RETRIES} retries`);
      return res; // Return 429 response to let caller handle
    }

    // Retry on other temporary errors (5xx, timeouts)
    if (!res.ok && res.status >= 500 && retries < MAX_RETRIES) {
      const delay = BASE_DELAY_MS * Math.pow(2, retries);
      console.log(
        `[KRAKEN] ${res.status} error — retrying in ${delay}ms (${retries + 1}/${MAX_RETRIES})`
      );
      await new Promise((r) => setTimeout(r, delay));
      return fetchWithRetry(url, retries + 1);
    }

    return res;
  } catch (err) {
    // Network errors: retry with backoff
    if (retries < MAX_RETRIES) {
      const delay = BASE_DELAY_MS * Math.pow(2, retries);
      console.log(
        `[KRAKEN] Network error — retrying in ${delay}ms (${retries + 1}/${MAX_RETRIES})`
      );
      await new Promise((r) => setTimeout(r, delay));
      return fetchWithRetry(url, retries + 1);
    }
    console.error(`[KRAKEN] ✗ Network error after ${MAX_RETRIES} retries:`, err);
    throw err;
  }
}

/**
 * Fetch OHLCV data from CoinGecko as backup when Kraken fails.
 * Returns data in same Candle format for seamless fallback.
 * CoinGecko free tier returns daily OHLC data; we aggregate as needed.
 */
async function fetchCandlesFromCoinGecko(
  symbol: string,
  intervalMinutes: number,
  count = 200
): Promise<CandleWithSource> {
  const coinId = COINGECKO_ID[symbol];
  if (!coinId) throw new Error(`Unknown symbol for CoinGecko: ${symbol}`);

  try {
    // CoinGecko market_chart with ohlc endpoint: returns daily OHLC for last 90 days
    // This is the only granularity CoinGecko free tier provides
    const days = Math.min(90, Math.ceil((count * intervalMinutes) / (60 * 24)) + 1);
    const url = `https://api.coingecko.com/api/v3/coins/${coinId}/ohlc?vs_currency=usd&days=${days}`;
    
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`CoinGecko HTTP ${res.status}`);
    }

    const json = await res.json();
    const ohlcData = json as [number, number, number, number, number][]; // [timestamp_ms, open, high, low, close]
    
    if (!ohlcData?.length) {
      throw new Error(`No OHLC data from CoinGecko for ${coinId}`);
    }

    // Convert daily OHLC to candle format, take last count candles
    const candles: Candle[] = ohlcData.slice(-count).map((row) => ({
      time: Math.floor(row[0] / 1000), // Convert ms to seconds
      open: row[1],
      high: row[2],
      low: row[3],
      close: row[4],
      volume: 0, // CoinGecko free tier doesn't provide volume
    }));

    console.log(`[COINGECKO] ✓ Fetched ${candles.length} OHLC candles for ${symbol} (backup source, daily granularity)`);
    return {
      candles,
      source: "COINGECKO",
      timestamp: Date.now(),
    };
  } catch (err) {
    console.error(
      `[COINGECKO] ✗ Failed to fetch candles for ${symbol}:`,
      err instanceof Error ? err.message : String(err)
    );
    throw err;
  }
}

/**
 * Fetch OHLCV candles with automatic failover.
 * PRIMARY: Try Kraken (fast, accurate 15M/4H candles)
 * FALLBACK: Use CoinGecko if Kraken fails (slower, daily granularity, no volume)
 */
export async function fetchCandles(
  symbol: string,
  intervalMinutes: number,
  count = 200
): Promise<CandleWithSource> {
  const pair = KRAKEN_PAIR[symbol];
  if (!pair) throw new Error(`Unknown symbol: ${symbol}`);

  // PRIMARY: Try Kraken first
  try {
    const since = Math.floor(Date.now() / 1000) - count * intervalMinutes * 60;
    const url = `https://api.kraken.com/0/public/OHLC?pair=${pair}&interval=${intervalMinutes}&since=${since}`;

    const revalidate = Math.max(30, Math.floor(intervalMinutes * 60 * 0.75));
    const res = await fetchWithRetry(url);

    if (!res.ok) {
      throw new Error(
        `Kraken HTTP ${res.status} for ${pair} ${intervalMinutes}m after ${MAX_RETRIES} retries`
      );
    }

    const json = await res.json();
    if (json.error?.length) {
      throw new Error(`Kraken API error: ${json.error.join(", ")}`);
    }

    const resultKey = Object.keys(json.result).find((k) => k !== "last");
    if (!resultKey) {
      throw new Error(`No OHLC data for ${pair}`);
    }

    const raw: unknown[][] = json.result[resultKey];
    console.log(`[KRAKEN] ✓ Fetched ${raw.length} ${intervalMinutes}m candles for ${pair}`);

    return {
      candles: raw.map((r) => ({
        time: Number(r[0]),
        open: parseFloat(r[1] as string),
        high: parseFloat(r[2] as string),
        low: parseFloat(r[3] as string),
        close: parseFloat(r[4] as string),
        volume: parseFloat(r[6] as string),
      })),
      source: "KRAKEN",
      timestamp: Date.now(),
    };
  } catch (krakenErr) {
    console.warn(`[KRAKEN FAILOVER] Kraken failed, attempting CoinGecko backup: ${krakenErr instanceof Error ? krakenErr.message : String(krakenErr)}`);

    // FALLBACK: Try CoinGecko
    try {
      return await fetchCandlesFromCoinGecko(symbol, intervalMinutes, count);
    } catch (coinGeckoErr) {
      console.error(
        `[FAILOVER] ✗ Both Kraken and CoinGecko failed for ${symbol}:`,
        `Kraken: ${krakenErr instanceof Error ? krakenErr.message : String(krakenErr)}`,
        `CoinGecko: ${coinGeckoErr instanceof Error ? coinGeckoErr.message : String(coinGeckoErr)}`
      );
      throw new Error(`All data sources failed for ${symbol}`);
    }
  }
}
