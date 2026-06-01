import { kv } from "@vercel/kv";

const KEY = "cx:snapshots";

/**
 * Store a single signal snapshot
 */
export async function storeSignalSnapshot(signal: any) {
  try {
    if (!signal || !signal.symbol) return;

    const existing = await kv.get<any[]>(KEY);

    const safeArray = Array.isArray(existing) ? existing : [];

    const updated = [
      {
        ...signal,
        savedAt: new Date().toISOString(),
      },
      ...safeArray,
    ].slice(0, 50); // keep last 50 only

    await kv.set(KEY, updated);

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
 * Get latest snapshots for UI
 */
export async function getLatestSignalSnapshots() {
  try {
    const data = await kv.get<any[]>(KEY);

    if (!Array.isArray(data)) {
      console.warn("[KV] No snapshot array found, returning empty list");
      return [];
    }

    return data;
  } catch (err) {
    console.error("[KV READ ERROR]", err);
    return [];
  }
}

/**
 * Optional helper (used if you ever reset system)
 */
export async function clearSignalSnapshots() {
  try {
    await kv.del(KEY);
    console.log("[KV] snapshots cleared");
  } catch (err) {
    console.error("[KV CLEAR ERROR]", err);
  }
}
