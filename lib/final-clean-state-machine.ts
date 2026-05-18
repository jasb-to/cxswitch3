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

export type UIState = "BUILDING" | "SNIPER" | "ACTIVE_SNIPER" | "CONFIRMED";

/**
 * CANONICAL DISPLAY STATE RESOLVER
 *
 * SINGLE function that maps all backend signal flags → ONE display string.
 * UI MUST call this and render ONLY its return value.
 *
 * RULES:
 * - ACTIVE_SNIPER takes priority over transitional SNIPER
 * - Never concatenate states
 * - Never render raw flags
 * - If state contains both SNIPER and ACTIVE_SNIPER → ACTIVE_SNIPER wins
 */
export function resolveDisplayState(card: SymbolCardState): UIState {
  if (card.source === "bootstrap") return "BUILDING";

  const s = (card as any).signalState as string | undefined;

  // HARD GUARD: if somehow both states are present, ACTIVE_SNIPER wins
  if (s === "ACTIVE_SNIPER") return "ACTIVE_SNIPER";
  if (s === "ACTIVE_CONFIRMED") return "CONFIRMED";
  if (s === "SNIPER") {
    if (
      card.tradeReadinessScore !== null &&
      card.tradeReadinessScore >= 70 &&
      card.direction &&
      card.direction !== "NEUTRAL"
    ) {
      return "SNIPER";
    }
  }
  return "BUILDING";
}

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
  // Delegate entirely to the canonical resolver — single source of truth
  return resolveDisplayState(card);
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
    case "ACTIVE_SNIPER":
      return "border-cyan-700 bg-cyan-950 text-cyan-400";
    case "SNIPER":
      return "border-blue-700 bg-blue-900 text-blue-200";
    case "CONFIRMED":
      return "border-green-700 bg-green-900 text-green-200";
    case "BUILDING":
    default:
      return "border-zinc-700 bg-zinc-800 text-zinc-300";
  }
}
