/**
 * SINGLE SOURCE OF TRUTH
 * 
 * Cron generates snapshot once per minute.
 * API returns snapshot directly.
 * Frontend renders snapshot directly.
 * 
 * NO transforms, NO rebuilds, NO fallbacks.
 */

export type RuntimeSnapshot = {
  updatedAt: string;
  cards: any[];
  setups: any[];
};

let snapshot: RuntimeSnapshot = {
  updatedAt: "",
  cards: [],
  setups: [],
};

export function setSnapshot(data: RuntimeSnapshot) {
  snapshot = data;
  console.log("[SNAPSHOT] Updated", {
    updatedAt: data.updatedAt,
    cardCount: data.cards.length,
    setupCount: data.setups.length,
  });
}

export function getSnapshot(): RuntimeSnapshot {
  return snapshot;
}
