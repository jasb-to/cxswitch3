// lib/state.ts — v29.1 State Persistence (UPSTASH REDIS)
// ============================================================
// Uses Upstash Redis (REST API) for persistence.
// Credentials are read from environment variables automatically.
//
// Required env vars (already set in your Vercel project):
//   KV_REST_API_URL=https://amused-shepherd-136664.upstash.io
//   KV_REST_API_TOKEN=gQAAAAAAAhXYAAIgcDI1YzhhM2FhNmY0ZjA0NDRlOWE2ZGEwY2U2MDkwYTc4MA

import { createClient } from "@vercel/kv";
import { MarketRegime, ExitRecord, Signal } from "./strategy";

const kv = createClient({
  url: process.env.KV_REST_API_URL!,
  token: process.env.KV_REST_API_TOKEN!,
});

// ─── ACTIVE SIGNALS ───

const ACTIVE_SIGNALS_KEY = "cxswitch:active_signals";

export async function saveActiveSignals(signals: Signal[]): Promise<void> {
  await kv.set(ACTIVE_SIGNALS_KEY, signals);
}

export async function loadActiveSignals(): Promise<Signal[]> {
  const data = await kv.get<Signal[]>(ACTIVE_SIGNALS_KEY);
  return data || [];
}

// ─── REGIME PERSISTENCE ───

const REGIME_KEY = "cxswitch:regimes";

export async function persistRegime(pair: string, regime: MarketRegime): Promise<void> {
  const all = (await kv.get<Record<string, MarketRegime>>(REGIME_KEY)) || {};
  all[pair] = regime;
  await kv.set(REGIME_KEY, all);
}

export async function loadRegime(pair: string): Promise<MarketRegime | null> {
  const all = await kv.get<Record<string, MarketRegime>>(REGIME_KEY);
  return all?.[pair] || null;
}

// ─── EXIT PERSISTENCE ───

const EXITS_KEY = "cxswitch:exits";

export async function persistExit(record: ExitRecord): Promise<void> {
  const all = (await kv.get<ExitRecord[]>(EXITS_KEY)) || [];
  all.push(record);
  await kv.set(EXITS_KEY, all);
}

export async function loadExits(): Promise<ExitRecord[]> {
  return (await kv.get<ExitRecord[]>(EXITS_KEY)) || [];
}

// ─── CRON TRACKING ───

const CRON_KEY = "cxswitch:last_cron";

export async function setLastCronRun(timestamp: number): Promise<void> {
  await kv.set(CRON_KEY, { timestamp });
}

export async function getLastCronRun(): Promise<number | null> {
  const data = await kv.get<{ timestamp: number }>(CRON_KEY);
  return data?.timestamp || null;
}

// ─── DASHBOARD SNAPSHOT ───
// Saved by /api/cron, read by /api/signals.

const SNAPSHOT_KEY = "cxswitch:dashboard_snapshot";
const SNAPSHOT_TTL_MS = 20 * 60 * 1000; // 20 minutes

export async function saveDashboardSnapshot(snapshot: any): Promise<void> {
  await kv.set(SNAPSHOT_KEY, snapshot);
}

export async function loadDashboardSnapshot(): Promise<any | null> {
  const snapshot = await kv.get<any>(SNAPSHOT_KEY);
  if (!snapshot) return null;

  const age = Date.now() - (snapshot?.timestamp || 0);
  if (age > SNAPSHOT_TTL_MS) {
    console.warn(`[SNAPSHOT] Stale — ${Math.round(age / 60000)}min old`);
  }

  return snapshot;
}
