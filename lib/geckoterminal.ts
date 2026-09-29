import type { Candle } from "@/lib/kraken";

const BASE = "https://api.geckoterminal.com/api/v2";
const PAID_POOL = "0x633a0b2a75eb609cf388996f88d0739fe9ea2c80fad339d6e56fc1abc968e526";
const VERSION = "20230203";
const FOUR_H_LIMIT = 1000;
const FOUR_H_BACKFILL_PAGES = 3;

async function gtFetch(path: string): Promise<any> {
  const res = await fetch(`${BASE}${path}`, {
    headers: {
      accept: `application/json;version=${VERSION}`,
    },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`GeckoTerminal HTTP ${res.status}`);
  return res.json();
}

function parseOhlcv(rows: any[], intervalMs: number): Candle[] {
  const now = Date.now();
  return rows
    .map((c: any[]) => ({
      timestamp: Number(c[0]) * 1000,
      open: Number(c[1]),
      high: Number(c[2]),
      low: Number(c[3]),
      close: Number(c[4]),
      volume: Number(c[5] ?? 0),
    }))
    .filter(
      (c: Candle) =>
        Number.isFinite(c.timestamp) &&
        Number.isFinite(c.open) &&
        Number.isFinite(c.high) &&
        Number.isFinite(c.low) &&
        Number.isFinite(c.close) &&
        c.timestamp + intervalMs <= now,
    )
    .sort((a: Candle, b: Candle) => a.timestamp - b.timestamp);
}

export async function getPaidOhlcv(
  timeframe: "minute" | "hour" | "day",
  aggregate: number,
  limit = 1000,
): Promise<Candle[]> {
  const data = await gtFetch(
    `/networks/base/pools/${PAID_POOL}/ohlcv/${timeframe}?aggregate=${aggregate}&limit=${Math.min(limit, 1000)}`,
  );
  const rows = data?.data?.attributes?.ohlcv_list;
  if (!Array.isArray(rows)) throw new Error("GeckoTerminal OHLCV missing");

  const intervalMs =
    timeframe === "minute"
      ? aggregate * 60_000
      : timeframe === "hour"
        ? aggregate * 3_600_000
        : aggregate * 86_400_000;

  return parseOhlcv(rows, intervalMs);
}

/**
 * PAID's native daily endpoint currently exposes only ~183 candles.
 * Build the 1D series from genuine 4H OHLCV instead: six complete 4H
 * candles = one UTC day. No prices/candles are fabricated.
 *
 * We page backwards using GeckoTerminal's before_timestamp parameter so
 * the 1D engine can see the full available pool history.
 */
export async function getPaidAggregatedDailyCandles(): Promise<Candle[]> {
  const intervalMs = 4 * 3_600_000;
  const all = new Map<number, Candle>();
  let beforeTimestamp: number | undefined;

  for (let page = 0; page < FOUR_H_BACKFILL_PAGES; page++) {
    const suffix = beforeTimestamp ? `&before_timestamp=${beforeTimestamp}` : "";
    const data = await gtFetch(
      `/networks/base/pools/${PAID_POOL}/ohlcv/hour?aggregate=4&limit=${FOUR_H_LIMIT}${suffix}`,
    );
    const rows = data?.data?.attributes?.ohlcv_list;
    if (!Array.isArray(rows) || rows.length === 0) break;

    const candles = parseOhlcv(rows, intervalMs);
    if (!candles.length) break;

    for (const candle of candles) all.set(candle.timestamp, candle);

    const oldest = Math.min(...candles.map(c => c.timestamp));
    const nextBefore = Math.floor(oldest / 1000) - 1;
    if (!Number.isFinite(nextBefore) || nextBefore >= (beforeTimestamp ?? Infinity)) break;
    beforeTimestamp = nextBefore;

    if (candles.length < FOUR_H_LIMIT) break;
  }

  const sorted = [...all.values()].sort((a, b) => a.timestamp - b.timestamp);
  const daily: Candle[] = [];

  // Do not align to calendar dates: PAID's pool candles are not guaranteed
  // to start at midnight UTC. Build days from six genuinely contiguous 4H
  // candles, preserving the real OHLCV data and skipping gaps.
  for (let i = 0; i + 5 < sorted.length; ) {
    const block = sorted.slice(i, i + 6);
    let contiguous = true;

    for (let j = 1; j < block.length; j++) {
      if (block[j].timestamp - block[j - 1].timestamp !== intervalMs) {
        contiguous = false;
        break;
      }
    }

    if (contiguous) {
      daily.push({
        timestamp: block[0].timestamp,
        open: block[0].open,
        high: Math.max(...block.map(b => b.high)),
        low: Math.min(...block.map(b => b.low)),
        close: block[5].close,
        volume: block.reduce((sum, b) => sum + b.volume, 0),
      });
      i += 6;
    } else {
      i += 1;
    }
  }

  return daily.sort((a, b) => a.timestamp - b.timestamp);
}

export async function getPaidPrice(): Promise<number> {
  const candles = await getPaidOhlcv("minute", 15, 2);
  const price = candles.at(-1)?.close;
  if (!Number.isFinite(price) || !price || price <= 0) {
    throw new Error("GeckoTerminal PAID price unavailable");
  }
  return price;
}

export async function getPaidMarketData(): Promise<{
  price: number;
  candles1h: Candle[];
  candles4h: Candle[];
  candles15m: Candle[];
}> {
  const [candles1h, candles4h, candles15m] = await Promise.all([
    getPaidOhlcv("hour", 1, 1000),
    getPaidOhlcv("hour", 4, 1000),
    getPaidOhlcv("minute", 15, 1000),
  ]);
  const price = candles15m.at(-1)?.close ?? candles1h.at(-1)?.close;
  if (!Number.isFinite(price) || !price || price <= 0) {
    throw new Error("GeckoTerminal PAID price unavailable");
  }
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
  return [...groups.values()]
    .filter(bars => bars.length > 0)
    .map(bars => ({
      timestamp: bars[0].timestamp,
      open: bars[0].open,
      high: Math.max(...bars.map(b => b.high)),
      low: Math.min(...bars.map(b => b.low)),
      close: bars[bars.length - 1].close,
      volume: bars.reduce((sum, b) => sum + b.volume, 0),
    }))
    .sort((a, b) => a.timestamp - b.timestamp);
}
