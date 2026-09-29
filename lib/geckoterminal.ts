import type { Candle } from "@/lib/kraken";

const BASE = "https://api.mexc.com";
const PAID_SYMBOL = "PAIDUSDT";
const KLINE_LIMIT = 1000;

async function mexcFetch(path: string): Promise<any> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { accept: "application/json" },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`MEXC HTTP ${res.status}`);
  return res.json();
}

function parseOhlcv(rows: any[], intervalMs: number): Candle[] {
  const now = Date.now();
  return rows.map((c: any[]) => ({
    timestamp: Number(c[0]),
    open: Number(c[1]),
    high: Number(c[2]),
    low: Number(c[3]),
    close: Number(c[4]),
    volume: Number(c[5] ?? 0),
  })).filter((c: Candle) =>
    Number.isFinite(c.timestamp) &&
    Number.isFinite(c.open) &&
    Number.isFinite(c.high) &&
    Number.isFinite(c.low) &&
    Number.isFinite(c.close) &&
    c.timestamp + intervalMs <= now
  ).sort((a: Candle, b: Candle) => a.timestamp - b.timestamp);
}

export async function getPaidOhlcv(
  timeframe: "minute" | "hour" | "day",
  aggregate: number,
  limit = 1000,
): Promise<Candle[]> {
  const interval =
    timeframe === "minute" ? `${aggregate}m` :
    timeframe === "hour" ? `${aggregate}h` :
    `${aggregate}d`;
  const data = await mexcFetch(
    `/api/v3/klines?symbol=${PAID_SYMBOL}&interval=${interval}&limit=${Math.min(limit, KLINE_LIMIT)}`,
  );
  if (!Array.isArray(data)) throw new Error("MEXC PAID OHLCV missing");
  const intervalMs =
    timeframe === "minute" ? aggregate * 60_000 :
    timeframe === "hour" ? aggregate * 3_600_000 :
    aggregate * 86_400_000;
  return parseOhlcv(data, intervalMs);
}

/** PAID-only: native MEXC daily OHLCV. PAID launched on MEXC in Sep 2026,
 * so the available daily history is intentionally limited to the token's real age.
 */
export async function getPaidAggregatedDailyCandles(): Promise<Candle[]> {
  return getPaidOhlcv("day", 1, KLINE_LIMIT);
}

export async function getPaidPrice(): Promise<number> {
  const data = await mexcFetch(`/api/v3/ticker/price?symbol=${PAID_SYMBOL}`);
  const price = Number(data?.price);
  if (!Number.isFinite(price) || price <= 0) throw new Error("MEXC PAID price unavailable");
  return price;
}

export async function getPaidMarketData(): Promise<{
  price: number;
  candles1h: Candle[];
  candles4h: Candle[];
  candles15m: Candle[];
}> {
  const [candles1h, candles4h, candles15m, ticker] = await Promise.all([
    getPaidOhlcv("hour", 1, KLINE_LIMIT),
    getPaidOhlcv("hour", 4, KLINE_LIMIT),
    getPaidOhlcv("minute", 15, KLINE_LIMIT),
    mexcFetch(`/api/v3/ticker/price?symbol=${PAID_SYMBOL}`),
  ]);
  const price = Number(ticker?.price);
  if (!Number.isFinite(price) || price <= 0) throw new Error("MEXC PAID price unavailable");
  return { price, candles1h, candles4h, candles15m };
}

export async function getPaidDailyCandles(): Promise<Candle[]> {
  return getPaidOhlcv("day", 1, 1000);
}

export function aggregatePaidDailyToWeekly(daily: Candle[]): Candle[] {
  const sorted = [...daily].sort((a, b) => a.timestamp - b.timestamp);
  const groups = new Map<string, Candle[]>();
  for (const c of sorted) {
    const d = new Date(c.timestamp);
    const day = d.getUTCDay();
    const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - ((day + 6) % 7)));
    const key = monday.toISOString().slice(0, 10);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(c);
  }
  return [...groups.values()].filter(bars => bars.length > 0).map(bars => ({
    timestamp: bars[0].timestamp,
    open: bars[0].open,
    high: Math.max(...bars.map(b => b.high)),
    low: Math.min(...bars.map(b => b.low)),
    close: bars[bars.length - 1].close,
    volume: bars.reduce((sum, b) => sum + b.volume, 0),
  })).sort((a, b) => a.timestamp - b.timestamp);
}
