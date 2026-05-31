export interface SignalSnapshot {
  symbol: string;

  // state machine (new model)
  isEarly: boolean;
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
   STATE STORE
========================= */

// latest snapshot per symbol (source of truth for UI)
const signalSnapshots = new Map<string, SignalSnapshot>();

// telegram cooldown tracking
const telegramCooldowns = new Map<string, TelegramCooldown>();

console.log("[PERSISTENCE] initialized");

/* =========================
   SNAPSHOTS
========================= */

export async function storeSignalSnapshot(snapshot: SignalSnapshot) {
  const existing = signalSnapshots.get(snapshot.symbol);

  signalSnapshots.set(snapshot.symbol, snapshot);

  const state =
    snapshot.isSniper
      ? "🟢 SNIPER"
      : snapshot.isEarly
      ? "🟣 EARLY"
      : "⚪ WAIT";

  // only log transitions (reduces noise)
  if (!existing || existing.isSniper !== snapshot.isSniper || existing.isEarly !== snapshot.isEarly) {
    console.log(
      `[PERSISTENCE] ${snapshot.symbol}: ${state} | price=$${snapshot.price}`
    );
  }
}

export async function getLatestSignalSnapshots(): Promise<SignalSnapshot[]> {
  return Array.from(signalSnapshots.values());
}

/* =========================
   TELEGRAM COOLDOWN
========================= */

export async function getTelegramCooldown(symbol: string): Promise<TelegramCooldown | null> {
  return telegramCooldowns.get(symbol) || null;
}

export async function updateTelegramCooldown(symbol: string, timestamp: string) {
  telegramCooldowns.set(symbol, {
    symbol,
    lastAlertAt: timestamp,
  });

  console.log(`[PERSISTENCE] cooldown updated ${symbol}`);
}
