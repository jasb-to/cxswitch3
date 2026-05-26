import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.KV_REST_API_URL || "",
  token: process.env.KV_REST_API_TOKEN || "",
});

const COOLDOWN_KEY_PREFIX = "telegram:cooldown:";

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
