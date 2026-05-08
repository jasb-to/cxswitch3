/**
 * Signal Outcome Constants
 * Single source of truth for all allowed signal outcomes
 * 
 * CRITICAL: Must match database constraint in Supabase migration
 * If you add a new outcome here, you MUST also:
 * 1. Update the Supabase migration constraint
 * 2. Update the TypeScript type below
 * 3. Add logic to handle the new outcome in signal reconciliation
 */

// Database-backed outcomes (must exactly match Postgres constraint)
export const ALLOWED_SIGNAL_OUTCOMES = [
  "TP",                       // Trade hit take-profit target
  "SL",                       // Trade hit stop-loss
  "EXPIRED",                  // Signal expired without triggering
  "MANUAL",                   // Manually closed by user
  "STRUCTURE_INVALIDATED",    // Market structure invalidated the trade
] as const;

export type SignalOutcome = typeof ALLOWED_SIGNAL_OUTCOMES[number];

/**
 * Validate outcome against allowed list
 * Used to prevent invalid outcomes reaching the database
 */
export function isValidOutcome(outcome: unknown): outcome is SignalOutcome {
  return typeof outcome === "string" && ALLOWED_SIGNAL_OUTCOMES.includes(outcome as SignalOutcome);
}

/**
 * Safe outcome setter with validation
 * Returns null if outcome is invalid, preventing silent DB constraint failures
 */
export function validateOutcome(outcome: unknown): SignalOutcome | null {
  if (isValidOutcome(outcome)) {
    return outcome;
  }
  console.error(
    `[OUTCOME VALIDATION] Invalid outcome: ${outcome}. Allowed: ${ALLOWED_SIGNAL_OUTCOMES.join(", ")}`
  );
  return null;
}

/**
 * Get human-readable label for outcome
 */
export function getOutcomeLabel(outcome: SignalOutcome): string {
  const labels: Record<SignalOutcome, string> = {
    TP: "Target Hit",
    SL: "Stop Loss",
    EXPIRED: "Expired",
    MANUAL: "Manual Close",
    STRUCTURE_INVALIDATED: "Structure Invalidated",
  };
  return labels[outcome] || outcome;
}
