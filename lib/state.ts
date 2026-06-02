import type { Signal } from "./signalEngine";

let state: {
  signals: Signal[];
  updatedAt: number;
} = {
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
