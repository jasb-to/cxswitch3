// In-memory signal store (persists for the lifetime of the serverless function instance)
import type { Signal } from "./strategy";

declare global {
  // eslint-disable-next-line no-var
  var __signalStore: Signal[] | undefined;
}

function getStore(): Signal[] {
  if (!global.__signalStore) global.__signalStore = [];
  return global.__signalStore;
}

export function getSignals(): Signal[] {
  return getStore().filter((s) => s.state !== "END");
}

export function getAllSignals(): Signal[] {
  return getStore();
}

export function upsertSignal(next: Signal): void {
  const store = getStore();
  const idx = store.findIndex(
    (s) => s.symbol === next.symbol && s.direction === next.direction && s.state !== "END"
  );
  if (idx >= 0) {
    store[idx] = next;
  } else {
    store.push(next);
  }
}

export function endSignal(symbol: string, direction: string): void {
  const store = getStore();
  const s = store.find(
    (s) => s.symbol === symbol && s.direction === direction && s.state !== "END"
  );
  if (s) s.state = "END";
}

export function incrementCandleCount(symbol: string): void {
  const store = getStore();
  store.forEach((s) => {
    if (s.symbol === symbol && s.state === "EARLY") s.candlesSince++;
  });
}
