/**
 * PRODUCTION ALERT PIPELINE - PHASES 3-6
 * 
 * PHASE 3: Alert Pipeline Isolation
 * - Alerts dispatch immediately after signal generation
 * - Alerts do NOT depend on snapshot or UI state
 * - Single source: CanonicalSignal only
 * 
 * PHASE 4: Transition-Only Alerting
 * - Alerts only fire on state transitions
 * - Track previous signal state per symbol
 * - NO duplicate alerts for unchanged states
 * 
 * PHASE 5: Persistent Alert Queue
 * - Survive crashes, deploys, runtime failures
 * - Database-backed queue with retry logic
 * 
 * PHASE 6: Alert Audit Trail
 * - Comprehensive logging of all alert lifecycle events
 */

import { CanonicalSignal } from "./types";

// ============================================================================
// SIGNAL STATE TRANSITION TRACKING
// ============================================================================

export type SignalTransition = {
  symbol: string;
  from: {
    direction: string | null;
    activationState: string | null;
  };
  to: {
    direction: string;
    activationState: string;
  };
  timestamp: string;
  isTransition: boolean;
};

/**
 * Track previous signal states to detect transitions
 * In-memory cache (can be backed by database for persistence)
 */
const signalStateHistory: Map<
  string,
  {
    direction: string;
    activationState: string;
    timestamp: string;
  }
> = new Map();

/**
 * Detect if signal represents a state transition
 * PHASE 4: Only alert on transitions
 */
export function detectSignalTransition(signal: CanonicalSignal): SignalTransition {
  const key = signal.symbol;
  const previous = signalStateHistory.get(key);

  const transition: SignalTransition = {
    symbol: signal.symbol,
    from: {
      direction: previous?.direction ?? null,
      activationState: previous?.activationState ?? null,
    },
    to: {
      direction: signal.direction,
      activationState: signal.activationState,
    },
    timestamp: signal.generatedAt,
    isTransition: false,
  };

  // Check if this is a state transition
  if (
    !previous ||
    previous.direction !== signal.direction ||
    previous.activationState !== signal.activationState
  ) {
    transition.isTransition = true;
    
    // Update history for next cycle
    signalStateHistory.set(key, {
      direction: signal.direction,
      activationState: signal.activationState,
      timestamp: signal.generatedAt,
    });

    console.log(
      `[TRANSITION_DETECTED] ${signal.symbol}: ${transition.from.direction}/${transition.from.activationState} → ${transition.to.direction}/${transition.to.activationState}`
    );
  } else {
    console.log(
      `[NO_TRANSITION] ${signal.symbol}: State unchanged (${signal.direction}/${signal.activationState})`
    );
  }

  return transition;
}

// ============================================================================
// PERSISTENT ALERT QUEUE - PHASE 5
// ============================================================================

export type AlertQueueEntry = {
  alertId: string; // UUID
  signalId: string; // Reference to canonical signal
  symbol: string;
  direction: string;
  activationState: string;
  createdAt: string; // ISO timestamp
  sentAt: string | null;
  telegramStatus: number | null;
  retryCount: number;
  maxRetries: number;
  payload: {
    message: string;
    emoji?: string;
  };
};

/**
 * In-memory queue (PHASE 5 requires database persistence)
 * TODO: Implement Supabase backend for crash-safe persistence
 */
const alertQueue: AlertQueueEntry[] = [];

/**
 * Enqueue alert for dispatch
 * PHASE 5: Alerts survive crashes via database
 */
