// lib/state.ts — v20.2 KV storage
// ============================================================

import { Redis } from "@upstash/redis";

export const redis = Redis.fromEnv();

// ─── Keys ──────────────────────────────────────────────────

const SIGNALS_KEY = "cx_signals_v14";
const MARKET_KEY = "cx_market_v14";
const ACTIVE_TRADES_KEY = "cx_active_trades_v14";
const LAST_CRON_RUN_KEY = "cx_last_cron_run_v14";

// ─── TTLs ───────────────────────────────────────────────────

const SIGNALS_TTL = 6 * 60 * 60;
const MARKET_TTL = 4 * 60 * 60;
const ACTIVE_TRADES_TTL = 24 * 60 * 60;
const LAST_CRON_RUN_TTL = 24 * 60 * 60;

// ─── Constants ───────────────────────────────────────────────

const CURRENT_SIGNAL_VERSION = 2;

// ─── Helpers ───────────────────────────────────────────────

function safeParseArray(data: unknown): any[] {
  if (!data) return [];
  const parsed = typeof data === "string" ? JSON.parse(data) : data;
  return Array.isArray(parsed) ? parsed : [];
}

function safeParseObject(data: unknown): Record<string, any> {
  if (!data) return {};
  return typeof data === "string" ? JSON.parse(data) : (data || {});
}

function getSignalMaxAgeHours(signal: any): number {
  if (signal.type === "EARLY") return 2;
  if (signal.type === "REVERSAL") return 4;
  return 6;
}

function isSignalExpired(signal: any): boolean {
  const ageHours = (Date.now() - signal.timestamp) / (1000 * 60 * 60);
  return ageHours >= getSignalMaxAgeHours(signal);
}

// ─── Signals ─────────────────────────────────────────────────

export async function setSignals(signals: any[]) {
  const incoming = Array.isArray(signals) ? signals : [];
  try {
    const existing = await getSignals();
    const now = Date.now();
    
    const freshExisting = existing.filter((s: any) => {
      if (!s.id || s.version !== CURRENT_SIGNAL_VERSION) {
        console.log(`[STATE] Purging old-format signal for ${s.pair || "unknown"} (id=${s.id}, version=${s.version})`);
        return false;
      }
      
      const ageHours = (now - s.timestamp) / (1000 * 60 * 60);
      return ageHours < getSignalMaxAgeHours(s);
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
    return safeParseArray(data);
  } catch (err) {
    console.error("[STATE] Signals KV read failed:", err);
    return [];
  }
}

// ─── Market Data ─────────────────────────────────────────────

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
    return safeParseArray(data);
  } catch (err) {
    console.error("[STATE] Market KV read failed:", err);
    return [];
  }
}

// ─── Active Trades ───────────────────────────────────────────

export async function getActiveTrades(): Promise<<Record<string, any>> {
  try {
    const data = await redis.get(ACTIVE_TRADES_KEY);
    return safeParseObject(data);
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

// ─── Cron Rate Limit ─────────────────────────────────────────

export async function getLastCronRun(): Promise<number> {
  try {
    const data = await redis.get(LAST_CRON_RUN_KEY);
    return data ? Number(data) : 0;
  } catch {
    return 0;
  }
}

export async function setLastCronRun(timestamp: number): Promise<void> {
  try {
    await redis.set(LAST_CRON_RUN_KEY, timestamp, { ex: LAST_CRON_RUN_TTL });
  } catch (err) {
    console.error("[STATE] Last cron run KV write failed:", err);
  }
}

// ─── Reset ───────────────────────────────────────────────────

export async function resetAll() {
  try {
    await redis.del(SIGNALS_KEY);
    await redis.del(MARKET_KEY);
    await redis.del(ACTIVE_TRADES_KEY);
    await redis.del(LAST_CRON_RUN_KEY);
    console.log("[STATE] All KV data reset");
  } catch (err) {
    console.error("[STATE] Reset failed:", err);
  }
}
