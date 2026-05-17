/**
 * UI Normalization Layer - Fix Schema at Render Boundary
 * 
 * Ensures all cards have proper values before render to prevent dead UI.
 * This is the missing piece that prevents NaN, LOADING paradoxes.
 */

import { SymbolCardState } from "@/lib/runtime-snapshot";

export interface NormalizedCard extends SymbolCardState {
  isExecution: boolean;
  isDisplay: boolean;
  safeTradeReadiness: number; // Always 0-100, never NaN
}

/**
 * FIX #2: Normalize a single card for render
 * - Hard guards against NaN tradeReadiness
 * - Determines card type (execution vs display)
 * - Ensures all percentages are valid
 */
export function normalizeCard(card: SymbolCardState): NormalizedCard {
  const safeTradeReadiness = Number.isFinite(card.tradeReadinessScore)
    ? Math.max(0, Math.min(100, card.tradeReadinessScore))
    : 0;

  return {
    ...card,
    isExecution: card.signalState === "SNIPER_READY" || card.signalState === "ACTIVE_SNIPER",
    isDisplay: card.signalState === "BUILDING",
    safeTradeReadiness,
  };
}

/**
 * FIX #1: Guard against NaN in percentage rendering
 * Returns safe percentage string for display
 */
export function safePercent(value: number | null | undefined): string {
  if (!Number.isFinite(value)) return "—";
  const bounded = Math.max(0, Math.min(100, value));
  return `${Math.round(bounded)}%`;
}

/**
 * FIX #1: Guard against NaN in bar width
 * Returns safe CSS width for progress bars
 */
export function safeBarWidth(value: number | null | undefined): string {
  if (!Number.isFinite(value)) return "0%";
  const bounded = Math.max(0, Math.min(100, value));
  return `${bounded}%`;
}

/**
 * FIX #4: Determine UI status state
 * Returns actual state, not "LOADING" when data exists
 */
export function getCardStatus(
  card: NormalizedCard,
  isStale: boolean
): "READY" | "STALE" | "EXECUTION" | "BUILDING" {
  if (card.isExecution && card.signalState === "ACTIVE_SNIPER") {
    return "EXECUTION";
  }
  if (card.isDisplay || card.signalState === "BUILDING") {
    return "BUILDING";
  }
  if (isStale) {
    return "STALE";
  }
  return "READY";
}
