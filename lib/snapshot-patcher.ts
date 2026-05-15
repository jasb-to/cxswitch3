/**
 * v7.2.7 FIX #5 — DELTA SNAPSHOT PATCHING
 * 
 * Instead of replacing entire snapshot, patch only changed cards
 * Preserves existing card state and updates only delta fields
 */

import type { SymbolCardState } from "./strategy-v21";

export type SnapshotPatch = {
  symbol: string;
  fields: Partial<SymbolCardState>;
  timestamp: number;
};

/**
 * Apply delta patches to snapshot (v7.2.7 FIX #5)
 * Merges only changed fields into existing cards
 */
export function applySnapshotPatches(
  existingCards: SymbolCardState[],
  patches: SnapshotPatch[]
): SymbolCardState[] {
  // Create lookup map
  const cardMap = new Map(existingCards.map(c => [c.symbol, c]));

  // Apply patches
  for (const patch of patches) {
    const card = cardMap.get(patch.symbol);
    if (card) {
      // Merge patch fields only
      Object.assign(card, patch.fields, { updatedAt: new Date().toISOString() });
    } else {
      // New card - add it
      cardMap.set(patch.symbol, {
        symbol: patch.symbol,
        // Default fields
        price: 0,
        source: "unknown",
        degraded: true,
        direction: "NEUTRAL",
        mode: "NONE",
        confidence: 0,
        signalState: "NONE",
        stochRsi: null,
        emaSlope: null,
        volatilityLevel: null,
        htf4hTrend: "NEUTRAL",
        htf4hMomentum: null,
        htf1hAlignment: null,
        htf15mCompression: null,
        marketReadinessState: "NEUTRAL",
        tradeReadinessScore: null,
        expectedMovePercent: null,
        targetPrices: null,
        riskReward: null,
        notes: "Pending update",
        updatedAt: new Date().toISOString(),
        ...patch.fields,
      } as SymbolCardState);
    }
  }

  return Array.from(cardMap.values());
}

/**
 * Calculate patches needed (v7.2.7 FIX #5)
 * Compare old and new cards, return only changed fields
 */
export function calculatePatches(
  oldCards: SymbolCardState[],
  newCards: SymbolCardState[]
): SnapshotPatch[] {
  const oldMap = new Map(oldCards.map(c => [c.symbol, c]));
  const patches: SnapshotPatch[] = [];

  for (const newCard of newCards) {
    const oldCard = oldMap.get(newCard.symbol);
    if (!oldCard) {
      // New card - full patch
      patches.push({
        symbol: newCard.symbol,
        fields: newCard,
        timestamp: Date.now(),
      });
    } else {
      // Existing card - find changed fields
      const changedFields: Partial<SymbolCardState> = {};
      
      // Check each field
      if (oldCard.price !== newCard.price) changedFields.price = newCard.price;
      if (oldCard.direction !== newCard.direction) changedFields.direction = newCard.direction;
      if (oldCard.mode !== newCard.mode) changedFields.mode = newCard.mode;
      if (oldCard.signalState !== newCard.signalState) changedFields.signalState = newCard.signalState;
      if (oldCard.confidence !== newCard.confidence) changedFields.confidence = newCard.confidence;
      if (oldCard.stochRsi !== newCard.stochRsi) changedFields.stochRsi = newCard.stochRsi;
      if (oldCard.emaSlope !== newCard.emaSlope) changedFields.emaSlope = newCard.emaSlope;
      if (oldCard.volatilityLevel !== newCard.volatilityLevel) changedFields.volatilityLevel = newCard.volatilityLevel;
      if (oldCard.htf4hTrend !== newCard.htf4hTrend) changedFields.htf4hTrend = newCard.htf4hTrend;
      if (oldCard.marketReadinessState !== newCard.marketReadinessState) changedFields.marketReadinessState = newCard.marketReadinessState;
      if (oldCard.tradeReadinessScore !== newCard.tradeReadinessScore) changedFields.tradeReadinessScore = newCard.tradeReadinessScore;
      if (JSON.stringify(oldCard.targetPrices) !== JSON.stringify(newCard.targetPrices)) changedFields.targetPrices = newCard.targetPrices;
      if (oldCard.notes !== newCard.notes) changedFields.notes = newCard.notes;

      if (Object.keys(changedFields).length > 0) {
        patches.push({
          symbol: newCard.symbol,
          fields: changedFields,
          timestamp: Date.now(),
        });
      }
    }
  }

  return patches;
}
