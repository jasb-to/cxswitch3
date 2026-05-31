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

const BASE = "https://api.kraken.com/0/public";

/* =========================
   SYMBOL MAP
========================= */

function pair(symbol: Symbol) {
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
   CORE FETCH
========================= */

async function fetchOHLC(symbol: Symbol, interval: number) {
  const res = await fetch(
    `${BASE}/OHLC?pair=${pair(symbol)}&interval=${interval}`
  );

  if (!res.ok) throw new Error(`Kraken OHLC failed`);

  const json = await res.json();
  const data = json.result?.[pair(symbol)];

  if (!data) return [];

  return data.map((c: any[]) => ({
    time: Number(c[0]),
    open: Number(c[1]),
    high: Number(c[2]),
    low: Number(c[3]),
    close: Number(c[4]),
    volume: Number(c[6]),
  }));
}

/* =========================
   PUBLIC API (MATCH YOUR APP)
========================= */

export async function getCandles5M(symbol: Symbol): Promise<Candle[]> {
  return fetchOHLC(symbol, 5);
}

export async function getCandles15M(symbol: Symbol): Promise<Candle[]> {
  return fetchOHLC(symbol, 15);
}

export async function getCandles4H(symbol: Symbol): Promise<Candle[]> {
  return fetchOHLC(symbol, 240);
}

export async function getCurrentPrice(symbol: Symbol): Promise<number> {
  const res = await fetch(
    `${BASE}/Ticker?pair=${pair(symbol)}`
  );

  if (!res.ok) throw new Error(`Kraken ticker failed`);

  const json = await res.json();
  const data = json.result?.[pair(symbol)];

  if (!data?.c?.[0]) return 0;

  return Number(data.c[0]);
}
