// lib/kraken.ts — Kraken Exchange API Client
// ============================================================
// Kraken API client with paginated historical backfill for 350+ candles

export type Symbol = "BTC" | "ETH" | "SOL" | "HYPE";
const BASE_URL = "https://api.kraken.com/0/public";

const SYMBOL_MAP: Record<string, string> = {
  BTC: "XXBTZUSD",
  ETH: "XETHZUSD",
  SOL: "SOLUSD",
  HYPE: "HYPEUSD",
};

export interface Candle {
  timestamp: number;
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

export async function getCurrentPrice(pair: Symbol): Promise<number> {
  const symbol = SYMBOL_MAP[pair];
  if (!symbol) throw new Error(`Unknown pair: ${pair}`);

  try {
    const res = await fetch(`https://api.kraken.com/0/public/Ticker?pair=${symbol}`);
    const data = await res.json();
    if (data.error && data.error.length) throw new Error(data.error[0]);
    const result = data.result;
    const key = Object.keys(result)[0];
    const price = parseFloat(result[key].c[0]);
    return price;
  } catch (e) {
    console.error(`[KRAKEN] Price fetch failed for ${pair}:`, e);
    throw e;
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

export async function getCandles(pair: Symbol, intervalMinutes: number): Promise<Candle[]> {
  const symbol = SYMBOL_MAP[pair];
  if (!symbol) throw new Error(`Unknown pair: ${pair}`);

  // Kraken intervals: 1, 5, 15, 30, 60, 240, 1440, 10080, 21600
  const krakenInterval = intervalMinutes;
  const since = Math.floor((Date.now() - 30 * 24 * 60 * 60 * 1000) / 1000); // 30 days back

  try {
    const res = await fetch(
      `https://api.kraken.com/0/public/OHLC?pair=${symbol}&interval=${krakenInterval}&since=${since}`
    );
    const data = await res.json();
    if (data.error && data.error.length) throw new Error(data.error[0]);
    const result = data.result;
    const key = Object.keys(result)[0];
    const raw = result[key];

    return raw.map((c: any[]) => ({
      timestamp: c[0] * 1000,
      open: parseFloat(c[1]),
      high: parseFloat(c[2]),
      low: parseFloat(c[3]),
      close: parseFloat(c[4]),
      volume: parseFloat(c[6]),
    }));
  } catch (e) {
    console.error(`[KRAKEN] Candles fetch failed for ${pair} ${intervalMinutes}m:`, e);
    throw e;
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
