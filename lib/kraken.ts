// Kraken API client with paginated historical backfill for 350+ candles

const BASE_URL = "https://api.kraken.com/0/public";

export interface KrakenCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  vwap: number;
  volume: number;
  count: number;
}

interface KrakenResponse {
  error: string[];
  result: {
    [pair: string]: KrakenCandle[];
  };
}

// Map trading pairs to Kraken pair format
const PAIR_MAP: Record<string, string> = {
  BTC: "XXBTZUSD",
  ETH: "XETHZUSD",
  SOL: "SOLZUSD",
  HYPE: "HYPEUSD",
};

/**
 * Fetch OHLC data from Kraken with automatic pagination to accumulate 350+ candles
 * Kraken returns max 720 candles per call, but we paginate to ensure full history
 */
export async function fetchKrakenOHLC(pair: string, interval: number = 240): Promise<KrakenCandle[]> {
  const krakenPair = PAIR_MAP[pair] || pair;
  const allCandles: KrakenCandle[] = [];
  let since: number | null = null;
  const maxRetries = 5; // Max 5 pagination rounds = ~3600 candles worth of data
  let round = 0;

  while (round < maxRetries) {
    try {
      const params = new URLSearchParams({
        pair: krakenPair,
        interval: interval.toString(),
      });

      if (since) {
        params.append("since", since.toString());
      }

      const response = await fetch(`${BASE_URL}/OHLC?${params}`, {
        method: "GET",
        headers: { "User-Agent": "cx-trading-bot" },
      });

      if (!response.ok) {
        console.error(`[v0] Kraken API error: ${response.status}`);
        break;
      }

      const data: KrakenResponse = await response.json();

      if (data.error.length > 0) {
        console.error(`[v0] Kraken API error: ${data.error[0]}`);
        break;
      }

      const candles = data.result[krakenPair] || [];

      if (candles.length === 0) {
        console.log(`[v0] Kraken pagination complete: ${allCandles.length} total candles fetched`);
        break;
      }

      allCandles.push(...candles);
      console.log(`[v0] Kraken round ${round + 1}: fetched ${candles.length} candles (total: ${allCandles.length})`);

      // Kraken returns timestamp for "since" in last candle of response
      const lastCandle = candles[candles.length - 1];
      since = lastCandle.time;

      // If we've accumulated 350+ candles, stop paginating
      if (allCandles.length >= 350) {
        console.log(`[v0] Target reached: ${allCandles.length} >= 350 candles`);
        break;
      }

      // Small delay to respect rate limits
      await new Promise(resolve => setTimeout(resolve, 100));
      round++;
    } catch (error) {
      console.error(`[v0] Kraken fetch error round ${round + 1}:`, error);
      break;
    }
  }

  // Sort by timestamp ascending (oldest first)
  allCandles.sort((a, b) => a.time - b.time);

  // Log acquisition status
  const status = allCandles.length >= 350 ? "READY" : "WARMING_UP";
  console.log(`[v0] ${pair}: 4H candles ${allCandles.length} — ${status}`);

  return allCandles;
}

/**
 * Batch fetch OHLC for multiple pairs
 */
export async function fetchBatchOHLC(pairs: string[]): Promise<Record<string, KrakenCandle[]>> {
  const results: Record<string, KrakenCandle[]> = {};

  for (const pair of pairs) {
    results[pair] = await fetchKrakenOHLC(pair);
  }

  return results;
}
