/**
 * Event-Driven Monitor Layer (v23.0)
 * 
 * Converts from static state reporting to transition-based event system.
 * Reports what CHANGED between cycles, not what IS.
 * 
 * Tracks:
 * - Direction changes (LONG→SHORT, NEUTRAL→LONG, etc.)
 * - Signal state transitions (BUILDING→SNIPER, SNIPER→EXPIRED, etc.)
 * - Momentum degradation/recovery
 * - Structure validation events
 * - Macro context shifts (4H trend changes)
 * 
 * v37.1 ARCHITECTURE FIX: Import types from centralized lib/types.ts
 * This breaks the circular dependency: monitor-event → types (not → strategy-v6)
 */

import type { SymbolCardState, MonitorEventType, MonitorEvent } from "./types";

// v36.1 FIX: Lazy initialize previousStates to avoid circular dependency TDZ
// The Map uses SymbolCardState type which creates circular import with strategy-v6.ts
// By deferring initialization to first function call, we avoid TDZ during module load
let previousStates: Map<string, Partial<SymbolCardState>> | null = null;

function getPreviousStates(): Map<string, Partial<SymbolCardState>> {
  if (previousStates === null) {
    previousStates = new Map();
  }
  return previousStates;
}

/**
 * Detect what changed between cycles for a symbol
 * Returns the EVENT that occurred, not the current state
 */
export function detectMonitorEvent(currentCard: SymbolCardState): MonitorEvent {
  const symbol = currentCard.symbol;
  const states = getPreviousStates();
  const previousCard = states.get(symbol);

  // First cycle for this symbol - no changes to detect
  if (!previousCard) {
    states.set(symbol, captureCardState(currentCard));
    return { 
      type: "NONE", 
      symbol, 
      timestamp: Date.now(),
      previousState: {},
      currentState: captureCardState(currentCard),
      details: { reason: "Initial state" }
    };
  }

  let eventType: MonitorEventType = "NONE";
  const details: Record<string, any> = {};

  // Check for direction change
  if (previousCard.direction !== currentCard.direction) {
    eventType = "DIRECTION_FLIP";
    details.previousDirection = previousCard.direction;
    details.currentDirection = currentCard.direction;
  }

  // Check for signal state transition
  else if (previousCard.signalState !== currentCard.signalState) {
    eventType = "SIGNAL_STATE_CHANGE";
    details.previousSignalState = previousCard.signalState;
    details.currentSignalState = currentCard.signalState;
    
    // Specific sub-cases
    if (previousCard.signalState === "BUILDING" && currentCard.signalState === "ACTIVE_SNIPER") {
      details.reason = "Signal promoted to SNIPER";
    } else if (currentCard.signalState === "EXPIRED") {
      details.reason = "Signal expired or revalidation failed";
    }
  }

  // Check for momentum spikes (stoch or EMA surge)
  else if (previousCard.stochRsi !== undefined && currentCard.stochRsi !== undefined) {
    const stochChange = currentCard.stochRsi - (previousCard.stochRsi || 0);
    
    if (stochChange > 15 || (previousCard.stochRsi ?? 0) < 30 && currentCard.stochRsi > 55) {
      eventType = "MOMENTUM_SPIKE";
      details.stochChange = stochChange;
      details.currentStoch = currentCard.stochRsi;
    } else if (stochChange < -15 || (previousCard.stochRsi ?? 0) > 70 && currentCard.stochRsi < 45) {
      eventType = "MOMENTUM_FADE";
      details.stochChange = stochChange;
      details.currentStoch = currentCard.stochRsi;
    }
  }

  // Check for structure validation/invalidation
  else if (previousCard.emaSlope !== undefined && currentCard.emaSlope !== undefined) {
    const previousEmaValid = isEMAValid(previousCard.emaSlope, previousCard.direction);
    const currentEmaValid = isEMAValid(currentCard.emaSlope, currentCard.direction);
    
    if (!previousEmaValid && currentEmaValid) {
      eventType = "STRUCTURE_CONFIRMATION";
      details.reason = "EMA now aligns with direction";
      details.emaChange = currentCard.emaSlope - (previousCard.emaSlope || 0);
    } else if (previousEmaValid && !currentEmaValid) {
      eventType = "STRUCTURE_INVALIDATION";
      details.reason = "EMA now contradicts direction";
      details.emaChange = currentCard.emaSlope - (previousCard.emaSlope || 0);
    }
  }

  // Check for macro shift (4H trend change)
  else if (previousCard.htf4hTrend !== currentCard.htf4hTrend) {
    eventType = "MACRO_SHIFT";
    details.previousTrend = previousCard.htf4hTrend;
    details.currentTrend = currentCard.htf4hTrend;
    details.reason = `4H trend: ${previousCard.htf4hTrend} → ${currentCard.htf4hTrend}`;
  }

  // Check for impulse state changes
  else if (previousCard.execution15mState !== currentCard.execution15mState) {
    if ((previousCard.execution15mState === "RANGING" || previousCard.execution15mState === "RETEST_DOWN") && 
        (currentCard.execution15mState === "EXPANDING" || currentCard.execution15mState === "BREAKOUT_READY")) {
      eventType = "IMPULSE_STARTING";
      details.reason = `15M impulse: ${previousCard.execution15mState} → ${currentCard.execution15mState}`;
    }
  }

  // Check for confidence changes
  else if (previousCard.momentumScore !== undefined && currentCard.momentumScore !== undefined) {
    const scoreChange = currentCard.momentumScore - (previousCard.momentumScore || 0);
    
    if (previousCard.momentumScore < 70 && currentCard.momentumScore >= 70) {
      eventType = "CONFIDENCE_SURGE";
      details.scoreChange = scoreChange;
      details.currentScore = currentCard.momentumScore;
    } else if (previousCard.momentumScore >= 40 && currentCard.momentumScore < 40) {
      eventType = "CONFIDENCE_DROP";
      details.scoreChange = scoreChange;
      details.currentScore = currentCard.momentumScore;
    }
  }

  // Update stored state for next cycle
  states.set(symbol, captureCardState(currentCard));

  return {
    type: eventType,
    symbol,
    timestamp: Date.now(),
    previousState: previousCard,
    currentState: captureCardState(currentCard),
    details,
  };
}

