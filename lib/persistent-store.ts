import { Redis } from "@upstash/redis";
import type { Signal } from "./strategy-core";

const redis = new Redis({
  url: process.env.KV_REST_API_URL || "",
  token: process.env.KV_REST_API_TOKEN || "",
});

const SIGNALS_KEY = "signals:current";
const COOLDOWN_KEY_PREFIX = "telegram:cooldown:";
const LAST_CRON_KEY = "cron:last_execution";
const REQUEST_DEDUP_KEY_PREFIX = "request:dedup:";

/**
 * Read all current signals from Redis
 * Returns empty array if no signals exist
 */
export async function readSignals(): Promise<Signal[]> {
  try {
    const data = await redis.get(SIGNALS_KEY);
    console.log("[STORE/READ] Raw Redis response:", data ? `${(data as any[]).length} items` : "null");
    if (!data) {
      console.log("[STORE/READ] No data in Redis, returning empty array");
      return [];
    }
    if (!Array.isArray(data)) {
      console.error("[STORE/READ] Data is not array, got:", typeof data, data);
      return [];
    }
    console.log("[STORE/READ] Returning", data.length, "signals from Redis");
    data.forEach((s: any) => {
      console.log(`[STORE/READ] ${s.symbol}: state=${s.state}, readiness=${s.readiness_score}`);
    });
    return data;
  } catch (error) {
    console.error("[STORE] Error reading signals:", error);
    return [];
  }
}

/**
 * Write signals to Redis (overwrites existing)
 * Sets 24-hour TTL to prevent stale data
 */
export async function writeSignals(signals: Signal[]): Promise<void> {
  try {
    await redis.set(SIGNALS_KEY, signals, { ex: 86400 }); // 24 hour TTL
  } catch (error) {
    console.error("[STORE] Error writing signals:", error);
    throw error;
  }
}

/**
 * Get a single signal by symbol
 */
export async function getSignal(symbol: string): Promise<Signal | null> {
  try {
    const signals = await readSignals();
    return signals.find((s) => s.symbol === symbol) || null;
  } catch (error) {
    console.error(`[STORE] Error getting signal for ${symbol}:`, error);
    return null;
  }
}

/**
 * Get Telegram cooldown for a symbol (milliseconds)
 * Returns 0 if no cooldown exists (alert is ready)
 */
export async function getTelegramCooldown(symbol: string): Promise<number> {
  try {
    const cooldown = await redis.get(`${COOLDOWN_KEY_PREFIX}${symbol}`);
    return cooldown ? Number(cooldown) : 0;
  } catch (error) {
    console.error(`[STORE] Error getting cooldown for ${symbol}:`, error);
    return 0;
  }
}

/**
 * Set Telegram cooldown for a symbol (persists for 30 minutes)
 */
export async function setTelegramCooldown(symbol: string, timestamp: number): Promise<void> {
  try {
    await redis.set(`${COOLDOWN_KEY_PREFIX}${symbol}`, timestamp, { ex: 1800 }); // 30 min TTL
  } catch (error) {
    console.error(`[STORE] Error setting cooldown for ${symbol}:`, error);
    throw error;
  }
}

/**
 * Record last cron execution time
 */
export async function getLastCronExecution(): Promise<number> {
  try {
    const lastExec = await redis.get(LAST_CRON_KEY);
    return lastExec ? Number(lastExec) : 0;
  } catch (error) {
    console.error("[STORE] Error getting last cron execution:", error);
    return 0;
  }
}

/**
 * Update last cron execution time
 */
export async function setLastCronExecution(timestamp: number): Promise<void> {
  try {
    await redis.set(LAST_CRON_KEY, timestamp, { ex: 3600 }); // 1 hour TTL
  } catch (error) {
    console.error("[STORE] Error setting last cron execution:", error);
    throw error;
  }
}

/**
 * Request deduplication for 60 seconds
 * Returns true if request should be processed, false if duplicate
 */
export async function checkAndSetRequestDedup(requestId: string): Promise<boolean> {
  try {
    const existing = await redis.get(`${REQUEST_DEDUP_KEY_PREFIX}${requestId}`);
    if (existing) {
      return false; // Duplicate, skip processing
    }
    await redis.set(`${REQUEST_DEDUP_KEY_PREFIX}${requestId}`, "1", { ex: 60 }); // 60 sec TTL
    return true; // First time, process it
  } catch (error) {
    console.error(`[STORE] Error checking dedup for ${requestId}:`, error);
    return true; // On error, allow processing
  }
}

/**
 * Health check - verify Redis connectivity
 */
export async function healthCheck(): Promise<boolean> {
  try {
    await redis.ping();
    return true;
  } catch (error) {
    console.error("[STORE] Redis health check failed:", error);
    return false;
  }
}
