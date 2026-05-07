/**
 * Signal State Transition Tracer (v2.7.2)
 * 
 * Auditable record of every state mutation with full context.
 * Enables root-cause analysis of lifecycle violations.
 */

import { EndReason, isValidEndReason } from "./signal-states";

export type StateTransition = {
  signalId: number;
  symbol: string;
  from: string;
  to: string;
  reason: string;
  trigger: string;
  endReason?: EndReason;
  timestamp: number;
  metadata?: Record<string, any>;
};

// In-memory transition log (last 500 transitions)
const transitionLog: StateTransition[] = [];

/**
 * Log a state transition with full audit trail
 */
export function logStateTransition(
  signalId: number,
  symbol: string,
  fromState: string,
  toState: string,
  reason: string,
  trigger: string,
  endReason?: EndReason,
  metadata?: Record<string, any>
): StateTransition {
  // Validate END transition has explicit reason
  if (toState === "END" && !endReason) {
    throw new Error(`[SIGNAL STATE GUARD] Cannot transition ${symbol} to END without explicit EndReason`);
  }

  if (endReason && !isValidEndReason(endReason)) {
    throw new Error(`[SIGNAL STATE GUARD] Invalid EndReason: ${endReason}`);
  }

  const transition: StateTransition = {
    signalId,
    symbol,
    from: fromState,
    to: toState,
    reason,
    trigger,
    endReason,
    timestamp: Date.now(),
    metadata,
  };

  // Log to console with full context
  console.log(
    `[SIGNAL STATE TRANSITION] id=${signalId} | ${symbol} | ${fromState} → ${toState} | ` +
    `reason="${reason}" | trigger="${trigger}"${endReason ? ` | endReason="${endReason}"` : ""}`
  );

  // Add to in-memory log (FIFO buffer, max 500)
  transitionLog.push(transition);
  if (transitionLog.length > 500) {
    transitionLog.shift();
  }

  return transition;
}

/**
 * Get recent transitions
 */
export function getRecentTransitions(limit: number = 20): StateTransition[] {
  return transitionLog.slice(-limit).reverse();
}

/**
 * Get transitions for a specific symbol
 */
export function getTransitionsForSymbol(symbol: string, limit: number = 20): StateTransition[] {
  return transitionLog
    .filter(t => t.symbol === symbol)
    .slice(-limit)
    .reverse();
}

/**
 * Get transitions for a specific signal ID
 */
export function getTransitionsForSignal(signalId: number, limit: number = 20): StateTransition[] {
  return transitionLog
    .filter(t => t.signalId === signalId)
    .slice(-limit)
    .reverse();
}

/**
 * Get all END transitions
 */
export function getEndTransitions(limit: number = 20): StateTransition[] {
  return transitionLog
    .filter(t => t.to === "END")
    .slice(-limit)
    .reverse();
}

/**
 * Clear transition log
 */
export function clearTransitionLog(): void {
  transitionLog.length = 0;
}

/**
 * Get transition log stats
 */
export function getTransitionStats() {
  return {
    totalTransitions: transitionLog.length,
    toEarlyOpen: transitionLog.filter(t => t.to === "EARLY_OPEN").length,
    toConfirmed: transitionLog.filter(t => t.to === "CONFIRMED").length,
    toEnd: transitionLog.filter(t => t.to === "END").length,
    lastTransition: transitionLog[transitionLog.length - 1],
  };
}
