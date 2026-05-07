/**
 * Signal Health Logger (v2.7.4)
 * 
 * Logs trader-readable signal health summary.
 * Detects only actual corruption (invalid states).
 * No lifecycle spam or paranoia.
 */

import { supabase } from "@/lib/supabase-client";
import { ACTIVE_SIGNAL_STATES, TERMINAL_SIGNAL_STATES } from "./signal-states";

export type SignalHealthReport = {
  timestamp: number;
  total: number;
  active: number;
  ended: number;
  invalid: number;
};

/**
 * Quick health scan — trader-readable output only
 */
export async function scanSignalHealth(): Promise<SignalHealthReport> {
  const report: SignalHealthReport = {
    timestamp: Date.now(),
    total: 0,
    active: 0,
    ended: 0,
    invalid: 0,
  };

  try {
    // Count signals by state
    const { data: allSignals, error: queryErr } = await supabase
      .from("signals")
      .select("state", { count: "exact" });

    if (queryErr) {
      console.error("[SIGNAL HEALTH] Query failed:", queryErr.message);
      return report;
    }

    if (!allSignals || allSignals.length === 0) {
      console.log("[SIGNAL HEALTH] total=0 active=0 ended=0 invalid=0");
      return report;
    }

    report.total = allSignals.length;

    // Count by state
    for (const signal of allSignals) {
      if (ACTIVE_SIGNAL_STATES.includes(signal.state)) {
        report.active++;
      } else if (TERMINAL_SIGNAL_STATES.includes(signal.state)) {
        report.ended++;
      } else {
        // Invalid state
        report.invalid++;
      }
    }

    // Log trader-readable summary
    console.log(
      `[SIGNAL HEALTH] total=${report.total} active=${report.active} ended=${report.ended} invalid=${report.invalid}`
    );

    // Only warn if actual corruption
    if (report.invalid > 0) {
      console.warn(`[SIGNAL HEALTH] ⚠ ${report.invalid} signals with invalid state — investigation required`);
    }

    return report;
  } catch (err) {
    console.error("[SIGNAL HEALTH] Scan failed:", err);
    return report;
  }
}
