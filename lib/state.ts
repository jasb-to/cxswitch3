// lib/state.ts — v28 "Redis State Management"
// ============================================================

import { Redis } from "@upstash/redis";

export const redis = Redis.fromEnv();

const KEY_VERSION = "v28";

const SIGNALS_KEY = `cx_signals_${KEY_VERSION}`;
const MARKET_KEY = `cx_market_${KEY_VERSION}`;
const ACTIVE_TRADES_KEY = `cx_active_trades_${KEY_VERSION}`;
const LAST_CRON_RUN_KEY = `cx_last_cron_run_${KEY_VERSION}`;
const SIGNAL_HISTORY_KEY = `cx_signal_history_${KEY_VERSION}`;
const UI_ALERTS_KEY = `cx_ui_alerts_${KEY_VERSION}`;
const CRON_LOGS_KEY = `cx_cron_logs_${KEY_VERSION}`;

const SIGNALS_TTL = 6 * 60 * 60;
const MARKET_TTL = 4 * 60 * 60;
const ACTIVE_TRADES_TTL = 24 * 60 * 60;
const LAST_CRON_RUN_TTL = 24 * 60 * 60;
const SIGNAL_HISTORY_TTL = 48 * 60 * 60;
const UI_ALERTS_TTL = 24 * 60 * 60;
const CRON_LOGS_TTL = 24 * 60 * 60;
const PAIR_STATE_TTL = 7 * 24 * 60 * 60;

export const CURRENT_SIGNAL_VERSION = 28;

export interface Signal {
  id: string;
  pair: string;
  direction: "LONG" | "SHORT";
  type?: "ACCUMULATE" | "BREAKOUT" | "EXIT";
  scale?: "ENTRY_1" | "ENTRY_2" | "ADD" | null;
  stage?: "WATCHING" | "ACCUMULATION" | "READY" | "CONFIRMED";
  rsi?: number;
  stochK?: number;
  stochD?: number;
  expectedMove?: number;
  reason?: string;
  explanation?: string;
  zoneTop?: number;
  zoneBottom?: number;
  trail?: number;
  entry: number;
  stop: number;
  target: number;
  confidence: number;
  rr: number;
  adx: number;
  timestamp: number;
  version: number;
  tradeState?: string;
  highestPrice?: number;
  lowestPrice?: number;
  lockedStop?: number;
  exited?: boolean;
  exitReason?: string;
  exitPrice?: number;
  exitTimestamp?: number;
}

export interface SignalHistory {
  pair: string;
  direction: "LONG" | "SHORT";
  type: string;
  entry: number;
  stop: number;
  target: number;
  exitedAt: number;
  exitReason: "stop_hit" | "target_hit" | "expired" | "forced_exit" | "trail_stop";
  exitPrice: number | null;
}

export interface UIAlert {
  type: string;
  message: string;
  timestamp: number;
  pair: string;
}

function safeParseArray(data: unknown): any[] {
  if (!data) return [];
  const parsed = typeof data === "string" ? JSON.parse(data) : data;
  return Array.isArray(parsed) ? parsed : [];
}

function safeParseObject(data: unknown): Record<string, any> {
  if (!data) return {};
  return typeof data === "string" ? JSON.parse(data) : (data || {});
}

function getSignalMaxAgeHours(signal: any): number {
  return 24;
}

function isSignalExpired(signal: any): boolean {
  const ageHours = (Date.now() - signal.timestamp) / (1000 * 60 * 60);
  return ageHours >= getSignalMaxAgeHours(signal);
}

