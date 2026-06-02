import type { Signal } from "./strategy";

let signals: Signal[] = [];

export function setSignals(data: Signal[]) {
  // ONLY keep strongest per symbol
  const map = new Map<string, Signal>();

  for (const s of data) {
    const existing = map.get(s.symbol);

    if (!existing) {
      map.set(s.symbol, s);
      continue;
    }

    // keep higher confidence signal only
    if (s.confidence > existing.confidence) {
      map.set(s.symbol, s);
    }
  }

  signals = Array.from(map.values());
}

export function getSignals() {
  return signals;
}
