import { Redis } from "@upstash/redis";
import type { Signal, TradeState, SignalEvent } from "./strategy-core";

const redis = new Redis({
  url: process.env.KV_REST_API_URL || "",
  token: process.env.KV_REST_API_TOKEN || "",
});

const SIGNALS_KEY = "signals:current";
const COOLDOWN_KEY_PREFIX = "telegram:cooldown:";
const HOLD_STATE_KEY_PREFIX = "hold:state:";
const LAST_CRON_KEY = "cron:last_execution";
const REQUEST_DEDUP_KEY_PREFIX = "request:dedup:";
const SIGNAL_EVENTS_QUEUE_KEY = "signal:events:queue"; // Event-driven architecture

const HOLD_DURATION_MS = 5 * 60 * 1000; // 5 minutes
const SIGNAL_LOCK_MS = 120 * 1000; // 2 minutes - lock window for signal persistence

/**
 * Signal Hold State - persisted per symbol
 * Prevents state flickering by adding inertia
 */
export interface SignalHoldState {
  symbol: string;
  state: TradeState;
  lastState: TradeState;
  lastChangeTimestamp: number;
  holdUntil: number;
  confidence: number;
  sniper_confirmed_at?: number; // When SNIPER was confirmed
  lockUntil?: number; // UI-only: prevents flicker, does NOT block evaluation
  sniperProbationUntil?: number; // SNIPER probation: minimum cycles before downgrade allowed
}

/**
 * Get current hold state for a symbol
 */
export async function getHoldState(symbol: string): Promise<SignalHoldState | null> {
  try {
    const data = await redis.get(`${HOLD_STATE_KEY_PREFIX}${symbol}`);
    if (!data) return null;
    return data as SignalHoldState;
  } catch (error) {
    console.error(`[STORE] Error getting hold state for ${symbol}:`, error);
    return null;
  }
}

/**
 * Check if a signal is currently locked (prevent recomputation)
 */
export async function isSignalLocked(symbol: string, now: number = Date.now()): Promise<boolean> {
  const holdState = await getHoldState(symbol);
  if (!holdState || !holdState.lockUntil) return false;
  return now < holdState.lockUntil;
}

/**
 * Set hold state for a symbol (persists for 30 minutes to outlive any hold)
 */
export async function setHoldState(state: SignalHoldState): Promise<void> {
  try {
    await redis.set(`${HOLD_STATE_KEY_PREFIX}${state.symbol}`, state, { ex: 1800 }); // 30 min TTL
  } catch (error) {
    console.error(`[STORE] Error setting hold state for ${state.symbol}:`, error);
    throw error;
  }
}

/**
 * Apply hold rule to an evaluated state
 * Returns the actual state to use based on hold rules
 * 
 * CRITICAL: Signal lock prevents recomputation during lock window
 */
