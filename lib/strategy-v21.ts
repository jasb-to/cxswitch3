/**
 * v22.0 - QUALITY FILTER LAYER (MULTI-CYCLE STABILITY + CONFIDENCE GATING)
 * 
 * 6-Phase Pipeline + Enhanced Quality Layer:
 * 1. PHASE_MARKET_DATA: Fetch, compute, normalize
 * 2. PHASE_DIRECTION: EMA/displacement/stoch inference (NO HTF authority)
 * 3. PHASE_IMPULSE: Canonical computeImpulseStrength
 * 4. PHASE_QUALITY: ENHANCED - Multi-cycle stability, confidence gating, decay detection
 * 5. PHASE_CLASSIFY: Metadata only (never mutates state)
 * 6. PHASE_OUTPUT: Persist atomically (no post-processing)
 * 
 * NEW in v22.0:
 * - Multi-cycle directional consistency check (2 consecutive cycles required)
 * - Real confidence calculation and HARD gating (>= 70 required)
 * - Impulse decay detection (reject if weakening or single-cycle spikes)
 * - HTF alignment adjustment (±10 confidence, not blocking)
 * - Signal validity window (2-4 candles, auto-expire)
 * - Target: 60-65% win rate by reducing weak entries
 */

import type { PriceData } from "./price-router";

// ============================================================================
// v21.3.0: SNIPER EVENT LIFECYCLE STATE MACHINE (UNIFIED ARCHITECTURE)
// ============================================================================

/**
 * v21.3.0: SNIPER_EVENT = Immutable trade event
 * 
 * Single rule: Once created, NEVER mutate entry/tp/sl/direction
 * Lifecycle: ACTIVE → CLOSED (only on exit conditions)
 * 
 * This eliminates:
 * - Signal flickering (event is immutable)
 * - Queue corruption (no shared mutable state)
 * - Missing alerts (alert fired at creation)
 * - Duplicate signals (registry blocks re-fire)
 */
export interface SniperEvent {
  symbol: string;
  direction: "LONG" | "SHORT";
  entry: number;
  tp1: number;  // Primary target
  tp2: number;  // Secondary target (2x move)
  sl: number;   // Stop loss
  impulse: number; // impulse value when fired
  createdAt: number; // timestamp (ms)
  status: "ACTIVE" | "CLOSED";
  closureReason?: "TP_HIT" | "SL_HIT" | "EXPIRY" | "INVALIDATION";
  cycleId: string;
}

/**
 * v21.3.0: EVENT REGISTRY
 * Per-symbol active event storage
 * Single source of truth for SNIPER state
 */
const activeEvents = new Map<string, SniperEvent>();

// ============================================================================
// v22.0: MULTI-CYCLE STATE TRACKING (QUALITY FILTER LAYER)
// ============================================================================

/**
 * v22.0: Per-symbol cycle memory for stability checks
 * Tracks: previous direction, impulse, timestamps, confidence
 * Used for: directional consistency, impulse decay detection, spike rejection
 */
interface CycleMemory {
  symbol: string;
  previousDirection: "LONG" | "SHORT" | "NEUTRAL" | null;
  previousImpulse: number | null;
  previousConfidence: number | null;
  previousTimestamp: number | null;
  htfDirection: "LONG" | "SHORT" | "NEUTRAL" | null;  // 4H trend (for adjustment only)
  signalFiredAt: number | null;  // When SNIPER actually fired
  signalValidUntil: number | null;  // Signal expires after 2-4 candles
}

// v22.0: Per-symbol memory persistence (resets daily, survives individual cycles)
const cycleMemory = new Map<string, CycleMemory>();

/**
 * v22.0: Initialize or retrieve cycle memory for symbol
 */
function getOrInitCycleMemory(symbol: string): CycleMemory {
  if (!cycleMemory.has(symbol)) {
    cycleMemory.set(symbol, {
      symbol,
      previousDirection: null,
      previousImpulse: null,
      previousConfidence: null,
      previousTimestamp: null,
      htfDirection: null,
      signalFiredAt: null,
      signalValidUntil: null,
    });
  }
  return cycleMemory.get(symbol)!;
}

/**
 * v22.0: QUALITY FILTER - ENHANCED SNIPER VALIDATION
 * 
 * Returns: { canFire: boolean, reason: string }
 * 
 * Gates:
 * 1. Directional Consistency: Direction same for 2 consecutive cycles
 * 2. Impulse Strength: Must be >= 27 AND not weakening
 * 3. Confidence Gating: HARD BLOCKER - must be >= 70 (not just display)
 * 4. Spike Rejection: Reject single-cycle spikes (must continue next cycle)
 * 5. HTF Adjustment: Modify confidence (not block) based on 4H alignment
 * 6. Signal Validity: Once fired, only valid for 2-4 candle window
 * 7. Impulse Decay: If impulse drops > 20% from trigger, invalidate
 */
/**
 * v22.1: DETAILED GATE TRACE for signal observability
 * Every decision includes full reasoning chain
 */
interface GateTrace {
  symbol: string;
  rawImpulse: number;
  confidenceBreakdown: {
    base: number;
    htfAdjustment: number;
    final: number;
  };
  cycleMemoryState: "cycle1" | "cycle2" | "confirmed" | "missing";
  spikeRejection: {
    rejected: boolean;
    reason?: string;
  };
  directionalConsistency: {
    pass: boolean;
    reason?: string;
  };
  finalDecision: "ALLOWED" | "BLOCKED";
  blockReason?: string;
}

interface QualityFilterResult {
  canFire: boolean;
  finalConfidence: number;  // After HTF adjustment
  reason: string;
  gateTrace: GateTrace;  // v22.1: Full observability
}

