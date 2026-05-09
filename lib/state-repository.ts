/**
 * STATE REPOSITORY (v5.1.1)
 * 
 * ONLY DB operations
 * ZERO business logic
 * 
 * This is a simple CRUD interface for signals
 * The only module that touches Supabase
 */

import { supabase } from "./supabase-client";
import type { Signal } from "./strategy";

const ACTIVE_SIGNAL_STATES = ["EARLY_OPEN", "CONFIRMED"];
const TERMINAL_SIGNAL_STATES = ["END"];

/**
 * Get all non-END signals from database
 * Pure read, no logic, no filtering
 */
export async function getAllActiveSignals(): Promise<Signal[]> {
  if (!supabase) {
    console.warn("[REPO] Supabase not connected");
    return [];
  }

  try {
    const { data, error } = await supabase
      .from("signals")
      .select("*")
      .neq("state", "END")
      .order("created_at", { ascending: false });

    if (error) {
      console.error("[REPO] Query error:", error);
      return [];
    }

    console.log(`[REPO] Fetched ${data?.length ?? 0} active signals`);
    return data ?? [];
  } catch (err) {
    console.error("[REPO] Fetch failed:", err);
    return [];
  }
}

/**
 * Update signal state in database
 * This is the ONLY place state is written
 */
export async function updateSignalState(
  signalId: number,
  newState: string,
  outcome?: string,
  notes?: string
): Promise<boolean> {
  if (!supabase) {
    console.warn("[REPO] Supabase not connected");
    return false;
  }

  try {
    const updateData: any = {
      state: newState,
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
      console.error(`[REPO] Update failed for signal ${signalId}:`, error);
      return false;
    }

    console.log(`[REPO] ✓ Signal ${signalId} updated to state: ${newState}`);
    return true;
  } catch (err) {
    console.error(`[REPO] Update error:`, err);
    return false;
  }
}

/**
 * Check if symbol has active signal
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
 * Get signals ended within last N hours
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
