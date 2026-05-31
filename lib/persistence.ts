export interface SignalSnapshot {
  symbol: string;

  isSetupValid: boolean;
  isSniperCandidate: boolean;
  isSniper: boolean;

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
   PURE STORAGE
========================= */

const signalSnapshots = new Map<string, SignalSnapshot>();
const telegramCooldowns = new Map<string, TelegramCooldown>();

console.log("[PERSISTENCE] initialized");

/* =========================
   SNAPSHOTS
========================= */

export async function storeSignalSnapshot(
  snapshot: SignalSnapshot
): Promise<void> {
  signalSnapshots.set(snapshot.symbol, snapshot);
}

/* latest snapshots */
export async function getLatestSignalSnapshots(): Promise<SignalSnapshot[]> {
  return Array.from(signalSnapshots.values());
}

/* single snapshot */
export async function getSignalSnapshot(
  symbol: string
): Promise<SignalSnapshot | null> {
  return signalSnapshots.get(symbol) ?? null;
}

/* =========================
   TELEGRAM COOLDOWN
========================= */

export async function getTelegramCooldown(
  symbol: string
): Promise<TelegramCooldown | null> {
  return telegramCooldowns.get(symbol) ?? null;
}

export async function updateTelegramCooldown(
  symbol: string,
  timestamp: string
): Promise<void> {
  telegramCooldowns.set(symbol, {
    symbol,
    lastAlertAt: timestamp,
  });
}

/* =========================
   DEBUG (optional only)
========================= */

export function clearPersistence(): void {
  signalSnapshots.clear();
  telegramCooldowns.clear();
}
