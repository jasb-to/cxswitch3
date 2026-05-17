/**
 * CANONICAL SNAPSHOT TYPE
 * 
 * ONE source of truth for entire system:
 * Backend → snapshot → frontend render
 * 
 * No derived state, no duplicate validation, no secondary inference.
 */

export type CanonicalSnapshot = {
  ready: boolean;           // true only when cards.length === 3
  cards: any[];            // exactly 0 or 3 - never partial
  updatedAt: string | null; // ISO timestamp or null
};

/**
 * EMPTY_SNAPSHOT is the ONLY valid initial state
 * Frontend MUST always start here
 */
export const EMPTY_SNAPSHOT: CanonicalSnapshot = {
  ready: false,
  cards: [],
  updatedAt: null,
};

/**
 * Validate snapshot matches canonical shape
 * Used internally by globalThis storage only - NOT for frontend logic
 */
export function isCanonicalSnapshot(value: any): value is CanonicalSnapshot {
  return (
    value &&
    typeof value === "object" &&
    typeof value.ready === "boolean" &&
    Array.isArray(value.cards) &&
    (value.updatedAt === null || typeof value.updatedAt === "string")
  );
}
