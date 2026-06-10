import { Redis } from "@upstash/redis";
import { Signal } from "./strategy";

const redis = Redis.fromEnv();

const SIGNALS_KEY = "cx_signals_v2";
const MARKET_KEY = "cx_market_v2";
const ACTIVE_TRADES_KEY = "cx_active_trades";

export async function setSignals(data: Signal[]) {
  const signals = Array.isArray(data) ? data : [];
  try {
    await redis.set(SIGNALS_KEY, signals);
    console.log("[STATE] Saved", signals.length, "signals to KV");
  } catch (err) {
    console.error("[STATE] Signals KV write failed:", err);
  }
}

export async function getSignals(): Promise<Signal[]> {
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

export async function setMarketData(data: any[]) {
  const marketData = Array.isArray(data) ? data : [];
  try {
    await redis.set(MARKET_KEY, marketData);
    console.log("[STATE] Saved", marketData.length, "market entries to KV");
  } catch (err) {
    console.error("[STATE] Market KV write failed:", err);
  }
}

export async function getMarketData(): Promise<any[]> {
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

export async function getActiveTrades(): Promise<Record<string, { direction: string; timestamp: number }>> {
  try {
    const data = await redis.get(ACTIVE_TRADES_KEY);
    if (!data) return {};
    return typeof data === "string" ? JSON.parse(data) : (data || {});
  } catch (err) {
    console.error("[STATE] Active trades KV read failed:", err);
    return {};
  }
}

export async function setActiveTrades(trades: Record<string, any>) {
  try {
    await redis.set(ACTIVE_TRADES_KEY, trades);
  } catch (err) {
    console.error("[STATE] Active trades KV write failed:", err);
  }
}
