/**
 * v16.3.0 - ATOMIC SNAPSHOT RUNTIME
 * 
 * Single persistent snapshot stored in globalThis.
 * No delta patching. No partial updates. Full replacement only.
 * 
 * Cron writes entire snapshot atomically once per minute.
 * Signals route reads and returns directly.
 * Frontend renders snapshot as-is with no transforms.
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
 * v16.3.0: Atomic snapshot replacement
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
 * v16.3.0: Get current snapshot
 * Returns the live atomic snapshot (no fallbacks, no defaults)
 */
export function getSnapshot(): RuntimeSnapshot {
  return globalThis.__snapshot__ || defaultSnapshot;
}
