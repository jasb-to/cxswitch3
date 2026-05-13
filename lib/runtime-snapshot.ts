/**
 * v16.4.0 - ATOMIC SNAPSHOT RUNTIME WITH SIGNAL LIFECYCLES
 * 
 * Single persistent snapshot stored in globalThis.
 * No delta patching. No partial updates. Full replacement only.
 * Now includes explicit signal lifecycle states for all signals.
 * 
 * Cron writes entire snapshot atomically once per minute.
 * Signals route reads and returns directly.
 * Frontend renders snapshot as-is with no transforms.
 */

export type RuntimeSnapshot = {
  updatedAt: string;
  cards: any[];
  setups: any[];
  lifecycles?: any[];  // v16.4.0: Signal lifecycle states for all symbols
  renderableSymbols?: string[];  // v16.4.0: Efficiency: pre-filtered list of renderable symbols
};

declare global {
  // eslint-disable-next-line no-var
  var __snapshot__: RuntimeSnapshot | undefined;
}

const defaultSnapshot: RuntimeSnapshot = {
  updatedAt: "",
  cards: [],
  setups: [],
  lifecycles: [],
  renderableSymbols: [],
};

/**
 * v16.4.0: Atomic snapshot replacement
 * Always replaces entire snapshot, never patches
 */
export function setSnapshot(data: RuntimeSnapshot) {
  globalThis.__snapshot__ = data;
  console.log("[SNAPSHOT_SET] Atomic replacement persisted", {
    updatedAt: data.updatedAt,
    cardCount: data.cards.length,
    setupCount: data.setups.length,
    lifecycleCount: data.lifecycles?.length || 0,
  });
}

/**
 * v16.4.0: Get current snapshot
 * Returns the live atomic snapshot (no fallbacks, no defaults)
 */
export function getSnapshot(): RuntimeSnapshot {
  return globalThis.__snapshot__ || defaultSnapshot;
}
