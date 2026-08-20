// lib/state.ts — v01 canonical state
// V28 trade architecture is stored here as the single active/history model.

import { Redis } from "@upstash/redis";
import { Signal } from "./strategy";

const redis = new Redis({
  url: process.env.KV_REST_API_URL!,
  token: process.env.KV_REST_API_TOKEN!,
});

const LEGACY_SIGNALS_KEY = "cxswitch:signals";
const LEGACY_TRADES_KEY = "cxswitch:active_trades";
const ACTIVE_SIGNALS_KEY = "cxswitch:active_signals";
const SIGNAL_HISTORY_KEY = "cxswitch:signal_history";
const MARKET_KEY = "cxswitch:market";
const CRON_KEY = "cxswitch:last_cron";
const SNAPSHOT_KEY = "cxswitch:dashboard_snapshot";
const MIGRATION_FLAG_KEY = "cxswitch:migrated_v01";
const COOLDOWN_KEY = "cxswitch:cooldowns";

export interface ActiveTrade {
  id: string;
  pair: string;
  direction: "LONG" | "SHORT";
  type: "ENTRY_1" | "ENTRY_2" | "ADD";
  entry: number;
  stop: number;
  target: number;
  tp1?: number;
  tp2?: number;
  tp3?: number;
  tp1HitAt?: number;
  tp2HitAt?: number;
  tp3HitAt?: number;
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
  tp1?: number;
  tp2?: number;
  tp3?: number;
  tp1HitAt?: number;
  tp2HitAt?: number;
  tp3HitAt?: number;
  timestamp: number;
  rr: number;
  status: HistoryStatus;
  exitReason?: string;
  exitPrice?: number;
  exitTimestamp?: number;
  context: any;
  version: number;
}

function stagedTargets(s: any) {
  return {
    tp1: s?.tp1 ?? s?.context?.stages?.tp1,
    tp2: s?.tp2 ?? s?.context?.stages?.tp2 ?? s?.target,
    tp3: s?.tp3 ?? s?.context?.stages?.tp3 ?? s?.target,
  };
}

// One-time migration of data written by the pre-v01 state model.
// After this runs, all application code uses the canonical keys below.
export async function runMigrationIfNeeded(): Promise<void> {
  const migrated = await redis.get<boolean>(MIGRATION_FLAG_KEY);
  if (migrated) return;

  console.log("[STATE] Running one-time state migration...");
  const legacySignals = await redis.get<any[]>(LEGACY_SIGNALS_KEY) || [];
  const legacyTrades = await redis.get<Record<string, any>>(LEGACY_TRADES_KEY) || {};
  const activeSignals: ActiveTrade[] = [];
  const historyEntries: SignalHistoryEntry[] = [];

  for (const s of legacySignals) {
    if (!s || !s.id) continue;
    const stages = stagedTargets(s);
    const isActive = s.meta?.status === "ACTIVE" && !s.exited;
    const isTpHit = s.meta?.status === "TP_HIT" || s.exitReason === "tp_hit";
    const isSlHit = s.meta?.status === "SL_HIT" || s.exitReason === "sl_hit";
    const isExpired = s.meta?.status === "EXPIRED" || s.meta?.status === "STALE" || s.exitReason === "expired_ttl";
    let historyStatus: HistoryStatus = "ACTIVE";
    if (isTpHit) historyStatus = "TP_HIT";
    else if (isSlHit) historyStatus = "SL_HIT";
    else if (isExpired) historyStatus = "EXPIRED";
    else if (s.exited) historyStatus = "FAILED";

    historyEntries.push({
      id: s.id,
      pair: s.pair,
      direction: s.direction,
      type: s.type,
      entry: s.entry,
      stop: s.stop,
      target: stages.tp2 ?? s.target,
      tp1: stages.tp1,
      tp2: stages.tp2,
      tp3: stages.tp3,
      timestamp: s.timestamp,
      rr: s.rr ?? 0,
      status: historyStatus,
      exitReason: s.exitReason || s.meta?.status,
      exitPrice: s.exitPrice,
      exitTimestamp: s.exitTimestamp,
      context: s.context || {},
      version: 1,
    });

    if (isActive) {
      activeSignals.push({
        id: s.id,
        pair: s.pair,
        direction: s.direction,
        type: s.type,
        entry: s.entry,
        stop: s.stop,
        target: stages.tp2 ?? s.target,
        tp1: stages.tp1,
        tp2: stages.tp2,
        tp3: stages.tp3,
        timestamp: s.timestamp,
        rr: s.rr ?? 0,
        status: "ACTIVE",
        context: s.context || {},
        version: 1,
      });
    }
  }

  for (const [key, t] of Object.entries(legacyTrades)) {
    if (!t || !t.id) continue;
    if (activeSignals.some(a => a.id === t.id)) continue;
    const stages = stagedTargets(t);
    activeSignals.push({
      id: t.id,
      pair: t.pair || key.split("_")[0],
      direction: t.direction,
      type: t.type || "ENTRY_1",
      entry: t.entry,
      stop: t.stop,
      target: stages.tp2 ?? t.target,
      tp1: stages.tp1,
      tp2: stages.tp2,
      tp3: stages.tp3,
      timestamp: t.timestamp,
      rr: 0,
      status: "ACTIVE",
      context: t.context || {},
      version: 1,
    });
  }

  if (activeSignals.length) await redis.set(ACTIVE_SIGNALS_KEY, activeSignals);
  if (historyEntries.length) await redis.set(SIGNAL_HISTORY_KEY, historyEntries);
  await redis.set(MIGRATION_FLAG_KEY, true);
  console.log(`[STATE] Migration complete: active=${activeSignals.length} history=${historyEntries.length}`);
}

