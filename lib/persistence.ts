import { Redis } from "@upstash/redis";

// uses your existing Vercel/Upstash env vars automatically
const redis = Redis.fromEnv();

const KEY = "cx:snapshots";

/**
 * Store signal snapshot
 */
export async function storeSignalSnapshot(signal: any) {
  try {
    if (!signal || !signal.symbol) return;

    const existing = await redis.get<any[]>(KEY);

    const safeArray = Array.isArray(existing) ? existing : [];

    const updated = [
      {
        ...signal,
        savedAt: new Date().toISOString(),
      },
      ...safeArray,
    ].slice(0, 50);

    await redis.set(KEY, updated);

    console.log(
      `[KV] ${signal.symbol}: ${signal.state} | $${signal.price}`
    );

    return true;
  } catch (err) {
    console.error("[KV STORE ERROR]", err);
    return false;
  }
}

/**
 * Read latest signals
 */
export async function getLatestSignalSnapshots() {
  try {
    const data = await redis.get<any[]>(KEY);

    if (!Array.isArray(data)) return [];

    return data;
  } catch (err) {
    console.error("[KV READ ERROR]", err);
    return [];
  }
}

/**
 * Optional reset
 */
export async function clearSignalSnapshots() {
  try {
    await redis.del(KEY);
    console.log("[KV] cleared");
  } catch (err) {
    console.error("[KV CLEAR ERROR]", err);
  }
}
