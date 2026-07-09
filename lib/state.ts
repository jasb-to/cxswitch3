// lib/state.ts — v29.1 State persistence for CXSwitch
// ============================================================
// Handles: active signals, regime cache, exit records, cron state
// Falls back to in-memory if no KV/DB configured.

import { Signal, MarketRegime, ExitRecord } from "@/lib/strategy-consolidated";

// ─── Storage backend selection ───

const USE_REDIS = !!process.env.KV_URL || !!process.env.REDIS_URL;
const USE_SQLITE = !!process.env.DATABASE_URL;

// In-memory fallback
const memoryState: {
  signals: Signal[];
  regimes: Record<string, MarketRegime>;
  exits: ExitRecord[];
  lastCronRun: number;
} = {
  signals: [],
  regimes: {},
  exits: [],
  lastCronRun: 0,
};

// ─── Redis helpers (Vercel KV or Upstash) ───

async function getRedisClient() {
  if (!USE_REDIS) return null;
  try {
    const { createClient } = await import("redis");
    const client = createClient({ url: process.env.KV_URL || process.env.REDIS_URL });
    await client.connect();
    return client;
  } catch {
    return null;
  }
}

// ─── Signal persistence ───

export async function saveActiveSignals(signals: Signal[]): Promise<void> {
  const client = await getRedisClient();
  if (client) {
    await client.set("cxswitch:active_signals", JSON.stringify(signals));
    await client.disconnect();
    return;
  }
  memoryState.signals = signals;
}

export async function loadActiveSignals(): Promise<Signal[]> {
  const client = await getRedisClient();
  if (client) {
    const data = await client.get("cxswitch:active_signals");
    await client.disconnect();
    return data ? JSON.parse(data) : [];
  }
  return memoryState.signals;
}

// ─── Regime persistence ───

export async function persistRegime(pair: string, regime: MarketRegime): Promise<void> {
  const client = await getRedisClient();
  if (client) {
    await client.hSet("cxswitch:regimes", pair, JSON.stringify(regime));
    await client.disconnect();
    return;
  }
  memoryState.regimes[pair] = regime;
}

export async function loadRegime(pair: string): Promise<MarketRegime | null> {
  const client = await getRedisClient();
  if (client) {
    const data = await client.hGet("cxswitch:regimes", pair);
    await client.disconnect();
    return data ? JSON.parse(data) : null;
  }
  return memoryState.regimes[pair] || null;
}

// ─── Exit record persistence ───

export async function persistExit(record: ExitRecord): Promise<void> {
  const client = await getRedisClient();
  if (client) {
    const existing = await client.lRange("cxswitch:exits", 0, 999);
    const exits: ExitRecord[] = existing.map(e => JSON.parse(e));
    exits.push(record);
    // Keep last 500
    const trimmed = exits.slice(-500);
    await client.del("cxswitch:exits");
    for (const r of trimmed) {
      await client.rPush("cxswitch:exits", JSON.stringify(r));
    }
    await client.disconnect();
    return;
  }
  memoryState.exits.push(record);
  if (memoryState.exits.length > 500) memoryState.exits.shift();
}

export async function loadExits(): Promise<ExitRecord[]> {
  const client = await getRedisClient();
  if (client) {
    const data = await client.lRange("cxswitch:exits", 0, -1);
    await client.disconnect();
    return data.map(d => JSON.parse(d));
  }
  return memoryState.exits;
}

// ─── Cron state ───

export async function setLastCronRun(timestamp: number): Promise<void> {
  const client = await getRedisClient();
  if (client) {
    await client.set("cxswitch:last_cron", String(timestamp));
    await client.disconnect();
    return;
  }
  memoryState.lastCronRun = timestamp;
}

export async function getLastCronRun(): Promise<number> {
  const client = await getRedisClient();
  if (client) {
    const data = await client.get("cxswitch:last_cron");
    await client.disconnect();
    return data ? parseInt(data, 10) : 0;
  }
  return memoryState.lastCronRun;
}

// ─── SQLite helpers (if DATABASE_URL is set) ───

export async function initSQLite(): Promise<void> {
  if (!USE_SQLITE) return;
  try {
    const { default: Database } = await import("better-sqlite3");
    const db = new Database(process.env.DATABASE_URL!.replace("file:", ""));
    db.exec(`
      CREATE TABLE IF NOT EXISTS signals (
        id TEXT PRIMARY KEY,
        pair TEXT NOT NULL,
        direction TEXT NOT NULL,
        entry REAL NOT NULL,
        stop REAL NOT NULL,
        target REAL NOT NULL,
        confidence REAL NOT NULL,
        timestamp INTEGER NOT NULL,
        data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS exits (
        signal_id TEXT PRIMARY KEY,
        pair TEXT NOT NULL,
        direction TEXT NOT NULL,
        exit_timestamp INTEGER NOT NULL,
        exit_reason TEXT NOT NULL,
        exit_price REAL NOT NULL
      );
      CREATE TABLE IF NOT EXISTS regimes (
        pair TEXT PRIMARY KEY,
        direction TEXT,
        strength TEXT,
        confidence REAL,
        reason TEXT,
        detected_at INTEGER NOT NULL
      );
    `);
    db.close();
  } catch (err) {
    console.warn("[STATE] SQLite init failed:", err);
  }
}
