/**
 * STATE DRIFT ENFORCEMENT - PHASE 8
 * 
 * Add runtime invariants everywhere
 * FAIL LOUD if any layer changes core signal properties
 * Trading systems MUST not fail silently
 */

import { CanonicalSignal } from "./types";

// ============================================================================
// STATE DRIFT DETECTION
// ============================================================================

export type StateDriftViolation = {
  field: string;
  expectedValue: any;
  actualValue: any;
  context: string;
};

/**
 * Verify signal immutability and consistency
 * PHASE 8: Fail fast on any mutations
 */
export function assertSignalImmutability(signal: CanonicalSignal, context: string): void {
  // Check if signal is frozen
  if (!Object.isFrozen(signal)) {
    throw new Error(
      `[STATE_DRIFT] Signal is not frozen in context: ${context} (${signal.signalId})`
    );
  }

  // Check that all properties are still what they should be (readonly check)
  if (!(signal as any).readonly) {
    throw new Error(
      `[STATE_DRIFT] Signal lost readonly marker in context: ${context} (${signal.signalId})`
    );
  }
}

/**
 * Verify snapshot matches source signals
 * PHASE 8: No hidden mutations between layers
 */
export function assertSnapshotConsistency(
  originalSignal: CanonicalSignal,
  snapshotSignal: any,
  context: string
): void {
  const violations: StateDriftViolation[] = [];

  // Check core properties haven't changed
  const criticalFields = [
    "signalId",
    "symbol",
    "direction",
    "activationState",
    "macro",
    "confidence",
  ];

  for (const field of criticalFields) {
    const original = (originalSignal as any)[field];
    const snapshot = snapshotSignal?.[field];

    if (original !== snapshot) {
      violations.push({
        field,
        expectedValue: original,
        actualValue: snapshot,
        context,
      });
    }
  }

  if (violations.length > 0) {
    throw new Error(
      `[STATE_DRIFT] Snapshot inconsistency detected: ${JSON.stringify(violations)}`
    );
  }
}

/**
 * Verify UI render doesn't modify state
 * PHASE 8: UI is truly read-only
 */
export function assertUIReadOnly(signal: CanonicalSignal): void {
  const originalValues = {
    direction: signal.direction,
    activationState: signal.activationState,
    macro: signal.macro,
    confidence: signal.confidence,
  };

  // After any UI operation, verify unchanged
  return () => {
    if (signal.direction !== originalValues.direction) {
      throw new Error(
        `[STATE_DRIFT] Direction changed during UI render: ${originalValues.direction} → ${signal.direction}`
      );
    }
    if (signal.activationState !== originalValues.activationState) {
      throw new Error(
        `[STATE_DRIFT] ActivationState changed during UI render: ${originalValues.activationState} → ${signal.activationState}`
      );
    }
    if (signal.macro !== originalValues.macro) {
      throw new Error(
        `[STATE_DRIFT] Macro changed during UI render: ${originalValues.macro} → ${signal.macro}`
      );
    }
    if (signal.confidence !== originalValues.confidence) {
      throw new Error(
        `[STATE_DRIFT] Confidence changed during UI render: ${originalValues.confidence} → ${signal.confidence}`
      );
    }
  };
}

/**
 * Comprehensive state validation before alert dispatch
 * PHASE 8: No alerts for corrupted state
 */
export function validateSignalForAlert(signal: CanonicalSignal): void {
  // Must be frozen
  if (!Object.isFrozen(signal)) {
    throw new Error(`[STATE_DRIFT] Cannot alert on unfrozen signal: ${signal.signalId}`);
  }

  // Must have valid direction
  if (!["LONG", "SHORT", "NEUTRAL"].includes(signal.direction)) {
    throw new Error(
      `[STATE_DRIFT] Invalid direction in signal: ${signal.direction} (${signal.signalId})`
    );
  }

  // Must have valid activation
  if (!["ACTIVE_SNIPER", "CONFIRMED", "DO_NOT_TRADE"].includes(signal.activationState)) {
    throw new Error(
      `[STATE_DRIFT] Invalid activationState in signal: ${signal.activationState} (${signal.signalId})`
    );
  }

  // Must have valid macro
  if (!["BULLISH", "BEARISH", "NEUTRAL"].includes(signal.macro)) {
    throw new Error(
      `[STATE_DRIFT] Invalid macro in signal: ${signal.macro} (${signal.signalId})`
    );
  }

  // Confidence must be valid number
  if (typeof signal.confidence !== "number" || signal.confidence < 0 || signal.confidence > 100) {
    throw new Error(
      `[STATE_DRIFT] Invalid confidence in signal: ${signal.confidence} (${signal.signalId})`
    );
  }

  // Signal ID must match format
  if (!signal.signalId.match(/^\w+_\w+_\w+_\d{4}-\d{2}-\d{2}T/)) {
    throw new Error(
      `[STATE_DRIFT] Invalid signalId format: ${signal.signalId}`
    );
  }
}

// ============================================================================
// LOGGING & DEBUGGING
// ============================================================================

export function logStateDriftCheckpoint(
  checkpoint: string,
  signal: CanonicalSignal
): void {
  console.log(
    `[STATE_CHECK] ${checkpoint}: ${signal.symbol} ${signal.direction}/${signal.activationState} confidence=${signal.confidence}%`
  );
}
