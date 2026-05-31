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

// =========================
// IN-MEMORY STORAGE
// =========================

const signalSnapshots = new Map<string, SignalSnapshot>();
const telegramCooldowns = new Map<string, TelegramCooldown>();

console.log("[PERSISTENCE] initialized (in-memory mode)");

// =========================
// SNAPSHOTS
// =========================

export async function storeSignalSnapshot(snapshot: SignalSnapshot) {
  signalSnapshots.set(snapshot.symbol, snapshot);

  const status = snapshot.isSniper
    ? "🟢 SNIPER"
    : snapshot.isSetupValid
    ? "🟡 SETUP"
    : "⚪ NO_SETUP";

  console.log(
    `[PERSISTENCE] ${snapshot.symbol}: ${status} | candidate=${snapshot.isSniperCandidate} | ADX=${snapshot.adx.toFixed(
      1
    )} | SL/TP=${snapshot.stopLoss !== null ? "populated" : "null"}`
  );
}

export async function getLatestSignalSnapshots(): Promise<SignalSnapshot[]> {
  const snapshots = Array.from(signalSnapshots.values());

  console.log(
    `[PERSISTENCE] getLatestSignalSnapshots → ${snapshots.length} items`
  );

  return snapshots;
}

// =========================
// TELEGRAM COOLDOWN
// =========================

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
    `[PERSISTENCE] cooldown updated ${symbol}: ${timestamp}`
  );
}