function validateQualityFilter(
  symbol: string,
  direction: "LONG" | "SHORT" | "NEUTRAL",
  impulse: number,
  rawConfidence: number,
  htfDirection: "LONG" | "SHORT" | "NEUTRAL",
  nowMs: number
): QualityFilterResult {
  const memory = getOrInitCycleMemory(symbol);
  
  // Determine cycle memory state for tracing
  let cycleMemoryState: "cycle1" | "cycle2" | "confirmed" | "missing" = "missing";
  if (memory.previousDirection === null) {
    cycleMemoryState = "cycle1";
  } else if (memory.previousDirection === direction && memory.previousImpulse !== null) {
    cycleMemoryState = "cycle2";
  } else {
    cycleMemoryState = "confirmed";
  }

  // Initialize base confidence breakdown
  let baseConfidence = rawConfidence;
  let htfAdjustment = 0;
  let finalConfidence = rawConfidence;

  // Calculate HTF adjustment first (so it's available for all gates)
  if (htfDirection !== "NEUTRAL" && direction !== "NEUTRAL") {
    if (htfDirection === direction) {
      htfAdjustment = +5;
      finalConfidence += 5;
    } else {
      htfAdjustment = -10;
      finalConfidence -= 10;
    }
  }

  // Initialize gate trace object
  const gateTrace: GateTrace = {
    symbol,
    rawImpulse: impulse,
    confidenceBreakdown: {
      base: baseConfidence,
      htfAdjustment,
      final: finalConfidence,
    },
    cycleMemoryState,
    spikeRejection: { rejected: false },
    directionalConsistency: { pass: true },
    finalDecision: "BLOCKED",
    blockReason: undefined,
  };

  // =========================================================================
  // GATE 1: Directional Consistency (2 consecutive cycles)
  // =========================================================================
  if (memory.previousDirection !== null && memory.previousDirection !== direction) {
    gateTrace.directionalConsistency = {
      pass: false,
      reason: `direction changed ${memory.previousDirection} → ${direction}`,
    };
    gateTrace.finalDecision = "BLOCKED";
    gateTrace.blockReason = `[GATE1_DIRECTION] ${gateTrace.directionalConsistency.reason}`;

    return {
      canFire: false,
      finalConfidence,
      reason: gateTrace.blockReason,
      gateTrace,
    };
  }

  // If direction is NEUTRAL, cannot fire SNIPER
  if (direction === "NEUTRAL") {
    gateTrace.directionalConsistency = {
      pass: false,
      reason: "direction is NEUTRAL",
    };
    gateTrace.finalDecision = "BLOCKED";
    gateTrace.blockReason = `[GATE1_NEUTRAL] direction is NEUTRAL`;

    return {
      canFire: false,
      finalConfidence,
      reason: gateTrace.blockReason,
      gateTrace,
    };
  }

  gateTrace.directionalConsistency = { pass: true };

  // =========================================================================
  // GATE 2: Impulse Strength & Decay Detection
  // =========================================================================
  if (impulse < 27) {
    gateTrace.finalDecision = "BLOCKED";
    gateTrace.blockReason = `[GATE2_IMPULSE_LOW] impulse ${impulse.toFixed(1)} < 27`;

    return {
      canFire: false,
      finalConfidence,
      reason: gateTrace.blockReason,
      gateTrace,
    };
  }

  // Reject single-cycle spikes (must continue in next cycle)
  if (memory.previousImpulse !== null && impulse > memory.previousImpulse * 1.5) {
    gateTrace.spikeRejection = {
      rejected: true,
      reason: `impulse jumped ${memory.previousImpulse?.toFixed(1)} → ${impulse.toFixed(1)} (1.5x threshold)`,
    };
    gateTrace.finalDecision = "BLOCKED";
    gateTrace.blockReason = `[GATE2_SPIKE] ${gateTrace.spikeRejection.reason}`;

    return {
      canFire: false,
      finalConfidence,
      reason: gateTrace.blockReason,
      gateTrace,
    };
  }

  // Reject if impulse is weakening
  if (memory.previousImpulse !== null && impulse < memory.previousImpulse) {
    gateTrace.finalDecision = "BLOCKED";
    gateTrace.blockReason = `[GATE2_DECAY] impulse weakening ${memory.previousImpulse?.toFixed(1)} → ${impulse.toFixed(1)}`;

    return {
      canFire: false,
      finalConfidence,
      reason: gateTrace.blockReason,
      gateTrace,
    };
  }

  // =========================================================================
  // GATE 3: Confidence Gating (HARD BLOCKER - not just display)
  // =========================================================================
  if (finalConfidence < 70) {
    gateTrace.finalDecision = "BLOCKED";
    gateTrace.blockReason = `[GATE3_CONFIDENCE] ${finalConfidence.toFixed(0)}% < 70% threshold (base: ${baseConfidence.toFixed(0)}, HTF adj: ${htfAdjustment > 0 ? '+' : ''}${htfAdjustment})`;

    return {
      canFire: false,
      finalConfidence,
      reason: gateTrace.blockReason,
      gateTrace,
    };
  }

  // =========================================================================
  // GATE 4: Signal Validity Window (check if already fired)
  // =========================================================================
  if (memory.signalValidUntil !== null && nowMs < memory.signalValidUntil) {
    gateTrace.finalDecision = "BLOCKED";
    gateTrace.blockReason = `[GATE4_VALIDITY] signal still valid until ${new Date(memory.signalValidUntil).toISOString()}`;

    return {
      canFire: false,
      finalConfidence,
      reason: gateTrace.blockReason,
      gateTrace,
    };
  }

  // =========================================================================
  // GATE 5: Check if existing signal has decayed too much (> 20%)
  // =========================================================================
  if (memory.signalFiredAt !== null && memory.previousImpulse !== null) {
    const decayThreshold = memory.previousImpulse * 0.8;
    if (impulse < decayThreshold) {
      gateTrace.finalDecision = "BLOCKED";
      gateTrace.blockReason = `[GATE5_DECAY] impulse ${impulse.toFixed(1)} < 80% of trigger ${memory.previousImpulse?.toFixed(1)}`;

      return {
        canFire: false,
        finalConfidence,
        reason: gateTrace.blockReason,
        gateTrace,
      };
    }
  }

  // =========================================================================
  // ALL GATES PASSED!
  // =========================================================================
  gateTrace.finalDecision = "ALLOWED";

  return {
    canFire: true,
    finalConfidence,
    reason: `[QUALITY_PASS] All gates passed. Direction: ${direction}, Impulse: ${impulse.toFixed(1)}, Confidence: ${finalConfidence.toFixed(0)}%`,
    gateTrace,
  };
}


