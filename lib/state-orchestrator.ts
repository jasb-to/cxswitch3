/**
 * STATE ORCHESTRATOR (v5.1.1)
 * 
 * Business rules and lifecycle management
 * ZERO DB access (delegates to state-repository)
 * 
 * Job: Apply transitions and enforce rules
 * Input: Signals from engine + market health check
 * Output: Persistence instructions (via state-repository)
 */

import { updateSignalState, getAllActiveSignals, getRecentlyEndedSignals } from "./state-repository";
import type { Signal } from "./strategy";

/**
 * Apply a state transition with validation
 * RULE: This is where logic lives
 * RULE: This NEVER touches DB directly, always calls state-repository
 */
export async function applyStateTransition(
  signal: Signal,
  targetState: string,
  outcome?: string,
  notes?: string
): Promise<boolean> {
  // Validate transition is legal
  const isValidTransition = isLegalTransition(signal.state, targetState);
  if (!isValidTransition) {
    console.log(`[ORCHESTRATOR] Invalid transition: ${signal.state} → ${targetState}`);
    return false;
  }

  // Persist the transition through repository
  const success = await updateSignalState(signal.id!, targetState, outcome, notes);
  if (success) {
    console.log(`[ORCHESTRATOR] ✓ Applied transition: ${signal.id} ${signal.state} → ${targetState}`);
  }
  return success;
}

/**
 * Reconcile active signals against market data health
 * RULE: Only transition to END if market is degraded
 */
export async function reconcileAgainstMarketHealth(
  marketHealthCheck: (symbol: string) => boolean
): Promise<void> {
  const activeSignals = await getAllActiveSignals();

  for (const signal of activeSignals) {
    const isHealthy = marketHealthCheck(signal.symbol);

    if (!isHealthy) {
      console.log(`[ORCHESTRATOR] ${signal.symbol}: Market degraded, initiating reconciliation`);
      
      const success = await applyStateTransition(
        signal,
        "END",
        "STRUCTURE_INVALIDATED",
        "Market data health check failed"
      );

      if (!success) {
        console.warn(`[ORCHESTRATOR] Failed to reconcile ${signal.symbol}`);
      }
    }
  }
}

/**
 * Check if a state transition is legal
 * Defines the state machine
 */
function isLegalTransition(fromState: string, toState: string): boolean {
  const legalTransitions: Record<string, string[]> = {
    EARLY_OPEN: ["CONFIRMED", "END"],
    CONFIRMED: ["END"],
    END: [], // Terminal state
  };

  const allowed = legalTransitions[fromState] ?? [];
  return allowed.includes(toState);
}

/**
 * Get signal state for UI display
 * PURE FUNCTION: no DB access, just interpretation
 */
export function getSignalDisplayState(signal: Signal): string {
  if (signal.state === "END") {
    return `CLOSED (${signal.outcome || "unknown"})`;
  }
  return signal.state;
}

/**
 * Check if a signal is in a critical state
 * PURE FUNCTION: used by UI and rules
 */
export function isSignalCritical(signal: Signal): boolean {
  return signal.state === "CONFIRMED" && !signal.pnl; // Confirmed but no PnL yet
}

/**
 * Get cooldown status for a symbol
 * RULE: No new signals for 4 hours after previous signal ended
 */
export async function getSymbolCooldownStatus(symbol: string): Promise<{
  onCooldown: boolean;
  minutesRemaining: number;
}> {
  const recentEnded = await getRecentlyEndedSignals(4);
  const symbolEnded = recentEnded.find(s => s.symbol === symbol);

  if (!symbolEnded) {
    return { onCooldown: false, minutesRemaining: 0 };
  }

  const elapsed = Date.now() - new Date(symbolEnded.updated_at).getTime();
  const cooldownMs = 4 * 60 * 60 * 1000;
  const remaining = Math.max(0, cooldownMs - elapsed);

  return {
    onCooldown: remaining > 0,
    minutesRemaining: Math.ceil(remaining / 60000),
  };
}
