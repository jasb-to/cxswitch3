// lib/state.ts — v23.3 "Sync with strategy v28.1 + UI alerts"
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
const UI_ALERTS_KEY = "cx_ui_alerts_v15"; // NEW

const SIGNALS_TTL = 6 * 60 * 60;
const MARKET_TTL = 4 * 60 * 60;
const ACTIVE_TRADES_TTL = 24 * 60 * 60;
const LAST_CRON_RUN_TTL = 24 * 60 * 60;
const SIGNAL_HISTORY_TTL = 48 * 60 * 60;
const UI_ALERTS_TTL = 24 * 60 * 60; // NEW

// CRITICAL FIX: Must match lib/strategy.ts CURRENT_SIGNAL_VERSION
// v28.1 strategy emits version 28 — state must accept it
export const CURRENT_SIGNAL_VERSION = 28;

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
  // v28.1 fields (optional for backward compat)
  scale?: "ENTRY_1" | "ENTRY_2" | "ADD" | null;
}

// NEW: UI Alert interface
export interface UIAlert {
  type: "SHORT_ALERT_OVERSOLD_CROSS" | "LONG_ALERT_OVERBOUGHT_CROSS";
  message: string;
  stochK: number;
  stochD: number;
  timestamp: number;
  pair: string;
}

// ... rest of existing functions unchanged ...

// NEW: UI Alert KV helpers
export async function setUIAlerts(alerts: UIAlert[]): Promise<void> {
  try {
    await redis.set(UI_ALERTS_KEY, alerts, { ex: UI_ALERTS_TTL });
  } catch (err) {
    console.error("[STATE] UI alerts KV write failed:", err);
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

export async function addUIAlert(alert: UIAlert): Promise<void> {
  try {
    const existing = await getUIAlerts();
    // Deduplicate: same pair + same type within 1 hour
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    const filtered = existing.filter(a => 
      !(a.pair === alert.pair && a.type === alert.type && a.timestamp > oneHourAgo)
    );
    filtered.push(alert);
    await redis.set(UI_ALERTS_KEY, filtered.slice(-20), { ex: UI_ALERTS_TTL });
  } catch (err) {
    console.error("[STATE] UI alert add failed:", err);
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
    await redis.del(UI_ALERTS_KEY); // NEW
    console.log("[STATE] All KV data reset");
  } catch (err) {
    console.error("[STATE] Reset failed:", err);
  }
}

// ... existing cron logs functions unchanged ...