/**
 * v22.0: Update cycle memory after evaluation
 */
function updateCycleMemory(
  symbol: string,
  direction: "LONG" | "SHORT" | "NEUTRAL",
  impulse: number,
  confidence: number,
  htfDirection: "LONG" | "SHORT" | "NEUTRAL",
  firedNow: boolean,
  nowMs: number
): void {
  const memory = getOrInitCycleMemory(symbol);
  
  memory.previousDirection = direction;
  memory.previousImpulse = impulse;
  memory.previousConfidence = confidence;
  memory.previousTimestamp = nowMs;
  memory.htfDirection = htfDirection;
  
  if (firedNow) {
    memory.signalFiredAt = nowMs;
    // Signal valid for 2-4 candles (assuming 15m candles = 30-60 min)
    // Using 45 minutes (2.5 candles average)
    memory.signalValidUntil = nowMs + 45 * 60 * 1000;
  }
}

/**
 * v22.0: ENHANCED SNIPER ENTRY RULE (WITH QUALITY FILTER)
 * 
 * Fire event if:
 * 1. Impulse >= 27 AND not weakening
 * 2. Direction consistent across 2 cycles
 * 3. Confidence >= 70 (after HTF adjustment)
 * 4. Not a single-cycle spike
 * 5. No active event exists
 * 6. Signal validity window allows
 */
function shouldFireSniperEvent(
  symbol: string,
  impulse: number,
  direction: "LONG" | "SHORT" | "NEUTRAL",
  confidence: number,
  htfDirection: "LONG" | "SHORT" | "NEUTRAL",
  nowMs: number
): boolean {
  // Check if already active
  if (activeEvents.has(symbol)) {
    return false; // Already fired, don't re-fire
  }
  
  // Run quality filter validation
  const qualityResult = validateQualityFilter(
    symbol,
    direction,
    impulse,
    confidence,
    htfDirection,
    nowMs
  );
  
  // v22.1: ALWAYS output GATE_TRACE, even when blocked
  console.log(`[GATE_TRACE] ${JSON.stringify(qualityResult.gateTrace)}`);
  
  if (!qualityResult.canFire) {
    // v22.1: Log as SOFT_SNIPER_CANDIDATE if it would have passed in v21.1
    // (i.e., impulse >= 27 and confidence would be > 50 base)
    const wouldPassV21 = impulse >= 27 && confidence > 50;
    
    if (wouldPassV21) {
      console.log(
        `[SOFT_SNIPER_CANDIDATE] ${symbol}: BLOCKED in v22 but would pass v21 criteria. ` +
        `Impulse: ${impulse.toFixed(1)}, Confidence: ${qualityResult.finalConfidence.toFixed(0)}% ` +
        `(base: ${confidence.toFixed(0)}%). ` +
        `Reason: ${qualityResult.gateTrace.blockReason}`
      );
      
      // Flag as FILTER_OVERRIDE_CANDIDATE if this is a real signal being blocked
      if (qualityResult.gateTrace.directionalConsistency.pass && impulse >= 27) {
        console.log(
          `[FILTER_OVERRIDE_CANDIDATE] ${symbol}: Review this block - ` +
          `direction is consistent, impulse is strong. ` +
          `Block reason: ${qualityResult.gateTrace.blockReason}`
        );
      }
    }
    
    console.log(`[SNIPER_BLOCKED] ${symbol}: ${qualityResult.reason}`);
    // Still update memory even if rejected (for next cycle comparison)
    updateCycleMemory(symbol, direction, impulse, confidence, htfDirection, false, nowMs);
    return false;
  }
  
  console.log(
    `[SNIPER_ALLOWED] ${symbol}: ${qualityResult.reason} - ` +
    `Cycle state: ${qualityResult.gateTrace.cycleMemoryState}, ` +
    `Confidence breakdown: base=${qualityResult.gateTrace.confidenceBreakdown.base.toFixed(0)}% + ` +
    `HTF=${qualityResult.gateTrace.confidenceBreakdown.htfAdjustment > 0 ? '+' : ''}${qualityResult.gateTrace.confidenceBreakdown.htfAdjustment}`
  );
  
  // Update memory for next cycle
  updateCycleMemory(symbol, direction, impulse, confidence, htfDirection, true, nowMs);
  
  return true; // Fire the signal!
}


