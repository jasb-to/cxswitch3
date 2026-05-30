/**
 * CRITICAL: This is the ONLY place old states (WAIT/WATCH/LONG/SHORT) are mapped to new states
 * (WATCHING_SHIFT/BUILDING/SNIPER). This ensures unified state semantics throughout the system.
 * 
 * Rule: OLD states MUST NEVER leak beyond this mapper.
 */

import { ValidState } from "./stateValidator";

export type LegacyState = "WAIT" | "WATCH" | "LONG" | "SHORT";

/**
 * Maps legacy strategy states to unified system states
 * This is the AUTHORITATIVE mapping used throughout the codebase.
 * 
 * WAIT → WATCHING_SHIFT (no setup)
 * WATCH → BUILDING (setup forming, waiting for entry)
 * LONG/SHORT → SNIPER (active entry signal)
 */
export function mapLegacyStateToUnified(legacyState: LegacyState): ValidState {
  switch (legacyState) {
    case "WAIT":
      return "WATCHING_SHIFT";
    case "WATCH":
      return "BUILDING";
    case "LONG":
    case "SHORT":
      return "SNIPER";
    default:
      // Exhaustive check - TypeScript should catch any missing cases
      const _exhaustive: never = legacyState;
      console.error(`[STATE_MAPPER] Unknown legacy state: ${_exhaustive}`);
      return "WATCHING_SHIFT";
  }
}

/**
 * Validates that a value is a valid legacy state
 */
export function isLegacyState(value: any): value is LegacyState {
  return value === "WAIT" || value === "WATCH" || value === "LONG" || value === "SHORT";
}

/**
 * Strict assertion - throws if not a valid legacy state
 */
export function assertLegacyState(value: any): LegacyState {
  if (!isLegacyState(value)) {
    throw new Error(`[STATE_MAPPER] Invalid legacy state: ${value}`);
  }
  return value;
}
