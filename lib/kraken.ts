import type { Candle, Symbol } from "./strategy";

const KRAKEN_BASE = "https://api.kraken.com/0/public";

/* =========================
   SYMBOL MAPPING
========================= */

function mapSymbol(symbol: Symbol) {
  switch (symbol) {
    case "BTC":
      return "XXBTZUSD";
    case "ETH":
      return "XETHZUSD";
    case "SOL":
      return "SOLUSD";
    default:
      return "XXBTZUSD";
  }
}

/* =========================
   SAFE FETCH WRAPPER
========================= */

async function fetchKraken(url: string) {
  try {
    const res = await fetch(url);

    if (!res.ok) {
      console.error(`[KRAKEN] HTTP error ${res.status}`);
      return null;
    }

    const data = await res.json();

    if (data?.error?.length) {
      console.error(`[KRAKEN] API error`, data.error);
      return null;
    }

    return data.result;
  } catch (err) {
    console.error(`[KRAKEN] Fetch failed`, err);
    return null;
  }
}

/* =========================
   CANDLE PARSER
========================= */

function parseCandles(raw: any): Candle[] {
  if (!raw) return [];

  const key = Object.keys(raw)[0];
  const arr = raw[key];

  if (!Array.isArray(arr)) return [];

  return arr.map((c: any) => ({
    time: Number(c[0]),
    open: Number(c[1]),
    high: Number(c[2]),
    low: Number(c[3]),
    close: Number(c[4]),
    volume: Number(c[6]),
  }));
}

/* =========================
   TIMEFRAMES
========================= */

export async function getCandles4H(symbol: Symbol): Promise<Candle[]> {
  return getCandles(symbol, 240);
}

export async function getCandles15M(symbol: Symbol): Promise<Candle[]> {
  return getCandles(symbol, 15);
}

export async function getCandles5M(symbol: Symbol): Promise<Candle[]> {
  return getCandles(symbol, 5);
}

/* =========================
   CORE CANDLE FETCH
========================= */

async function getCandles(symbol: Symbol, interval: number): Promise<Candle[]> {
  const pair = mapSymbol(symbol);

  const url = `${KRAKEN_BASE}/OHLC?pair=${pair}&interval=${interval}`;

  const result = await fetchKraken(url);

  const candles = parseCandles(result);

  if (!candles.length) {
    console.warn(`[KRAKEN] No candles returned for ${symbol} (${interval}m)`);
    return [];
  }

  // Ensure sorted oldest → newest
  return candles.sort((a, b) => a.time - b.time);
}

/* =========================
   CURRENT PRICE (FIXED)
========================= */

export async function getCurrentPrice(symbol: Symbol): Promise<number> {
  const pair = mapSymbol(symbol);

  const url = `${KRAKEN_BASE}/Ticker?pair=${pair}`;

  const result = await fetchKraken(url);

  if (!result) return 0;

  const key = Object.keys(result)[0];

  const price = result?.[key]?.c?.[0];

  const parsed = Number(price);

  if (!parsed || isNaN(parsed)) {
    console.warn(`[KRAKEN] Invalid price for ${symbol}`);
    return 0;
  }

  return parsed;
}