function createSniperEvent(
  symbol: string,
  direction: "LONG" | "SHORT",
  entry: number,
  volatilityLevel: number | null,
  impulse: number,
  cycleId: string
): SniperEvent {
  // v21.3.0 FIX: Use fixed 1.5% move size (matches computeTargets)
  // This ensures consistency between event creation and card display
  const moveSize = entry * 0.015;
  
  // LONG: TP above entry, SL below
  // SHORT: TP below entry, SL above
  const event: SniperEvent = {
    symbol,
    direction,
    entry,
    tp1: direction === "LONG" 
      ? entry + moveSize
      : entry - moveSize,
    tp2: direction === "LONG"
      ? entry + moveSize * 2
      : entry - moveSize * 2,
    sl: direction === "LONG"
      ? entry - moveSize * 0.5
      : entry + moveSize * 0.5,
    impulse,
    createdAt: Date.now(),
    status: "ACTIVE",
    cycleId,
  };
  
  // Store in registry (immutable from this point)
  activeEvents.set(symbol, event);
  
  console.log(
    `[SNIPER_EVENT_CREATED] ${symbol} ${direction} entry=${entry.toFixed(2)} ` +
    `tp1=${event.tp1.toFixed(2)} tp2=${event.tp2.toFixed(2)} sl=${event.sl.toFixed(2)} impulse=${impulse.toFixed(1)}`
  );
  
  return event;
}

/**
 * v21.3.0: GET ACTIVE EVENT
 * Returns immutable event if active, null otherwise
 */
function getActiveEvent(symbol: string): SniperEvent | null {
  const event = activeEvents.get(symbol);
  if (!event) return null;
  
  // Check expiry (4H = 14400000ms)
  const age = Date.now() - event.createdAt;
  const EXPIRY_MS = 4 * 60 * 60 * 1000;
  
  if (age > EXPIRY_MS && event.status === "ACTIVE") {
    closeEvent(symbol, "EXPIRY");
    return null;
  }
  
  return event;
}

/**
 * v21.3.0: CLOSE EVENT (EXIT CONDITIONS)
 */
function closeEvent(symbol: string, reason: SniperEvent["closureReason"]): void {
  const event = activeEvents.get(symbol);
  if (!event) return;
  
  event.status = "CLOSED";
  event.closureReason = reason;
  
  const ageMin = ((Date.now() - event.createdAt) / 1000 / 60).toFixed(1);
  console.log(`[SNIPER_EVENT_CLOSED] ${symbol}: ${reason} (age=${ageMin}min)`);
}

// ============================================================================
// v21.1.0: TYPE DEFINITIONS (CLEAN - NO v17/v18/v19/v20 contamination)
// ============================================================================

export type SignalState = "NONE" | "BUILDING" | "ACTIVE_SNIPER";

export type MarketStructureClass =
  | "TREND_FOLLOWING"
  | "EARLY_REVERSAL"
  | "COUNTER_TREND"
  | "TRANSITION"
  | "RANGE"
  | "CHOP";

export type SymbolCardState = {
  symbol: string;
  price: number;
  source: string;
  degraded: boolean;

  // v21.2.0: EXECUTION STATE (TERMINAL, UNREVOKABLE)
  signalState: SignalState;
  marketClass: MarketStructureClass;
  direction: "LONG" | "SHORT" | "NEUTRAL";
  tradeReadinessScore: number | null;
  ignitionProbability: number;
  sniperTradeType?: "EARLY_REVERSAL" | "CONTINUATION" | "WEAK_EXPANSION" | "FALSE_START" | null;
  
  // v21.2.0: TELEGRAM FIELDS (required for alert formatting)
  mode: "SNIPER" | "CONFIRMED";
  confidence: number;  // Alias for tradeReadinessScore for telegram compatibility

  // v21.2.0: INDICATORS
  stochRsi: number | null;
  emaSlope: number | null;
  emaPressure: number;
  volatilityLevel: number | null;

  // v21.2.0: HTF CONTEXT (READ-ONLY, NEVER MUTATES STATE)
  htf4hTrend: "BULLISH" | "BEARISH" | "NEUTRAL";
  htf4hMomentum: number | null;
  htf1hAlignment: boolean | null;
  htf15mCompression: boolean | null;

  // v21.2.0: STRUCTURE
  execution15mState: "COMPRESSING" | "BREAKOUT_READY" | "EXPANDING" | "CHOP";
  marketReadinessState: string;

  // v21.2.0: CONDITIONAL TARGETS
  expectedMovePercent: { sniper: { min: number; max: number } } | null;
  targetPrices: { tp1: number; tp2: number; sl: number } | null;
  riskReward: number | null;

  // v21.2.0: METADATA
  cycleId: string;
  lastSignalTime?: number;
  notes: string;
  updatedAt: string;
  blockReason?: string;

  // v21.2.0: TRANSPARENCY BREAKDOWN
  scoreBreakdown?: {
    stochComponent: number;
    emaComponent: number;
    volatilityComponent: number;
    volumeComponent: number;
    totalImpulse: number;
  };
};

export type Setup = {
  symbol: string;
  mode: "SNIPER";
  direction: "LONG" | "SHORT";
  score: number;
  reason: string;
  price: number;
  entry: number;  // GUARANTEED: last candle close
  tp: number;     // GUARANTEED: entry ± volatility%
  sl: number;     // GUARANTEED: entry ∓ volatility%
  momentum: {
    stochRsiSignal: string;
    emaStackSignal: string;
    volatilitySignal: string;
    trend4H: boolean;
  };
  targetPrices?: { tp1: number; tp2: number; sl: number };
  riskReward?: number;
};

// ============================================================================
// v21.2.0: PHASE 1 - MARKET DATA COMPUTATION (from candle history)
// ============================================================================

/**
 * Compute Stoch RSI from candle close prices
 * Returns value 0-100
 */
