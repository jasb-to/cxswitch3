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
  stopLoss: number | null;  // Only populated if isSniper === true
  takeProfit: number | null;  // Only populated if isSniper === true
  riskRewardRatio: number | null;  // Only populated if isSniper === true
  updatedAt: string;
}

export interface TelegramCooldown {
  symbol: string;
  lastAlertAt: string;
}

// In-memory storage (single source of truth)
const signalSnapshots = new Map<string, SignalSnapshot>();
const telegramCooldowns = new Map<string, TelegramCooldown>();

console.log("[PERSISTENCE] In-memory storage initialized (no external DB)");

// Store signal snapshot
export async function storeSignalSnapshot(snapshot: SignalSnapshot) {
  signalSnapshots.set(snapshot.symbol, snapshot);
  const status = snapshot.isSniper ? "🟢 SNIPER" : snapshot.isSetupValid ? "🟡 SETUP_ACTIVE" : "⚪ NO_SETUP";
  console.log(`[PERSISTENCE] ${snapshot.symbol}: ${status} | candidate=${snapshot.isSniperCandidate} | ADX=${snapshot.adx.toFixed(1)} | SL/TP=${snapshot.stopLoss !== null ? "populated" : "null"}`);
}

// Get latest signal snapshots for all symbols
export async function getLatestSignalSnapshots(): Promise<SignalSnapshot[]> {
  const snapshots = Array.from(signalSnapshots.values());
  console.log(`[PERSISTENCE] Retrieved ${snapshots.length} snapshots`);
  return snapshots;
}

// Get or update telegram cooldown
export async function getTelegramCooldown(
  symbol: string
): Promise<TelegramCooldown | null> {
  const cooldown = telegramCooldowns.get(symbol);
  return cooldown || null;
}

// Update telegram cooldown
export async function updateTelegramCooldown(symbol: string, timestamp: string) {
  telegramCooldowns.set(symbol, { symbol, lastAlertAt: timestamp });
  console.log(`[PERSISTENCE] Updated telegram cooldown for ${symbol}: ${timestamp}`);
}
