// lib/kraken.ts — v29.1 Kraken REST API wrapper for CXSwitch
// ============================================================

const KRAKEN_API_URL = "https://api.kraken.com";

// ─── Types ───

export interface KrakenCandle {
  time: number;
  open: string;
  high: string;
  low: string;
  close: string;
  vwap: string;
  volume: string;
  count: number;
}

export interface KrakenOHLCResult {
  error: string[];
  result: Record<string, KrakenCandle[]>;
}

export interface KrakenTickerResult {
  error: string[];
  result: Record<string, {
    a: string[]; // ask
    b: string[]; // bid
    c: string[]; // last trade closed [price, volume]
    v: string[]; // volume [today, last 24h]
    p: string[]; // VWAP [today, last 24h]
    t: number[]; // number of trades [today, last 24h]
    l: string[]; // low [today, last 24h]
    h: string[]; // high [today, last 24h]
    o: string;   // opening price
  }>;
}

export interface KrakenBalanceResult {
  error: string[];
  result: Record<string, string>;
}

export interface KrakenOrderResult {
  error: string[];
  result: {
    descr: { order: string };
    txid?: string[];
  };
}

// ─── Rate-limiting queue ───

let lastRequestTime = 0;
const MIN_INTERVAL_MS = 600; // Kraken tier-1: ~1.5 req/sec

async function rateLimitedFetch(url: string, options?: RequestInit): Promise<Response> {
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  if (elapsed < MIN_INTERVAL_MS) {
    await new Promise(r => setTimeout(r, MIN_INTERVAL_MS - elapsed));
  }
  lastRequestTime = Date.now();
  return fetch(url, options);
}

// ─── Public API ───

export async function getOHLC(pair: string, interval: number = 60, since?: number): Promise<KrakenCandle[]> {
  // interval: 1, 5, 15, 30, 60, 240, 1440, 10080, 21600
  const url = new URL(`${KRAKEN_API_URL}/0/public/OHLC`);
  url.searchParams.set("pair", pair);
  url.searchParams.set("interval", String(interval));
  if (since) url.searchParams.set("since", String(since));

  const res = await rateLimitedFetch(url.toString());
  if (!res.ok) throw new Error(`Kraken OHLC HTTP ${res.status}`);

  const data: KrakenOHLCResult = await res.json();
  if (data.error.length > 0) throw new Error(`Kraken OHLC error: ${data.error.join(", ")}`);

  const key = Object.keys(data.result).find(k => k !== "last");
  if (!key) throw new Error("No OHLC data returned");

  return data.result[key];
}

export async function getTicker(pair: string): Promise<{ price: number; bid: number; ask: number; volume24h: number }> {
  const url = `${KRAKEN_API_URL}/0/public/Ticker?pair=${encodeURIComponent(pair)}`;
  const res = await rateLimitedFetch(url);
  if (!res.ok) throw new Error(`Kraken Ticker HTTP ${res.status}`);

  const data: KrakenTickerResult = await res.json();
  if (data.error.length > 0) throw new Error(`Kraken Ticker error: ${data.error.join(", ")}`);

  const key = Object.keys(data.result)[0];
  const tick = data.result[key];

  return {
    price: parseFloat(tick.c[0]),
    bid: parseFloat(tick.b[0]),
    ask: parseFloat(tick.a[0]),
    volume24h: parseFloat(tick.v[1]),
  };
}

// ─── Private API (requires API key) ───

function getKrakenSignature(path: string, nonce: string, body: string, secret: string): string {
  const crypto = require("crypto");
  const sha256 = crypto.createHash("sha256").update(nonce + body).digest();
  const hmac = crypto.createHmac("sha512", Buffer.from(secret, "base64"));
  hmac.update(path + sha256);
  return hmac.digest("base64");
}

function krakenRequest(path: string, params: Record<string, string>, apiKey?: string, apiSecret?: string): Promise<any> {
  const nonce = Date.now() * 1000 + Math.floor(Math.random() * 1000);
  const body = new URLSearchParams({ ...params, nonce: String(nonce) }).toString();

  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
  };

  if (apiKey && apiSecret) {
    headers["API-Key"] = apiKey;
    headers["API-Sign"] = getKrakenSignature(path, String(nonce), body, apiSecret);
  }

  return rateLimitedFetch(`${KRAKEN_API_URL}${path}`, {
    method: "POST",
    headers,
    body,
  }).then(async r => {
    if (!r.ok) throw new Error(`Kraken private HTTP ${r.status}`);
    const data = await r.json();
    if (data.error?.length > 0) throw new Error(`Kraken private error: ${data.error.join(", ")}`);
    return data;
  });
}

export async function getBalance(): Promise<Record<string, number>> {
  const apiKey = process.env.KRAKEN_API_KEY;
  const apiSecret = process.env.KRAKEN_API_SECRET;
  if (!apiKey || !apiSecret) throw new Error("KRAKEN_API_KEY and KRAKEN_API_SECRET required");

  const data = await krakenRequest("/0/private/Balance", {}, apiKey, apiSecret);
  const result: Record<string, number> = {};
  for (const [asset, amount] of Object.entries(data.result)) {
    result[asset] = parseFloat(amount as string);
  }
  return result;
}

export async function placeMarketOrder(pair: string, direction: "buy" | "sell", volume: number): Promise<string> {
  const apiKey = process.env.KRAKEN_API_KEY;
  const apiSecret = process.env.KRAKEN_API_SECRET;
  if (!apiKey || !apiSecret) throw new Error("KRAKEN_API_KEY and KRAKEN_API_SECRET required");

  const data = await krakenRequest("/0/private/AddOrder", {
    pair,
    type: direction,
    ordertype: "market",
    volume: String(volume),
  }, apiKey, apiSecret);

  return data.result.txid?.[0] || "";
}

export async function placeLimitOrder(pair: string, direction: "buy" | "sell", volume: number, price: number): Promise<string> {
  const apiKey = process.env.KRAKEN_API_KEY;
  const apiSecret = process.env.KRAKEN_API_SECRET;
  if (!apiKey || !apiSecret) throw new Error("KRAKEN_API_KEY and KRAKEN_API_SECRET required");

  const data = await krakenRequest("/0/private/AddOrder", {
    pair,
    type: direction,
    ordertype: "limit",
    price: String(price),
    volume: String(volume),
  }, apiKey, apiSecret);

  return data.result.txid?.[0] || "";
}

// ─── Helpers ───

export function krakenPairFormat(pair: string): string {
  // BTC/USD -> XBTUSD (Kraken format)
  const map: Record<string, string> = {
    "BTC": "XBT",
    "BTC/USD": "XBTUSD",
    "ETH/USD": "ETHUSD",
    "SOL/USD": "SOLUSD",
  };
  return map[pair] || pair.replace("/", "");
}

export function krakenPairToDisplay(pair: string): string {
  const map: Record<string, string> = {
    "XBTUSD": "BTC/USD",
    "ETHUSD": "ETH/USD",
    "SOLUSD": "SOL/USD",
  };
  return map[pair] || pair;
}
