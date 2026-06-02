import type { Signal } from "./strategy";

let signals: Signal[] = [];

export function setSignals(data: Signal[]) {
  signals = data;
}

export function getSignals() {
  return signals;
}
