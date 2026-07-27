// lib/state.ts — v50 Simplified State
// ============================================================

import { Redis } from "@upstash/redis";
import { Signal } from "./strategy";

const redis = new Redis({
  url: process.env.KV_REST_API_URL!,
  token: process.env.KV_REST_API_TOKEN!,
});

const SIGNALS_KEY = "cxswitch:signals";
const MARKET_KEY = "cxswitch:market";
const TRADES_KEY = "cxswitch:active_trades";
const CRON_KEY = "cxswitch:last_cron";
const HISTORY_KEY = "cxswitch:history";
const LAST_EXIT_KEY = "cxswitch:last_exits";
const SNAPSHOT_KEY = "cxswitch:dashboard_snapshot";

// ─── Signals (backward compat aliases) ───────────────────

export async function getSignals(): Promise<Signal[]> {
  const data = await redis.get<Signal[]>(SIGNALS_KEY);
  return data || [];
}

export async function setSignals(signals: Signal[]): Promise<void> {
  await redis.set(SIGNALS_KEY, signals);
}

/** @deprecated Use setSignals */
export async function saveActiveSignals(signals: Signal[]): Promise<void> {
  await setSignals(signals);
}

/** @deprecated Use getSignals */
export async function loadActiveSignals(): Promise<Signal[]> {
  return getSignals();
}

// ─── Market Data ───────────────────────────────────────────

export async function getMarketData(): Promise<any[]> {
  const data = await redis.get<any[]>(MARKET_KEY);
  return data || [];
}

export async function setMarketData(data: any[]): Promise<void> {
  await redis.set(MARKET_KEY, data);
}

// ─── Active Trades ─────────────────────────────────────────

export async function getActiveTrades(): Promise<Record<string, any>> {
  const data = await redis.get<Record<string, any>>(TRADES_KEY);
  return data || {};
}

export async function setActiveTrades(trades: Record<string, any>): Promise<void> {
  await redis.set(TRADES_KEY, trades);
}

// ─── Cron Tracking ─────────────────────────────────────────

export async function getLastCronRun(): Promise<number> {
  const data = await redis.get<{ timestamp: number }>(CRON_KEY);
  return data?.timestamp || 0;
}

export async function setLastCronRun(ts: number): Promise<void> {
  await redis.set(CRON_KEY, { timestamp: ts });
}

// ─── Signal History ────────────────────────────────────────

export async function getSignalHistory(): Promise<any[]> {
  const data = await redis.get<any[]>(HISTORY_KEY);
  return data || [];
}

export async function addSignalToHistory(
  signal: Signal,
  reason: string,
  exitPrice: number
): Promise<void> {
  const all = await getSignalHistory();
  all.push({
    ...signal,
    exitReason: reason,
    exitPrice,
    exitTimestamp: Date.now(),
  });
  if (all.length > 200) all.splice(0, all.length - 200);
  await redis.set(HISTORY_KEY, all);
}

// ─── Exit Records ─────────────────────────────────────────

export async function persistExit(record: any): Promise<void> {
  const all = (await redis.get<any[]>("cxswitch:exits")) || [];
  all.push(record);
  await redis.set("cxswitch:exits", all);
}

// ─── Last Exit Tracking ────────────────────────────────────

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

// ─── Dashboard Snapshot ────────────────────────────────────

export async function saveDashboardSnapshot(snapshot: any): Promise<void> {
  await redis.set(SNAPSHOT_KEY, { ...snapshot, timestamp: Date.now() });
}

export async function loadDashboardSnapshot(): Promise<any | null> {
  const data = await redis.get<any>(SNAPSHOT_KEY);
  if (!data) return null;
  const age = Date.now() - (data?.timestamp || 0);
  if (age > 20 * 60 * 1000) {
    console.warn(`[SNAPSHOT] Stale — ${Math.round(age / 60000)}min old`);
  }
  return data;
}
