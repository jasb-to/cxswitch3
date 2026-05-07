/**
 * Signal State Constants & Lifecycle Rules (v2.7.2)
 * 
 * Single source of truth for all signal state usage across the system.
 * Ensures zero ambiguity in state filtering, transitions, and queries.
 */

// Active signal states — signals in these states are operational
export const ACTIVE_SIGNAL_STATES = ["EARLY_OPEN", "CONFIRMED"] as const;
export type ActiveSignalState = typeof ACTIVE_SIGNAL_STATES[number];

// Terminal signal states — signals in these states are closed
export const TERMINAL_SIGNAL_STATES = ["END"] as const;
export type TerminalSignalState = typeof TERMINAL_SIGNAL_STATES[number];

// All valid signal states
export const ALL_SIGNAL_STATES = [...ACTIVE_SIGNAL_STATES, ...TERMINAL_SIGNAL_STATES] as const;
export type ValidSignalState = typeof ALL_SIGNAL_STATES[number];

// END transition reasons — required to transition a signal to END
export const END_REASONS = {
  STOP_LOSS_HIT: "STOP_LOSS_HIT",
  TAKE_PROFIT_HIT: "TAKE_PROFIT_HIT",
  STRUCTURE_INVALIDATED: "STRUCTURE_INVALIDATED",
  TTL_EXPIRED: "TTL_EXPIRED",
  MANUAL_CLOSE: "MANUAL_CLOSE",
} as const;

export type EndReason = typeof END_REASONS[keyof typeof END_REASONS];

/**
 * Verify a state is valid and active
 */
export function isActiveState(state: unknown): state is ActiveSignalState {
  return ACTIVE_SIGNAL_STATES.includes(state as any);
}

/**
 * Verify a state is valid and terminal
 */
export function isTerminalState(state: unknown): state is TerminalSignalState {
  return TERMINAL_SIGNAL_STATES.includes(state as any);
}

/**
 * Verify a state is valid (active or terminal)
 */
export function isValidState(state: unknown): state is ValidSignalState {
  return ALL_SIGNAL_STATES.includes(state as any);
}

/**
 * Get query filter for active signals only
 */
export function getActiveStateFilter() {
  return ACTIVE_SIGNAL_STATES;
}

/**
 * Get query filter for ended signals only
 */
export function getTerminalStateFilter() {
  return TERMINAL_SIGNAL_STATES;
}

/**
 * Verify END reason is valid
 */
export function isValidEndReason(reason: unknown): reason is EndReason {
  return Object.values(END_REASONS).includes(reason as any);
}
