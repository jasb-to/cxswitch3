/**
 * UI NORMALISER - Pure Pass-Through
 * 
 * Takes signals and ensures frontend has consistent shape
 * NO synthesis, NO aggregation, NO fallback generation
 * Just type consistency
 */

import type { Signal } from "@/lib/signal-store";

export type NormalisedSignal = Signal;

/**
 * Identity function - pass through unchanged
 */
export function normaliseSignal(signal: Signal): NormalisedSignal {
  return signal;
}

