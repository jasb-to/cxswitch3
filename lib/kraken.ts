// lib/kraken.ts — Kraken Exchange API Client
// ============================================================

export type Symbol = "BTC" | "ETH" | "SOL" | "HYPE";

const SYMBOL_MAP: Record<string, string> = {
  BTC: "XXBTZUSD",
  ETH: "XETHZUSD",
  SOL: "SOLUSD",
  HYPE: "HYPEUSD",
};

export interface Candle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
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
  }
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
  }
}
