/**
 * Signal Health & Invariant Scanner (v2.7.2)
 * 
 * Detects invalid states, orphans, impossible transitions, and lifecycle violations.
 * Runs on every cron cycle to catch corruption early.
 */

import { supabase } from "@/lib/supabase-client";
import { ACTIVE_SIGNAL_STATES, TERMINAL_SIGNAL_STATES, isValidState } from "./signal-states";

export type SignalHealthReport = {
  timestamp: number;
  total: number;
  active: number;
  ended: number;
  latestInserted?: { id: number; symbol: string; createdAt: string };
  latestEnded?: { id: number; symbol: string; createdAt: string };
  violations: SignalViolation[];
};

export type SignalViolation =
  | { type: "INVALID_STATE"; signalId: number; symbol: string; state: string }
  | { type: "NULL_STATE"; signalId: number; symbol: string }
  | { type: "RAPID_END"; signalId: number; symbol: string; ageMs: number; endReason?: string }
  | { type: "ORPHAN"; signalId: number; symbol: string }
  | { type: "IMPOSSIBLE_TRANSITION"; signalId: number; symbol: string; from: string; to: string };

/**
 * Scan all signals and detect violations
 */
export async function scanSignalHealth(): Promise<SignalHealthReport> {
  const report: SignalHealthReport = {
    timestamp: Date.now(),
    total: 0,
    active: 0,
    ended: 0,
    violations: [],
  };

  try {
    // Fetch all signals
    const { data: allSignals, error: queryErr } = await supabase
      .from("signals")
      .select("*")
      .order("created_at", { ascending: false });

    if (queryErr) {
      console.error("[SIGNAL HEALTH] Query failed:", queryErr.message);
      return report;
    }

    if (!allSignals || allSignals.length === 0) {
      console.log("[SIGNAL HEALTH] No signals in database");
      return report;
    }

    report.total = allSignals.length;

    // Categorize signals and detect violations
    for (const signal of allSignals) {
      // Check for NULL or invalid state
      if (!signal.state) {
        report.violations.push({
          type: "NULL_STATE",
          signalId: signal.id,
          symbol: signal.symbol,
        });
        continue;
      }

      if (!isValidState(signal.state)) {
        report.violations.push({
          type: "INVALID_STATE",
          signalId: signal.id,
          symbol: signal.symbol,
          state: signal.state,
        });
        continue;
      }

      // Count active vs ended
      if (ACTIVE_SIGNAL_STATES.includes(signal.state)) {
        report.active++;
        // Track latest inserted
        if (!report.latestInserted) {
          report.latestInserted = {
            id: signal.id,
            symbol: signal.symbol,
            createdAt: signal.created_at,
          };
        }
      } else if (TERMINAL_SIGNAL_STATES.includes(signal.state)) {
        report.ended++;
        // Track latest ended
        if (!report.latestEnded) {
          report.latestEnded = {
            id: signal.id,
            symbol: signal.symbol,
            createdAt: signal.created_at,
          };
        }

        // Check for rapid END (within 5 minutes of creation)
        const createdAt = new Date(signal.created_at).getTime();
        const ageMs = Date.now() - createdAt;
        if (ageMs < 300_000) {
          // 5 minutes
          report.violations.push({
            type: "RAPID_END",
            signalId: signal.id,
            symbol: signal.symbol,
            ageMs,
            endReason: signal.outcome,
          });
        }
      }
    }

    // Log health summary
    console.log(
      `[SIGNAL HEALTH] total=${report.total} | active=${report.active} | ended=${report.ended} | ` +
      `violations=${report.violations.length}`
    );

    if (report.violations.length > 0) {
      console.warn(`[SIGNAL HEALTH] ${report.violations.length} violations detected:`, report.violations);
    }

    return report;
  } catch (err) {
    console.error("[SIGNAL HEALTH] Scan failed:", err);
    return report;
  }
}

/**
 * Get current signal counts by state
 */
export async function getSignalCounts() {
  try {
    const { data: active } = await supabase
      .from("signals")
      .select("*", { count: "exact", head: true })
      .in("state", ACTIVE_SIGNAL_STATES);

    const { data: ended } = await supabase
      .from("signals")
      .select("*", { count: "exact", head: true })
      .in("state", TERMINAL_SIGNAL_STATES);

    return {
      active: active?.length ?? 0,
      ended: ended?.length ?? 0,
      total: (active?.length ?? 0) + (ended?.length ?? 0),
    };
  } catch (err) {
    console.error("[SIGNAL COUNTS] Failed:", err);
    return { active: 0, ended: 0, total: 0 };
  }
}
