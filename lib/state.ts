// lib/state.ts — v54 Clean Separation
// ============================================================
// Architecture:
//   activeSignals  → KV store for currently open trades only
//   signalHistory  → KV store for permanent alert history (UI)
//   Legacy signals / active_trades KV is deprecated and migrated on first run.

import { Redis } from "@upstash/redis";
import { Signal } from "./strategy";

const redis = new Redis({
  url: process.env.KV_REST_API_URL!,
  token: process.env.KV_REST_API_TOKEN!,
});

// ─── Legacy Keys (deprecated, kept for migration) ──────────
const LEGACY_SIGNALS_KEY = "cxswitch:signals";
const LEGACY_TRADES_KEY = "cxswitch:active_trades";

// ─── New Keys ──────────────────────────────────────────────
const ACTIVE_SIGNALS_KEY = "cxswitch:active_signals";
const SIGNAL_HISTORY_KEY = "cxswitch:signal_history";
const MARKET_KEY = "cxswitch:market";
const CRON_KEY = "cxswitch:last_cron";
const SNAPSHOT_KEY = "cxswitch:dashboard_snapshot";
const MIGRATION_FLAG_KEY = "cxswitch:migrated_v54";

// ─── Types ─────────────────────────────────────────────────

export interface ActiveTrade {
  id: string;
  pair: string;
  direction: "LONG" | "SHORT";
  type: "ENTRY_1" | "ENTRY_2" | "ADD";
  entry: number;
  stop: number;
  target: number;
  timestamp: number;
  rr: number;
  status: "ACTIVE";
  context: any;
  version: number;
  holdAdvice?: {
    status: "healthy" | "warning" | "failed";
    reason: string;
    newStop?: number;
    checkedAt: number;
  };
}

export type HistoryStatus = "ACTIVE" | "TP_HIT" | "SL_HIT" | "FAILED" | "EXPIRED";

export interface SignalHistoryEntry {
  id: string;
  pair: string;
  direction: "LONG" | "SHORT";
  type: "ENTRY_1" | "ENTRY_2" | "ADD";
  entry: number;
  stop: number;
  target: number;
  timestamp: number;
  rr: number;
  status: HistoryStatus;
  exitReason?: string;
  exitPrice?: number;
  exitTimestamp?: number;
  context: any;
  version: number;
}

// ─── Migration ─────────────────────────────────────────────

