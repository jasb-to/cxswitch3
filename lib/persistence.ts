export interface SignalSnapshot {
  symbol: string;

  isSetupValid: boolean;
  isSniperCandidate: boolean;
  isSniper: boolean;

  setupId: string;

  confidence: number;

  price: number;

  adx: number;

  stochK: number;
  stochD: number;

  bias: "Bullish" | "Bearish" | "Neutral";

  reason: string;

  stopLoss: number | null;
  takeProfit: number | null;
  riskRewardRatio: number | null;

  updatedAt: string;
}

export interface TelegramCooldown {
  symbol: string;
  lastAlertAt: string;
}

/* =========================
   IN-MEMORY STORAGE
========================= */

const signalSnapshots = new Map<string, SignalSnapshot>();
const telegramCooldowns = new Map<string, TelegramCooldown>();

const consumedSetups = new Set<string>();

console.log("[PERSISTENCE] initialized");

/* =========================
   SNAPSHOTS
========================= */

export function storeSignalSnapshot(snapshot: SignalSnapshot) {
  signalSnapshots.set(snapshot.symbol, snapshot);
}

export function getLatestSignalSnapshots(): SignalSnapshot[] {
  return Array.from(signalSnapshots.values());
}

/* =========================
   TELEGRAM COOLDOWN
========================= */

export function getTelegramCooldown(symbol: string) {
  return telegramCooldowns.get(symbol) || null;
}

export function updateTelegramCooldown(symbol: string, timestamp: string) {
  telegramCooldowns.set(symbol, {
    symbol,
    lastAlertAt: timestamp,
  });
}

/* =========================
   SETUP LOCK SYSTEM
========================= */

export function isSetupConsumed(setupId: string) {
  return consumedSetups.has(setupId);
}

export function markSetupConsumed(setupId: string) {
  consumedSetups.add(setupId);
}

/* =========================
   OPTIONAL DEBUG RESET
========================= */

export function clearPersistence() {
  signalSnapshots.clear();
  telegramCooldowns.clear();
  consumedSetups.clear();
}