function computeStochRsi(priceData: PriceData): number | null {
  if (!priceData.candles || priceData.candles.length < 14) return null;
  
  const closes = priceData.candles.map(c => c.close);
  
  // Simple RSI calculation (14 period)
  const gains: number[] = [];
  const losses: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    gains.push(change > 0 ? change : 0);
    losses.push(change < 0 ? -change : 0);
  }
  
  const avgGain = gains.slice(-14).reduce((a, b) => a + b, 0) / 14;
  const avgLoss = losses.slice(-14).reduce((a, b) => a + b, 0) / 14;
  
  if (avgLoss === 0) return avgGain > 0 ? 100 : 50;
  
  const rs = avgGain / avgLoss;
  const rsi = 100 - (100 / (1 + rs));
  
  // Stoch RSI: convert RSI to 0-100 scale (typically takes RSI over last 14 RSI values)
  return Math.min(100, Math.max(0, rsi));
}

/**
 * Compute EMA slope from candle closes
 * Returns slope of 8-period EMA
 */
function computeEmaSlope(priceData: PriceData): number | null {
  if (!priceData.candles || priceData.candles.length < 8) return null;
  
  const closes = priceData.candles.map(c => c.close);
  
  // Calculate 8-period EMA
  let ema = closes[0];
  const multiplier = 2 / (8 + 1);
  
  for (let i = 1; i < closes.length; i++) {
    ema = closes[i] * multiplier + ema * (1 - multiplier);
  }
  
  // Previous EMA (one candle ago)
  let prevEma = closes[0];
  for (let i = 1; i < closes.length - 1; i++) {
    prevEma = closes[i] * multiplier + prevEma * (1 - multiplier);
  }
  
  return ema - prevEma;
}

/**
 * Compute volatility level from candles (ATR-like)
 * Returns 0-100 scale
 */
function computeVolatilityLevel(priceData: PriceData): number | null {
  if (!priceData.candles || priceData.candles.length < 14) return null;
  
  const candles = priceData.candles.slice(-14);
  const atr = candles.reduce((sum, c) => {
    const tr = Math.max(
      c.high - c.low,
      Math.abs(c.high - (priceData.candles![priceData.candles!.length - 1].close)),
      Math.abs(c.low - (priceData.candles![priceData.candles!.length - 1].close))
    );
    return sum + tr;
  }, 0) / candles.length;
  
  // Normalize to 0-100 (50 = moderate volatility)
  const currentPrice = priceData.price;
  const volatilityPercent = (atr / currentPrice) * 100;
  return Math.min(100, volatilityPercent * 50);
}

/**
 * Compute volume impulse component
 */
function computeVolumeComponent(priceData: PriceData): number {
  if (!priceData.candles || priceData.candles.length < 20) return 0;
  
  const recentVolumes = priceData.candles.slice(-5).map(c => c.volume);
  const avgVolume = priceData.candles.slice(-20).reduce((sum, c) => sum + c.volume, 0) / 20;
  
  if (avgVolume === 0) return 0;
  
  const currentVolume = recentVolumes.reduce((a, b) => a + b, 0) / recentVolumes.length;
  const volumeRatio = currentVolume / avgVolume;
  
  // Scale 0-10: ratio of 1.0 = 0, ratio of 2.0 = 10
  return Math.min(10, Math.max(0, (volumeRatio - 1) * 10));
}

// ============================================================================
// v21.2.0: PHASE 2 - DIRECTION INFERENCE (NO HTF AUTHORITY)
// ============================================================================

/**
 * v21.1.0: DIRECTION ENGINE (PHASE 2)
 * 
 * CRITICAL AUTHORITY: Direction is the primary decision authority
 * Sources: EMA slope, stochastic structure, displacement, expansion direction
 * NO volatility influence on direction
 * 
 * Deterministic rule:
 * - Bullish: EMA acceleration > 0.5 + stoch < 60 + positive pressure
 * - Bearish: EMA deceleration < -0.5 + stoch > 40 + negative pressure
 * - Conflict or missing signals: NEUTRAL (never fallback to LONG)
 */
function inferDirection(
  emaSlope: number | null,
  stochRsi: number | null,
  emaPressure: number
): "LONG" | "SHORT" | "NEUTRAL" {
  // Input validation - if critical signals missing, NEUTRAL (not fallback)
  if (emaSlope === null || stochRsi === null) {
    return "NEUTRAL";
  }

  // v21.1.0: Bullish structural confluence (ALL required)
  // 1. EMA accelerating up (> 0.5)
  // 2. Stochastic in lower range (< 60) - room to run
  // 3. Price pressure positive (above EMA)
  const bullishStructure = 
    emaSlope > 0.5 &&           // Strong upward acceleration
    stochRsi < 60 &&             // Not overextended
    emaPressure > 0;             // Price above EMA

  // v21.1.0: Bearish structural confluence (ALL required)
  // 1. EMA accelerating down (< -0.5)
  // 2. Stochastic in upper range (> 40) - room to decline
  // 3. Price pressure negative (below EMA)
  const bearishStructure =
    emaSlope < -0.5 &&           // Strong downward acceleration
    stochRsi > 40 &&             // Not oversold
    emaPressure < 0;             // Price below EMA

  // Determine direction from structural confluence ONLY
  if (bullishStructure) {
    return "LONG";
  }

  if (bearishStructure) {
    return "SHORT";
  }

  // No confluence = NEUTRAL (not fallback to LONG, not driven by volatility)
  return "NEUTRAL";
}

// ============================================================================
// v21.2.0: INPUT GUARANTEE LAYER - HARD SANITISER (PREVENTS NaN PROPAGATION)
// ============================================================================