export async function runMigrationIfNeeded(): Promise<void> {
  const migrated = await redis.get<boolean>(MIGRATION_FLAG_KEY);
  if (migrated) return;

  console.log("[STATE] Running v54 migration...");

  const legacySignals = await redis.get<any[]>(LEGACY_SIGNALS_KEY) || [];
  const legacyTrades = await redis.get<Record<string, any>>(LEGACY_TRADES_KEY) || {};

  const activeSignals: ActiveTrade[] = [];
  const historyEntries: SignalHistoryEntry[] = [];

  for (const s of legacySignals) {
    if (!s || !s.id) continue;

    const isActive = s.meta?.status === "ACTIVE" && !s.exited;
    const isTpHit = s.meta?.status === "TP_HIT" || s.exitReason === "tp_hit";
    const isSlHit = s.meta?.status === "SL_HIT" || s.exitReason === "sl_hit";
    const isExpired = s.meta?.status === "EXPIRED" || s.meta?.status === "STALE" || s.exitReason === "expired_ttl";

    let historyStatus: HistoryStatus = "ACTIVE";
    if (isTpHit) historyStatus = "TP_HIT";
    else if (isSlHit) historyStatus = "SL_HIT";
    else if (isExpired) historyStatus = "EXPIRED";
    else if (s.exited) historyStatus = "FAILED";

    const historyEntry: SignalHistoryEntry = {
      id: s.id,
      pair: s.pair,
      direction: s.direction,
      type: s.type,
      entry: s.entry,
      stop: s.stop,
      target: s.target,
      timestamp: s.timestamp,
      rr: s.rr ?? 0,
      status: historyStatus,
      exitReason: s.exitReason || s.meta?.status,
      exitPrice: s.exitPrice,
      exitTimestamp: s.exitTimestamp,
      context: s.context || {},
      version: s.version ?? 54,
    };
    historyEntries.push(historyEntry);

    if (isActive) {
      activeSignals.push({
        id: s.id,
        pair: s.pair,
        direction: s.direction,
        type: s.type,
        entry: s.entry,
        stop: s.stop,
        target: s.target,
        timestamp: s.timestamp,
        rr: s.rr ?? 0,
        status: "ACTIVE",
        context: s.context || {},
        version: s.version ?? 54,
      });
    }
  }

  for (const [key, t] of Object.entries(legacyTrades)) {
    if (!t || !t.id) continue;
    const alreadyInActive = activeSignals.find(a => a.id === t.id);
    if (!alreadyInActive) {
      activeSignals.push({
        id: t.id,
        pair: t.pair || key.split("_")[0],
        direction: t.direction,
        type: t.type || "ENTRY_1",
        entry: t.entry,
        stop: t.stop,
        target: t.target,
        timestamp: t.timestamp,
        rr: 0,
        status: "ACTIVE",
        context: {},
        version: 54,
      });
    }
  }

  if (activeSignals.length) {
    await redis.set(ACTIVE_SIGNALS_KEY, activeSignals);
    console.log(`[STATE] Migrated ${activeSignals.length} active signals`);
  }
  if (historyEntries.length) {
    await redis.set(SIGNAL_HISTORY_KEY, historyEntries);
    console.log(`[STATE] Migrated ${historyEntries.length} history entries`);
  }

  await redis.set(MIGRATION_FLAG_KEY, true);
  console.log("[STATE] Migration complete");
}

// ─── Active Signals ────────────────────────────────────────

export async function getActiveSignals(): Promise<ActiveTrade[]> {
  await runMigrationIfNeeded();
  const data = await redis.get<ActiveTrade[]>(ACTIVE_SIGNALS_KEY);
  return data || [];
}

export async function setActiveSignals(signals: ActiveTrade[]): Promise<void> {
  await redis.set(ACTIVE_SIGNALS_KEY, signals);
}

export async function addActiveSignal(signal: Signal): Promise<void> {
  const active = await getActiveSignals();
  const trade: ActiveTrade = {
    id: signal.id,
    pair: signal.pair,
    direction: signal.direction,
    type: signal.type,
    entry: signal.entry,
    stop: signal.stop,
    target: signal.target,
    timestamp: signal.timestamp,
    rr: signal.rr,
    status: "ACTIVE",
    context: signal.context,
    version: signal.version,
  };
  const idx = active.findIndex(a => a.pair === signal.pair && a.direction === signal.direction);
  if (idx >= 0) {
    console.log(`[ACTIVE] Replacing existing ${signal.pair} ${signal.direction}`);
    active[idx] = trade;
  } else {
    active.push(trade);
  }
  await setActiveSignals(active);
  console.log(`[ACTIVE] Added ${signal.pair} ${signal.direction} ${signal.type}`);
}

export async function removeActiveSignal(pair: string, direction: "LONG" | "SHORT"): Promise<void> {
  const active = await getActiveSignals();
  const filtered = active.filter(a => !(a.pair === pair && a.direction === direction));
  if (filtered.length !== active.length) {
    await setActiveSignals(filtered);
    console.log(`[ACTIVE] Removed ${pair} ${direction}`);
  }
}

// ─── Signal History ────────────────────────────────────────

export async function getSignalHistory(): Promise<SignalHistoryEntry[]> {
  await runMigrationIfNeeded();
  const data = await redis.get<SignalHistoryEntry[]>(SIGNAL_HISTORY_KEY);
  return data || [];
}

export async function setSignalHistory(history: SignalHistoryEntry[]): Promise<void> {
  await redis.set(SIGNAL_HISTORY_KEY, history);
}

