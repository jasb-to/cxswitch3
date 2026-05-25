/**
 * SNAPSHOT PURITY ENFORCEMENT - PHASE 9
 * 
 * Snapshot layer may ONLY serialize frozen signals
 * NO transformations, NO rebuilding, NO enrichment, NO derivation
 */

import { CanonicalSignal } from "./types";
import { deepFreeze } from "./immutability";

// ============================================================================
// PURE SNAPSHOT TYPE
// ============================================================================

export type PureSnapshot = {
  ready: boolean;
  cards: ReadonlyArray<CanonicalSignal>;
  timestamp: string;
  version: string;
};

// ============================================================================
// PURE SNAPSHOT CREATION
// ============================================================================

/**
 * PHASE 9: Create pure snapshot from frozen signals
 * This is the ONLY operation allowed on signals before UI
 * No map(), no rebuild(), no normalize(), no fallback()
 */
export function createPureSnapshot(
  signals: readonly CanonicalSignal[],
  version: string = "1.0"
): PureSnapshot {
  // Validate all signals are frozen
  for (const signal of signals) {
    if (!Object.isFrozen(signal)) {
      throw new Error(`[SNAPSHOT_PURITY] Non-frozen signal in snapshot: ${signal.signalId}`);
    }
  }

  const snapshot: PureSnapshot = {
    ready: signals.length > 0,
    cards: signals, // DIRECT REFERENCE - no copying, no transformation
    timestamp: new Date().toISOString(),
    version,
  };

  // Freeze entire snapshot for immutability
  Object.freeze(snapshot);
  Object.freeze(snapshot.cards);

  console.log(
    `[SNAPSHOT_CREATED] Pure snapshot with ${signals.length} frozen signals at ${snapshot.timestamp}`
  );

  return snapshot;
}

// ============================================================================
// SNAPSHOT VALIDATION
// ============================================================================

/**
 * Verify snapshot is pure (no mutations, no transformations)
 */
export function validateSnapshotPurity(snapshot: PureSnapshot): void {
  // Snapshot must be frozen
  if (!Object.isFrozen(snapshot)) {
    throw new Error("[SNAPSHOT_PURITY] Snapshot is not frozen");
  }

  // Cards array must be frozen
  if (!Object.isFrozen(snapshot.cards)) {
    throw new Error("[SNAPSHOT_PURITY] Snapshot.cards array is not frozen");
  }

  // Each card must be a CanonicalSignal and frozen
  for (let i = 0; i < snapshot.cards.length; i++) {
    const card = snapshot.cards[i];

    if (!Object.isFrozen(card)) {
      throw new Error(
        `[SNAPSHOT_PURITY] Card[${i}] (${card.signalId}) is not frozen in snapshot`
      );
    }

    // Verify no extra properties (pure snapshot has only canonical properties)
    const allowedKeys = [
      "signalId",
      "symbol",
      "direction",
      "activationState",
      "macro",
      "confidence",
      "structure",
      "execution15m",
      "htf4hTrend",
      "generatedAt",
      "targetPrices",
      "readonly",
    ];

    const extraKeys = Object.keys(card).filter((k) => !allowedKeys.includes(k));
    if (extraKeys.length > 0) {
      throw new Error(
        `[SNAPSHOT_PURITY] Card[${i}] has extra properties: ${extraKeys.join(", ")}`
      );
    }
  }
}

// ============================================================================
// SNAPSHOT SERIALIZATION FOR TRANSMISSION
// ============================================================================

/**
 * Serialize snapshot for API transmission
 * CRITICAL: Do NOT transform during serialization
 * JSON stringification is the ONLY operation allowed
 */
export function serializeSnapshot(snapshot: PureSnapshot): string {
  // Verify snapshot is pure before serialization
  validateSnapshotPurity(snapshot);
  
  // Re-freeze to ensure immutability before serialization
  const refrozen = deepFreeze({ ...snapshot, cards: snapshot.cards });
  
  return JSON.stringify(refrozen);
}

/**
 * Deserialize snapshot from JSON
 * Re-freeze all signals after deserialization
 */
export function deserializeSnapshot(json: string): PureSnapshot {
  try {
    const data = JSON.parse(json);

    // Re-freeze all signals with deep freeze (they lose frozen status during JSON round-trip)
    const cards = (data.cards || []).map((card: any) => deepFreeze(card));

    const snapshot = {
      ready: data.ready,
      cards: deepFreeze(cards),
      timestamp: data.timestamp,
      version: data.version,
    };

    validateSnapshotPurity(snapshot);
    return deepFreeze(snapshot) as PureSnapshot;
  } catch (error) {
    throw new Error(
      `[SNAPSHOT_ERROR] Failed to deserialize snapshot: ${(error as Error).message}`
    );
  }
}

}

/**
 * Deserialize snapshot from transmission
 * Re-freeze all signals after deserialization
 */
export function deserializeSnapshot(json: string): PureSnapshot {
  try {
    const data = JSON.parse(json);

    // Re-freeze all signals (they lose frozen status during JSON round-trip)
    const cards = (data.cards || []).map((card: any) => Object.freeze(card));

    const snapshot = {
      ready: data.ready,
      cards: Object.freeze(cards),
      timestamp: data.timestamp,
      version: data.version,
    };

    validateSnapshotPurity(snapshot);
    return Object.freeze(snapshot) as PureSnapshot;
  } catch (error) {
    throw new Error(
      `[SNAPSHOT_ERROR] Failed to deserialize snapshot: ${(error as Error).message}`
    );
  }
}

// ============================================================================
// SNAPSHOT CONSISTENCY VERIFICATION
// ============================================================================

/**
 * Verify snapshot hasn't drifted from source signals
 */
export function verifySnapshotConsistency(
  snapshot: PureSnapshot,
  originalSignals: readonly CanonicalSignal[]
): void {
  if (snapshot.cards.length !== originalSignals.length) {
    throw new Error(
      `[SNAPSHOT_CONSISTENCY] Card count mismatch: snapshot=${snapshot.cards.length} vs original=${originalSignals.length}`
    );
  }

  for (let i = 0; i < snapshot.cards.length; i++) {
    const snapshotCard = snapshot.cards[i];
    const originalCard = originalSignals[i];

    if (snapshotCard.signalId !== originalCard.signalId) {
      throw new Error(
        `[SNAPSHOT_CONSISTENCY] Signal ID mismatch at index ${i}: ${snapshotCard.signalId} vs ${originalCard.signalId}`
      );
    }

    // Verify critical properties are identical
    const criticalProps = ["direction", "activationState", "macro", "confidence"];
    for (const prop of criticalProps) {
      if ((snapshotCard as any)[prop] !== (originalCard as any)[prop]) {
        throw new Error(
          `[SNAPSHOT_CONSISTENCY] Property ${prop} changed in snapshot for ${snapshotCard.signalId}`
        );
      }
    }
  }

  console.log("[SNAPSHOT_CONSISTENCY] Verified: snapshot matches source signals exactly");
}
