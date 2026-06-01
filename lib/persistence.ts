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

const globalAny = global as any;

/* =========================
   GLOBAL SINGLETON STORE (FIX)
========================= */

if (!globalAny.signalHistory) {
  globalAny.signalHistory = new Map<string, SignalSnapshot[]>();
}

if (!globalAny.telegramCooldowns) {
  globalAny.telegramCooldowns = new Map<string, any>();
}

const signalHistory: Map<string, SignalSnapshot[]> = globalAny.signalHistory;
const telegramCooldowns: Map<string, any> = globalAny.telegramCooldowns;

console.log("[PERSISTENCE] GLOBAL store initialized");

/* =========================
   SNAPSHOT STORAGE
========================= */

export async function storeSignalSnapshot(snapshot: SignalSnapshot) {
  const existing = signalHistory.get(snapshot.symbol) || [];

  const updated = [...existing, snapshot];

  if (updated.length > 50) updated.shift();

  signalHistory.set(snapshot.symbol, updated);

  const status = snapshot.isSniper
    ? "🟢 SNIPER"
    : snapshot.isEarly
    ? "🟣 EARLY"
    : "⚪ WAIT";

  console.log(`[PERSISTENCE] ${snapshot.symbol}: ${status} | $${snapshot.price}`);
}

/* =========================
   LATEST SNAPSHOTS (UI)
========================= */

export async function getLatestSignalSnapshots(): Promise<SignalSnapshot[]> {
  const latest: SignalSnapshot[] = [];

  for (const [, history] of signalHistory.entries()) {
    if (history?.length) {
      latest.push(history[history.length - 1]);
    }
  }

  return latest;
}

/* =========================
   OPTIONAL HISTORY
========================= */

export async function getSignalHistory(symbol: string) {
  return signalHistory.get(symbol) || [];
}