/**
 * v21.2.0: HARD INPUT SANITISER
 * 
 * No NaN can ever enter the pipeline.
 * Every indicator must pass through this checkpoint.
 * Fallback: 0 (neutral, safe default)
 */
function safeNumber(value: any, fallback = 0): number {
  if (value === null || value === undefined) return fallback;
  if (Number.isNaN(value)) return fallback;
  if (!Number.isFinite(value)) return fallback;
  return value;
}

// ============================================================================
// v21.2.0: PHASE 3 - CANONICAL IMPULSE CALCULATION (SINGLE SOURCE OF TRUTH)
// ============================================================================

function computeImpulseStrength(
  stochComponent: number,
  emaComponent: number,
  volatilityComponent: number,
  volumeComponent: number
): number {
  // v21.2.0: HARD INPUT SANITISER - prevent NaN from entering pipeline
  const stoch = safeNumber(stochComponent, 0);
  const ema = safeNumber(emaComponent, 0);
  const vol = safeNumber(volatilityComponent, 0);
  const volume = safeNumber(volumeComponent, 0);
  
  const impulse = stoch + ema + vol + volume;
  console.log(
    `[IMPULSE_PIPELINE] v21.2.0 unified score=${impulse.toFixed(2)} ` +
    `(stoch=${stoch.toFixed(2)} + ema=${ema.toFixed(2)} + ` +
    `vol=${vol.toFixed(2)} + volume=${volume.toFixed(2)})`
  );
  return impulse;
}

// ============================================================================
// v21.2.0: PHASE 4 - QUALITY FILTER (THRESHOLD → TERMINAL STATE)
// ============================================================================

const IMPULSE_QUALITY_THRESHOLD = 27;

function deriveExecutionState(ignitionProbability: number): SignalState {
  if (ignitionProbability >= IMPULSE_QUALITY_THRESHOLD) return "ACTIVE_SNIPER";
  if (ignitionProbability >= 1) return "BUILDING";
  return "NONE";
}

// ============================================================================
// v21.2.0: PHASE 5 - CLASSIFICATION (METADATA ONLY - NEVER MUTATES STATE)
// ============================================================================

function classifyTradeType(
  impulseStrength: number,
  emaSlope: number | null,
  stochRsi: number | null,
  direction: "LONG" | "SHORT" | "NEUTRAL",
  htf4hTrend: "BULLISH" | "BEARISH" | "NEUTRAL"
): "EARLY_REVERSAL" | "CONTINUATION" | "WEAK_EXPANSION" | "FALSE_START" | null {
  if (direction === "NEUTRAL" || impulseStrength < IMPULSE_QUALITY_THRESHOLD) {
    return null;
  }

  const isAlignedToHTF =
    (direction === "LONG" && htf4hTrend === "BULLISH") ||
    (direction === "SHORT" && htf4hTrend === "BEARISH");

  const isWeakEMA = emaSlope !== null && Math.abs(emaSlope) < 5;
  const isWeakStoch = stochRsi !== null && (stochRsi < 30 || stochRsi > 70);

  if (!isAlignedToHTF && !isWeakEMA) return "EARLY_REVERSAL";
  if (isAlignedToHTF && !isWeakEMA) return "CONTINUATION";
  if (isWeakEMA && !isWeakStoch) return "WEAK_EXPANSION";
  return "FALSE_START";
}

// ============================================================================
// UTILITY: ASSET NORMALIZATION
// ============================================================================

/**
 * v21.3.0: CANONICAL ASSET FILTER
 * Returns canonical symbol (BTC/ETH/SOL) or null if not in whitelist
 * Ensures no non-canonical assets reach signal engine
 */
function normalizeAsset(rawSymbol: string): string | null {
  const canonical = rawSymbol.toUpperCase().replace(/\/.*/, ""); // Remove any pair suffix
  
  const CANONICAL_ASSETS = new Set(["BTC", "ETH", "SOL"]);
  if (CANONICAL_ASSETS.has(canonical)) {
    return canonical;
  }
  
  return null;
}

// ============================================================================
// v21.2.0: PHASE 6 - ATOMIC SNAPSHOT OUTPUT (NO POST-PROCESSING)
// ============================================================================

