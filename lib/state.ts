// lib/state.ts — v14 KV storage
// ============================================================

import { Redis } from "@upstash/redis";

const redis = Redis.fromEnv();

const SIGNALS_KEY = "cx_signals_v14";
const MARKET_KEY = "cx_market_v14";
const ACTIVE_TRADES_KEY = "cx_active_trades_v14";

const SIGNALS_TTL = 6 * 60 * 60;
const MARKET_TTL = 4 * 60 * 60;
const ACTIVE_TRADES_TTL = 24 * 60 * 60;

export async function setSignals(signals: any[]) {
  const incoming = Array.isArray(signals) ? signals : [];
  try {
    const existing = await getSignals();
    const now = Date.now();
    
    // Respect per-type expiry: EARLY = 2h, SWEEP = 6h
    const freshExisting = existing.filter((s: any) => {
      const ageHours = (now - s.timestamp) / (1000 * 60 * 60);
      const maxAge = s.type === "EARLY" ? 2 : 6;
      return ageHours < maxAge;
    });
    
    const merged: any[] = [...freshExisting];
    for (const s of incoming) {
      const idx = merged.findIndex((x: any) => x.pair === s.pair);
      if (idx >= 0) merged[idx] = s;
      else merged.push(s);
    }
    
    await redis.set(SIGNALS_KEY, merged, { ex: SIGNALS_TTL });
    console.log("[STATE] Saved", merged.length, "signals to KV (merged)");
  } catch (err) {
    console.error("[STATE] Signals KV write failed:", err);
  }
}

export async function getSignals(): Promise<any[]> {
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

export async function getActiveTrades(): Promise<Record<string, any>> {
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

export async function resetAll() {
  try {
    await redis.del(SIGNALS_KEY);
    await redis.del(MARKET_KEY);
    await redis.del(ACTIVE_TRADES_KEY);
    console.log("[STATE] All KV data reset");
  } catch (err) {
    console.error("[STATE] Reset failed:", err);
  }
}
