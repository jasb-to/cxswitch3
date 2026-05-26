/**
 * PERSISTENT SIGNAL STORE
 * Stores signals and Telegram cooldowns in file system
 * Single source of truth across serverless invocations
 */

import { promises as fs } from "fs";
import path from "path";
import type { Signal } from "./signal-store";

const STORE_DIR = "/tmp";
const SIGNALS_FILE = path.join(STORE_DIR, "signals.json");
const COOLDOWN_FILE = path.join(STORE_DIR, "telegram_cooldown.json");

interface SignalsStore {
  signals: Record<string, Signal>;
  lastUpdated: string;
}

interface TelegramCooldown {
  [symbol: string]: number; // timestamp of last alert
}

// Ensure store directory exists
async function ensureDir() {
  try {
    await fs.mkdir(STORE_DIR, { recursive: true });
  } catch (err) {
    console.error("[STORE] Failed to create dir:", err);
  }
}

// Read signals from persistent store
export async function readSignals(): Promise<Signal[]> {
  try {
    await ensureDir();
    const data = await fs.readFile(SIGNALS_FILE, "utf-8");
    const store: SignalsStore = JSON.parse(data);
    return Object.values(store.signals);
  } catch (err) {
    if ((err as any).code === "ENOENT") {
      console.log("[STORE] Signals file not found, starting fresh");
      return [];
    }
    console.error("[STORE] Failed to read signals:", err);
    return [];
  }
}

// Write signals to persistent store
export async function writeSignals(signals: Signal[]): Promise<void> {
  try {
    await ensureDir();
    const store: SignalsStore = {
      signals: Object.fromEntries(signals.map(s => [s.symbol, s])),
      lastUpdated: new Date().toISOString(),
    };
    await fs.writeFile(SIGNALS_FILE, JSON.stringify(store, null, 2));
    console.log(`[STORE] Persisted ${signals.length} signals`);
  } catch (err) {
    console.error("[STORE] Failed to write signals:", err);
  }
}

// Get a specific signal
export async function getSignal(symbol: string): Promise<Signal | undefined> {
  const signals = await readSignals();
  return signals.find(s => s.symbol === symbol);
}

// Get Telegram cooldown timestamp for symbol
export async function getTelegramCooldown(symbol: string): Promise<number> {
  try {
    await ensureDir();
    const data = await fs.readFile(COOLDOWN_FILE, "utf-8");
    const cooldowns: TelegramCooldown = JSON.parse(data);
    return cooldowns[symbol] || 0;
  } catch (err) {
    if ((err as any).code === "ENOENT") {
      return 0; // No cooldown file yet
    }
    console.error("[STORE] Failed to read cooldowns:", err);
    return 0;
  }
}

// Set Telegram cooldown for symbol
export async function setTelegramCooldown(symbol: string, timestamp: number): Promise<void> {
  try {
    await ensureDir();
    let cooldowns: TelegramCooldown = {};
    
    try {
      const data = await fs.readFile(COOLDOWN_FILE, "utf-8");
      cooldowns = JSON.parse(data);
    } catch (err) {
      // File doesn't exist yet, start fresh
    }
    
    cooldowns[symbol] = timestamp;
    await fs.writeFile(COOLDOWN_FILE, JSON.stringify(cooldowns, null, 2));
    console.log(`[STORE] Set Telegram cooldown for ${symbol} to ${new Date(timestamp).toISOString()}`);
  } catch (err) {
    console.error("[STORE] Failed to set cooldown:", err);
  }
}
