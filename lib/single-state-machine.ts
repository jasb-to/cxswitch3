/**
 * SINGLE SOURCE OF TRUTH for UI state
 * Returns ONLY: BUILDING | SNIPER | CONFIRMED
 * 
 * This function is the ONLY place that decides what state shows in UI
 * All other state names (SNIPER_READY, CONFIRMED_READY, etc) are INTERNAL ONLY
 */

import type { SymbolCardState } from "./strategy-v6";

export type UIState = "BUILDING" | "SNIPER" | "CONFIRMED";

/**
 * STRICT STATE MACHINE
 * 
 * BUILDING → SNIPER → CONFIRMED
 * 
 * Transitions are ONE-WAY and require ALL conditions:
 * - BUILDING → SNIPER: compression detected + ignition >= 70 + valid direction + not macro blocked
 * - SNIPER → CONFIRMED: continuation confirmed + macro not conflicting + sustained direction
 * - Otherwise: return to BUILDING
 */
export function getFinalTradeState(card: SymbolCardState): UIState {
  // RULE: If no price, it's not tradable
  if (!card.price || card.price <= 0) {
    return "BUILDING";
  }

  // RULE: If degraded (display-only fallback), it's not tradable
  if (card.degraded) {
    return "BUILDING";
  }

  // RULE: If no direction, can't trade
  if (!card.direction || card.direction === "NEUTRAL") {
    return "BUILDING";
  }

  // RULE: Internal state SNIPER_READY or ACTIVE_SNIPER → UI state SNIPER
  if (card.signalState === "SNIPER_READY" || card.signalState === "ACTIVE_SNIPER") {
    // TRANSITION CHECK: All SNIPER conditions must be met
    // 1. Compression/expansion detected
    if (!card.emaSlope || Math.abs(card.emaSlope) < 0.1) {
      return "BUILDING";
    }
    // 2. Ignition threshold passed (tradeReadiness >= 70 indicates SNIPER trigger)
    if (card.tradeReadinessScore === null || card.tradeReadinessScore < 70) {
      return "BUILDING";
    }
    // 3. Direction is valid (already checked above)
    // 4. Not blocked by macro (4H)
    if (card.htf4hTrend === "BEARISH" && card.direction === "LONG") {
      return "BUILDING";
    }
    if (card.htf4hTrend === "BULLISH" && card.direction === "SHORT") {
      return "BUILDING";
    }
    return "SNIPER";
  }

  // RULE: Internal state CONFIRMED_READY or ACTIVE_CONFIRMED → UI state CONFIRMED
  if (card.signalState === "CONFIRMED_READY" || card.signalState === "ACTIVE_CONFIRMED") {
    // TRANSITION CHECK: All CONFIRMED conditions must be met
    // 1. Continuation confirmed (15M alignment with structure)
    if (!card.execution15mState || card.execution15mState === "CONFLICTED") {
      return "BUILDING";
    }
    // 2. Macro (4H) not conflicting OR overridden by strong signal
    // For now, macro conflict means step back to SNIPER, not CONFIRMED
    if (card.htf4hTrend === "BEARISH" && card.direction === "LONG") {
      return "SNIPER";
    }
    if (card.htf4hTrend === "BULLISH" && card.direction === "SHORT") {
      return "SNIPER";
    }
    // 3. Sustained direction (no flip in 4H)
    if (card.htf4hMomentum === null || card.htf4hMomentum < 0) {
      return "SNIPER";
    }
    return "CONFIRMED";
  }

  // DEFAULT: Everything else is BUILDING
  return "BUILDING";
}

/**
 * Safe percentage rendering (FIX NaN ISSUE)
 * Returns number 0-100 or "—" if invalid
 */
export function safePercent(value: number | null | undefined): string {
  // If null/undefined, return dash
  if (value === null || value === undefined) {
    return "—";
  }
  // If NaN or not finite, return dash
  if (!Number.isFinite(value)) {
    return "—";
  }
  // Clamp to 0-100
  const clamped = Math.max(0, Math.min(100, value));
  // Round to nearest integer
  return Math.round(clamped).toString();
}

/**
 * Safe bar width for CSS (FIX NaN% CSS ERROR)
 * Returns valid CSS width: "0%" to "100%"
 */
export function safeBarWidth(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "0%";
  }
  const clamped = Math.max(0, Math.min(100, value));
  return `${Math.round(clamped)}%`;
}

/**
 * Color for trade readiness score badge
 */
export function getReadinessColor(score: number | null | undefined): string {
  if (score === null || score === undefined || !Number.isFinite(score)) {
    return "text-zinc-500"; // Gray for unknown
  }
  if (score < 40) return "text-red-500"; // Red: dead market
  if (score < 60) return "text-yellow-500"; // Yellow: building
  if (score < 75) return "text-blue-500"; // Blue: SNIPER
  return "text-green-500"; // Green: CONFIRMED
}
