/**
 * STATE LAYER (v5 architecture)
 * 
 * ONLY place that writes to Supabase
 * Handles:
 * - Signal persistence
 * - State transitions
 * - Outcome reconciliation
 * - Lifecycle validation
 * 
 * Input: Signal decisions from engine
 * Output: Persisted state in database
 */

import { supabase } from "./supabase-client";
import type { Signal } from "./strategy";

const ACTIVE_SIGNAL_STATES = ["EARLY_OPEN", "CONFIRMED"];
const TERMINAL_SIGNAL_STATES = ["END"];

/**
 * Fetch all non-END signals from database
 * PURE READ: no filtering, no logic, just return what exists
 */
export async function getAllActiveSignals(): Promise<Signal[]> {
  if (!supabase) {
    console.warn("[STATE] Supabase not connected");
    return [];
  }

  try {
    const { data, error } = await supabase
      .from("signals")
      .select("*")
      .neq("state", "END")
      .order("created_at", { ascending: false });

    if (error) {
      console.error("[STATE] Query error:", error);
      return [];
    }

    console.log(`[STATE] Fetched ${data?.length ?? 0} active signals from database`);
    return data ?? [];
  } catch (err) {
    console.error("[STATE] Fetch failed:", err);
    return [];
  }
}

/**
 * Persist signal state change to database
 * This is the ONLY place that calls updateSignalState
 */
export async function persistSignalTransition(
  signalId: number,
  fromState: string,
  toState: string,
  outcome?: string,
  notes?: string
): Promise<boolean> {
  if (!supabase) {
    console.warn("[STATE] Supabase not connected");
    return false;
  }

  try {
    const updateData: any = {
      state: toState,
      updated_at: new Date().toISOString(),
    };

    if (outcome) {
      updateData.outcome = outcome;
    }

    if (notes) {
      updateData.notes = notes;
    }

    const { error } = await supabase
      .from("signals")
      .update(updateData)
      .eq("id", signalId);

    if (error) {
      console.error(`[STATE] Failed to transition signal ${signalId} ${fromState} → ${toState}:`, error);
      return false;
    }

    console.log(`[STATE] ✓ Signal ${signalId}: ${fromState} → ${toState}${outcome ? ` (${outcome})` : ""}`);
    return true;
  } catch (err) {
    console.error(`[STATE] Transition error:`, err);
    return false;
  }
}

/**
 * Check if a symbol already has an active signal
 */
export async function hasActiveSignal(symbol: string): Promise<boolean> {
  if (!supabase) return false;

  try {
    const { data, error } = await supabase
      .from("signals")
      .select("id", { count: "exact", head: true })
      .eq("symbol", symbol)
      .neq("state", "END");

    if (error) return false;
    return (data?.length ?? 0) > 0;
  } catch {
    return false;
  }
}

/**
 * Get recently ended signals (for cooldown logic)
 */
export async function getRecentlyEndedSignals(hoursAgo: number = 4): Promise<Signal[]> {
  if (!supabase) return [];

  try {
    const cutoff = new Date(Date.now() - hoursAgo * 60 * 60 * 1000).toISOString();
    const { data, error } = await supabase
      .from("signals")
      .select("*")
      .in("state", TERMINAL_SIGNAL_STATES)
      .gte("updated_at", cutoff);

    if (error) return [];
    return data ?? [];
  } catch {
    return [];
  }
}

/**
 * Reconcile active signals against market data health
 * Force end signals that don't have LIVE market validation
 */
export async function reconcileSignalsAgainstMarketHealth(
  activeSignals: Signal[],
  marketHealthCheck: (symbol: string) => boolean
): Promise<void> {
  for (const signal of activeSignals) {
    const isHealthy = marketHealthCheck(signal.symbol);

    if (!isHealthy) {
      const success = await persistSignalTransition(
        signal.id!,
        signal.state,
        "END",
        "STRUCTURE_INVALIDATED",
        "Market data degraded"
      );

      if (!success) {
        console.error(`[STATE] Failed to invalidate ${signal.symbol} signal due to market degradation`);
      }
    }
  }
}
