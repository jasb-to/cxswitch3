/**
 * SIGNAL VIEW MODEL MAPPER
 * 
 * Pure pass-through: Signal → SignalViewModel
 * No simulation, no transformation
 * Just type alias to ensure consistency
 * 
 * All market context comes from signal-engine (unified evaluation source)
 */

import type { Signal } from "@/lib/signal-engine";

export type SignalViewModel = Signal;

/**
 * Pure identity function - pass through unchanged
 */
export function toViewModel(signal: Signal): SignalViewModel {
  return signal;
}

