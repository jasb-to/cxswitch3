export interface SignalSnapshot {
  symbol: string;
  isEarly: boolean;
  isSniper: boolean;
  isActive: boolean;

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

export interface SignalHistory {
  symbol: string;
  snapshots: SignalSnapshot[];
}

export interface TelegramCooldown {
  symbol: string;
  lastAlertAt: string;
}

/* =========================
   IN-MEMORY STORE
========================= */

const signalHistory = new Map<string, SignalSnapshot[]>();
const telegramCooldowns = new Map<string, TelegramCooldown>();

console.log("[PERSISTENCE] initialized");

/* =========================
   SNAPSHOT STORAGE (NOW WITH HISTORY)
========================= */

export async function storeSignalSnapshot(snapshot: SignalSnapshot) {
  const existing = signalHistory.get(snapshot.symbol) || [];

  const updated = [...existing, snapshot];

  // keep last 50 snapshots per symbol (lightweight + enough context)
  if (updated.length > 50) {
    updated.shift();
  }

  signalHistory.set(snapshot.symbol, updated);

  const status = snapshot.isSniper
    ? "🟢 SNIPER"
    : snapshot.isEarly
    ? "🟣 EARLY"
    : "⚪ WAIT";

  console.log(
    `[PERSISTENCE] ${snapshot.symbol}: ${status} | $${snapshot.price}`
  );
}

/* =========================
   GET LATEST SNAPSHOT (UI USE)
========================= */

export async function getLatestSignalSnapshots(): Promise<
  SignalSnapshot[]
> {
  const latest: SignalSnapshot[] = [];

  for (const [, history] of signalHistory.entries()) {
    if (history.length > 0) {
      latest.push(history[history.length - 1]);
    }
  }

  return latest;
}

/* =========================
   OPTIONAL: FULL HISTORY (for future charting)
========================= */

export async function getSignalHistory(
  symbol: string
): Promise<SignalSnapshot[]> {
  return signalHistory.get(symbol) || [];
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
