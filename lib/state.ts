// lib/state.ts — v29.1 State Persistence (UPSTASH REDIS)
// ============================================================
// Uses @upstash/redis (HTTP/REST client) for persistence.
// Install: npm install @upstash/redis  or  pnpm add @upstash/redis
//
// Your env vars (already set):
//   KV_REST_API_URL=https://amused-shepherd-136664.upstash.io
//   KV_REST_API_TOKEN=gQAAAAAAAhXYAAIgcDI1YzhhM2FhNmY0ZjA0NDRlOWE2ZGEwY2U2MDkwYTc4MA

import { Redis } from "@upstash/redis";
import { MarketRegime, ExitRecord, Signal } from "./strategy";

const redis = new Redis({
  url: process.env.KV_REST_API_URL!,
  token: process.env.KV_REST_API_TOKEN!,
});

// ─── ACTIVE SIGNALS ───

const ACTIVE_SIGNALS_KEY = "cxswitch:active_signals";

export async function saveActiveSignals(signals: Signal[]): Promise<void> {
  await redis.set(ACTIVE_SIGNALS_KEY, signals);
}

export async function loadActiveSignals(): Promise<Signal[]> {
  const data = await redis.get<Signal[]>(ACTIVE_SIGNALS_KEY);
  return data || [];
}

// ─── REGIME PERSISTENCE ───

const REGIME_KEY = "cxswitch:regimes";

export async function persistRegime(pair: string, regime: MarketRegime): Promise<void> {
  const all = (await redis.get<Record<string, MarketRegime>>(REGIME_KEY)) || {};
  all[pair] = regime;
  await redis.set(REGIME_KEY, all);
}

export async function loadRegime(pair: string): Promise<MarketRegime | null> {
  const all = await redis.get<Record<string, MarketRegime>>(REGIME_KEY);
  return all?.[pair] || null;
}

// ─── EXIT PERSISTENCE ───

const EXITS_KEY = "cxswitch:exits";

export async function persistExit(record: ExitRecord): Promise<void> {
  const all = (await redis.get<ExitRecord[]>(EXITS_KEY)) || [];
  all.push(record);
  await redis.set(EXITS_KEY, all);
}

export async function loadExits(): Promise<ExitRecord[]> {
  return (await redis.get<ExitRecord[]>(EXITS_KEY)) || [];
}

// ─── CRON TRACKING ───

const CRON_KEY = "cxswitch:last_cron";

export async function setLastCronRun(timestamp: number): Promise<void> {
  await redis.set(CRON_KEY, { timestamp });
}

export async function getLastCronRun(): Promise<number | null> {
  const data = await redis.get<{ timestamp: number }>(CRON_KEY);
  return data?.timestamp || null;
}

// ─── DASHBOARD SNAPSHOT ───
// Saved by /api/cron, read by /api/signals.

const SNAPSHOT_KEY = "cxswitch:dashboard_snapshot";
const SNAPSHOT_TTL_MS = 20 * 60 * 1000; // 20 minutes

export async function saveDashboardSnapshot(snapshot: any): Promise<void> {
  await redis.set(SNAPSHOT_KEY, snapshot);
}

export async function loadDashboardSnapshot(): Promise<any | null> {
  const snapshot = await redis.get<any>(SNAPSHOT_KEY);
  if (!snapshot) return null;

  const age = Date.now() - (snapshot?.timestamp || 0);
  if (age > SNAPSHOT_TTL_MS) {
    console.warn(`[SNAPSHOT] Stale — ${Math.round(age / 60000)}min old`);
  }

  return snapshot;
}
