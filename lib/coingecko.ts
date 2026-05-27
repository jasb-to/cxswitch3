const COINGECKO_API_KEY = process.env.COINGECKO_API_KEY;
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

export interface OHLC {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface PriceData {
  symbol: string;
  price: number;
  change24h: number;
  volume24h: number;
}

async function redis(command: string[]): Promise<any> {
  if (!REDIS_URL || !REDIS_TOKEN) {
    console.warn("[CG] Redis not configured");
    return null;
  }

  try {
    const response = await fetch(`${REDIS_URL}/exec`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${REDIS_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ commands: [command] }),
    });

    const data = await response.json();
    return data.result?.[0];
  } catch (err) {
    console.error("[CG] Redis error:", err);
    return null;
  }
}

async function getCache(key: string): Promise<any> {
  const cached = await redis(["GET", key]);
  return cached ? JSON.parse(cached) : null;
}

async function setCache(key: string, data: any, ttl: number): Promise<void> {
  await redis(["SETEX", key, ttl.toString(), JSON.stringify(data)]);
}

export async function fetchPrice(cgId: string): Promise<PriceData | null> {
  try {
    const res = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${cgId}&vs_currencies=usd&include_24hr_change=true&include_24hr_vol=true&x_cg_demo_api_key=${COINGECKO_API_KEY}`,
      { cache: "no-store" }
    );
    const data = await res.json();

    if (!data[cgId]) throw new Error(`No price data for ${cgId}`);

    const symbol = cgId === "bitcoin" ? "BTC" : cgId === "ethereum" ? "ETH" : "SOL";
    return {
      symbol,
      price: data[cgId].usd,
      change24h: data[cgId].usd_24h_change || 0,
      volume24h: data[cgId].usd_24h_vol || 0,
    };
  } catch (err) {
    console.error(`[CG] Price fetch ${cgId} failed:`, err);
    return null;
  }
}

export async function fetchOHLC1H(cgId: string): Promise<OHLC[]> {
  const cacheKey = `ohlc:1h:${cgId}`;
  
  try {
    // Check cache first (5 minute TTL)
    const cached = await getCache(cacheKey);
    if (cached) {
      console.log(`[CG] 1H OHLC ${cgId} from cache`);
      return cached;
    }

    const res = await fetch(
      `https://api.coingecko.com/api/v3/coins/${cgId}/ohlc?vs_currency=usd&days=1&x_cg_demo_api_key=${COINGECKO_API_KEY}`,
      { cache: "no-store" }
    );
    const data = await res.json();

    if (!Array.isArray(data)) throw new Error(`Invalid 1H OHLC data for ${cgId}`);

    const ohlc: OHLC[] = data.map((candle: any[]) => ({
      time: candle[0],
      open: candle[1],
      high: candle[2],
      low: candle[3],
      close: candle[4],
    }));

    // Cache for 5 minutes
    await setCache(cacheKey, ohlc, 300);
    console.log(`[CG] 1H OHLC ${cgId} fetched and cached`);

    return ohlc;
  } catch (err) {
    console.error(`[CG] 1H OHLC fetch ${cgId} failed:`, err);
    return [];
  }
}

export async function fetchOHLC4H(cgId: string): Promise<OHLC[]> {
  const cacheKey = `ohlc:4h:${cgId}`;
  
  try {
    // Check cache first (15 minute TTL)
    const cached = await getCache(cacheKey);
    if (cached) {
      console.log(`[CG] 4H OHLC ${cgId} from cache`);
      return cached;
    }

    const res = await fetch(
      `https://api.coingecko.com/api/v3/coins/${cgId}/ohlc?vs_currency=usd&days=30&x_cg_demo_api_key=${COINGECKO_API_KEY}`,
      { cache: "no-store" }
    );
    const data = await res.json();

    if (!Array.isArray(data)) throw new Error(`Invalid 4H OHLC data for ${cgId}`);

    // Extract 4H candles (every 4th candle from 1H data, or filter accordingly)
    const ohlc: OHLC[] = data
      .filter((_, idx) => idx % 4 === 0)
      .slice(-20)
      .map((candle: any[]) => ({
        time: candle[0],
        open: candle[1],
        high: candle[2],
        low: candle[3],
        close: candle[4],
      }));

    // Cache for 15 minutes
    await setCache(cacheKey, ohlc, 900);
    console.log(`[CG] 4H OHLC ${cgId} fetched and cached`);

    return ohlc;
  } catch (err) {
    console.error(`[CG] 4H OHLC fetch ${cgId} failed:`, err);
    return [];
  }
}
