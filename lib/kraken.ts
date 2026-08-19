const KRAKEN_API_URL = "https://api.kraken.com";

export interface Candle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

let lastReq = 0;
const MIN_MS = 600;

async function rateFetch(url: string, opts?: RequestInit): Promise<Response> {
  const now = Date.now();
  const elapsed = now - lastReq;
  if (elapsed < MIN_MS) await new Promise(r => setTimeout(r, MIN_MS - elapsed));
  lastReq = Date.now();
  return fetch(url, opts);
}

export async function getCandles(pair: string, interval: number = 60, since?: number): Promise<Candle[]> {
  const defaultSince = Math.floor((Date.now() - 90 * 24 * 60 * 60 * 1000) / 1000);
  const url = new URL(`${KRAKEN_API_URL}/0/public/OHLC`);
  url.searchParams.set("pair", pair);
  url.searchParams.set("interval", String(interval));
  url.searchParams.set("since", String(since ?? defaultSince));
  const res = await rateFetch(url.toString());
  if (!res.ok) throw new Error(`Kraken OHLC HTTP ${res.status}`);
  const data = await res.json();
  if (data.error?.length > 0) throw new Error(`Kraken OHLC error: ${data.error.join(", ")}`);
  const key = Object.keys(data.result).find(k => k !== "last");
  if (!key) throw new Error("No OHLC data");
  const raw = data.result[key];
  if (!Array.isArray(raw)) throw new Error(`OHLC not array: ${typeof raw}`);

  const intervalMs = interval * 60 * 1000;
  const now = Date.now();
  if (raw.length > 0) {
    const lastCandleTime = raw[raw.length - 1][0] * 1000;
    if (lastCandleTime + intervalMs > now) raw.pop();
  }

  return raw.map((c: any) => ({
    timestamp: c[0] * 1000,
    open: parseFloat(c[1]),
    high: parseFloat(c[2]),
    low: parseFloat(c[3]),
    close: parseFloat(c[4]),
    volume: parseFloat(c[6]),
  }));
}

export async function getCurrentPrice(pair: string): Promise<number> {
  const url = `${KRAKEN_API_URL}/0/public/Ticker?pair=${encodeURIComponent(pair)}`;
  const res = await rateFetch(url);
  if (!res.ok) throw new Error(`Kraken Ticker HTTP ${res.status}`);
  const data = await res.json();
  if (data.error?.length > 0) throw new Error(`Kraken Ticker error: ${data.error.join(", ")}`);
  const key = Object.keys(data.result)[0];
  return parseFloat(data.result[key].c[0]);
}

export function krakenPairFormat(pair: string): string {
  const map: Record<string, string> = {
    "BTC/USD": "XBTUSD",
    "ETH/USD": "ETHUSD",
    "SOL/USD": "SOLUSD",
    "HYPE/USD": "HYPEUSD",
  };
  return map[pair] || pair.replace("/", "");
}

export function aggregateTo1D(candles4h: Candle[]): Candle[] {
  if (!candles4h?.length) return [];
  const sorted = [...candles4h].sort((a, b) => a.timestamp - b.timestamp);
  const groups = new Map<string, Candle[]>();
  for (const c of sorted) {
    const key = new Date(c.timestamp).toISOString().split("T")[0];
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(c);
  }
  const daily: Candle[] = [];
  for (const [, bars] of groups) {
    if (!bars.length) continue;
    daily.push({
      timestamp: bars[0].timestamp,
      open: bars[0].open,
      high: Math.max(...bars.map(b => b.high)),
      low: Math.min(...bars.map(b => b.low)),
      close: bars[bars.length - 1].close,
      volume: bars.reduce((s, b) => s + b.volume, 0),
    });
  }
  return daily.sort((a, b) => a.timestamp - b.timestamp);
}

// Exchange position sync is optional. When it is unavailable, CXSwitch must
// never interpret an empty response as "the user has no position".
export function isExchangeSyncConfigured(): boolean {
  return Boolean(process.env.KRAKEN_API_KEY && process.env.KRAKEN_API_SECRET);
}

function getKrakenSignature(path: string, nonce: string, body: string, secret: string): string {
  const crypto = require("crypto");
  const message = nonce + body;
  const hash = crypto.createHash("sha256").update(message).digest();
  const hmac = crypto.createHmac("sha512", Buffer.from(secret, "base64"));
  hmac.update(path + hash);
  return hmac.digest("base64");
}

export async function getExchangePositions(): Promise<{ symbol: string; side: string; size: number }[]> {
  const apiKey = process.env.KRAKEN_API_KEY;
  const apiSecret = process.env.KRAKEN_API_SECRET;

  if (!apiKey || !apiSecret) {
    console.log("[KRAKEN] No API credentials, position sync unavailable");
    return [];
  }

  const path = "/0/private/OpenPositions";
  const nonce = String(Date.now());
  const body = new URLSearchParams({ nonce }).toString();

  const res = await rateFetch(`${KRAKEN_API_URL}${path}`, {
    method: "POST",
    headers: {
      "API-Key": apiKey,
      "API-Sign": getKrakenSignature(path, nonce, body, apiSecret),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  if (!res.ok) throw new Error(`Kraken OpenPositions HTTP ${res.status}`);

  const data = await res.json();
  if (data.error?.length > 0) {
    throw new Error(`Kraken OpenPositions error: ${data.error.join(", ")}`);
  }

  const positions = data.result || {};
  const result: { symbol: string; side: string; size: number }[] = [];

  for (const [, pos] of Object.entries(positions)) {
    const p = pos as any;
    result.push({
      symbol: p.pair || "",
      side: p.type === "buy" ? "LONG" : p.type === "sell" ? "SHORT" : p.type?.toUpperCase() || "",
      size: parseFloat(p.vol || "0"),
    });
  }

  console.log(`[KRAKEN] Found ${result.length} open positions`);
  return result;
}
