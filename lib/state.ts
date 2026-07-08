// lib/state.ts — v29.1 State Management
// ============================================================

import { kv } from "@vercel/kv";

export async function getSignals() {
  try {
    return await kv.get("signals") || [];
  } catch (e) {
    console.error("[STATE] getSignals error:", e);
    return [];
  }
}

export async function setSignals(signals: any[]) {
  try {
    await kv.set("signals", signals);
  } catch (e) {
    console.error("[STATE] setSignals error:", e);
  }
}

export async function getMarketData() {
  try {
    return await kv.get("marketData") || [];
  } catch (e) {
    console.error("[STATE] getMarketData error:", e);
    return [];
  }
}

export async function setMarketData(data: any[]) {
  try {
    await kv.set("marketData", data);
  } catch (e) {
    console.error("[STATE] setMarketData error:", e);
  }
}

export async function getActiveTrades() {
  try {
    return await kv.get("activeTrades") || [];
  } catch (e) {
    console.error("[STATE] getActiveTrades error:", e);
    return [];
  }
}

export async function setActiveTrades(trades: any[]) {
  try {
    await kv.set("activeTrades", trades);
  } catch (e) {
    console.error("[STATE] setActiveTrades error:", e);
  }
}

export async function getLastCronRun() {
  try {
    return await kv.get("lastCronRun") || 0;
  } catch (e) {
    console.error("[STATE] getLastCronRun error:", e);
    return 0;
  }
}

export async function setLastCronRun(timestamp: number) {
  try {
    await kv.set("lastCronRun", timestamp);
  } catch (e) {
    console.error("[STATE] setLastCronRun error:", e);
  }
}

export async function addSignalToHistory(signal: any) {
  try {
    const history = await getSignalHistory();
    history.unshift(signal);
    await kv.set("signalHistory", history.slice(0, 1000));
  } catch (e) {
    console.error("[STATE] addSignalToHistory error:", e);
  }
}

export async function getSignalHistory() {
  try {
    return await kv.get("signalHistory") || [];
  } catch (e) {
    console.error("[STATE] getSignalHistory error:", e);
    return [];
  }
}

export async function setCronLogs(logs: any[]) {
  try {
    await kv.set("cronLogs", logs);
  } catch (e) {
    console.error("[STATE] setCronLogs error:", e);
  }
}

export async function getCronLogs() {
  try {
    return await kv.get("cronLogs") || [];
  } catch (e) {
    console.error("[STATE] getCronLogs error:", e);
    return [];
  }
}

export async function persistExit(exit: any) {
  try {
    const exits = await loadExits();
    exits.push(exit);
    await kv.set("exits", exits);
  } catch (e) {
    console.error("[STATE] persistExit error:", e);
  }
}

export async function loadExits() {
  try {
    return await kv.get("exits") || [];
  } catch (e) {
    console.error("[STATE] loadExits error:", e);
    return [];
  }
}
