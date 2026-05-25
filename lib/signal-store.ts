/**
 * MINIMAL STATE STORAGE
 * In-memory only (no DB needed for demo)
 * Stores raw signals, nothing else
 */

import type { RawSignal } from "./strategy-core";

let signals: Map<string, RawSignal> = new Map();

export function setSignal(signal: RawSignal): void {
  signals.set(signal.symbol, signal);
}

export function getSignals(): RawSignal[] {
  return Array.from(signals.values());
}

export function clearSignals(): void {
  signals.clear();
}

export function isReady(): boolean {
  // Ready when all 3 symbols have signals
  return signals.size === 3;
}
