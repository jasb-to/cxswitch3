// lib/state.ts — v23.2 "FIXED: Early TTL 1h + freshness gate + KV persistence"
// ============================================================

import { Redis } from "@upstash/redis";

export const redis = Redis.fromEnv();

const SIGNALS_KEY = "cx_signals_v15";
const MARKET_KEY = "cx_market_v15";
const ACTIVE_TRADES_KEY = "cx_active_trades_v15";
const LAST_CRON_RUN_KEY = "cx_last_cron_run_v15";
const SIGNAL_HISTORY_KEY = "cx_signal_history_v15";
const HYSTERESIS_KEY = "cx_hysteresis_v15";
const TRENDLINE_KEY = "cx_trendline_v15";

const SIGNALS_TTL = 6 * 60 * 60;
const MARKET_TTL = 4 * 60 * 60;
const ACTIVE_TRADES_TTL = 24 * 60 * 60;
const LAST_CRON_RUN_TTL = 24 * 60 * 60;
const SIGNAL_HISTORY_TTL = 48 * 60 * 60;

// CRITICAL: Must match lib/strategy.ts CURRENT_SIGNAL_VERSION
export const CURRENT_SIGNAL_VERSION = 30;

export type SignalType = "EARLY" | "BREAKOUT" | "PULLBACK" | "CONTINUATION" | "REVERSAL";

export interface Signal {
  id: string;
  pair: string;
  direction: "LONG" | "SHORT";
  type: SignalType;
  confidence: number;
  entry: number;
  stop: number;
  target: number;
  rr: number;
  timestamp: number;
  adx: number;
  rsi: number;
  stochK: number;
  stochD: number;
  expectedMove: number;
  reason: string;
  version: number;
}

export interface SignalHistory {
  pair: string;
  direction: "LONG" | "SHORT";
  type: string;
  entry: number;
  stop: number;
  target: number;
  exitedAt: number;
  exitReason: "stop_hit" | "target_hit" | "expired" | "hold_exit";
  exitPrice: number | null;
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
  if (signal.type === "EARLY") return 1;
  if (signal.type === "BREAKOUT") return 6;
  if (signal.type === "PULLBACK") return 4;
  if (signal.type === "REVERSAL") return 4;
  return 6;
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

export async function addSignalToHistory(signal: any, exitReason: "stop_hit" | "target_hit" | "expired" | "hold_exit", exitPrice?: number) {
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

export async function getHysteresisState(): Promise<Record<string, any>> {
  try {
    const data = await redis.get(HYSTERESIS_KEY);
    return safeParseObject(data);
  } catch (err) {
    console.error("[STATE] Hysteresis KV read failed:", err);
    return {};
  }
}

export async function setHysteresisState(state: Record<string, any>): Promise<void> {
  try {
    await redis.set(HYSTERESIS_KEY, state, { ex: ACTIVE_TRADES_TTL });
  } catch (err) {
    console.error("[STATE] Hysteresis KV write failed:", err);
  }
}

export async function getTrendlineState(): Promise<Record<string, any>> {
  try {
    const data = await redis.get(TRENDLINE_KEY);
    return safeParseObject(data);
  } catch (err) {
    console.error("[STATE] Trendline KV read failed:", err);
    return {};
  }
}

export async function setTrendlineState(state: Record<string, any>): Promise<void> {
  try {
    await redis.set(TRENDLINE_KEY, state, { ex: ACTIVE_TRADES_TTL });
  } catch (err) {
    console.error("[STATE] Trendline KV write failed:", err);
  }
}

export async function resetAll() {
  try {
    await redis.del(SIGNALS_KEY);
    await redis.del(MARKET_KEY);
    await redis.del(ACTIVE_TRADES_KEY);
    await redis.del(LAST_CRON_RUN_KEY);
    await redis.del(SIGNAL_HISTORY_KEY);
    await redis.del(HYSTERESIS_KEY);
    await redis.del(TRENDLINE_KEY);
    console.log("[STATE] All KV data reset");
  } catch (err) {
    console.error("[STATE] Reset failed:", err);
  }
  
}

const CRON_LOGS_KEY = "cx_cron_logs_v15";
const CRON_LOGS_TTL = 24 * 60 * 60;

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