export async function setSignals(signals: any[]) {
  const incoming = Array.isArray(signals) ? signals : [];
  try {
    const existing = await getSignals();
    const now = Date.now();
    const freshExisting = existing.filter((s: any) => {
      if (!s.id || s.version !== CURRENT_SIGNAL_VERSION) {
        console.log(`[STATE] Purging old-format signal for ${s.pair || "unknown"} (id=${s.id}, version=${s.version}, need=${CURRENT_SIGNAL_VERSION})`);
        return false;
      }
      const ageHours = (now - s.timestamp) / (1000 * 60 * 60);
      return ageHours < getSignalMaxAgeHours(s);
    });
    const merged: any[] = [...freshExisting];
    for (const s of incoming) {
      const idx = merged.findIndex((x: any) => x.pair === s.pair);
      if (idx >= 0) merged[idx] = s;
      else merged.push(s);
    }
    await redis.set(SIGNALS_KEY, merged, { ex: SIGNALS_TTL });
    console.log("[STATE] Saved", merged.length, "signals to KV (merged)");
  } catch (err) {
    console.error("[STATE] Signals KV write failed:", err);
  }
}

export async function getSignals(): Promise<any[]> {
  try {
    const data = await redis.get(SIGNALS_KEY);
    return safeParseArray(data);
  } catch (err) {
    console.error("[STATE] Signals KV read failed:", err);
    return [];
  }
}

export async function addSignalToHistory(signal: any, exitReason: "stop_hit" | "target_hit" | "expired" | "forced_exit" | "trail_stop", exitPrice?: number) {
  try {
    const history = await getSignalHistory();
    const entry = { ...signal, exitedAt: Date.now(), exitReason, exitPrice: exitPrice || null };
    const filtered = history.filter((h: any) => h.pair !== signal.pair);
    filtered.push(entry);
    await redis.set(SIGNAL_HISTORY_KEY, filtered.slice(-30), { ex: SIGNAL_HISTORY_TTL });
    console.log(`[STATE] Added ${signal.pair} to history: ${exitReason}`);
  } catch (err) {
    console.error("[STATE] History write failed:", err);
  }
}

export async function getSignalHistory(): Promise<any[]> {
  try {
    const data = await redis.get(SIGNAL_HISTORY_KEY);
    return safeParseArray(data);
  } catch (err) {
    console.error("[STATE] History read failed:", err);
    return [];
  }
}

export async function clearSignalHistory(): Promise<void> {
  try {
    await redis.del(SIGNAL_HISTORY_KEY);
  } catch (err) {
    console.error("[STATE] History clear failed:", err);
  }
}

export async function setMarketData(data: any[]) {
  const marketData = Array.isArray(data) ? data : [];
  try {
    await redis.set(MARKET_KEY, marketData, { ex: MARKET_TTL });
    console.log("[STATE] Saved", marketData.length, "market entries to KV");
  } catch (err) {
    console.error("[STATE] Market KV write failed:", err);
  }
}

export async function getMarketData(): Promise<any[]> {
  try {
    const data = await redis.get(MARKET_KEY);
    return safeParseArray(data);
  } catch (err) {
    console.error("[STATE] Market KV read failed:", err);
    return [];
  }
}

export async function getActiveTrades(): Promise<Record<string, any>> {
  try {
    const data = await redis.get(ACTIVE_TRADES_KEY);
    return safeParseObject(data);
  } catch (err) {
    console.error("[STATE] Active trades KV read failed:", err);
    return {};
  }
}

export async function setActiveTrades(trades: Record<string, any>) {
  try {
    await redis.set(ACTIVE_TRADES_KEY, trades, { ex: ACTIVE_TRADES_TTL });
  } catch (err) {
    console.error("[STATE] Active trades KV write failed:", err);
  }
}

export async function getLastCronRun(): Promise<number> {
  try {
    const data = await redis.get(LAST_CRON_RUN_KEY);
    return data ? Number(data) : 0;
  } catch {
    return 0;
  }
}

export async function setLastCronRun(timestamp: number): Promise<void> {
  try {
    await redis.set(LAST_CRON_RUN_KEY, timestamp, { ex: LAST_CRON_RUN_TTL });
  } catch (err) {
    console.error("[STATE] Last cron run KV write failed:", err);
  }
}

export async function getUIAlerts(): Promise<UIAlert[]> {
  try {
    const data = await redis.get(UI_ALERTS_KEY);
    return safeParseArray(data);
  } catch (err) {
    console.error("[STATE] UI alerts KV read failed:", err);
    return [];
  }
}