export async function getActiveSignals(): Promise<ActiveTrade[]> {
  await runMigrationIfNeeded();
  return (await redis.get<ActiveTrade[]>(ACTIVE_SIGNALS_KEY)) || [];
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
    target: signal.tp2 ?? signal.target,
    tp1: signal.tp1,
    tp2: signal.tp2,
    tp3: signal.tp3,
    timestamp: signal.timestamp,
    rr: signal.rr,
    status: "ACTIVE",
    context: signal.context,
    version: 1,
  };
  const idx = active.findIndex(a => a.pair === signal.pair && a.direction === signal.direction);
  if (idx >= 0) active[idx] = { ...active[idx], ...trade };
  else active.push(trade);
  await setActiveSignals(active);
  console.log(`[ACTIVE] Added ${signal.pair} ${signal.direction} ${signal.type} | TP1 ${trade.tp1 ?? "—"} | TP2 ${trade.tp2 ?? "—"} | TP3 ${trade.tp3 ?? "—"}`);
}

export async function removeActiveSignal(pair: string, direction: "LONG" | "SHORT"): Promise<void> {
  const active = await getActiveSignals();
  const filtered = active.filter(a => !(a.pair === pair && a.direction === direction));
  if (filtered.length !== active.length) {
    await setActiveSignals(filtered);
    console.log(`[ACTIVE] Removed ${pair} ${direction}`);
  }
}

export async function removeActiveSignalById(id: string): Promise<void> {
  const active = await getActiveSignals();
  const filtered = active.filter(a => a.id !== id);
  if (filtered.length !== active.length) {
    await setActiveSignals(filtered);
    console.log(`[ACTIVE] Removed signal ${id}`);
  }
}

export async function updateActiveTradeMilestones(id: string, price: number): Promise<ActiveTrade | undefined> {
  const active = await getActiveSignals();
  const trade = active.find(a => a.id === id);
  if (!trade) return undefined;
  const hit = (level: number | undefined, direction: "LONG" | "SHORT") =>
    level !== undefined && (direction === "LONG" ? price >= level : price <= level);
  let changed = false;
  if (!trade.tp1HitAt && hit(trade.tp1, trade.direction)) {
    trade.tp1HitAt = Date.now();
    changed = true;
    console.log(`[MILESTONE] ${trade.pair} — TP1 reached @ ${price}`);
  }
  if (!trade.tp2HitAt && hit(trade.tp2, trade.direction)) {
    trade.tp2HitAt = Date.now();
    changed = true;
    console.log(`[MILESTONE] ${trade.pair} — TP2 reached @ ${price}`);
  }
  if (!trade.tp3HitAt && hit(trade.tp3, trade.direction)) {
    trade.tp3HitAt = Date.now();
    changed = true;
    console.log(`[MILESTONE] ${trade.pair} — TP3 reached @ ${price}`);
  }
  if (changed) await setActiveSignals(active);
  return trade;
}

export async function getSignalHistory(): Promise<SignalHistoryEntry[]> {
  await runMigrationIfNeeded();
  return (await redis.get<SignalHistoryEntry[]>(SIGNAL_HISTORY_KEY)) || [];
}

