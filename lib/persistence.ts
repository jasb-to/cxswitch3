export interface SignalSnapshot {
  symbol: string;
  state: "EARLY" | "SETUP" | "SNIPER" | "WAIT";
  price: number;

  isEarly: boolean;
  isSniper: boolean;
  isActive: boolean;

  bias: "Bullish" | "Bearish" | "Neutral";
  confidence: number;

  adx: number;
  stochK: number;
  stochD: number;

  reason: string;

  stopLoss: number | null;
  takeProfit: number | null;
  riskRewardRatio: number | null;

  updatedAt: string;
}

/* =========================
   IN-MEMORY STORE
========================= */

const signalHistory = new Map<string, SignalSnapshot[]>();

console.log("[PERSISTENCE] initialized");

/* =========================
   STORE SNAPSHOT
========================= */

export async function storeSignalSnapshot(snapshot: SignalSnapshot) {
  const existing = signalHistory.get(snapshot.symbol) || [];

  const updated = [...existing, snapshot];

  // keep last 50
  if (updated.length > 50) {
    updated.shift();
  }

  signalHistory.set(snapshot.symbol, updated);

  console.log(
    `[PERSISTENCE] ${snapshot.symbol}: ${snapshot.state} | $${snapshot.price}`
  );
}

/* =========================
   GET LATEST SNAPSHOTS (API USE)
========================= */

export async function getLatestSignalSnapshots(): Promise<SignalSnapshot[]> {
  const latest: SignalSnapshot[] = [];

  for (const [, history] of signalHistory.entries()) {
    if (history.length > 0) {
      latest.push(history[history.length - 1]);
    }
  }

  return latest;
}

/* =========================
   GET FULL HISTORY (ENGINE USE)
========================= */

export function getSignalHistory(symbol: string): SignalSnapshot[] {
  return signalHistory.get(symbol) || [];
}

/* =========================
   OPTIONAL TELEGRAM COOLDOWN (SAFE)
========================= */

const telegramCooldowns = new Map<
  string,
  { symbol: string; lastAlertAt: string }
>();

export async function updateTelegramCooldown(
  symbol: string,
  timestamp: string
) {
  telegramCooldowns.set(symbol, {
    symbol,
    lastAlertAt: timestamp,
  });

  console.log(`[PERSISTENCE] cooldown updated ${symbol}`);
}

export async function getTelegramCooldown(symbol: string) {
  return telegramCooldowns.get(symbol) || null;
}
