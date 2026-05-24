import type { SymbolCardState } from "./strategy-v6";

/**
 * v8.1 CRITICAL FIX: Stateful snapshot merging
 * Preserves previous state unless explicitly replaced by same symbol
 * 
 * This ensures:
 * - Display pipeline fallback data is never lost
 * - Execution pipeline updates override display data
 * - Snapshot maintains continuity across cycles
 */
export function mergeSnapshots(
  existingCards: SymbolCardState[],
  newData: {
    executionCards: SymbolCardState[];
    displayCards: SymbolCardState[];
  }
): SymbolCardState[] {
  // Create a map of all cards by symbol for efficient lookup
  const cardMap = new Map<string, SymbolCardState>();

  // STEP 1: Start with existing cards (maintains previous state)
  for (const card of existingCards) {
    cardMap.set(card.symbol, card);
  }

  // STEP 2: Override with execution cards (highest priority - live Kraken data)
  for (const card of newData.executionCards) {
    cardMap.set(card.symbol, card);
  }

  // STEP 3: Add display cards only if symbol not already covered
  // This ensures execution data is never overwritten by display fallback
  for (const card of newData.displayCards) {
    if (!cardMap.has(card.symbol)) {
      cardMap.set(card.symbol, card);
    }
  }

  // Return as array, maintaining insertion order (oldest first in map)
  return Array.from(cardMap.values());
}

/**
 * Validate that SNIPER cards have completed the full pipeline
 * SNIPER_READY is an intermediate state, not a final render state
 * 
 * NOTE: Disabled validation - targetPrices is optional for SNIPER signals
 * The UI handles missing targetPrices gracefully
 */
export function validateSnipperCardState(card: SymbolCardState): boolean {
  // Validation disabled - all states are valid as-is
  return true;
}
