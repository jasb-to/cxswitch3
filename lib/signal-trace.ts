/**
 * Signal Trace Infrastructure (v2.7.x)
 * Unified tracing system for all signal decisions
 */

export type SignalDecision = "TRIGGERED" | "BLOCKED" | "FAILED_INSERT" | "NO_SIGNAL" | "SKIPPED";

export interface SignalTrace {
  symbol: string;
  timestamp: number;
  decision: SignalDecision;
  score: {
    long: number;
    short: number;
  };
  reasons: string[];
  breakdown: Record<string, number | boolean | string>;
  direction?: "LONG" | "SHORT";
  entryPrice?: number;
  stopLoss?: number;
  takeProfit?: number;
  riskReward?: number;
  dbResult?: {
    success: boolean;
    error?: string;
    signalId?: number;
  };
}

class TraceBuffer {
  private traces: SignalTrace[] = [];
  private readonly maxSize = 100;

  push(trace: SignalTrace) {
    this.traces.push(trace);
    if (this.traces.length > this.maxSize) {
      this.traces = this.traces.slice(-this.maxSize);
    }
  }

  getRecent(count: number = 20): SignalTrace[] {
    return this.traces.slice(-count);
  }

  getBySymbol(symbol: string, count: number = 10): SignalTrace[] {
    return this.traces
      .filter(t => t.symbol === symbol)
      .slice(-count);
  }

  getFailures(count: number = 10): SignalTrace[] {
    return this.traces
      .filter(t => t.decision === "FAILED_INSERT")
      .slice(-count);
  }

  getTriggered(count: number = 20): SignalTrace[] {
    return this.traces
      .filter(t => t.decision === "TRIGGERED")
      .slice(-count);
  }

  clear() {
    this.traces = [];
  }
}

// Global trace buffer
export const traceBuffer = new TraceBuffer();

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
  traceBuffer.push(trace);
  
  const symbol = trace.symbol.split("/")[0];
  const icon = trace.decision === "TRIGGERED" ? "✓" : trace.decision === "FAILED_INSERT" ? "✗" : "○";
  
  console.log(
    `[TRACE] ${icon} ${symbol} | ${trace.decision} | L:${trace.score.long} S:${trace.score.short} | ${trace.reasons.join(" | ")}`
  );

  // Full trace output for debugging
  if (trace.decision === "TRIGGERED" || trace.decision === "FAILED_INSERT") {
    console.log(`[TRACE DETAIL] ${JSON.stringify(trace, null, 2)}`);
  }
}

export function getTraceStats() {
  const recent = traceBuffer.getRecent(100);
  
  return {
    totalTraces: recent.length,
    triggered: recent.filter(t => t.decision === "TRIGGERED").length,
    blocked: recent.filter(t => t.decision === "BLOCKED").length,
    failures: recent.filter(t => t.decision === "FAILED_INSERT").length,
    noSignal: recent.filter(t => t.decision === "NO_SIGNAL").length,
    skipped: recent.filter(t => t.decision === "SKIPPED").length,
  };
}
