import { Signal } from "./strategy";

let signals: Signal[] = [];

export function setSignals(data: Signal[]) {
  signals = Array.isArray(data) ? data : [];
}

export function getSignals() {
  return signals;
}
