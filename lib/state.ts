import type { Signal } from "./signalEngine";

type State = {
  signals: Signal[];
  updatedAt: string | null;
};

declare global {
  // eslint-disable-next-line no-var
  var __CX_STATE__: State | undefined;
}

export const state: State =
  global.__CX_STATE__ ?? (global.__CX_STATE__ = {
    signals: [],
    updatedAt: null,
  });

export function setSignals(signals: Signal[]) {
  state.signals = signals;
  state.updatedAt = new Date().toISOString();
}

export function getSignals() {
  return state;
}