export async function setSignalHistory(history: SignalHistoryEntry[]): Promise<void> {
  await redis.set(SIGNAL_HISTORY_KEY, history);
}

export async function appendSignalHistory(signal: Signal): Promise<void> {
  const history = await getSignalHistory();
  if (history.some(h => h.id === signal.id)) {
    console.log(`[HISTORY] Signal ${signal.id} already recorded`);
    return;
  }
  const entry: SignalHistoryEntry = {
    id: signal.id,
    pair: signal.pair,
    direction: signal.direction,
    type: signal.type,
    entry: signal.entry,
    stop: signal.stop,
    target: signal.tp2 ?? signal.target,
    tp1: signal.tp1,
    tp2: signal.tp2,
    tp3: signal.tp3,
    timestamp: signal.timestamp,
    rr: signal.rr,
    status: "ACTIVE",
    context: signal.context,
    version: 1,
  };
  history.push(entry);
  if (history.length > 500) history.splice(0, history.length - 500);
  await setSignalHistory(history);
  console.log(`[HISTORY] Appended ${signal.pair} ${signal.direction} ${signal.type} | TP1 ${entry.tp1 ?? "—"} | TP2 ${entry.tp2 ?? "—"} | TP3 ${entry.tp3 ?? "—"}`);
}

export async function updateSignalHistoryStatus(
  id: string,
  status: HistoryStatus,
  exitReason?: string,
  exitPrice?: number,
): Promise<void> {
  const history = await getSignalHistory();
  const idx = history.findIndex(h => h.id === id);
  if (idx < 0) {
    console.log(`[HISTORY] Warning: could not find ${id}`);
    return;
  }
  history[idx].status = status;
  if (exitReason) history[idx].exitReason = exitReason;
  if (exitPrice !== undefined) history[idx].exitPrice = exitPrice;
  history[idx].exitTimestamp = Date.now();
  await setSignalHistory(history);
  console.log(`[HISTORY] Updated ${id} -> ${status}${exitReason ? ` (${exitReason})` : ""}`);
}

export async function updateHistoryMilestones(id: string, price: number): Promise<SignalHistoryEntry | undefined> {
  const history = await getSignalHistory();
  const h = history.find(x => x.id === id);
  if (!h) return undefined;
  const hit = (level: number | undefined, direction: "LONG" | "SHORT") =>
    level !== undefined && (direction === "LONG" ? price >= level : price <= level);
  let changed = false;
  if (!h.tp1HitAt && hit(h.tp1, h.direction)) {
    h.tp1HitAt = Date.now();
    changed = true;
  }
  if (!h.tp2HitAt && hit(h.tp2, h.direction)) {
    h.tp2HitAt = Date.now();
    changed = true;
  }
  if (!h.tp3HitAt && hit(h.tp3, h.direction)) {
    h.tp3HitAt = Date.now();
    changed = true;
  }
  if (changed) await setSignalHistory(history);
  return h;
}

export async function getCooldowns(): Promise<Record<string, number>> {
  return (await redis.get<Record<string, number>>(COOLDOWN_KEY)) || {};
}

export async function setCooldowns(cooldowns: Record<string, number>): Promise<void> {
  await redis.set(COOLDOWN_KEY, cooldowns);
}

export async function getMarketData(): Promise<any[]> {
  return (await redis.get<any[]>(MARKET_KEY)) || [];
}

export async function setMarketData(data: any[]): Promise<void> {
  await redis.set(MARKET_KEY, data);
}

export async function getLastCronRun(): Promise<number> {
  const data = await redis.get<{ timestamp: number }>(CRON_KEY);
  return data?.timestamp || 0;
}

export async function setLastCronRun(ts: number): Promise<void> {
  await redis.set(CRON_KEY, { timestamp: ts });
}

export async function saveDashboardSnapshot(snapshot: any): Promise<void> {
  await redis.set(SNAPSHOT_KEY, { ...snapshot, timestamp: Date.now() });
}

export async function loadDashboardSnapshot(): Promise<any | null> {
  const data = await redis.get<any>(SNAPSHOT_KEY);
  if (!data) return null;
  const age = Date.now() - (data?.timestamp || 0);
  if (age > 20 * 60 * 1000) console.warn(`[SNAPSHOT] Stale — ${Math.round(age / 60000)}min old`);
  return data;
}
