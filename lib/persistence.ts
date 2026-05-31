export interface SignalSnapshot {
  symbol: string;

  // STRUCTURE STATES (NEW)
  engineState?: "EARLY" | "SETUP" | "SNIPER" | "NONE";

  isSetupValid: boolean;
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

// In-memory storage (single source of truth)
const signalSnapshots = new Map<string, SignalSnapshot>();
const telegramCooldowns = new Map<string, TelegramCooldown>();

console.log("[PERSISTENCE] initialized");

/* =========================
   SNAPSHOTS
========================= */

export async function storeSignalSnapshot(snapshot: SignalSnapshot) {
  signalSnapshots.set(snapshot.symbol, snapshot);

  const state =
    snapshot.engineState ??
    (snapshot.isSniper
      ? "SNIPER"
      : snapshot.isSetupValid
      ? "SETUP"
      : "NONE");

  const status =
    state === "SNIPER"
      ? "🟢 SNIPER"
      : state === "SETUP"
      ? "🟡 SETUP"
      : state === "EARLY"
      ? "🟣 EARLY"
      : "⚪ NONE";

  console.log(
    `[PERSISTENCE] ${snapshot.symbol}: ${status} | price=$${snapshot.price}`
  );
}

export async function getLatestSignalSnapshots(): Promise<SignalSnapshot[]> {
  return Array.from(signalSnapshots.values());
}

/* =========================
   TELEGRAM COOLDOWN
========================= */

export async function getTelegramCooldown(
  symbol: string
): Promise<TelegramCooldown | null> {
  return telegramCooldowns.get(symbol) || null;
}

export async function updateTelegramCooldown(
  symbol: string,
  timestamp: string
) {
  telegramCooldowns.set(symbol, {
    symbol,
    lastAlertAt: timestamp,
  });

  console.log(
    `[PERSISTENCE] cooldown updated ${symbol} @ ${timestamp}`
  );
}
