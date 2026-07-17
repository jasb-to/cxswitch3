import { Redis } from "@upstash/redis";
import { MarketRegime, ExitRecord, Signal } from "./strategy";

const redis = new Redis({
  url: process.env.KV_REST_API_URL!,
  token: process.env.KV_REST_API_TOKEN!,
});

const ACTIVE_KEY = "cxswitch:active_signals";
const REGIME_KEY = "cxswitch:regimes";
const EXIT_KEY = "cxswitch:exits";
const CRON_KEY = "cxswitch:last_cron";
const SNAPSHOT_KEY = "cxswitch:dashboard_snapshot";
const LAST_EXIT_KEY = "cxswitch:last_exits";

// ─── Active Signals ─────────────────────────────────────────

export async function saveActiveSignals(signals: Signal[]): Promise<void> {
  await redis.set(ACTIVE_KEY, signals);
}

export async function loadActiveSignals(): Promise<Signal[]> {
  const data = await redis.get<Signal[]>(ACTIVE_KEY);
  return data || [];
}

// ─── Regime Persistence ─────────────────────────────────────

export async function persistRegime(pair: string, regime: MarketRegime): Promise<void> {
  const all = (await redis.get<Record<string, MarketRegime>>(REGIME_KEY)) || {};
  all[pair] = regime;
  await redis.set(REGIME_KEY, all);
}

export async function loadRegime(pair: string): Promise<MarketRegime | null> {
  const all = await redis.get<Record<string, MarketRegime>>(REGIME_KEY);
  return all?.[pair] || null;
}

// ─── Exit Records ───────────────────────────────────────────

export async function persistExit(record: ExitRecord): Promise<void> {
  const all = (await redis.get<ExitRecord[]>(EXIT_KEY)) || [];
  all.push(record);
  await redis.set(EXIT_KEY, all);
}

export async function loadExits(): Promise<ExitRecord[]> {
  return (await redis.get<ExitRecord[]>(EXIT_KEY)) || [];
}

// ─── Last Exit Tracking (v37.5) ─────────────────────────────

export async function persistLastExit(
  pair: string,
  record: { direction: "LONG" | "SHORT"; reason: string; timestamp: number }
): Promise<void> {
  const all = (await redis.get<Record<string, { direction: "LONG" | "SHORT"; reason: string; timestamp: number }>>(LAST_EXIT_KEY)) || {};
  all[pair] = record;
  await redis.set(LAST_EXIT_KEY, all);
}

export async function loadLastExit(
  pair: string
): Promise<{ direction: "LONG" | "SHORT"; reason: string; timestamp: number } | null> {
  const all = await redis.get<Record<string, { direction: "LONG" | "SHORT"; reason: string; timestamp: number }>>(LAST_EXIT_KEY);
  if (!all || !all[pair]) return null;
  const record = all[pair];
  if (Date.now() - record.timestamp > 4 * 60 * 60 * 1000) {
    delete all[pair];
    await redis.set(LAST_EXIT_KEY, all);
    return null;
  }
  return record;
}

// ─── Cron Tracking ──────────────────────────────────────────

export async function setLastCronRun(ts: number): Promise<void> {
  await redis.set(CRON_KEY, { timestamp: ts });
}

export async function getLastCronRun(): Promise<number | null> {
  const data = await redis.get<{ timestamp: number }>(CRON_KEY);
  return data?.timestamp || null;
}

// ─── Dashboard Snapshot ─────────────────────────────────────

export async function saveDashboardSnapshot(snapshot: any): Promise<void> {
  await redis.set(SNAPSHOT_KEY, snapshot);
}

export async function loadDashboardSnapshot(): Promise<any | null> {
  const snapshot = await redis.get<any>(SNAPSHOT_KEY);
  if (!snapshot) return null;
  const age = Date.now() - (snapshot?.timestamp || 0);
  if (age > 20 * 60 * 1000) {
    console.warn(`[SNAPSHOT] Stale — ${Math.round(age / 60000)}min old`);
  }
  return snapshot;
}
