import type { Candle } from "@/lib/kraken";

const BASE = "https://api.geckoterminal.com/api/v2";

// PAID is the Solana token, not the legacy "paid-network" Base asset.
// CoinGecko/GeckoTerminal identifies the Solana mint as:
// 98kfF7rmsg1QDUEoCqNE7g7M1FdrTt92TEp2CLzypump
const PAID_POOL = "Gc5hVCBydc6k3Z7oc2cQEW4GThFQi2Fqk5HfKABqa2q8";
const KLINE_LIMIT = 1000;
const PAID_429_RETRIES = 3;

function sleep(ms:number){return new Promise(resolve=>setTimeout(resolve,ms));}

async function geckoFetch(path: string): Promise<any> {
  for(let attempt=0;attempt<=PAID_429_RETRIES;attempt++){
    const res = await fetch(`${BASE}${path}`, {
      headers: {
        accept: "application/json",
        "x-cg-demo-api-key": process.env.COINGECKO_API_KEY ?? "",
      },
      cache: "no-store",
    });

    if(res.ok)return res.json();

    if(res.status===429&&attempt<PAID_429_RETRIES){
      const retryAfter=Number(res.headers.get("retry-after"));
      const delay=Number.isFinite(retryAfter)&&retryAfter>0
        ? Math.min(retryAfter*1000,10000)
        : 1000*Math.pow(2,attempt);
      console.warn(`[PAID] GeckoTerminal 429 — retry ${attempt+1}/${PAID_429_RETRIES} in ${delay}ms`);
      await sleep(delay);
      continue;
    }

    throw new Error(`GeckoTerminal HTTP ${res.status}`);
  }
  throw new Error("GeckoTerminal PAID request exhausted retries");
}

function parseOhlcv(rows: any[][], intervalMs: number): Candle[] {
  const now = Date.now();
  return rows
    .map((row) => {
      const [timestamp, open, high, low, close, volume] = row.map(Number);
      return {
        timestamp: timestamp * 1000,
        open,
        high,
        low,
        close,
        volume: Number.isFinite(volume) ? volume : 0,
      };
    })
    .filter((c) =>
      Number.isFinite(c.timestamp) &&
      Number.isFinite(c.open) &&
      Number.isFinite(c.high) &&
      Number.isFinite(c.low) &&
      Number.isFinite(c.close) &&
      c.timestamp + intervalMs <= now
    )
    .sort((a, b) => a.timestamp - b.timestamp);
}

async function getPaidPoolOhlcv(
  timeframe: "minute" | "hour" | "day",
  aggregate: number,
  limit = KLINE_LIMIT,
): Promise<Candle[]> {
  const data = await geckoFetch(
    `/networks/solana/pools/${PAID_POOL}/ohlcv/${timeframe}?aggregate=${aggregate}&limit=${Math.min(limit, KLINE_LIMIT)}&currency=usd`,
  );
  const rows = data?.data?.attributes?.ohlcv_list;
  if (!Array.isArray(rows)) throw new Error("GeckoTerminal PAID OHLCV missing");

  const intervalMs =
    timeframe === "minute" ? aggregate * 60_000 :
    timeframe === "hour" ? aggregate * 3_600_000 :
    aggregate * 86_400_000;

  return parseOhlcv(rows, intervalMs);
}

/** PAID-only: CoinGecko/GeckoTerminal data for the Solana PAID token. */
export async function getPaidAggregatedDailyCandles(): Promise<Candle[]> {
  return getPaidPoolOhlcv("day", 1, KLINE_LIMIT);
}

export async function getPaidPrice(): Promise<number> {
  const data = await geckoFetch(
    `/networks/solana/pools/${PAID_POOL}`,
  );
  const price = Number(data?.data?.attributes?.base_token_price_usd);
  if (!Number.isFinite(price) || price <= 0) {
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
  // Keep PAID requests sequential rather than bursting four GeckoTerminal
  // requests at once. This is PAID-only rate-limit protection.
  const candles1h = await getPaidPoolOhlcv("hour", 1, KLINE_LIMIT);
  await sleep(250);
  const candles4h = await getPaidPoolOhlcv("hour", 4, KLINE_LIMIT);
  await sleep(250);
  const candles15m = await getPaidPoolOhlcv("minute", 15, KLINE_LIMIT);
  await sleep(250);
  const ticker = await geckoFetch(`/networks/solana/pools/${PAID_POOL}`);

  const price = Number(ticker?.data?.attributes?.base_token_price_usd);
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error("GeckoTerminal PAID price unavailable");
  }

  return { price, candles1h, candles4h, candles15m };
}

export async function getPaidDailyCandles(): Promise<Candle[]> {
  return getPaidPoolOhlcv("day", 1, KLINE_LIMIT);
}

export function aggregatePaidDailyToWeekly(daily: Candle[]): Candle[] {
  const sorted = [...daily].sort((a, b) => a.timestamp - b.timestamp);
  const groups = new Map<string, Candle[]>();

  for (const c of sorted) {
    const d = new Date(c.timestamp);
    const day = d.getUTCDay();
    const monday = new Date(
      Date.UTC(
        d.getUTCFullYear(),
        d.getUTCMonth(),
        d.getUTCDate() - ((day + 6) % 7),
      ),
    );
    const key = monday.toISOString().slice(0, 10);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(c);
  }

  return [...groups.values()]
    .filter((bars) => bars.length > 0)
    .map((bars) => ({
      timestamp: bars[0].timestamp,
      open: bars[0].open,
      high: Math.max(...bars.map((b) => b.high)),
      low: Math.min(...bars.map((b) => b.low)),
      close: bars[bars.length - 1].close,
      volume: bars.reduce((sum, b) => sum + b.volume, 0),
    }))
    .sort((a, b) => a.timestamp - b.timestamp);
}