/**
 * Convert monitor event to human-readable commentary
 * This replaces the static generateTradeWatchCommentary
 */
export function formatMonitorEvent(event: MonitorEvent): string {
  const { symbol, type, currentState, details } = event;

  if (type === "NONE") {
    return `${symbol}: No change detected`;
  }

  if (type === "DIRECTION_FLIP") {
    return `🔄 ${symbol} DIRECTION FLIP: ${details.previousDirection} → ${details.currentDirection}`;
  }

  if (type === "SIGNAL_STATE_CHANGE") {
    if (details.reason === "Signal promoted to SNIPER") {
      return `✅ ${symbol} SIGNAL PROMOTED: ${details.previousSignalState} → ACTIVE_SNIPER (score: ${currentState.momentumScore?.toFixed(1)})`;
    } else if (details.currentSignalState === "EXPIRED") {
      return `⏰ ${symbol} SIGNAL EXPIRED: ${details.previousSignalState} → EXPIRED`;
    }
    return `${symbol}: Signal state changed (${details.previousSignalState} → ${details.currentSignalState})`;
  }

  if (type === "MOMENTUM_SPIKE") {
    return `📈 ${symbol} MOMENTUM SPIKE: Stoch jumped +${details.stochChange?.toFixed(0)} to ${details.currentStoch?.toFixed(0)}`;
  }

  if (type === "MOMENTUM_FADE") {
    return `📉 ${symbol} MOMENTUM FADE: Stoch dropped ${details.stochChange?.toFixed(0)} to ${details.currentStoch?.toFixed(0)}`;
  }

  if (type === "STRUCTURE_CONFIRMATION") {
    return `✓ ${symbol} STRUCTURE CONFIRMED: ${currentState.direction} structure holds (EMA: ${currentState.emaSlope?.toFixed(3)})`;
  }

  if (type === "STRUCTURE_INVALIDATION") {
    return `✗ ${symbol} STRUCTURE BREAK: ${currentState.direction} structure no longer valid (EMA: ${currentState.emaSlope?.toFixed(3)})`;
  }

  if (type === "MACRO_SHIFT") {
    // v33.0 UI DISCIPLINE: Never imply macro affects direction
    return `🌍 ${symbol} MACRO SHIFT: 4H ${details.previousTrend} → ${details.currentTrend} (confidence modifier applies)`;
  }

  if (type === "IMPULSE_STARTING") {
    return `💥 ${symbol} IMPULSE STARTING: 15M now ${currentState.execution15mState}`;
  }

  if (type === "CONFIDENCE_SURGE") {
    return `🚀 ${symbol} CONFIDENCE SURGE: Score jumped to ${details.currentScore?.toFixed(1)} (+${details.scoreChange?.toFixed(1)})`;
  }

  if (type === "CONFIDENCE_DROP") {
    return `⚠️ ${symbol} CONFIDENCE DROP: Score fell to ${details.currentScore?.toFixed(1)} (${details.scoreChange?.toFixed(1)})`;
  }

  return `${symbol} [${type}]: ${details.reason || "Check details"}`;
}

/**
 * Helper: Determine if EMA is valid for direction
 */
function isEMAValid(emaSlope: number, direction?: string): boolean {
  if (direction === "LONG") return emaSlope >= -0.1;
  if (direction === "SHORT") return emaSlope <= 0.1;
  return true;
}

/**
 * Helper: Capture only relevant fields from card state
 */
function captureCardState(card: SymbolCardState): Partial<SymbolCardState> {
  return {
    symbol: card.symbol,
    direction: card.direction,
    signalState: card.signalState,
    momentumScore: card.momentumScore,
    stochRsi: card.stochRsi,
    emaSlope: card.emaSlope,
    volatilityLevel: card.volatilityLevel,
    execution15mState: card.execution15mState,
    htf4hTrend: card.htf4hTrend,
    tradeReadinessScore: card.tradeReadinessScore,
  };
}

/**
 * Reset state (for testing/debugging)
 */
export function resetMonitorState(): void {
  const states = getPreviousStates();
  states.clear();
}