export async function applyHoldRules(
  symbol: string,
  evaluatedState: TradeState,
  evaluatedConfidence: number,
  now: number = Date.now()
): Promise<{ finalState: TradeState; holdRemaining: number }> {
  const holdState = await getHoldState(symbol);
  
  // NOTE: Signal lock is UI-only (prevents flicker in display)
  // It does NOT block evaluation, state transitions, or event emission
  // Lock just tells UI to display the last locked state instead of flickering
  
  const lockRemaining = holdState?.lockUntil ? Math.max(0, holdState.lockUntil - now) : 0;
  const lockActive = lockRemaining > 0;

  // No hold state exists yet
  if (!holdState) {
    // Initialize hold state with signal lock
    const newHoldState: SignalHoldState = {
      symbol,
      state: evaluatedState,
      lastState: evaluatedState,
      lastChangeTimestamp: now,
      holdUntil: evaluatedState !== "WATCHING_SHIFT" ? now + HOLD_DURATION_MS : 0,
      confidence: evaluatedConfidence,
      lockUntil: evaluatedState !== "WATCHING_SHIFT" ? now + SIGNAL_LOCK_MS : 0,
      ...(evaluatedState === "SNIPER" ? { sniper_confirmed_at: now } : {}),
    };
    await setHoldState(newHoldState);
    
    // EMIT EVENT: Signal created
    await emitSignalEvent({
      type: "SIGNAL_CREATED",
      symbol,
      timestamp: now,
      newState: evaluatedState,
      confidence: evaluatedConfidence,
      price: 0,
    });
    
    return { finalState: evaluatedState, holdRemaining: 0 };
  }

  const holdRemaining = Math.max(0, holdState.holdUntil - now);
  const isHoldActive = holdRemaining > 0;

  console.log(`[HOLD] ${symbol}: current=${holdState.state}, evaluated=${evaluatedState}, holdActive=${isHoldActive}, holdRemaining=${holdRemaining}ms`);

  // SNIPER HOLD - Never downgrade during hold or probation
  if (holdState.state === "SNIPER" && isHoldActive) {
    const probationRemaining = holdState.sniperProbationUntil ? Math.max(0, holdState.sniperProbationUntil - now) : 0;
    
    if (evaluatedState !== "SNIPER") {
      // Try to downgrade from SNIPER
      if (probationRemaining > 0) {
        // Still in probation window - keep SNIPER (2-cycle minimum protection)
        console.log(`[HOLD] ${symbol} in SNIPER probation (${Math.ceil(probationRemaining/1000)}s remaining)`);
        return { finalState: "SNIPER", holdRemaining };
      }
      // Probation expired, allow transition below
    }
    
    // SNIPER remains, refresh confidence and set probation window
    const updated: SignalHoldState = {
      ...holdState,
      confidence: Math.max(holdState.confidence, evaluatedConfidence),
      lockUntil: holdState.lockUntil || now + SIGNAL_LOCK_MS,
      sniperProbationUntil: holdState.sniperProbationUntil || (now + 10 * 60 * 1000), // 10 min minimum (2 cycles)
    };
    await setHoldState(updated);
    return { finalState: "SNIPER", holdRemaining };
  }

  // BUILDING HOLD - Can upgrade to SNIPER immediately, cannot downgrade
  if (holdState.state === "BUILDING" && isHoldActive) {
    if (evaluatedState === "SNIPER") {
      // Upgrade to SNIPER - extend lock
      const updated: SignalHoldState = {
        symbol,
        state: "SNIPER",
        lastState: "BUILDING",
        lastChangeTimestamp: now,
        holdUntil: now + HOLD_DURATION_MS,
        confidence: evaluatedConfidence,
        lockUntil: now + SIGNAL_LOCK_MS,
        sniper_confirmed_at: now,
      };
      await setHoldState(updated);
      console.log(`[HOLD] ${symbol} upgraded: BUILDING → SNIPER (locked)`);
      
      // EMIT EVENT: SNIPER entry
      await emitSignalEvent({
        type: "SIGNAL_ENTERED_SNIPER",
        symbol,
        timestamp: now,
        prevState: "BUILDING",
        newState: "SNIPER",
        confidence: evaluatedConfidence,
        price: 0,
      });
      
      return { finalState: "SNIPER", holdRemaining: 0 };
    }
    // BUILDING persists through hold - cannot downgrade
    return { finalState: "BUILDING", holdRemaining };
  }

  // Hold expired or no active hold
  if (evaluatedState === holdState.state) {
    // State unchanged
    return { finalState: evaluatedState, holdRemaining: 0 };
  }

  // State changed (hold expired or transition happening)
  if (evaluatedState !== "WATCHING_SHIFT") {
    // Entering BUILDING or SNIPER, apply new hold and lock
    const updated: SignalHoldState = {
      symbol,
      state: evaluatedState,
      lastState: holdState.state,
      lastChangeTimestamp: now,
      holdUntil: now + HOLD_DURATION_MS,
      confidence: evaluatedConfidence,
      lockUntil: now + SIGNAL_LOCK_MS,
      ...(evaluatedState === "SNIPER" ? { sniper_confirmed_at: now } : {}),
    };
    await setHoldState(updated);
    console.log(`[HOLD] ${symbol} transitioned: ${holdState.state} → ${evaluatedState} (locked)`);
    
    // EMIT EVENT: State transition
    if (evaluatedState === "BUILDING") {
      await emitSignalEvent({
        type: "SIGNAL_ENTERED_BUILDING",
        symbol,
        timestamp: now,
        prevState: holdState.state,
        newState: "BUILDING",
        confidence: evaluatedConfidence,
        price: 0,
      });
    } else if (evaluatedState === "SNIPER") {
      await emitSignalEvent({
        type: "SIGNAL_ENTERED_SNIPER",
        symbol,
        timestamp: now,
        prevState: holdState.state,
        newState: "SNIPER",
        confidence: evaluatedConfidence,
        price: 0,
      });
    }
    
    return { finalState: evaluatedState, holdRemaining: 0 };
  }

  // Transitioning to WATCHING_SHIFT
  if (holdState.state === "WATCHING_SHIFT") {
    // Already watching, just update confidence
    const updated: SignalHoldState = {
      symbol,
      state: "WATCHING_SHIFT",
      lastState: holdState.state,
      lastChangeTimestamp: now,
      holdUntil: 0,
      confidence: evaluatedConfidence,
    };
    await setHoldState(updated);
    return { finalState: "WATCHING_SHIFT", holdRemaining: 0 };
  }

  // From BUILDING/SNIPER back to WATCHING_SHIFT - release hold but add hysteresis
  const updated: SignalHoldState = {
    symbol,
    state: "WATCHING_SHIFT",
    lastState: holdState.state,
    lastChangeTimestamp: now,
    holdUntil: 0,
    confidence: evaluatedConfidence,
  };
  await setHoldState(updated);
  console.log(`[HOLD] ${symbol} released: ${holdState.state} → WATCHING_SHIFT`);
  // SAFETY: Ensure finalState is always valid
  if (!finalState || !["WATCHING_SHIFT", "BUILDING", "SNIPER"].includes(finalState)) {
    console.warn(`[HOLD] SAFETY: Invalid finalState '${finalState}' for ${symbol}, defaulting to WATCHING_SHIFT`);
    return { finalState: "WATCHING_SHIFT", holdRemaining: 0 };
  }

  return { finalState, holdRemaining };
}

