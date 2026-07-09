// lib/state.ts — v29.1 State persistence (zero external deps)
// ============================================================
// Pure in-memory state with optional JSON file persistence via fs.
// No redis, no sqlite, no external packages required.

import { Signal, MarketRegime, ExitRecord } from "@/lib/strategy";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";

const DATA_DIR = process.cwd().includes("/tmp") ? "/tmp/cxswitch-data" : join(process.cwd(), ".cxswitch-data");
const SIGNALS_FILE = join(DATA_DIR, "signals.json");
const REGIMES_FILE = join(DATA_DIR, "regimes.json");
const EXITS_FILE = join(DATA_DIR, "exits.json");
const CRON_FILE = join(DATA_DIR, "cron.json");

function ensureDir() {
  try { if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true }); } catch {}
}

function loadJson<T>(path: string, fallback: T): T {
  try {
    if (existsSync(path)) return JSON.parse(readFileSync(path, "utf-8"));
  } catch {}
  return fallback;
}

function saveJson(path: string, data: any) {
  try { ensureDir(); writeFileSync(path, JSON.stringify(data, null, 2)); } catch {}
}

// ─── In-memory cache ───
let memSignals: Signal[] = [];
let memRegimes: Record<string, MarketRegime> = {};
let memExits: ExitRecord[] = [];
let memCron: { lastRun: number } = { lastRun: 0 };

// ─── Signal persistence ───

export async function saveActiveSignals(signals: Signal[]): Promise<void> {
  memSignals = signals;
  saveJson(SIGNALS_FILE, signals);
}

export async function loadActiveSignals(): Promise<Signal[]> {
  memSignals = loadJson(SIGNALS_FILE, []);
  return memSignals;
}

// Backward compat aliases used by old routes
export async function getSignals(): Promise<Signal[]> {
  return loadActiveSignals();
}

export async function setSignals(signals: Signal[]): Promise<void> {
  return saveActiveSignals(signals);
}

export async function getActiveTrades(): Promise<Signal[]> {
  const all = await loadActiveSignals();
  return all.filter(s => !s.exited);
}

export async function setActiveTrades(signals: Signal[]): Promise<void> {
  // Merge with full signal list
  const all = await loadActiveSignals();
  const nonActive = all.filter(s => !signals.find(ns => ns.id === s.id));
  await saveActiveSignals([...nonActive, ...signals]);
}

// ─── Regime persistence ───

export async function persistRegime(pair: string, regime: MarketRegime): Promise<void> {
  memRegimes[pair] = regime;
  saveJson(REGIMES_FILE, memRegimes);
}

export async function loadRegime(pair: string): Promise<MarketRegime | null> {
  if (!Object.keys(memRegimes).length) {
    memRegimes = loadJson(REGIMES_FILE, {});
  }
  return memRegimes[pair] || null;
}

// Backward compat
export async function getMarketData(pair: string): Promise<any> {
  const regime = await loadRegime(pair);
  return { pair, regime, timestamp: Date.now() };
}

export async function setMarketData(pair: string, data: any): Promise<void> {
  // No-op for backward compat
}

// ─── Exit record persistence ───

export async function persistExit(record: ExitRecord): Promise<void> {
  memExits.push(record);
  if (memExits.length > 500) memExits = memExits.slice(-500);
  saveJson(EXITS_FILE, memExits);
}

export async function loadExits(): Promise<ExitRecord[]> {
  memExits = loadJson(EXITS_FILE, []);
  return memExits;
}

// ─── Cron state ───

export async function setLastCronRun(timestamp: number): Promise<void> {
  memCron.lastRun = timestamp;
  saveJson(CRON_FILE, memCron);
}

export async function getLastCronRun(): Promise<number> {
  memCron = loadJson(CRON_FILE, { lastRun: 0 });
  return memCron.lastRun;
}

// ─── Signal history (backward compat) ───

export async function addSignalToHistory(signal: Signal): Promise<void> {
  // Signals are already saved via saveActiveSignals
}

export async function getSignalHistory(): Promise<Signal[]> {
  return loadActiveSignals();
}

// ─── Cron logs (backward compat) ───

export async function setCronLogs(logs: any[]): Promise<void> {
  saveJson(join(DATA_DIR, "cron-logs.json"), logs);
}

export async function getCronLogs(): Promise<any[]> {
  return loadJson(join(DATA_DIR, "cron-logs.json"), []);
}
