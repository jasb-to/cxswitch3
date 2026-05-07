/**
 * Signal Trace Stubs (v2.7.5)
 * Minimal stubs to maintain compatibility while removing trace infrastructure
 */

export type SignalDecision = "TRIGGERED" | "BLOCKED" | "FAILED_INSERT" | "NO_SIGNAL" | "SKIPPED";

export interface SignalTrace {
  symbol: string;
  timestamp: number;
  decision: SignalDecision;
  score: { long: number; short: number };
  reasons: string[];
  breakdown: Record<string, number | boolean | string>;
  direction?: "LONG" | "SHORT";
  entryPrice?: number;
  stopLoss?: number;
  takeProfit?: number;
  riskReward?: number;
  dbResult?: { success: boolean; error?: string; signalId?: number };
}

// Stub implementations
export const traceBuffer = { getRecent: () => [] };

export function createTrace(symbol: string): SignalTrace {
  return {
    symbol,
    timestamp: Date.now(),
    decision: "NO_SIGNAL",
    score: { long: 0, short: 0 },
    reasons: [],
    breakdown: {},
  };
}

export function logTrace(trace: SignalTrace) {
  // No-op
}

export function getTraceStats() {
  return {
    totalTraces: 0,
    triggered: 0,
    blocked: 0,
    failures: 0,
    noSignal: 0,
    skipped: 0,
  };
}
