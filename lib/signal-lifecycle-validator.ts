/**
 * Signal Lifecycle Validation (v2.9.0+)
 * Ensures symmetry between what's written and what's readable.
 * Validates EARLY_OPEN signals persist without transformation loss.
 */

import { supabase } from "@/lib/supabase-client";
import type { Signal } from "@/lib/strategy";

export type LifecycleValidationResult = {
  valid: boolean;
  issues: string[];
  stats: {
    totalSignals: number;
    earlyOpenCount: number;
    confirmedCount: number;
    endedCount: number;
    unknownStateCount: number;
  };
};

/**
 * Validates signal lifecycle consistency:
 * 1. All EARLY_OPEN signals are queryable
 * 2. No state transformation during read
 * 3. Query filters don't lose data
 */
export async function validateSignalLifecycle(): Promise<LifecycleValidationResult> {
  const issues: string[] = [];
  const stats = {
    totalSignals: 0,
    earlyOpenCount: 0,
    confirmedCount: 0,
    endedCount: 0,
    unknownStateCount: 0,
  };

  try {
    if (!supabase) {
      return { valid: false, issues: ["Supabase not connected"], stats };
    }

    // 1. Count all signals by state
    const { data: allSignals, error: allError } = await supabase
      .from("signals")
      .select("id, symbol, state");

    if (allError) {
      issues.push(`Failed to query all signals: ${allError.message}`);
      return { valid: false, issues, stats };
    }

    if (!allSignals) {
      return { valid: true, issues: [], stats };
    }

    stats.totalSignals = allSignals.length;

    // Count by state
    for (const signal of allSignals) {
      if (signal.state === "EARLY_OPEN") stats.earlyOpenCount++;
      else if (signal.state === "CONFIRMED") stats.confirmedCount++;
      else if (signal.state === "END") stats.endedCount++;
      else {
        stats.unknownStateCount++;
        issues.push(`Unknown state '${signal.state}' found on signal ${signal.id} (${signal.symbol})`);
      }
    }

    // 2. Verify EARLY_OPEN signals are queryable
    if (stats.earlyOpenCount > 0) {
      const { data: earlyOpen, error: earlyError } = await supabase
        .from("signals")
        .select("id, symbol, state")
        .eq("state", "EARLY_OPEN");

      if (earlyError) {
        issues.push(`Failed to query EARLY_OPEN signals: ${earlyError.message}`);
      } else if (!earlyOpen || earlyOpen.length !== stats.earlyOpenCount) {
        issues.push(
          `EARLY_OPEN query returned ${earlyOpen?.length ?? 0} but expected ${stats.earlyOpenCount}. Filtering loss detected.`
        );
      }
    }

    // 3. Verify active state filter works
    const { data: activeSignals, error: activeError } = await supabase
      .from("signals")
      .select("id, symbol, state")
      .in("state", ["EARLY_OPEN", "CONFIRMED"]);

    if (activeError) {
      issues.push(`Failed to query active signals: ${activeError.message}`);
    } else {
      const expectedActive = stats.earlyOpenCount + stats.confirmedCount;
      const actualActive = activeSignals?.length ?? 0;
      if (actualActive !== expectedActive) {
        issues.push(
          `Active state query returned ${actualActive} but expected ${expectedActive}. Filtering loss detected.`
        );
      }
    }

    // 4. Ensure no legacy state references
    if (stats.unknownStateCount > 0) {
      issues.push(`Found ${stats.unknownStateCount} signals with unknown/legacy states`);
    }

    return {
      valid: issues.length === 0,
      issues,
      stats,
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { valid: false, issues: [`Validation exception: ${reason}`], stats };
  }
}

/**
 * Debug function: List all signals with their full state
 */
export async function debugAllSignals(): Promise<
  Array<{ id: number; symbol: string; direction: string; state: string; created_at: string }>
> {
  if (!supabase) {
    console.warn("[debugAllSignals] Supabase not connected");
    return [];
  }

  try {
    const { data, error } = await supabase
      .from("signals")
      .select("id, symbol, direction, state, created_at")
      .order("created_at", { ascending: false });

    if (error) {
      console.error("[debugAllSignals] Query error:", error);
      return [];
    }

    return data ?? [];
  } catch (err) {
    console.error("[debugAllSignals] Error:", err);
    return [];
  }
}