/**
 * Read all current signals from Redis
 * Returns empty array if no signals exist
 */
export async function readSignals(): Promise<Signal[]> {
  try {
    const data = await redis.get(SIGNALS_KEY);
    if (!data || !Array.isArray(data)) return [];
    return data;
  } catch (error) {
    console.error("[STORE] Error reading signals:", error);
    return [];
  }
}

/**
 * Write signals to Redis
 */
export async function writeSignals(signals: Signal[]): Promise<void> {
  try {
    await redis.set(SIGNALS_KEY, signals, { ex: 86400 }); // 24 hour TTL
  } catch (error) {
    console.error("[STORE] Error writing signals:", error);
    throw error;
  }
}

/**
 * Get a single signal by symbol
 */
export async function getSignal(symbol: string): Promise<Signal | null> {
  try {
    const signals = await readSignals();
    return signals.find((s) => s.symbol === symbol) || null;
  } catch (error) {
    console.error(`[STORE] Error getting signal for ${symbol}:`, error);
    return null;
  }
}

/**
 * Get Telegram cooldown for a symbol (milliseconds)
 * Returns 0 if no cooldown exists (alert is ready)
 */
export async function getTelegramCooldown(symbol: string): Promise<number> {
  try {
    const cooldown = await redis.get(`${COOLDOWN_KEY_PREFIX}${symbol}`);
    return cooldown ? Number(cooldown) : 0;
  } catch (error) {
    console.error(`[STORE] Error getting cooldown for ${symbol}:`, error);
    return 0;
  }
}

