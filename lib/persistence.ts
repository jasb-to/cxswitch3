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

/* =========================
   GLOBAL SINGLETON STORE
   (CRITICAL FIX)
========================= */

const globalStore = globalThis as unknown as {
  signalHistory?: Map<string, SignalSnapshot>;
};

if (!globalStore.signalHistory) {
  globalStore.signalHistory = new Map();
  console.log("[PERSISTENCE] initialized (global singleton)");
}

const signalHistory = globalStore.signalHistory;

/* =========================
   STORE SNAPSHOT
========================= */

export async function storeSignalSnapshot(snapshot: SignalSnapshot) {
  signalHistory.set(snapshot.symbol, snapshot);

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
   GET LATEST SNAPSHOTS
========================= */

export async function getLatestSignalSnapshots(): Promise<
  SignalSnapshot[]
> {
  return Array.from(signalHistory.values());
}

/* =========================
   DEBUG HELPERS
========================= */

export function getRawStoreSize() {
  return signalHistory.size;
}
