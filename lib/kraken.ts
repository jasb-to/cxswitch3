import { createHmac } from "crypto";

const API_KEY = process.env.KRAKEN_API_KEY!;
const API_SECRET = process.env.KRAKEN_API_SECRET!;
const KRAKEN_BASE = "https://api.kraken.com/0/public";

export interface OHLCData {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// Simple in-memory cache for OHLC (TTL via timestamp)
const ohlcCache: Record<string, { data: OHLCData[]; expiry: number }> = {};

/**
 * Fetch OHLC data from Kraken with simple TTL caching (60 seconds)
 */
export async function getOHLC(
  pair: string,
  interval: number,
  limit: number = 50
): Promise<OHLCData[]> {
  const cacheKey = `${pair}:${interval}`;
  const now = Date.now();

  // Check cache
  if (ohlcCache[cacheKey] && ohlcCache[cacheKey].expiry > now) {
    console.log(`[v0] Cache hit for ${cacheKey}`);
    return ohlcCache[cacheKey].data;
  }

  try {
    const res = await fetch(
      `${KRAKEN_BASE}/OHLC?pair=${pair}&interval=${interval}&limit=${limit}`,
      { cache: "no-store" }
    );
    const data = await res.json();

    if (data.error?.length) {
      console.error("[Kraken OHLC Error]", data.error);
      return [];
    }

    // Parse Kraken OHLC response
    const ohlcKey = Object.keys(data.result || {}).find((k) => k !== "last");
    if (!ohlcKey) return [];

    const parsed: OHLCData[] = (data.result[ohlcKey] as any[]).map((item) => ({
      time: item[0],
      open: parseFloat(item[1]),
      high: parseFloat(item[2]),
      low: parseFloat(item[3]),
      close: parseFloat(item[4]),
      volume: parseFloat(item[7]),
    }));

    // Cache for 60 seconds
    ohlcCache[cacheKey] = { data: parsed, expiry: now + 60000 };

    return parsed;
  } catch (err) {
    console.error("[Kraken OHLC Fetch]", err);
    return [];
  }
}

export async function placeOrder(params: {
  pair: string;
  type: "buy" | "sell";
  ordertype: string;
  volume: string;
}) {
  const nonce = Date.now() * 1000;
  const body = new URLSearchParams({ ...params, nonce: nonce.toString() });
  
  const signature = createHmac("sha512", Buffer.from(API_SECRET, "base64"))
    .update(body.toString())
    .digest("base64");
  
  const res = await fetch("https://api.kraken.com/0/private/AddOrder", {
    method: "POST",
    headers: {
      "API-Key": API_KEY,
      "API-Sign": signature,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });
  
  const data = await res.json();
  if (data.error?.length) throw new Error(data.error.join(", "));
  
  return { txid: data.result.txid[0] };
}