export async function appendSignalHistory(signal: Signal): Promise<void> {
  const history = await getSignalHistory();
  const entry: SignalHistoryEntry = {
    id: signal.id,
    pair: signal.pair,
    direction: signal.direction,
    type: signal.type,
    entry: signal.entry,
    stop: signal.stop,
    target: signal.target,
    timestamp: signal.timestamp,
    rr: signal.rr,
    status: "ACTIVE",
    context: signal.context,
    version: signal.version,
  };
  const existingIdx = history.findIndex(h => h.id === signal.id);
  if (existingIdx >= 0) {
    console.log(`[HISTORY] Signal ${signal.id} already in history, skipping append`);
    return;
  }
  history.push(entry);
  if (history.length > 500) history.splice(0, history.length - 500);
  await setSignalHistory(history);
  console.log(`[HISTORY] Appended ${signal.pair} ${signal.direction} ${signal.type}`);
}

export async function updateSignalHistoryStatus(
  id: string,
  status: HistoryStatus,
  exitReason?: string,
  exitPrice?: number
): Promise<void> {
  const history = await getSignalHistory();
  const idx = history.findIndex(h => h.id === id);
  if (idx >= 0) {
    history[idx].status = status;
    if (exitReason) history[idx].exitReason = exitReason;
    if (exitPrice !== undefined) history[idx].exitPrice = exitPrice;
    history[idx].exitTimestamp = Date.now();
    await setSignalHistory(history);
    console.log(`[HISTORY] Updated ${id} -> ${status}${exitReason ? ` (${exitReason})` : ""}`);
  } else {
    console.log(`[HISTORY] Warning: could not find ${id} to update status`);
  }
}

// ─── Market Data ───────────────────────────────────────────

export async function getMarketData(): Promise<any[]> {
  const data = await redis.get<any[]>(MARKET_KEY);
  return data || [];
}

export async function setMarketData(data: any[]): Promise<void> {
  await redis.set(MARKET_KEY, data);
}

// ─── Cron Tracking ─────────────────────────────────────────

export async function getLastCronRun(): Promise<number> {
  const data = await redis.get<{ timestamp: number }>(CRON_KEY);
  return data?.timestamp || 0;
}

export async function setLastCronRun(ts: number): Promise<void> {
  await redis.set(CRON_KEY, { timestamp: ts });
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

// ─── Backward Compatibility ────────────────────────────────

/** @deprecated Use getActiveSignals */
export async function getSignals(): Promise<Signal[]> {
  const active = await getActiveSignals();
  return active.map(a => ({
    ...a,
    scale: a.type,
    adx: 0, rsi: 0, stochK: 0, stochD: 0,
    expectedMove: 0, reason: "", trend: a.direction,
    location: "", trigger: "",
  } as Signal));
}

/** @deprecated Use setActiveSignals */
export async function setSignals(signals: Signal[]): Promise<void> {}

/** @deprecated Use getActiveSignals + getSignalHistory */
export async function getActiveTrades(): Promise<Record<string, any>> {
  const active = await getActiveSignals();
  const trades: Record<string, any> = {};
  for (const a of active) {
    trades[`${a.pair}_${a.direction}`] = {
      direction: a.direction,
      timestamp: a.timestamp,
      entry: a.entry,
      stop: a.stop,
      target: a.target,
      id: a.id,
      type: a.type,
      crossHash: a.context?.crossHash || "",
    };
  }
  return trades;
}

/** @deprecated Use setActiveSignals */
export async function setActiveTrades(trades: Record<string, any>): Promise<void> {}

/** @deprecated Use appendSignalHistory + updateSignalHistoryStatus */
export async function addSignalToHistory(signal: Signal, reason: string, exitPrice: number): Promise<void> {
  await updateSignalHistoryStatus(signal.id, "FAILED", reason, exitPrice);
}

/** @deprecated Use appendSignalHistory */
export async function persistExit(record: any): Promise<void> {}

/** @deprecated Use updateSignalHistoryStatus */
export async function persistLastExit(pair: string, record: any): Promise<void> {}

/** @deprecated Not needed with new architecture */
export async function loadLastExit(pair: string): Promise<any | null> {
  return null;
}