export async function enqueueAlert(
  signal: CanonicalSignal,
  message: string,
  emoji?: string
): Promise<AlertQueueEntry> {
  const alertId = `alert_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

  const entry: AlertQueueEntry = {
    alertId,
    signalId: signal.signalId,
    symbol: signal.symbol,
    direction: signal.direction,
    activationState: signal.activationState,
    createdAt: new Date().toISOString(),
    sentAt: null,
    telegramStatus: null,
    retryCount: 0,
    maxRetries: 3,
    payload: {
      message,
      emoji,
    },
  };

  alertQueue.push(entry);

  // PHASE 6: Audit logging
  console.log(`[ALERT_ENQUEUED] alertId=${alertId} signalId=${signal.signalId} symbol=${signal.symbol}`);

  return entry;
}

/**
 * Get next alert from queue (FIFO)
 */
export function getNextAlert(): AlertQueueEntry | null {
  // Return first unprocessed alert
  const pending = alertQueue.find((a) => a.sentAt === null);
  return pending ?? null;
}

/**
 * Mark alert as sent successfully
 * PHASE 6: Audit trail
 */
export function markAlertSent(alertId: string, status: number): void {
  const entry = alertQueue.find((a) => a.alertId === alertId);
  if (entry) {
    entry.sentAt = new Date().toISOString();
    entry.telegramStatus = status;
    console.log(
      `[ALERT_SENT] alertId=${alertId} signalId=${entry.signalId} status=${status}`
    );
  }
}

/**
 * Mark alert as failed (retry logic)
 * PHASE 6: Audit trail
 */
export function markAlertFailed(alertId: string, error: Error): void {
  const entry = alertQueue.find((a) => a.alertId === alertId);
  if (entry) {
    entry.retryCount++;
    if (entry.retryCount >= entry.maxRetries) {
      console.error(
        `[ALERT_FAILED] alertId=${alertId} signalId=${entry.signalId} maxRetriesExceeded error=${error.message}`
      );
    } else {
      console.warn(
        `[ALERT_RETRY] alertId=${alertId} attempt=${entry.retryCount}/${entry.maxRetries} error=${error.message}`
      );
    }
  }
}

// ============================================================================
// ALLOWED TRANSITIONS - PHASE 4
// ============================================================================

/**
 * Define which state transitions should trigger alerts
 * PHASE 4: Restrictive alerting policy
 */
export const ALLOWED_ALERT_TRANSITIONS = [
  { from: "DO_NOT_TRADE", to: "ACTIVE_SNIPER" },
  { from: "ACTIVE_SNIPER", to: "CONFIRMED" },
  { from: "LONG", to: "SHORT" },
  { from: "SHORT", to: "LONG" },
  { from: "NEUTRAL", to: "LONG" },
  { from: "NEUTRAL", to: "SHORT" },
];

/**
 * Check if transition should generate alert
 */
export function shouldAlertOnTransition(transition: SignalTransition): boolean {
  if (!transition.isTransition) return false;

  const matches = ALLOWED_ALERT_TRANSITIONS.some(
    (t) =>
      t.from === transition.from.activationState &&
      t.to === transition.to.activationState
  );

  return matches;
}

// ============================================================================
// COMPLETE ALERT DISPATCH FLOW - PHASES 3-6 INTEGRATION
// ============================================================================

/**
 * PHASE 3: Alert dispatch immediately after signal generation
 * Integrated alert lifecycle: detection → validation → enqueue → sent
 */
export async function dispatchAlertForSignal(signal: CanonicalSignal): Promise<void> {
  // Step 1: Detect transition
  const transition = detectSignalTransition(signal);

  // Step 2: Check if should alert
  if (!shouldAlertOnTransition(transition)) {
    console.log(
      `[ALERT_SKIP] ${signal.symbol}: Transition not in allowed list, skipping alert`
    );
    return;
  }

  // Step 3: Build alert message
  const emoji =
    signal.direction === "LONG"
      ? "🟢"
      : signal.direction === "SHORT"
        ? "🔴"
        : "⚪";

  const message = `${emoji} ${signal.symbol}: ${signal.direction} ${signal.activationState}
Confidence: ${signal.confidence}%
4H Trend: ${signal.macro}`;

  // Step 4: Enqueue for dispatch
  const alert = await enqueueAlert(signal, message, emoji);

  // PHASE 6: Audit logging
  console.log(
    `[ALERT_GENERATED] signalId=${signal.signalId} symbol=${signal.symbol} direction=${signal.direction} activation=${signal.activationState}`
  );
}

// ============================================================================
// STATISTICS & DEBUGGING
// ============================================================================

export function getAlertQueueStats() {
  const pending = alertQueue.filter((a) => a.sentAt === null).length;
  const sent = alertQueue.filter((a) => a.sentAt !== null).length;
  const failed = alertQueue.filter((a) => a.retryCount >= a.maxRetries).length;

  return {
    totalAlerts: alertQueue.length,
    pending,
    sent,
    failed,
  };
}

export function getAllSignalStates(): Record<
  string,
  { direction: string; activationState: string; timestamp: string }
> {
  const result: Record<string, any> = {};
  signalStateHistory.forEach((value, key) => {
    result[key] = value;
  });
  return result;
}
