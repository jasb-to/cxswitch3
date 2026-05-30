import { Candle, Symbol } from "./strategy";

const KRAKEN_PAIRS: Record<Symbol, string> = {
  BTC: "XXBTZUSD",
  ETH: "XETHZUSD",
  SOL: "SOLUSD",
};

export async function fetchCandles(
  symbol: Symbol,
  interval: number
): Promise<Candle[]> {
  try {
    const pair = KRAKEN_PAIRS[symbol];
    const url = `https://api.kraken.com/0/public/OHLC?pair=${pair}&interval=${interval}`;

    const res = await fetch(url, { 
      cache: "no-store",
      timeout: 10000, // 10 second timeout per request
    });
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

export async function getCandles5M(symbol: Symbol): Promise<Candle[]> {
  return fetchCandles(symbol, 5);
}

// Fetch live current price from Kraken ticker
export async function getCurrentPrice(symbol: Symbol): Promise<number> {
  try {
    const pair = KRAKEN_PAIRS[symbol];
    const url = `https://api.kraken.com/0/public/Ticker?pair=${pair}`;

    const res = await fetch(url, {
      cache: "no-store",
      timeout: 10000,
    });

    if (!res.ok) {
      console.error(`[KRAKEN] Error fetching ticker for ${pair}: ${res.status}`);
      return 0;
    }

    const data = await res.json();

    if (data.error && data.error.length > 0) {
      console.error(`[KRAKEN] Ticker API error for ${pair}: ${data.error.join(", ")}`);
      return 0;
    }

    // Kraken ticker format: { pair: { a: [ask, ...], b: [bid, ...], c: [last, ...], ... } }
    const key = Object.keys(data.result || {}).find((k) => k !== "last");
    if (!key) {
      console.warn(`[KRAKEN] No ticker data found for ${pair}`);
      return 0;
    }

    // Get last trade price (index 0 of the "c" array is the price)
    const tickerData = data.result[key];
    const lastPrice = Number(tickerData.c?.[0] || 0);

    if (lastPrice === 0) {
      console.warn(`[KRAKEN] Invalid price data for ${pair}`);
      return 0;
    }

    console.log(`[KRAKEN] Current price for ${pair}: $${lastPrice.toFixed(2)}`);
    return lastPrice;
  } catch (err) {
    console.error(`[KRAKEN] Ticker fetch error: ${err}`);
    return 0;
  }
}
