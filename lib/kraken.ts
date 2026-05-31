// kraken.ts

export type Symbol = "BTC" | "ETH" | "SOL";

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

const KRAKEN_BASE = "https://api.kraken.com/0/public";

/* =========================
   SYMBOL MAP
========================= */

function getKrakenPair(symbol: Symbol) {
  switch (symbol) {
    case "BTC":
      return "XXBTZUSD";
    case "ETH":
      return "XETHZUSD";
    case "SOL":
      return "SOLUSD";
  }
}

/* =========================
   FETCH CANDLES
========================= */

export async function fetchCandles(
  symbol: Symbol,
  interval: 5 | 15 | 60 | 240 = 15,
  limit = 500
): Promise<Candle[]> {
  const pair = getKrakenPair(symbol);

  const url = `${KRAKEN_BASE}/OHLC?pair=${pair}&interval=${interval}`;

  const res = await fetch(url);

  if (!res.ok) {
    throw new Error(`Kraken OHLC failed: ${res.status}`);
  }

  const json = await res.json();

  const data = json.result?.[pair];

  if (!data || !Array.isArray(data)) {
    throw new Error(`Invalid OHLC response for ${symbol}`);
  }

  return data.slice(-limit).map((c: any[]) => ({
    time: Number(c[0]),
    open: Number(c[1]),
    high: Number(c[2]),
    low: Number(c[3]),
    close: Number(c[4]),
    volume: Number(c[6]),
  }));
}

/* =========================
   LIVE PRICE
========================= */

export async function fetchLivePrice(symbol: Symbol): Promise<number> {
  const pair = getKrakenPair(symbol);

  const url = `${KRAKEN_BASE}/Ticker?pair=${pair}`;

  const res = await fetch(url);

  if (!res.ok) {
    throw new Error(`Kraken ticker failed: ${res.status}`);
  }

  const json = await res.json();

  const result = json.result?.[pair];

  if (!result?.c?.[0]) {
    throw new Error(`Invalid ticker response for ${symbol}`);
  }

  return Number(result.c[0]);
}

/* =========================
   BATCH HELPER (IMPORTANT)
========================= */

export async function fetchMarketData(symbol: Symbol) {
  const [c5, c15, c240, price] = await Promise.all([
    fetchCandles(symbol, 5),
    fetchCandles(symbol, 15),
    fetchCandles(symbol, 240),
    fetchLivePrice(symbol),
  ]);

  return {
    symbol,
    candles5m: c5,
    candles15m: c15,
    candles4h: c240,
    price,
  };
}
