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

export function setSnapshot(data: RuntimeSnapshot) {
  globalThis.__snapshot__ = data;
  console.log("[SNAPSHOT] Persisted to globalThis", {
    updatedAt: data.updatedAt,
    cardCount: data.cards.length,
    setupCount: data.setups.length,
  });
}

export function getSnapshot(): RuntimeSnapshot {
  return globalThis.__snapshot__ || defaultSnapshot;
}
