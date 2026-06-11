import { Redis } from "@upstash/redis";
import { Signal } from "./strategy";

const redis = Redis.fromEnv();

const SIGNALS_KEY = "cx_signals_v2";
const MARKET_KEY = "cx_market_v2";
const ACTIVE_TRADES_KEY = "cx_active_trades";

const SIGNALS_TTL = 4 * 60 * 60;        // 4 hours
const MARKET_TTL = 4 * 60 * 60;         // 4 hours
const ACTIVE_TRADES_TTL = 24 * 60 * 60; // 24 hours

// Strip heavy candle arrays before saving to KV
function stripCandles(signal: Signal): Omit<Signal, "candles1h" | "candles4h"> {
  const { candles1h, candles4h, ...rest } = signal;
  return rest;
}

export async function setSignals(newSignals: Signal[]) {
  const incoming = Array.isArray(newSignals) ? newSignals : [];

  try {
    // Merge with existing signals, keeping ones < 4h old
    const existing = await getSignals();
    const fourHoursAgo = Date.now() - SIGNALS_TTL * 1000;

    const freshExisting = existing.filter((s: any) => s.timestamp > fourHoursAgo);

    // Merge: new signals overwrite existing for same pair
    const merged: any[] = [...freshExisting];
    for (const s of incoming) {
      const idx = merged.findIndex((x: any) => x.pair === s.pair);
      const lean = stripCandles(s);
      if (idx >= 0) merged[idx] = lean;
      else merged.push(lean);
    }

    await redis.set(SIGNALS_KEY, merged, { ex: SIGNALS_TTL });
    console.log("[STATE] Saved", merged.length, "signals to KV (merged)");
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
    await redis.set(MARKET_KEY, marketData, { ex: MARKET_TTL });
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
    await redis.set(ACTIVE_TRADES_KEY, trades, { ex: ACTIVE_TRADES_TTL });
  } catch (err) {
    console.error("[STATE] Active trades KV write failed:", err);
  }
}
