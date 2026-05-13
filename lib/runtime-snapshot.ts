/**
 * v17.0.0 - SIMPLE ATOMIC SNAPSHOT RUNTIME
 * 
 * Pure deterministic signal engine.
 * Snapshot is simply: current market state only.
 * No lifecycle metadata. No temporal fields. No computed render flags.
 * 
 * Cron writes entire snapshot atomically once per minute.
 * Frontend renders exactly what snapshot contains.
 */

export type RuntimeSnapshot = {
  updatedAt: string;
  cards: any[];
  setups: any[];
};

declare global {
  // eslint-disable-next-line no-var
  var __snapshot__: RuntimeSnapshot | undefined;
}

const defaultSnapshot: RuntimeSnapshot = {
  updatedAt: "",
  cards: [],
  setups: [],
};

/**
 * v17.0.0: Atomic snapshot replacement
 * Always replaces entire snapshot, never patches
 */
export function setSnapshot(data: RuntimeSnapshot) {
  globalThis.__snapshot__ = data;
  console.log("[SNAPSHOT_SET] Atomic replacement persisted", {
    updatedAt: data.updatedAt,
    cardCount: data.cards.length,
    setupCount: data.setups.length,
  });
}

/**
 * v17.0.0: Get current snapshot
 * Returns the live atomic snapshot (no transformation)
 */
export function getSnapshot(): RuntimeSnapshot {
  return globalThis.__snapshot__ || defaultSnapshot;
}
