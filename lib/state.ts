import type { Signal } from "./strategy";

let SIGNAL_CACHE: Signal[] = [];

export function setSignals(signals: Signal[]) {
  SIGNAL_CACHE = signals;
}

export function getSignals(): Signal[] {
  return SIGNAL_CACHE;
}