export async function setUIAlerts(alerts: UIAlert[]): Promise<void> {
  try {
    await redis.set(UI_ALERTS_KEY, alerts, { ex: UI_ALERTS_TTL });
  } catch (err) {
    console.error("[STATE] UI alerts KV write failed:", err);
  }
}

export async function addUIAlert(alert: UIAlert): Promise<void> {
  try {
    const existing = await getUIAlerts();
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    const filtered = existing.filter((a: UIAlert) =>
      !(a.pair === alert.pair && a.type === alert.type && a.timestamp > oneHourAgo)
    );
    filtered.push(alert);
    await redis.set(UI_ALERTS_KEY, filtered.slice(-20), { ex: UI_ALERTS_TTL });
  } catch (err) {
    console.error("[STATE] UI alert add failed:", err);
  }
}

export async function getCronLogs(): Promise<any[]> {
  try {
    const data = await redis.get(CRON_LOGS_KEY);
    return safeParseArray(data);
  } catch (err) {
    console.error("[STATE] Cron logs KV read failed:", err);
    return [];
  }
}

export async function setCronLogs(logs: any[]): Promise<void> {
  try {
    await redis.set(CRON_LOGS_KEY, logs, { ex: CRON_LOGS_TTL });
  } catch (err) {
    console.error("[STATE] Cron logs KV write failed:", err);
  }
}

export async function getPairState(pair: string): Promise<any> {
  try {
    const data = await redis.get(`cx_state_${pair}_${KEY_VERSION}`);
    return data ? safeParseObject(data) : { stage: "NONE" };
  } catch (err) {
    console.error(`[STATE] getPairState(${pair}) error:`, err);
    return { stage: "NONE" };
  }
}

export async function setPairState(pair: string, state: any): Promise<void> {
  try {
    await redis.set(`cx_state_${pair}_${KEY_VERSION}`, state, { ex: PAIR_STATE_TTL });
  } catch (err) {
    console.error(`[STATE] setPairState(${pair}) error:`, err);
  }
}

export async function resetPairConsumedZones(pair: string): Promise<void> {
  try {
    const existing = await getPairState(pair);
    await setPairState(pair, {
      ...existing,
      consumedZones: [],
      consumedZoneTimes: {},
      lastBreakoutTs: 0,
    });
    console.log(`[STATE] Reset consumed zones for ${pair}`);
  } catch (err) {
    console.error(`[STATE] resetPairConsumedZones(${pair}) failed:`, err);
  }
}

export async function resetAllConsumedZones(pairs: string[]): Promise<void> {
  for (const pair of pairs) {
    await resetPairConsumedZones(pair);
  }
}

export async function resetAll() {
  try {
    await redis.del(SIGNALS_KEY);
    await redis.del(MARKET_KEY);
    await redis.del(ACTIVE_TRADES_KEY);
    await redis.del(LAST_CRON_RUN_KEY);
    await redis.del(SIGNAL_HISTORY_KEY);
    await redis.del(UI_ALERTS_KEY);
    await redis.del(CRON_LOGS_KEY);
    console.log("[STATE] All KV data reset");
  } catch (err) {
    console.error("[STATE] Reset failed:", err);
  }
}

export async function migrateFromV15(): Promise<void> {
  const oldKeys = [
    "cx_signals_v15",
    "cx_market_v15",
    "cx_active_trades_v15",
    "cx_last_cron_run_v15",
    "cx_signal_history_v15",
    "cx_ui_alerts_v15",
    "cx_cron_logs_v15",
  ];
  for (const oldKey of oldKeys) {
    try {
      const data = await redis.get(oldKey);
      if (data) {
        const newKey = oldKey.replace("_v15", "_v28");
        await redis.set(newKey, data);
        console.log(`[MIGRATE] ${oldKey} → ${newKey}`);
      }
    } catch (e) {
      console.error(`[MIGRATE] Failed ${oldKey}:`, e);
    }
  }
}
