/**
 * CANONICAL SNAPSHOT TYPE - STRICT CONTRACT
 * 
 * ENFORCEMENT RULE: Snapshot ALWAYS contains COMPLETE state
 * No omissions. No partial data. No stale fields.
 * 
 * ONE source of truth for entire system:
 * Backend → snapshot → ALL consumers (UI, counters, alerts, displays)
 */

export type CanonicalSnapshot = {
  ready: boolean;           // true only when cards.length === 3
  cards: any[];            // exactly 0 or 3 - never partial
  setups: any[];           // ACTIVE_SNIPER + ACTIVE_CONFIRMED signals
  activeSignals: string[]; // Array of active signal symbols (derived from setups)
  signalCount: number;     // Total count of active signals (derived from setups.length)
  activeSnipers: number;   // Count of ACTIVE_SNIPER only (derived from setups)
  updatedAt: string | null; // ISO timestamp or null
};

/**
 * EMPTY_SNAPSHOT is the ONLY valid initial state
 * ALL fields must be present in every snapshot
 */
export const EMPTY_SNAPSHOT: CanonicalSnapshot = {
  ready: false,
  cards: [],
  setups: [],
  activeSignals: [],
  signalCount: 0,
  activeSnipers: 0,
  updatedAt: null,
};

/**
 * Create canonical snapshot from execution state
 * ENFORCES complete contract - all fields populated or defaults to empty
 */
export function createCanonicalSnapshot(input: {
  cards: any[];
  setups: any[];
  updatedAt?: string | null;
}): CanonicalSnapshot {
  const cards = input.cards || [];
  const setups = input.setups || [];
  
  // Compute derived fields
  const activeSignals = setups.map((s: any) => s.symbol);
  const signalCount = setups.length;
  const activeSnipers = setups.filter((s: any) => s.mode === "SNIPER").length;
  
  return {
    ready: cards.length === 3,
    cards,
    setups,
    activeSignals,
    signalCount,
    activeSnipers,
    updatedAt: input.updatedAt || null,
  };
}

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
    Array.isArray(value.setups) &&
    Array.isArray(value.activeSignals) &&
    typeof value.signalCount === "number" &&
    typeof value.activeSnipers === "number" &&
    (value.updatedAt === null || typeof value.updatedAt === "string")
  );
}
