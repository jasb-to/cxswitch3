import { Redis } from "@upstash/redis";
import type { Signal, TradeState } from "./strategy-core";

const redis = new Redis({
  url: process.env.KV_REST_API_URL || "",
  token: process.env.KV_REST_API_TOKEN || "",
});

const SIGNALS_KEY = "signals:current";
const COOLDOWN_KEY_PREFIX = "telegram:cooldown:";
const HOLD_STATE_KEY_PREFIX = "hold:state:";
const LAST_CRON_KEY = "cron:last_execution";
const REQUEST_DEDUP_KEY_PREFIX = "request:dedup:";

const HOLD_DURATION_MS = 5 * 60 * 1000; // 5 minutes

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
 */
export async function applyHoldRules(
  symbol: string,
  evaluatedState: TradeState,
  evaluatedConfidence: number,
  now: number = Date.now()
): Promise<{ finalState: TradeState; holdRemaining: number }> {
  const holdState = await getHoldState(symbol);
  
  // No hold state exists yet
  if (!holdState) {
    // Initialize hold state
    const newHoldState: SignalHoldState = {
      symbol,
      state: evaluatedState,
      lastState: evaluatedState,
      lastChangeTimestamp: now,
      holdUntil: evaluatedState !== "WATCHING_SHIFT" ? now + HOLD_DURATION_MS : 0,
      confidence: evaluatedConfidence,
      ...(evaluatedState === "SNIPER" ? { sniper_confirmed_at: now } : {}),
    };
    await setHoldState(newHoldState);
    return { finalState: evaluatedState, holdRemaining: 0 };
  }

  const holdRemaining = Math.max(0, holdState.holdUntil - now);
  const isHoldActive = holdRemaining > 0;

  console.log(`[HOLD] ${symbol}: current=${holdState.state}, evaluated=${evaluatedState}, holdActive=${isHoldActive}, holdRemaining=${holdRemaining}ms`);

  // SNIPER LOCK - Never downgrade during hold
  if (holdState.state === "SNIPER" && isHoldActive) {
    if (evaluatedState !== "SNIPER") {
      console.log(`[HOLD] ${symbol} locked in SNIPER (hold expires in ${holdRemaining}ms)`);
      return { finalState: "SNIPER", holdRemaining };
    }
    // SNIPER remains, refresh hold
    const updated: SignalHoldState = {
      ...holdState,
      confidence: Math.max(holdState.confidence, evaluatedConfidence),
    };
    await setHoldState(updated);
    return { finalState: "SNIPER", holdRemaining };
  }

  // BUILDING HOLD - Can upgrade to SNIPER immediately, cannot downgrade
  if (holdState.state === "BUILDING" && isHoldActive) {
    if (evaluatedState === "SNIPER") {
      // Upgrade to SNIPER
      const updated: SignalHoldState = {
        symbol,
        state: "SNIPER",
        lastState: "BUILDING",
        lastChangeTimestamp: now,
        holdUntil: now + HOLD_DURATION_MS,
        confidence: evaluatedConfidence,
        sniper_confirmed_at: now,
      };
      await setHoldState(updated);
      console.log(`[HOLD] ${symbol} upgraded: BUILDING → SNIPER`);
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
    // Entering BUILDING or SNIPER, apply new hold
    const updated: SignalHoldState = {
      symbol,
      state: evaluatedState,
      lastState: holdState.state,
      lastChangeTimestamp: now,
      holdUntil: now + HOLD_DURATION_MS,
      confidence: evaluatedConfidence,
      ...(evaluatedState === "SNIPER" ? { sniper_confirmed_at: now } : {}),
    };
    await setHoldState(updated);
    console.log(`[HOLD] ${symbol} transitioned: ${holdState.state} → ${evaluatedState}`);
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
  return { finalState: "WATCHING_SHIFT", holdRemaining: 0 };
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
