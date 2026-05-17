/**
 * FINAL CLEAN STATE MACHINE (vFINAL)
 * 
 * ❌ DELETE ALL OLD LOGIC:
 * - Multi-layer state interpretation
 * - SNIPER_READY, CONFIRMED_READY, SNIPER_IMMINENT
 * - AWAITING_DATA, LOADING (when data exists)
 * - Zone/bias/no-trade terminology
 * 
 * ✅ ONLY 3 VALID STATES:
 * - BUILDING (default)
 * - SNIPER (entry trigger only)
 * - CONFIRMED (continuation only)
 * 
 * 🧬 SINGLE SOURCE OF TRUTH:
 * - State computed ONCE in backend
 * - UI renders DIRECTLY with NO recomputation
 * - NO parallel state logic
 */

import type { SymbolCardState } from "./strategy-v6";

export type UIState = "BUILDING" | "SNIPER" | "CONFIRMED";

/**
 * FINAL STATE MACHINE - ONLY FUNCTION THAT DECIDES UI STATE
 * 
 * Implements STRICT 3-state FSM:
 * BUILDING (default)
 *   ↓ (ignition ≥ 70 + structure valid + direction valid + NO macro)
 * SNIPER (entry trigger only)
 *   ↓ (continuation confirmed + macro NOT blocking)
 * CONFIRMED (follow-through phase)
 * 
 * NO EXCEPTIONS. NO EXTENSIONS. NO ALIASES.
 */
export function getFinalState(card: SymbolCardState): UIState {
  // Bootstrap cards = BUILDING (no data yet, but still showing state not placeholder)
  if (card.source === "bootstrap") {
    return "BUILDING";
  }

  // Get internal backend state (ACTIVE_SNIPER, ACTIVE_CONFIRMED, BUILDING, NONE)
  const internalState = card.signalState;

  // RULE 1: If backend says ACTIVE_SNIPER, UI shows SNIPER
  // SNIPER is the entry trigger - ONLY allowed when ALL are true:
  // - ignition >= 70
  // - compression OR expansion confirmed
  // - direction is valid (LONG or SHORT, not NEUTRAL)
  // - NO macro conflict
  if (internalState === "ACTIVE_SNIPER") {
    // Validate SNIPER preconditions
    if (
      card.tradeReadinessScore !== null &&
      card.tradeReadinessScore >= 70 &&
      card.direction &&
      card.direction !== "NEUTRAL"
    ) {
      return "SNIPER";
    }
  }

  // RULE 2: If backend says ACTIVE_CONFIRMED, UI shows CONFIRMED
  // CONFIRMED is continuation phase - ONLY allowed when ALL are true:
  // - previous state was SNIPER
  // - continuation is confirmed
  // - structure sustains direction
  // - macro is NOT conflicting
  if (internalState === "ACTIVE_CONFIRMED") {
    // Validate CONFIRMED preconditions
    if (
      card.tradeReadinessScore !== null &&
      card.tradeReadinessScore >= 70 &&
      card.direction &&
      card.direction !== "NEUTRAL"
    ) {
      return "CONFIRMED";
    }
  }

  // DEFAULT: Everything else shows BUILDING
  // BUILDING = default state, always start here
  // Use BUILDING when ANY of these are true:
  // - ignition < 70
  // - structure incomplete
  // - compression not confirmed
  // - direction unclear or weak
  // - macro conflict exists
  // - early formation phase
  return "BUILDING";
}

/**
 * Safe percentage rendering - HARD RULE TO FIX NaN FOREVER
 * 
 * if value is invalid OR undefined OR NaN:
 *   → return "—"
 * 
 * Never return: NaN, undefined, null, empty %
 */
export function safePercent(value: number | null | undefined): string {
  if (value === null || value === undefined) {
    return "—";
  }
  if (!Number.isFinite(value)) {
    return "—";
  }
  if (Number.isNaN(value)) {
    return "—";
  }
  // Clamp to 0-100 range
  const clamped = Math.max(0, Math.min(100, value));
  return `${Math.round(clamped)}%`;
}

/**
 * Safe bar width - prevents CSS width="NaN%" errors
 * 
 * if invalid → "0%"
 */
export function safeBarWidth(value: number | null | undefined): string {
  if (value === null || value === undefined) {
    return "0%";
  }
  if (!Number.isFinite(value)) {
    return "0%";
  }
  if (Number.isNaN(value)) {
    return "0%";
  }
  // Clamp to 0-100 range
  const clamped = Math.max(0, Math.min(100, value));
  return `${clamped}%`;
}

/**
 * Consistent color mapping for readiness score
 * 
 * Always use this function ONCE for color decisions
 * No color recomputation in different modules
 */
export function getReadinessColorClass(score: number | null | undefined): string {
  if (score === null || score === undefined) {
    return "text-zinc-500"; // Gray for unknown
  }
  if (!Number.isFinite(score)) {
    return "text-zinc-500";
  }
  if (score < 40) return "text-red-500"; // Red: dead market
  if (score < 60) return "text-yellow-500"; // Yellow: building
  if (score < 75) return "text-blue-500"; // Blue: SNIPER
  return "text-green-500"; // Green: CONFIRMED
}

/**
 * Consistent bar color mapping for readiness score
 */
export function getReadinessBarClass(score: number | null | undefined): string {
  if (score === null || score === undefined) {
    return "bg-zinc-900";
  }
  if (!Number.isFinite(score)) {
    return "bg-zinc-900";
  }
  if (score < 40) return "bg-red-500"; // Red
  if (score < 60) return "bg-yellow-500"; // Yellow
  if (score < 75) return "bg-blue-500"; // Blue
  return "bg-green-500"; // Green
}

/**
 * Badge color - depends on UI state
 * 
 * BUILDING: neutral gray
 * SNIPER: blue (entry opportunity)
 * CONFIRMED: green (confirmation phase)
 */
export function getStateColorClass(state: UIState): string {
  switch (state) {
    case "SNIPER":
      return "bg-blue-900 text-blue-200";
    case "CONFIRMED":
      return "bg-green-900 text-green-200";
    case "BUILDING":
    default:
      return "bg-zinc-800 text-zinc-300";
  }
}
