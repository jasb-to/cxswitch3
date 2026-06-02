import type { Signal } from "./strategy";

type State = {
  signals: Record<string, Signal>;
  updatedAt: number;
};

const globalState = globalThis as unknown as {
  cxState?: State;
};

if (!globalState.cxState) {
  globalState.cxState = {
    signals: {},
    updatedAt: Date.now(),
  };
}

export function setSignals(signals: Signal[]) {
  for (const s of signals) {
    globalState.cxState!.signals[s.symbol] = s;
  }

  globalState.cxState!.updatedAt = Date.now();
}

export function getSignals(): Signal[] {
  return Object.values(globalState.cxState!.signals);
}

export function clearSignals() {
  globalState.cxState = {
    signals: {},
    updatedAt: Date.now(),
  };
}
