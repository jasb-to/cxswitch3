import type { Signal } from "./strategy";

let latest: Signal[] = [];

export function setSignals(s: Signal[]) {
  latest = s;
}

export function getSignals() {
  return latest;
}
