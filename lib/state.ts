import type { Signal } from "./strategy";

type State = {
  signals: Signal[];
  updatedAt: number;
};

let state: State = {
  signals: [],
  updatedAt: 0,
};

export function setSignals(signals: Signal[]) {
  state = {
    signals,
    updatedAt: Date.now(),
  };
}

export function getSignals() {
  return state;
}
