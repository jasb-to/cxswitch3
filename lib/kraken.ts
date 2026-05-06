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
 * Fetch OHLCV candles from Kraken public REST API.
 * interval is in minutes: 5, 15, 240
 * count limits how many candles we request (Kraken returns up to 720).
 * Cache TTL = 75% of the interval to avoid stale data while reducing API calls.
 * Includes automatic retry logic for resilience.
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

  try {
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

    return raw.map((r) => ({
      time: Number(r[0]),
      open: parseFloat(r[1] as string),
      high: parseFloat(r[2] as string),
      low: parseFloat(r[3] as string),
      close: parseFloat(r[4] as string),
      volume: parseFloat(r[6] as string),
    }));
  } catch (err) {
    console.error(
      `[KRAKEN] ✗ Failed to fetch ${intervalMinutes}m candles for ${symbol}:`,
      err instanceof Error ? err.message : String(err)
    );
    throw err;
  }
}
