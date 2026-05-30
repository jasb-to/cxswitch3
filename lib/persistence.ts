import { ValidState } from "./stateValidator";

export interface SignalSnapshot {
  symbol: string;
  state: ValidState;
  previousState: ValidState;
  confidence: number;
  price: number;
  entry?: number;
  stopLoss?: number;
  takeProfit?: number;
  riskReward?: number;
  bias: "Bullish" | "Bearish" | "Neutral";
  structure: string;
  updatedAt: string;
  stateEnteredAt: string;
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
  console.log(`[PERSISTENCE] Stored snapshot for ${snapshot.symbol}: ${snapshot.state}`);
}

// Get latest signal snapshots for all symbols
export async function getLatestSignalSnapshots(): Promise<SignalSnapshot[]> {
  const snapshots = Array.from(signalSnapshots.values());
  console.log(`[PERSISTENCE] Retrieved ${snapshots.length} snapshots from memory`);
  return snapshots;
}

// Store state transition
export async function storeTransition(transition: SignalTransition) {
  signalTransitions.push(transition);
  console.log(`[PERSISTENCE] Stored transition: ${transition.symbol} ${transition.fromState} → ${transition.toState}`);
}

// Record alert
export async function recordAlert(alert: AlertHistory) {
  alertHistory.push(alert);
  console.log(`[PERSISTENCE] Recorded alert: ${alert.symbol} ${alert.state}`);
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

// Get previous state for symbol
export async function getPreviousState(symbol: string): Promise<ValidState> {
  const snapshot = signalSnapshots.get(symbol);
  return snapshot?.state || "WATCHING_SHIFT";
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