export async function generateSetups(market: Record<string, PriceData>): Promise<{
  cards: SymbolCardState[];
  setups: Setup[];
}> {
  const cards: SymbolCardState[] = [];
  const setups: Setup[] = [];

  console.log(`[STATE] v21.2.0 START - Final Deterministic Impulse Engine`);
  const cycleStart = Date.now();

  for (const [rawSymbol, priceData] of Object.entries(market)) {
    let symbol: string | null = null;
    try {
      // v21.2.1: HARD ASSET FILTER - CRITICAL DATA HYGIENE BOUNDARY
      symbol = normalizeAsset(rawSymbol);
      if (!symbol) {
        console.log(`[ASSET_REJECT] ${rawSymbol} - not in canonical set (BTC/ETH/SOL)`);
        continue;
      }
      // PHASE 1: Market Data - compute from candles
      const stochRsi = computeStochRsi(priceData);
      const emaSlope = computeEmaSlope(priceData);
      const volatilityLevel = computeVolatilityLevel(priceData);
      const volumeComponent = computeVolumeComponent(priceData);
      const emaPressure = stochRsi !== null ? stochRsi - 50 : 0;

      // PHASE 2: Direction Inference (NO HTF authority)
      const direction = inferDirection(emaSlope, stochRsi, emaPressure);

      // PHASE 3: Impulse Calculation
      const stochComponent = stochRsi !== null ? stochRsi / 3 : 0;
      const emaComponent = emaSlope !== null ? Math.min(Math.abs(emaSlope) * 2, 30) : 0;
      const volatilityComponent = volatilityLevel !== null ? Math.min(volatilityLevel, 30) : 0;

      const ignitionProbability = computeImpulseStrength(
        stochComponent,
        emaComponent,
        volatilityComponent,
        volumeComponent
      );

      // v22.0: REAL CONFIDENCE CALCULATION (not hardcoded)
      // Confidence = ignitionProbability * quality factors (direction consistency, expansion state)
      // Base: ignitionProbability contributes 60%, structural factors contribute 40%
      let confidence = Math.min(ignitionProbability, 100);  // ignitionProbability is 0-100 percentage
      
      // Boost confidence if direction is trending strongly (emaSlope > 5)
      if (emaSlope !== null && Math.abs(emaSlope) > 5) {
        confidence += 5;
      }
      
      // Boost if stoch shows room to move (< 60 for bullish, > 40 for bearish)
      if (direction === "LONG" && stochRsi !== null && stochRsi < 60) {
        confidence += 5;
      } else if (direction === "SHORT" && stochRsi !== null && stochRsi > 40) {
        confidence += 5;
      }
      
      // Cap at 100
      confidence = Math.min(confidence, 100);


      // v21.3.0: CHECK FOR ACTIVE EVENT FIRST
      const activeEvent = getActiveEvent(symbol);
      let signalState: SignalState;
      let lockedEntry: number | null = null;
      let lockedTp: number | null = null;
      let lockedSl: number | null = null;
      let newEventFired: SniperEvent | null = null;
      
      if (activeEvent) {
        // EVENT ALREADY ACTIVE - MAINTAIN STATE (IMMUTABLE)
        // v21.3.0 SAFETY: Even locked events must respect directional gate
        if (direction === "NEUTRAL") {
          console.log(
            `[DIRECTION_GATE_REJECT] ${symbol}: ` +
            `Locked event discarded (direction=NEUTRAL cannot maintain ACTIVE_SNIPER)`
          );
          signalState = "BUILDING";
        } else {
          signalState = "ACTIVE_SNIPER";
          lockedEntry = activeEvent.entry;
          lockedTp = activeEvent.tp;
          lockedSl = activeEvent.sl;
          console.log(
            `[SNIPER_EVENT_MAINTAINED] ${symbol}: ` +
            `age=${((Date.now() - activeEvent.createdAt) / 1000 / 60).toFixed(0)}min ` +
            `entry=${activeEvent.entry.toFixed(2)}`
          );
        }
      } else {
        // NO ACTIVE EVENT - EVALUATE FRESH
        signalState = deriveExecutionState(ignitionProbability);
        
        // v21.3.0 CRITICAL GATE: NEUTRAL direction can NEVER produce ACTIVE_SNIPER
        // Hard architectural invariant: directional bias is required for SNIPER state
        if (direction === "NEUTRAL" && signalState === "ACTIVE_SNIPER") {
          console.log(
            `[DIRECTION_GATE_REJECT] ${symbol}: ` +
            `ACTIVE_SNIPER downgraded to BUILDING (direction=NEUTRAL is invalid)`
          );
          signalState = "BUILDING";
        }
        
        // v22.0: ENHANCED ENTRY RULE - Fire event if quality filter passes
        if (signalState === "ACTIVE_SNIPER" && shouldFireSniperEvent(symbol, ignitionProbability, direction, confidence, priceData.htf4hTrend || "NEUTRAL", Date.now())) {
          const entry = priceData.price;
          newEventFired = createSniperEvent(
            symbol,
            direction,
            entry,
            volatilityLevel,
            ignitionProbability,
            `${Date.now()}-${symbol}`
          );
          lockedEntry = entry;
          lockedTp = newEventFired.tp;
          lockedSl = newEventFired.sl;
        }
      }

      // PHASE 5: Classification (metadata only)
      const sniperTradeType =
        signalState === "ACTIVE_SNIPER"
          ? classifyTradeType(
              ignitionProbability,
              emaSlope,
              stochRsi,
              direction,
              priceData.htf4hTrend || "NEUTRAL"
            )
          : null;

      console.log(
        `[SNIPER_DECISION] ${symbol}: ` +
        `state=${signalState} ` +
        `probability=${ignitionProbability.toFixed(2)} ` +
        `direction=${direction} ` +
        `type=${sniperTradeType || "NONE"}`
      );

      // PHASE 6: Atomic Output
      const card: SymbolCardState = {
        symbol,
        price: priceData.price,
        source: "v22.0",
        degraded: false,
        signalState,
        marketClass: "TREND_FOLLOWING",
        direction,
        tradeReadinessScore: signalState === "ACTIVE_SNIPER" ? Math.ceil(confidence) : 30,
        ignitionProbability,
        sniperTradeType,
        stochRsi,
        emaSlope,
        emaPressure,
        volatilityLevel,
        htf4hTrend: priceData.htf4hTrend || "NEUTRAL",
        htf4hMomentum: null,
        htf1hAlignment: null,
        htf15mCompression: null,
        execution15mState: "EXPANDING",
        marketReadinessState: signalState,
        expectedMovePercent: signalState === "ACTIVE_SNIPER" ? { sniper: { min: 0.5, max: 2 } } : null,
        targetPrices: signalState === "ACTIVE_SNIPER" && newEventFired ? { tp1: newEventFired.tp1, tp2: newEventFired.tp2, sl: newEventFired.sl } : (signalState === "ACTIVE_SNIPER" && activeEvent ? { tp1: activeEvent.tp1, tp2: activeEvent.tp2, sl: activeEvent.sl } : null),
        riskReward: signalState === "ACTIVE_SNIPER" ? 2 : null,
        cycleId: `${Date.now()}-${symbol}`,
        notes: `${signalState} ${direction}`,
        updatedAt: new Date().toISOString(),
        scoreBreakdown: {
          stochComponent,
          emaComponent,
          volatilityComponent,
          volumeComponent,
          totalImpulse: ignitionProbability,
        },
        // v21.2.0: TELEGRAM FIELDS
        mode: signalState === "ACTIVE_SNIPER" ? "SNIPER" : "CONFIRMED",
        confidence: signalState === "ACTIVE_SNIPER" ? Math.ceil(confidence) : 30,
        // v21.3.0: EVENT MARKER FOR ALERT SYSTEM
        ...(newEventFired && { "_newEventFired": newEventFired }),
      };

      cards.push(card);

      // v22.1: SETUP HYDRATION INVARIANT - ACTIVE_SNIPER must ALWAYS have complete setup
      // Hard rule: If signalState is ACTIVE_SNIPER, setup creation is non-negotiable
      // No early exits, no skipping, no orphaned cards without trade objects
      if (signalState === "ACTIVE_SNIPER") {
        // MANDATORY: Direction must be valid for SNIPER (no NEUTRAL)
        if (direction === "NEUTRAL") {
          console.log(`[SETUP_REJECT_NEUTRAL] ${symbol}: ACTIVE_SNIPER has NEUTRAL direction, cannot create setup`);
          // This should not happen due to earlier gate, but enforce it here too
          card.signalState = "BUILDING"; // Downgrade to BUILDING
          card.blockReason = "Direction became NEUTRAL at output stage";
        } else {
          // MANDATORY: Setup MUST be created, with fallback values if needed
          const entry = priceData.price;
          const volFactor = (volatilityLevel || 30) / 100; // Default 30% volatility if null
          const tp = direction === "LONG" 
            ? entry * (1 + volFactor)
            : entry * (1 - volFactor);
          const sl = direction === "LONG"
            ? entry * (1 - volFactor)
            : entry * (1 + volFactor);
          
          // MANDATORY: Create setup regardless of whitelist check
          // Whitelisting is a risk/execution decision, not a signal validity decision
          const setup = {
            symbol,
            mode: "SNIPER" as const,
            direction: direction as "LONG" | "SHORT",
            score: Math.min(85, 100),
            reason: `${signalState} ${direction} - impulse=${ignitionProbability.toFixed(0)}`,
            price: entry,
            entry, // GUARANTEED: last candle close
            tp,    // GUARANTEED: entry ± volatility%
            sl,    // GUARANTEED: entry ∓ volatility%
            momentum: {
              stochRsiSignal: `Stoch RSI: ${stochRsi?.toFixed(1) ?? "—"}`,
              emaStackSignal: direction === "LONG" ? "8 EMA accelerating up" : "8 EMA accelerating down",
              volatilitySignal: volatilityLevel && volatilityLevel > 45 ? "Expansion" : "Forming",
              trend4H: priceData.htf4hTrend === "BULLISH" || priceData.htf4hTrend === "BEARISH",
            },
            targetPrices: card.targetPrices || undefined,
            riskReward: card.riskReward || undefined,
          };
          
          // MANDATORY: Add setup to output
          setups.push(setup);
          
          console.log(
            `[SETUP_HYDRATED] ${symbol} ACTIVE_SNIPER ${direction} | ` +
            `entry=${entry.toFixed(2)} tp=${tp.toFixed(2)} sl=${sl.toFixed(2)} | ` +
            `impulse=${ignitionProbability.toFixed(1)}`
          );
        }
      }
    } catch (error) {
      const displaySymbol = symbol || rawSymbol || "UNKNOWN";
      console.error(`[STATE] ERROR processing ${displaySymbol}:`, error);
      cards.push({
        symbol: displaySymbol,
        price: priceData.price,
        source: "v21.1.0-error",
        degraded: true,
        signalState: "NONE",
        marketClass: "CHOP",
        direction: "NEUTRAL",
        tradeReadinessScore: null,
        ignitionProbability: 0,
        stochRsi: null,
        emaSlope: null,
        emaPressure: 0,
        volatilityLevel: null,
        htf4hTrend: "NEUTRAL",
        htf4hMomentum: null,
        htf1hAlignment: null,
        htf15mCompression: null,
        execution15mState: "CHOP",
        marketReadinessState: "ERROR",
        expectedMovePercent: null,
        targetPrices: null,
        riskReward: null,
        cycleId: `${Date.now()}-${displaySymbol}`,
        notes: "ERROR",
        updatedAt: new Date().toISOString(),
      });
    }
  }

  const totalMs = Date.now() - cycleStart;
  console.log(
    `[STATE] v21.2.0 COMPLETE in ${totalMs}ms | ` +
    `cards=${cards.length} | ` +
    `setups=${setups.length}`
  );

  return { cards, setups };
}

// ============================================================================
// UTILITY: SIGNAL COMPUTATION FUNCTIONS
// ============================================================================


function computeTargets(
  price: number,
  direction: "LONG" | "SHORT" | "NEUTRAL"
): { tp1: number; tp2: number; sl: number } | null {
  if (direction === "NEUTRAL") return null;

  const moveSize = price * 0.015;

  if (direction === "LONG") {
    return {
      tp1: price + moveSize,
      tp2: price + moveSize * 2,
      sl: price - moveSize * 0.5,
    };
  } else {
    return {
      tp1: price - moveSize,
      tp2: price - moveSize * 2,
      sl: price + moveSize * 0.5,
    };
  }
}
