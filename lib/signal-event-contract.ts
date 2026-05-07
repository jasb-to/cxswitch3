/**
 * Signal Event Contract (v3.0.0)
 * 
 * Single source of truth for signal lifecycle events.
 * Strategy emits events, not raw signals. All downstream consumers
 * (Supabase, Telegram, logs) receive validated events.
 * 
 * This completely decouples strategy logic from database schema.
 */

export type SignalEventType = 
  | "SIGNAL_EMITTED"      // Entry signal created (EARLY_OPEN)
  | "SIGNAL_CONFIRMED"    // Retest validated (CONFIRMED)
  | "SIGNAL_TP_HIT"       // Take-profit hit
  | "SIGNAL_SL_HIT"       // Stop-loss hit
  | "SIGNAL_EXPIRED"      // Stale signal cleanup
  | "SIGNAL_MANUAL_EXIT"; // User manual close

export interface SignalEventPayload {
  symbol: string;
  direction: "LONG" | "SHORT";
  entry_price: number;
  stop_loss: number;
  take_profit: number;
  confidence: number;
  breakout_level: number;
}

export interface SignalEvent {
  type: SignalEventType;
  timestamp: number;           // Unix ms when event occurred
  payload: SignalEventPayload;
  source: "PROBABILITY_MODEL" | "EARLY_EXPANSION" | "POSITION_MANAGEMENT";
  metadata?: {
    reason?: string;           // Human-readable trigger reason
    displacement?: number;     // Breakout expansion %
    pnl?: number;             // For exits: realized PNL
    outcome?: "TP" | "SL" | "EXPIRED" | "MANUAL";
  };
}

/**
 * Event stream processor
 * Validates and distributes events to all consumers
 */
export class SignalEventStream {
  private listeners: Map<SignalEventType, Set<(event: SignalEvent) => Promise<void>>> = new Map();

  subscribe(eventType: SignalEventType, handler: (event: SignalEvent) => Promise<void>) {
    if (!this.listeners.has(eventType)) {
      this.listeners.set(eventType, new Set());
    }
    this.listeners.get(eventType)!.add(handler);
  }

  async emit(event: SignalEvent) {
    // Validate event structure before processing
    if (!this.validateEvent(event)) {
      console.error(`[EVENT VALIDATION] Failed for type ${event.type}:`, event);
      return;
    }

    // Notify all subscribers for this event type
    const handlers = this.listeners.get(event.type) || new Set();
    const results = await Promise.allSettled(
      Array.from(handlers).map(h => h(event))
    );

    // Log any handler failures
    results.forEach((result, idx) => {
      if (result.status === "rejected") {
        console.error(`[EVENT HANDLER ${idx}] Failed:`, result.reason);
      }
    });
  }

  private validateEvent(event: SignalEvent): boolean {
    // Required fields
    if (!event.type || !event.timestamp || !event.payload || !event.source) return false;

    // Payload validation
    const { payload } = event;
    if (!payload.symbol || !payload.direction || typeof payload.entry_price !== "number") return false;
    if (typeof payload.stop_loss !== "number" || typeof payload.take_profit !== "number") return false;
    if (typeof payload.confidence !== "number" || typeof payload.breakout_level !== "number") return false;

    // Direction must be LONG or SHORT
    if (!["LONG", "SHORT"].includes(payload.direction)) return false;

    // Confidence must be 0-100
    if (payload.confidence < 0 || payload.confidence > 100) return false;

    return true;
  }
}

// Global event stream singleton
export const signalEventStream = new SignalEventStream();

/**
 * Helper to create a signal event from strategy context
 */
export function createSignalEvent(
  type: SignalEventType,
  payload: SignalEventPayload,
  source: "PROBABILITY_MODEL" | "EARLY_EXPANSION" | "POSITION_MANAGEMENT",
  metadata?: SignalEvent["metadata"]
): SignalEvent {
  return {
    type,
    timestamp: Date.now(),
    payload,
    source,
    metadata,
  };
}
