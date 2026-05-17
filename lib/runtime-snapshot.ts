/**
 * PERSISTENT RUNTIME SNAPSHOT
 * 
 * Uses globalThis singleton to persist across serverless invocations.
 * This ensures cron and signals route share the same in-container memory.
 * 
 * Cron writes once per minute with EXACTLY 3 cards.
 * Frontend reads and renders directly with NO validation.
 * 
 * ATOMIC GUARANTEE: ready=true ONLY when cards.length === 3
 */

import type { CanonicalSnapshot } from "./canonical-snapshot";
import { EMPTY_SNAPSHOT } from "./canonical-snapshot";

declare global {
  // eslint-disable-next-line no-var
  var __snapshot__: CanonicalSnapshot;
}

// GLOBAL SINGLETON - Always initialized to EMPTY_SNAPSHOT
// Never undefined. Never partially constructed.
if (!globalThis.__snapshot__) {
  globalThis.__snapshot__ = EMPTY_SNAPSHOT;
}

/**
 * BACKEND ONLY: Set snapshot atomically with exactly 3 cards
 * 
 * RULE: This MUST only be called with exactly 3 cards.
 * ready flag is set automatically based on card count.
 * 
 * Frontend NEVER calls this.
 */
export function setSnapshot(snapshot: {
  cards: any[];
  updatedAt: string | null;
}): void {
  // ATOMIC: Enforce exactly 3 cards or no cards
  const isReady = Array.isArray(snapshot.cards) && snapshot.cards.length === 3;

  const canonical: CanonicalSnapshot = {
    ready: isReady,
    cards: isReady ? snapshot.cards : [],
    updatedAt: isReady ? snapshot.updatedAt : null,
  };

  globalThis.__snapshot__ = canonical;
  console.log("[SNAPSHOT_ATOMIC]", {
    ready: canonical.ready,
    cardCount: canonical.cards.length,
    updatedAt: canonical.updatedAt,
  });
}

/**
 * FRONTEND ONLY: Get snapshot
 * 
 * GUARANTEED invariants:
 * - snapshot is never undefined
 * - snapshot.ready === true only when cards.length === 3
 * - snapshot.ready === false means use BOOTSTRAP_CARDS
 */
export function getSnapshot(): CanonicalSnapshot {
  return globalThis.__snapshot__ || EMPTY_SNAPSHOT;
}