/**
 * Set Telegram cooldown for a symbol (persists for 30 minutes)
 */
export async function setTelegramCooldown(symbol: string, timestamp: number): Promise<void> {
  try {
    await redis.set(`${COOLDOWN_KEY_PREFIX}${symbol}`, timestamp, { ex: 1800 }); // 30 min TTL
  } catch (error) {
    console.error(`[STORE] Error setting cooldown for ${symbol}:`, error);
    throw error;
  }
}

/**
 * Record last cron execution time
 */
export async function getLastCronExecution(): Promise<number> {
  try {
    const lastExec = await redis.get(LAST_CRON_KEY);
    return lastExec ? Number(lastExec) : 0;
  } catch (error) {
    console.error("[STORE] Error getting last cron execution:", error);
    return 0;
  }
}

/**
 * Update last cron execution time
 */
export async function setLastCronExecution(timestamp: number): Promise<void> {
  try {
    await redis.set(LAST_CRON_KEY, timestamp, { ex: 3600 }); // 1 hour TTL
  } catch (error) {
    console.error("[STORE] Error setting last cron execution:", error);
    throw error;
  }
}

/**
 * Request deduplication for 60 seconds
 * Returns true if request should be processed, false if duplicate
 */
export async function checkAndSetRequestDedup(requestId: string): Promise<boolean> {
  try {
    const existing = await redis.get(`${REQUEST_DEDUP_KEY_PREFIX}${requestId}`);
    if (existing) return false;
    await redis.set(`${REQUEST_DEDUP_KEY_PREFIX}${requestId}`, "1", { ex: 60 });
    return true;
  } catch (error) {
    console.error(`[STORE] Error checking dedup for ${requestId}:`, error);
    return true;
  }
}

/**
 * SIGNAL EVENT LAYER - Event-driven architecture
 * Emits ONE event exactly once per state transition
 */
export async function emitSignalEvent(event: SignalEvent): Promise<void> {
  try {
    // Push event to queue (persisted as JSON list)
    await redis.lpush(SIGNAL_EVENTS_QUEUE_KEY, JSON.stringify(event));
    // Keep queue size bounded (max 1000 recent events)
    await redis.ltrim(SIGNAL_EVENTS_QUEUE_KEY, 0, 999);
    console.log(`[EVENT] ${event.type}: ${event.symbol} → ${event.newState}`);
  } catch (error) {
    console.error(`[EVENT] Error emitting event:`, error);
  }
}

/**
 * Get unprocessed signal events
 * Events are consumed and removed from queue after processing
 */
export async function getSignalEvents(): Promise<SignalEvent[]> {
  try {
    // Fetch all events (max 100)
    const events = await redis.lrange(SIGNAL_EVENTS_QUEUE_KEY, 0, 99);
    if (!events || events.length === 0) return [];
    
    // Parse and return
    return events.map((e) => {
      try {
        return JSON.parse(typeof e === "string" ? e : String(e)) as SignalEvent;
      } catch {
        return null;
      }
    }).filter((e): e is SignalEvent => e !== null);
  } catch (error) {
    console.error(`[EVENT] Error getting signal events:`, error);
    return [];
  }
}

/**
 * Clear processed signal events from queue
 */
export async function clearSignalEvents(count: number): Promise<void> {
  try {
    // Remove 'count' events from the right end of queue
    for (let i = 0; i < count; i++) {
      await redis.rpop(SIGNAL_EVENTS_QUEUE_KEY);
    }
  } catch (error) {
    console.error(`[EVENT] Error clearing signal events:`, error);
  }
}

/**
 * Health check - verify Redis connectivity
 */
export async function healthCheck(): Promise<boolean> {
  try {
    await redis.ping();
    return true;
  } catch (error) {
    console.error("[STORE] Redis health check failed:", error);
    return false;
  }
}
