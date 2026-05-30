import { createClient } from "@supabase/supabase-js";
import { ValidState } from "./stateValidator";

// Only initialize Supabase on the server side
let supabaseClient: ReturnType<typeof createClient> | null = null;

function getSupabaseClient() {
  if (typeof window !== "undefined") {
    throw new Error("Persistence layer should only be called from server");
  }

  if (!supabaseClient) {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!url || !key) {
      throw new Error(
        "Supabase credentials missing: NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY"
      );
    }

    supabaseClient = createClient(url, key);
  }

  return supabaseClient;
}

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

// Store signal snapshot
export async function storeSignalSnapshot(snapshot: SignalSnapshot) {
  const supabase = getSupabaseClient();
  const { error } = await supabase.from("signal_snapshots").upsert({
    symbol: snapshot.symbol,
    state: snapshot.state,
    previous_state: snapshot.previousState,
    confidence: snapshot.confidence,
    price: snapshot.price,
    entry: snapshot.entry,
    stop_loss: snapshot.stopLoss,
    take_profit: snapshot.takeProfit,
    risk_reward: snapshot.riskReward,
    bias: snapshot.bias,
    structure: snapshot.structure,
    updated_at: snapshot.updatedAt,
    state_entered_at: snapshot.stateEnteredAt,
  });

  if (error) {
    console.error("[PERSISTENCE] Failed to store signal snapshot:", error);
    throw error;
  }
}

// Get latest signal snapshots for all symbols
export async function getLatestSignalSnapshots(): Promise<SignalSnapshot[]> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("signal_snapshots")
    .select("*")
    .order("updated_at", { ascending: false });

  if (error) {
    console.error("[PERSISTENCE] Failed to fetch signal snapshots:", error);
    throw error;
  }

  return (data || []).map((row: any) => ({
    symbol: row.symbol,
    state: row.state,
    previousState: row.previous_state,
    confidence: row.confidence,
    price: row.price,
    entry: row.entry,
    stopLoss: row.stop_loss,
    takeProfit: row.take_profit,
    riskReward: row.risk_reward,
    bias: row.bias,
    structure: row.structure,
    updatedAt: row.updated_at,
    stateEnteredAt: row.state_entered_at,
  }));
}

// Store state transition
export async function storeTransition(transition: SignalTransition) {
  const supabase = getSupabaseClient();
  const { error } = await supabase.from("signal_transitions").insert({
    symbol: transition.symbol,
    from_state: transition.fromState,
    to_state: transition.toState,
    timestamp: transition.timestamp,
  });

  if (error) {
    console.error("[PERSISTENCE] Failed to store transition:", error);
    throw error;
  }
}

// Record alert
export async function recordAlert(alert: AlertHistory) {
  const supabase = getSupabaseClient();
  const { error } = await supabase.from("alert_history").insert({
    symbol: alert.symbol,
    state: alert.state,
    timestamp: alert.timestamp,
    alert_sent: alert.alertSent,
  });

  if (error) {
    console.error("[PERSISTENCE] Failed to record alert:", error);
    throw error;
  }
}

// Get or update telegram cooldown
export async function getTelegramCooldown(
  symbol: string
): Promise<TelegramCooldown | null> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("telegram_cooldowns")
    .select("*")
    .eq("symbol", symbol)
    .single();

  if (error && error.code !== "PGRST116") {
    console.error("[PERSISTENCE] Failed to fetch cooldown:", error);
  }

  return data
    ? { symbol: data.symbol, lastAlertAt: data.last_alert_at }
    : null;
}

// Update telegram cooldown
export async function updateTelegramCooldown(symbol: string, timestamp: string) {
  const supabase = getSupabaseClient();
  const { error } = await supabase.from("telegram_cooldowns").upsert({
    symbol,
    last_alert_at: timestamp,
  });

  if (error) {
    console.error("[PERSISTENCE] Failed to update cooldown:", error);
    throw error;
  }
}

// Get previous state for symbol
export async function getPreviousState(symbol: string): Promise<ValidState> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("signal_snapshots")
    .select("state")
    .eq("symbol", symbol)
    .single();

  if (error || !data) {
    return "WATCHING_SHIFT";
  }

  return data.state;
}
