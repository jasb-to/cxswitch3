import type { Signal } from "./strategy";

let latestSignals: Signal[] = [];
let lastUpdated = 0;

export function setSignals(signals: Signal[]) {
  latestSignals = signals;
  lastUpdated = Date.now();
}

export function getSignals() {
  return {
    signals: latestSignals,
    lastUpdated,
  };
}
