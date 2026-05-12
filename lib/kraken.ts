export interface Candle {
  time: number; // Unix seconds
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type CandleSource = "KRAKEN" | "COINGECKO_DAILY" | "KRAKEN_DEGRADED";

export interface CandleWithSource {
  candles: Candle[];
  source: CandleSource;
  timestamp: number;
  degraded?: boolean;
  granularity?: string;
}

/* ----------------------------------------
   SYMBOL MAPS
---------------------------------------- */

const KRAKEN_PAIR: Record<string, string> = {
  BTC: "XXBTZUSD",  // v8.8.0 FIX: Corrected from XBTUSD to XXBTZUSD (canonical Kraken pair)
  ETH: "XETHZUSD",  // v8.8.0 FIX: Corrected from ETHUSD to XETHZUSD (canonical Kraken pair)
  SOL: "SOLUSD",
};

const COINGECKO_ID: Record<string, string> = {
  BTC: "bitcoin",
  ETH: "ethereum",
  SOL: "solana",
};

/* ----------------------------------------
   CONFIG
---------------------------------------- */

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 500;

/* ----------------------------------------
   UTIL: SYMBOL NORMALIZATION
---------------------------------------- */

function normalizeSymbol(symbol: string) {
  return symbol.includes("/") ? symbol.split("/")[0] : symbol;
}

/* ----------------------------------------
   SAFE FETCH WITH RETRY (NO RECURSION)
---------------------------------------- */

async function fetchWithRetry(url: string): Promise<Response> {
  let retries = 0;

  while (retries <= MAX_RETRIES) {
    try {
      const res = await fetch(url);

      // RATE LIMIT
      if (res.status === 429) {
        const retryAfter = res.headers.get("Retry-After");
        const delay =
          retryAfter
            ? parseInt(retryAfter) * 1000
            : BASE_DELAY_MS * Math.pow(2, retries);

        if (retries === MAX_RETRIES) return res;

        console.log(`[API] 429 rate limit — retrying in ${delay}ms`);
        await new Promise((r) => setTimeout(r, delay));
        retries++;
        continue;
      }

      // SERVER ERRORS
      if (!res.ok && res.status >= 500) {
        if (retries === MAX_RETRIES) return res;

        const delay = BASE_DELAY_MS * Math.pow(2, retries);
        console.log(`[API] ${res.status} error — retrying in ${delay}ms`);
        await new Promise((r) => setTimeout(r, delay));
        retries++;
        continue;
      }

      return res;
    } catch (err) {
      if (retries === MAX_RETRIES) throw err;

      const delay = BASE_DELAY_MS * Math.pow(2, retries);
      console.log(`[API] network error — retrying in ${delay}ms`);
      await new Promise((r) => setTimeout(r, delay));
      retries++;
    }
  }

  throw new Error("fetchWithRetry failed unexpectedly");
}

/* ----------------------------------------
   COINGECKO FALLBACK (DAILY ONLY)
---------------------------------------- */

async function fetchFromCoinGecko(symbol: string): Promise<CandleWithSource> {
  const coinId = COINGECKO_ID[symbol];
  if (!coinId) throw new Error(`Unsupported CoinGecko symbol: ${symbol}`);

  const url = `https://api.coingecko.com/api/v3/coins/${coinId}/ohlc?vs_currency=usd&days=90`;

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`CoinGecko HTTP ${res.status}`);
  }

  const json = await res.json();
  if (!Array.isArray(json) || json.length === 0) {
    throw new Error("Invalid CoinGecko response");
  }

  const candles: Candle[] = json.map((row: any[]) => ({
    time: Math.floor(row[0] / 1000),
    open: row[1],
    high: row[2],
    low: row[3],
    close: row[4],
    volume: 0, // no volume available
  }));

  return {
    candles: candles.slice(-200),
    source: "COINGECKO_DAILY",
    timestamp: Date.now(),
    degraded: true,
    granularity: "1D",
  };
}

/* ----------------------------------------
   MAIN FETCHER (KRAKEN PRIMARY)
---------------------------------------- */

export async function fetchCandles(
  symbol: string,
  intervalMinutes: number,
  count = 200
): Promise<CandleWithSource> {
  const normalized = normalizeSymbol(symbol);
  const pair = KRAKEN_PAIR[normalized];

  if (!pair) throw new Error(`Unknown symbol: ${symbol}`);

  // ⚠️ BLOCK COINGECKO FOR INTRADAY TIMEFRAMES
  const canUseFallback = intervalMinutes >= 1440;

  try {
    const since =
      Math.floor(Date.now() / 1000) - count * intervalMinutes * 60;

    const url = `https://api.kraken.com/0/public/OHLC?pair=${pair}&interval=${intervalMinutes}&since=${since}`;

    console.log(`[KRAKEN] fetching ${symbol} ${intervalMinutes}m`);

    const res = await fetchWithRetry(url);

    if (!res.ok) {
      throw new Error(`Kraken HTTP ${res.status}`);
    }

    const json = await res.json();

    if (json.error?.length) {
      throw new Error(`Kraken error: ${json.error.join(", ")}`);
    }

    const key = Object.keys(json.result).find((k) => k !== "last");
    if (!key) throw new Error("No OHLC data returned");

    const raw: any[][] = json.result[key];

    if (!Array.isArray(raw) || raw.length === 0) {
      throw new Error("Invalid Kraken OHLC data");
    }

    const candles: Candle[] = raw.map((r) => ({
      time: Number(r[0]),
      open: parseFloat(r[1]),
      high: parseFloat(r[2]),
      low: parseFloat(r[3]),
      close: parseFloat(r[4]),
      volume: parseFloat(r[6]),
    }));

    return {
      candles,
      source: "KRAKEN",
      timestamp: Date.now(),
    };
  } catch (err) {
    console.warn(`[KRAKEN FAILOVER] ${symbol}:`, err);

    if (!canUseFallback) {
      throw new Error(
        `Kraken failed and fallback disabled for ${intervalMinutes}m timeframe`
      );
    }

    console.log(`[FALLBACK] switching to CoinGecko (daily only)`);

    return fetchFromCoinGecko(normalized);
  }
}
