export interface SignalSnapshot {
  symbol: string;
  isBuilding: boolean;
  isSniper: boolean;
  confidence: number;
  price: number;
  adx: number;
  stochK: number;
  stochD: number;
  bias: "Bullish" | "Bearish" | "Neutral";
  reason: string;
  stopLoss: number;
  takeProfit: number;
  riskRewardRatio: number;
  updatedAt: string;
}

export interface SignalTransition {
  symbol: string;
  fromState: ValidState;
  toState: ValidState;
  timestamp: string;
}

export interface AlertHistory {
  symbol: string;
  state: ValidState;
  timestamp: string;
  alertSent: boolean;
}

export interface TelegramCooldown {
  symbol: string;
  lastAlertAt: string;
}

// In-memory storage (single source of truth)
const signalSnapshots = new Map<string, SignalSnapshot>();
const signalTransitions: SignalTransition[] = [];
const alertHistory: AlertHistory[] = [];
const telegramCooldowns = new Map<string, TelegramCooldown>();

console.log("[PERSISTENCE] In-memory storage initialized (no external DB)");

// Store signal snapshot
export async function storeSignalSnapshot(snapshot: SignalSnapshot) {
  signalSnapshots.set(snapshot.symbol, snapshot);
  console.log(`[PERSISTENCE] Stored snapshot for ${snapshot.symbol}: isBuilding=${snapshot.isBuilding}, isSniper=${snapshot.isSniper}, ADX=${snapshot.adx.toFixed(1)}`);
}

// Get latest signal snapshots for all symbols
export async function getLatestSignalSnapshots(): Promise<SignalSnapshot[]> {
  const snapshots = Array.from(signalSnapshots.values());
  console.log(`[PERSISTENCE] Retrieved ${snapshots.length} snapshots: ${snapshots.map(s => `${s.symbol}(${s.isBuilding ? 'B' : ''}${s.isSniper ? 'S' : ''} ADX=${s.adx.toFixed(1)})`).join(', ')}`);
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

// Debug: Get all in-memory state
export function getDebugState() {
  return {
    snapshots: Array.from(signalSnapshots.entries()),
    transitions: signalTransitions,
    alerts: alertHistory,
    cooldowns: Array.from(telegramCooldowns.entries()),
  };
}
