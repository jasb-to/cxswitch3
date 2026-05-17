/**
 * PERSISTENT RUNTIME SNAPSHOT
 * 
 * Uses globalThis singleton to persist across serverless invocations.
 * This ensures cron and signals route share the same in-container memory.
 * 
 * Cron writes once per minute.
 * Signals reads and returns directly.
 * Frontend renders snapshot as-is with no transforms.
 */

type RuntimeSnapshot = {
  updatedAt: string;
  cards: any[];
  setups: any[];
  ready?: boolean; // Atomic readiness flag - snapshot is valid only when ready === true
};

declare global {
  // eslint-disable-next-line no-var
  var __snapshot__: RuntimeSnapshot | undefined;
}

const defaultSnapshot: RuntimeSnapshot = {
  updatedAt: "",
  cards: [],
  setups: [],
  ready: false, // Default to not ready until explicitly set
};

export function setSnapshot(data: RuntimeSnapshot) {
  // ATOMIC: Always set ready=true when snapshot is updated
  // UI must NEVER read snapshot during construction (ready=false)
  const snapshot: RuntimeSnapshot = {
    ...data,
    ready: data.cards && data.cards.length > 0 ? true : false,
  };
  globalThis.__snapshot__ = snapshot;
  console.log("[SNAPSHOT] Persisted to globalThis", {
    updatedAt: snapshot.updatedAt,
    cardCount: snapshot.cards.length,
    setupCount: snapshot.setups.length,
    ready: snapshot.ready,
  });
}

export function getSnapshot(): RuntimeSnapshot {
  return globalThis.__snapshot__ || defaultSnapshot;
}
