// lib/state-v14.ts
// KV storage for v14 strategy
// ============================================================

import { Redis } from "@upstash/redis";

const redis = Redis.fromEnv();

const SIGNALS_KEY = "cx_signals_v14";
const MARKET_KEY = "cx_market_v14";

const SIGNALS_TTL = 6 * 60 * 60;  // 6 hours (matches signal expiry)
const MARKET_TTL = 4 * 60 * 60;   // 4 hours

export interface StoredSignal {
  pair: string;
  direction: "LONG" | "SHORT";
  entry: number;
  stop: number;
  target: number;
  confidence: number;
  type: "SWEEP" | "FVG";
  reason: string;
  timestamp: number;
  expectedMove: number;
}

export interface StoredMarketData {
  pair: string;
  price: number;
  structure4h: string;
  structure1h: string;
  roc1h: number;
  atr1h: number;
  sweepDetected: boolean;
}

export async function setSignals(signals: StoredSignal[]) {
  try {
    await redis.set(SIGNALS_KEY, signals, { ex: SIGNALS_TTL });
    console.log("[STATE] Saved", signals.length, "signals to KV");
  } catch (err) {
    console.error("[STATE] Signals KV write failed:", err);
  }
}

export async function getSignals(): Promise<StoredSignal[]> {
  try {
    const data = await redis.get(SIGNALS_KEY);
    if (!data) return [];
    const parsed = typeof data === "string" ? JSON.parse(data) : data;
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.error("[STATE] Signals KV read failed:", err);
    return [];
  }
}

export async function setMarketData(data: StoredMarketData[]) {
  try {
    await redis.set(MARKET_KEY, data, { ex: MARKET_TTL });
    console.log("[STATE] Saved", data.length, "market entries to KV");
  } catch (err) {
    console.error("[STATE] Market KV write failed:", err);
  }
}

export async function getMarketData(): Promise<StoredMarketData[]> {
  try {
    const data = await redis.get(MARKET_KEY);
    if (!data) return [];
    const parsed = typeof data === "string" ? JSON.parse(data) : data;
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.error("[STATE] Market KV read failed:", err);
    return [];
  }
}

// Reset function for CLI
export async function resetAll() {
  try {
    await redis.del(SIGNALS_KEY);
    await redis.del(MARKET_KEY);
    console.log("[STATE] All KV data reset");
  } catch (err) {
    console.error("[STATE] Reset failed:", err);
  }
}
