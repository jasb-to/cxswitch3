/**
 * SIGNAL VIEW MODEL MAPPER
 * 
 * Pure pass-through: Signal → SignalViewModel
 * No simulation, no deterministic transforms
 * Just type alias to ensure consistency
 * 
 * All market context comes from strategy-core
 */

import type { Signal } from "@/lib/signal-store";

export type SignalViewModel = Signal;

/**
 * Pure identity function - pass through unchanged
 */
export function toViewModel(signal: Signal): SignalViewModel {
  return signal;
}

