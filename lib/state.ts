// lib/state.ts — v29 "Redis State Management"
// ============================================================
// MIGRATED from v15 to v29 keys
// All functions preserved, no breaking changes

import { kv } from "@vercel/kv";

// ─── Redis Key Helpers ─────────────────────────────────────────────────

const KEY_VERSION = "v29";

function key(base: string): string {
  return `cx_${base}_${KEY_VERSION}`;
}

// ─── Signals ───────────────────────────────────────────────────────────

export async function getSignals(): Promise<any[]> {
  try {
    const data = await kv.get(key("signals"));
    return Array.isArray(data) ? data : [];
  } catch (e) {
    console.error("[STATE] getSignals error:", e);
    return [];
  }
}

export async function setSignals(signals: any[]): Promise<void> {
  try {
    await kv.set(key("signals"), signals);
  } catch (e) {
    console.error("[STATE] setSignals error:", e);
  }
}

// ─── Market Data ───────────────────────────────────────────────────────

export async function getMarketData(): Promise<any[]> {
  try {
    const data = await kv.get(key("market"));
    return Array.isArray(data) ? data : [];
  } catch (e) {
    console.error("[STATE] getMarketData error:", e);
    return [];
  }
}

export async function setMarketData(data: any[]): Promise<void> {
  try {
    await kv.set(key("market"), data);
  } catch (e) {
    console.error("[STATE] setMarketData error:", e);
  }
}

// ─── Active Trades ─────────────────────────────────────────────────────

export async function getActiveTrades(): Promise<Record<string, any>> {
  try {
    const data = await kv.get(key("active_trades"));
    return data && typeof data === "object" ? data : {};
  } catch (e) {
    console.error("[STATE] getActiveTrades error:", e);
    return {};
  }
}

export async function setActiveTrades(trades: Record<string, any>): Promise<void> {
  try {
    await kv.set(key("active_trades"), trades);
  } catch (e) {
    console.error("[STATE] setActiveTrades error:", e);
  }
}

// ─── Last Cron Run ─────────────────────────────────────────────────────

export async function getLastCronRun(): Promise<number> {
  try {
    const data = await kv.get(key("last_cron_run"));
    return typeof data === "number" ? data : 0;
  } catch (e) {
    console.error("[STATE] getLastCronRun error:", e);
    return 0;
  }
}

export async function setLastCronRun(timestamp: number): Promise<void> {
  try {
    await kv.set(key("last_cron_run"), timestamp);
  } catch (e) {
    console.error("[STATE] setLastCronRun error:", e);
  }
}

// ─── Signal History ──────────────────────────────────────────────────────

export async function getSignalHistory(): Promise<any[]> {
  try {
    const data = await kv.get(key("signal_history"));
    return Array.isArray(data) ? data : [];
  } catch (e) {
    console.error("[STATE] getSignalHistory error:", e);
    return [];
  }
}

export async function addSignalToHistory(signal: any, reason: string, exitPrice: number): Promise<void> {
  try {
    const history = await getSignalHistory();
    history.unshift({
      signal,
      reason,
      exitPrice,
      exitedAt: Date.now(),
    });
    // Keep last 100
    await kv.set(key("signal_history"), history.slice(0, 100));
  } catch (e) {
    console.error("[STATE] addSignalToHistory error:", e);
  }
}

// ─── UI Alerts ──────────────────────────────────────────────────────────

export async function getUIAlerts(): Promise<any[]> {
  try {
    const data = await kv.get(key("ui_alerts"));
    return Array.isArray(data) ? data : [];
  } catch (e) {
    console.error("[STATE] getUIAlerts error:", e);
    return [];
  }
}

export async function setUIAlerts(alerts: any[]): Promise<void> {
  try {
    await kv.set(key("ui_alerts"), alerts);
  } catch (e) {
    console.error("[STATE] setUIAlerts error:", e);
  }
}

// ─── Cron Logs ─────────────────────────────────────────────────────────

export async function getCronLogs(): Promise<any[]> {
  try {
    const data = await kv.get(key("cron_logs"));
    return Array.isArray(data) ? data : [];
  } catch (e) {
    console.error("[STATE] getCronLogs error:", e);
    return [];
  }
}

export async function setCronLogs(logs: any[]): Promise<void> {
  try {
    await kv.set(key("cron_logs"), logs);
  } catch (e) {
    console.error("[STATE] setCronLogs error:", e);
  }
}

// ─── Per-Pair State (for strategy persistence) ───────────────────────────

export async function getPairState(pair: string): Promise<any> {
  try {
    const data = await kv.get(key(`state_${pair}`));
    return data || { stage: "NONE" };
  } catch (e) {
    console.error(`[STATE] getPairState(${pair}) error:`, e);
    return { stage: "NONE" };
  }
}

export async function setPairState(pair: string, state: any): Promise<void> {
  try {
    await kv.set(key(`state_${pair}`), state, { ex: 7 * 24 * 60 * 60 });
  } catch (e) {
    console.error(`[STATE] setPairState(${pair}) error:`, e);
  }
}

// ─── Legacy Compatibility (v15 migration helpers) ──────────────────────

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
      const data = await kv.get(oldKey);
      if (data) {
        const newKey = oldKey.replace("_v15", "_v29");
        await kv.set(newKey, data);
        console.log(`[MIGRATE] ${oldKey} → ${newKey}`);
      }
    } catch (e) {
      console.error(`[MIGRATE] Failed ${oldKey}:`, e);
    }
  }
}
