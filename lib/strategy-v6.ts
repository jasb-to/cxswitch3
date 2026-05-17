/**
 * SNIPER ENGINE v7.0 - MOMENTUM IGNITION SYSTEM
 * 
 * Converts from structure-based scanner to momentum wave detector
 * Uses Stochastic RSI + EMA Stack + Volatility Compression
 * 
 * NO STATE, NO DB ACCESS, PURE EVALUATION
 */

import type { PriceData } from "./price-router";
import type { SegregatedMarketData } from "./market-data-layer";

// ═════════════════════════════════════════════════════════════════════════════
// v7.6.0: EXECUTION CONTEXT - SINGLE SOURCE OF TRUTH
// ═════════════════════════════════════════════════════════════════════════════
// 
// v7.7.0 CRITICAL FIX: Separate data trust from infrastructure health
// - executionGrade: ONLY based on source (kraken_live or kraken_cached)
// - systemHealth: ONLY based on infrastructure state
// - NEVER conflate these - they are orthogonal concerns
//
export type ExecutionContext = {
  // Identifier
  symbol: string;
  cycleId: string;

  // DATA TRUST (never changes per cycle, ONLY based on source)
  executionGrade: boolean;  // true if source is kraken_live or kraken_cached
  dataSource: "KRAKEN" | "COINGECKO";

  // SYSTEM HEALTH (infrastructure state, independent from data trust)
  systemHealth: "LIVE" | "DEGRADED" | "OFFLINE";
  systemHealthReason?: string;

  // Market snapshot (immutable for cycle)
  price: number;
  timestamp: number;
};

/**
 * Build execution context at scan entry point
 * v7.7.0: CORRECTLY SEPARATE data trust from system health
 * 
 * executionAllowed = ONLY based on DATA SOURCE
 * (does NOT depend on system health)
 */
function buildExecutionContext(symbol: string, priceData: PriceData): ExecutionContext {
  // DATA TRUST: Based ONLY on source
  const isKrakenSource = priceData.source === "kraken_live" || priceData.source === "kraken_cached";
  
  const ctx: ExecutionContext = {
    symbol,
    cycleId: `${Date.now()}-${symbol}`,
    
    // DATA TRUST: execution-grade if Kraken source (cached OR live)
    executionGrade: isKrakenSource,
    dataSource: isKrakenSource ? "KRAKEN" : "COINGECKO",
    
    // SYSTEM HEALTH: independent from data trust
    systemHealth: priceData.health,
    systemHealthReason: priceData.health === "LIVE" ? undefined : `System health: ${priceData.health}`,
    
    price: priceData.price,
    timestamp: Date.now(),
  };

  // Log the distinction clearly
  if (!ctx.executionGrade) {
    console.log(`[GATE] ${symbol} BLOCKED (data trust): source=${priceData.source}`);
  } else if (ctx.systemHealth !== "LIVE") {
    console.log(`[GATE] ${symbol} ALLOWED (execution-grade) but DEGRADED (system): ${ctx.systemHealthReason}`);
  }

  return ctx;
}

// ═════════════════════════════════════════════════════════════════════════════
// v8.5: BREAKOUT-AWARE DIRECTION INFERENCE (STRUCTURE-FIRST)
// ═════════════════════════════════════════════════════════════════════════════
// 
// CRITICAL FIX: SNIPER was momentum-first, triggering contradictory SHORT signals
// during bullish breakout retests. Now detects breakout states and prevents
// direction finalization until structural confirmation is complete.
//
// Breakout State Machine:
// NONE → BREAKOUT_UP → RETEST_PHASE → NONE (or confirm LONG) OR return to NONE
// NONE → BREAKOUT_DOWN → RETEST_PHASE → NONE (or confirm SHORT) OR return to NONE

type BreakoutState = "NONE" | "BREAKOUT_UP" | "BREAKOUT_DOWN" | "RETEST_PHASE";

interface LevelAwareness {
  recentHigh: number;        // Recent swing high (20-period reference)
  recentLow: number;         // Recent swing low (20-period reference)
  breakoutState: BreakoutState;
  breakoutPrice: number | null;
  breakoutTime?: number;
  priceAboveHigh: boolean;   // Price is above recentHigh
  priceBelowLow: boolean;    // Price is below recentLow
}

/**
 * Compute level awareness from recent price action
 * Tracks breakout states to prevent contradictory signals
 */
function computeLevelAwareness(
  price: number,
  priceHistory: number[] | null,
  previousBreakoutState: BreakoutState
): LevelAwareness {
  // Default to recent price as reference if no history
  const recentHigh = priceHistory && priceHistory.length >= 10 
    ? Math.max(...priceHistory.slice(-20))
    : price * 1.01;  // Assume 1% above current
    
  const recentLow = priceHistory && priceHistory.length >= 10
    ? Math.min(...priceHistory.slice(-20))
    : price * 0.99;  // Assume 1% below current

  const priceAboveHigh = price > recentHigh;
  const priceBelowLow = price < recentLow;

  // Detect state transitions
  let breakoutState = previousBreakoutState;
  let breakoutPrice: number | null = null;

  if (previousBreakoutState === "NONE") {
    // Detect new breakout
    if (priceAboveHigh) {
      breakoutState = "BREAKOUT_UP";
      breakoutPrice = recentHigh;
    } else if (priceBelowLow) {
      breakoutState = "BREAKOUT_DOWN";
      breakoutPrice = recentLow;
    }
  } else if (previousBreakoutState === "BREAKOUT_UP") {
    // In breakout-up phase, check for retest or failure
    if (price < recentHigh * 0.98) {
      // Price pulled back - now in retest phase
      breakoutState = "RETEST_PHASE";
    }
  } else if (previousBreakoutState === "BREAKOUT_DOWN") {
    // In breakout-down phase, check for retest or failure
    if (price > recentLow * 1.02) {
      // Price bounced back - now in retest phase
      breakoutState = "RETEST_PHASE";
    }
  } else if (previousBreakoutState === "RETEST_PHASE") {
    // In retest phase, price can either re-establish breakout or fail
    if (priceAboveHigh) {
      // Retest passed above high - confirm breakout
      breakoutState = "NONE";
    } else if (priceBelowLow) {
      // Retest passed below low - confirm breakout
      breakoutState = "NONE";
    }
    // Otherwise stay in RETEST_PHASE
  }

  return {
    recentHigh,
    recentLow,
    breakoutState,
    breakoutPrice,
    priceAboveHigh,
    priceBelowLow,
  };
}

/**
 * Validate direction against breakout state
 * Prevents contradictory signals during breakout phases
 * 
 * Example: During bullish breakout, suppress SHORT signals
 */
function validateDirectionAgainstBreakout(
  proposedDirection: "LONG" | "SHORT" | "NEUTRAL",
  levelAwareness: LevelAwareness
): "LONG" | "SHORT" | "NEUTRAL" | "WATCH_BREAKOUT" {
  const { breakoutState, priceAboveHigh, priceBelowLow } = levelAwareness;

  // If in retest phase of a breakout, hold direction
  if (breakoutState === "RETEST_PHASE") {
    return "WATCH_BREAKOUT";  // Don't commit to direction yet
  }

  // If breakout-up active, block SHORT signals
  if (breakoutState === "BREAKOUT_UP" && proposedDirection === "SHORT") {
    return "WATCH_BREAKOUT";  // Don't allow SHORT during bullish breakout
  }

  // If breakout-down active, block LONG signals
  if (breakoutState === "BREAKOUT_DOWN" && proposedDirection === "LONG") {
    return "WATCH_BREAKOUT";  // Don't allow LONG during bearish breakout
  }

  return proposedDirection;
}

// ═════════════════════════════════════════════════════════════════════════════
// v9: STRUCTURE STATE SYSTEM (CORE LAYER - STRUCTURE-FIRST)
// ═════════════════════════════════════════════════════════════════════════════
//
// CRITICAL PRINCIPLE: Structure determines direction BEFORE momentum evaluation
// Momentum never overrides structure - only affects confidence
//
// State Machine:
// RANGE → BREAKOUT_UP/DOWN → RETEST_UP/DOWN → TREND_CONTINUATION
//                          ↘ FAILED_BREAKOUT ↙

type StructureState = 
  | "RANGE"                 // No clear structure, swinging within high/low
  | "BREAKOUT_UP"           // Price breaks above swing high
  | "BREAKOUT_DOWN"         // Price breaks below swing low
  | "RETEST_UP"             // Pullback within breakout-up, retest zone
  | "RETEST_DOWN"           // Bounce within breakout-down, retest zone
  | "FAILED_BREAKOUT"       // Breakout failed, reversal
  | "TREND_CONTINUATION";   // Retest passed, trend confirmed

/**
 * Compute structure state from price action and history
 * Returns deterministic structure classification
 */
function computeStructureState(
  price: number,
  prevStructureState: StructureState,
  swingHigh: number,
  swingLow: number,
  breakoutLevel: number | null
): StructureState {
  // A. RANGE DETECTION (no clear breakout)
  if (!swingHigh || !swingLow || swingHigh <= swingLow) {
    return "RANGE";
  }

  // B. BREAKOUT DETECTION (structure creation)
  if (price > swingHigh * 1.005) {  // 0.5% buffer to avoid noise
    return "BREAKOUT_UP";
  }
  if (price < swingLow * 0.995) {   // 0.5% buffer to avoid noise
    return "BREAKOUT_DOWN";
  }

  // C. RETEST LOGIC (CRITICAL - locked direction)
  if (prevStructureState === "BREAKOUT_UP" && breakoutLevel) {
    // Price pulled back to retest zone
    if (price <= breakoutLevel * 0.99) {  // Within 1% of breakout
      return "RETEST_UP";
    }
  }

  if (prevStructureState === "BREAKOUT_DOWN" && breakoutLevel) {
    // Price bounced to retest zone
    if (price >= breakoutLevel * 1.01) {  // Within 1% of breakout
      return "RETEST_DOWN";
    }
  }

  // D. FAILURE CONDITIONS (no signal if structure breaks)
  if (prevStructureState === "BREAKOUT_UP" && price < swingLow) {
    return "FAILED_BREAKOUT";  // Bullish breakout failed
  }

  if (prevStructureState === "BREAKOUT_DOWN" && price > swingHigh) {
    return "FAILED_BREAKOUT";  // Bearish breakout failed
  }

  // E. CONTINUATION (retest passed, trend continuing)
  if (prevStructureState === "RETEST_UP" && price > (breakoutLevel || swingHigh)) {
    return "TREND_CONTINUATION";
  }

  if (prevStructureState === "RETEST_DOWN" && price < (breakoutLevel || swingLow)) {
    return "TREND_CONTINUATION";
  }

  // Default: maintain state
  return prevStructureState;
}

/**
 * Get direction from structure state (HARD LOCK - structure overrides momentum)
 * Returns direction forced by structure, or NEUTRAL if in RANGE
 */
function getDirectionFromStructure(
  structureState: StructureState,
  momentumEmaSlope: number | null
): "LONG" | "SHORT" | "NEUTRAL" {
  // HARD STRUCTURE LOCKS (direction cannot violate these)
  if (structureState === "RETEST_UP" || structureState === "BREAKOUT_UP") {
    return "LONG";  // Structure-locked LONG
  }

  if (structureState === "RETEST_DOWN" || structureState === "BREAKOUT_DOWN") {
    return "SHORT";  // Structure-locked SHORT
  }

  // RANGE: use momentum to break tie
  if (structureState === "RANGE") {
    if (momentumEmaSlope !== null && momentumEmaSlope > 0.2) {
      return "LONG";   // EMA bullish
    }
    if (momentumEmaSlope !== null && momentumEmaSlope < -0.2) {
      return "SHORT";  // EMA bearish
    }
    return "NEUTRAL";  // No clear structure or momentum
  }

  // FAILED_BREAKOUT or TREND_CONTINUATION: use momentum
  if (momentumEmaSlope !== null && momentumEmaSlope > 0.1) {
    return "LONG";
  }
  if (momentumEmaSlope !== null && momentumEmaSlope < -0.1) {
    return "SHORT";
  }

  return "NEUTRAL";
}

/**
 * Validate direction against structure - HARD BLOCKS for contradictions
 * Used by SNIPER entry gate to prevent impossible trades
 */
function validateDirectionVsStructure(
  proposedDirection: "LONG" | "SHORT" | "NEUTRAL",
  structureState: StructureState
): boolean {
  // HARD BLOCKS (these trades are impossible)
  if (structureState === "RETEST_UP" && proposedDirection === "SHORT") {
    return false;  // Cannot SHORT during bullish retest
  }

  if (structureState === "RETEST_DOWN" && proposedDirection === "LONG") {
    return false;  // Cannot LONG during bearish retest
  }

  if (structureState === "FAILED_BREAKOUT") {
    return false;  // No trades during failed breakout
  }

  if (structureState === "RANGE" && proposedDirection === "NEUTRAL") {
    return false;  // No neutral signals
  }

  return true;  // Direction valid for this structure
}

// FIX #1: Unified signal state (v7.2.6) - REMOVED SNIPER_IMMINENT (regression leak)
// v7.4.0: Clean state machine - only 3 valid states for signal generation
// v8.5: Added WATCH_BREAKOUT for structure-first breakout detection
// v9: Added structure-first direction locking
export type SignalState = 
  | "NONE"              // No signal
  | "BUILDING"          // Directional bias + compression, waiting for ignition
  | "SNIPER_READY"      // All SNIPER conditions passed, awaiting entry confirmation
  | "CONFIRMED_READY"   // All CONFIRMED conditions passed, awaiting confirmation
  | "ACTIVE_SNIPER"     // SNIPER signal active, trade window open (30 min cooldown)
  | "ACTIVE_CONFIRMED"  // CONFIRMED signal active, trend confirmation (90 min cooldown) - INTERNAL ONLY
  | "WATCH_BREAKOUT";   // Breakout detected, holding direction until retest confirmation

export type SymbolCardState = {
  symbol: string;
  price: number;
  source: string;
  degraded: boolean;

  direction: "LONG" | "SHORT" | "NEUTRAL";
  mode: "SNIPER" | "CONFIRMED" | "NONE";
  confidence: number;
  
  // FIX #1: Unified signal state (v7.2.6), extended for v7.2.8, standardized for v7.2.9
  // v8.5: Added WATCH_BREAKOUT state for structure-first awareness
  signalState: SignalState;
  lastSignalTime?: number;

  // Momentum indicators (5M)
  stochRsi: number | null;
  emaSlope: number | null;
  volatilityLevel: number | null;

  // v8.5: Breakout awareness (structure-first)
  breakoutState?: BreakoutState;
  recentHigh?: number;
  recentLow?: number;

  // v9: Structure state system (core layer - structure-first)
  structureState: StructureState;
  swingHigh: number;
  swingLow: number;
  breakoutLevel: number | null;
  structureTimeframe: number;  // ms since last structure state change
  lastStructureUpdate: number; // timestamp

  // Higher TimeFrame alignment (v7.1.1 - SIMPLIFIED FOR v7.2.10)
  // v7.2.10: Remove 1H dependency, use 15M execution structure instead
  htf4hTrend: "BULLISH" | "BEARISH" | "NEUTRAL";
  htf4hMomentum: number | null;
  htf1hAlignment: boolean | null; // Deprecated v7.2.10, kept only for signal logic
  htf15mCompression: boolean | null;
  
  // v7.2.10 FIX #1 & #2: 15M EXECUTION STRUCTURE (replaces 1H display)
  // Shows entry readiness based on 15M structure + volatility state
  execution15mState: "COMPRESSING" | "BREAKOUT_READY" | "EXPANDING" | "CHOP";

  // Market readiness engine (v7.2.1)
  marketReadinessState: string;
  tradeReadinessScore: number | null;
  
  // Conditional: Only populate if mode === "SNIPER" or "CONFIRMED"
  expectedMovePercent: { sniper: { min: number; max: number } } | null;
  targetPrices: { tp1: number; tp2: number; sl: number } | null;
  riskReward: number | null;

  // Trend memory (v7.2.5)
  lastBullishCycle?: number;
  lastBearishCycle?: number;
  trendMemory?: "BULLISH" | "BEARISH";

  cycleId: string;  // Unique identifier for this signal cycle
  notes: string;
  updatedAt: string;
};

export type Setup = {
  symbol: string;
  mode: "SNIPER" | "CONFIRMED";
  direction: "LONG" | "SHORT"; // NO NEUTRAL ALLOWED
  score: number;
  reason: string;
  price: number;
  // Momentum signal breakdown
  momentum: {
    stochRsiSignal: string;
    emaStackSignal: string;
    volatilitySignal: string;
    trend4H: boolean;
  };
  // HTF Alignment breakdown (v7.1.1)
  htf: {
    trend4h: "BULLISH" | "BEARISH";
    alignment1h: boolean;
    compression15m: boolean;
    trigger5m: string;
  };
};

/**
 * Generate symbol card states + setups from EXECUTION PIPELINE ONLY
 * v8.0: HARD PIPELINE SEGREGATION
 * 
 * This function ONLY receives Kraken data (already segregated at ingestion).
 * No gating needed - separation happened upstream in market-data-layer.
 * PURE FUNCTION - momentum-based detection
 */
export async function generateSetups(segregatedMarkets: SegregatedMarketData): Promise<{ cards: SymbolCardState[]; setups: Setup[] }> {
  const cards: SymbolCardState[] = [];
  const setups: Setup[] = [];

  // ===== v8.0: EXECUTION PIPELINE ONLY =====
  // segregatedMarkets.execution contains ONLY Kraken data
  // No fallback data participates in this loop
  for (const [symbol, priceData] of Object.entries(segregatedMarkets.execution)) {
    if (priceData.price === 0) {
      console.log(`[SCAN] ${symbol} no data`);
      continue;
    }

    // Build execution context (guaranteed execution-grade - Kraken only)
    const ctx = buildExecutionContext(symbol, priceData);
    
    // Generate card for scan
    const card = generateCardState(symbol, priceData);
    card.cycleId = ctx.cycleId;
    cards.push(card);

    // Score using momentum system
    const score = calculateMomentumScore(card);
    
    console.log(`[SCAN] ${symbol} score=${score} direction=${card.direction} stoch=${card.stochRsi?.toFixed(1) ?? "—"} emaSlope=${card.emaSlope?.toFixed(2) ?? "—"}`);

    // ONLY generate setups with directional conviction
    // SNIPER v21.1.0: Single signal mode (CONFIRMED path deleted)
    // SNIPER ALERT: score >= 70 AND sniper conditions met
    if (score >= 70 && card.direction !== "NEUTRAL" && checkSniperConditions(card)) {
      // v7.3.1 FIX #1: Validate ACTIVE_SNIPER execution requirements
      const executionValidation = validateActiveSniperExecution(card, score);
      
      if (!executionValidation.valid) {
        // Execution validation failed - block ACTIVE_SNIPER
        console.log(`[EXECUTION BLOCKED] ${symbol} ${card.direction}: ${executionValidation.reason}`);
        // Fall through to non-alert state calculation below
        card.signalState = "SNIPER_READY";  // FIX: Remove SNIPER_IMMINENT, use SNIPER_READY
      } else {
        // Execution validation passed - promote to ACTIVE_SNIPER (TERMINAL STATE)
        card.mode = "SNIPER";
        card.confidence = Math.min(score, 99);
        card.lastSignalTime = Date.now();
        card.signalState = "ACTIVE_SNIPER"; // v9 PHASE 5: Terminal state - immutable once set
        card.notes = `SNIPER ${card.direction} execution early-entry ${score}`;
        
        // Populate trade targets (v7.2.1)
        const targets = calculateTradeTargets(card.price, card.volatilityLevel ?? 50, card.direction);
        card.expectedMovePercent = targets.expectedMovePercent;
        card.targetPrices = targets.targetPrices;
        card.riskReward = targets.riskReward;
        card.tradeReadinessScore = calculateTradeReadinessScore("SNIPER", card.direction, card.htf4hTrend, card.htf1hAlignment, card.emaSlope, card.stochRsi, card.volatilityLevel);
        
        setups.push({
          symbol,
          mode: "SNIPER",
          direction: card.direction,
          score: card.confidence,
          reason: `SNIPER ${card.direction} - HTF:${card.htf4hTrend} + 15M:${card.execution15mState} + 5M trigger`,
          price: card.price,
          momentum: {
            stochRsiSignal: `Stoch RSI: ${card.stochRsi?.toFixed(1) ?? "—"}`,
            emaStackSignal: card.direction === "LONG" ? "8 EMA turning up" : "8 EMA turning down",
            volatilitySignal: (card.volatilityLevel ?? 40) < 40 ? "Compression active" : "Normal",
            trend4H: card.htf4hTrend !== "NEUTRAL",
          },
          // HTF Breakdown for Telegram alerts (v7.3.1: only populated if execution valid)
          htf: {
            trend4h: card.htf4hTrend as "BULLISH" | "BEARISH",
            alignment1h: card.htf1hAlignment ?? false,
            compression15m: card.htf15mCompression ?? false,
            trigger5m: (card.stochRsi ?? 50) > 20 && (card.stochRsi ?? 50) < 80 ? "Stoch RSI cross" : "EMA flip",
          },
        });
        console.log(`[EXECUTION] ${symbol} ACTIVE_SNIPER ${card.direction} score=${score} | 4H:${card.htf4hTrend} 15M:${card.execution15mState}`);
      }
    }
    else {
      // No SNIPER conditions met - stay in BUILDING state
      card.signalState = "BUILDING";
      console.log(`[BUILDING] ${symbol} score=${score} - awaiting ignition trigger`);
    }

    // v9 PHASE 5: ACTIVE_SNIPER TERMINAL STATE IMMUTABILITY
    // Once impulse >= 27 AND ACTIVE_SNIPER state assigned, it becomes immutable
    // No downgrades, no state changes, no mutations after terminal state assignment
    // This ensures alert system always receives consistent ACTIVE_SNIPER state
    if (card.signalState === "ACTIVE_SNIPER" && card.lastSignalTime) {
      // Mark as terminal - prevent any downstream modifications
      // Alert worker must treat ACTIVE_SNIPER as final
      (card as any)._terminalState = true;
      console.log(`[TERMINAL] ${symbol} ACTIVE_SNIPER immutable lock (impulse=${score})`);
    }
  }

  return { cards, setups };
}

/**
 * Generate display cards from DISPLAY PIPELINE ONLY
 * v8.0: HARD PIPELINE SEGREGATION
 * 
 * This function receives fallback/degraded data (CoinGecko).
 * These cards are DISPLAY_ONLY - no signals, no execution.
 * NEVER enters scan engine, NEVER builds ExecutionContext.
 */
export function generateDisplayCards(displayMarkets: Record<string, PriceData>): SymbolCardState[] {
  const displayCards: SymbolCardState[] = [];

  // ===== DISPLAY PIPELINE ONLY =====
  // displayMarkets contains fallback data (CoinGecko only)
  // These are for UI display, never for trading
  for (const [symbol, priceData] of Object.entries(displayMarkets)) {
    if (priceData.price === 0) {
      continue;  // Skip if no price
    }

    // Create display-only card (NEUTRAL, no signals possible)
    const displayCard: SymbolCardState = {
      symbol,
      price: priceData.price,
      source: priceData.source,
      degraded: true,
      signalState: "BUILDING",  // Display only, no execution
      mode: "NONE",
      confidence: 0,
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
      marketReadinessState: "DISPLAY_ONLY",
      expectedMovePercent: null,
      targetPrices: null,
      riskReward: null,
      cycleId: `${Date.now()}-${symbol}-display`,
      notes: `Display only (${priceData.source})`,
      updatedAt: new Date().toISOString(),
    };

    displayCards.push(displayCard);
    console.log(`[DISPLAY] ${symbol} from ${priceData.source} (display only)`);
  }

  return displayCards;
}

/**
 * NEW SCORING SYSTEM (v7.0)
 * 
 * +25 → 4H trend alignment
 * +20 → EMA stack alignment (8/21 slope or cross)
 * +20 → Stoch RSI momentum shift
 * +20 → volatility compression present
 * +15 → impulse candle detected
 * 
 * RANGE: 0-100
 * SNIPER: ≥60
 * CONFIRMED: ≥75
 */
function calculateMomentumScore(card: SymbolCardState): number {
  // BASE SCORE - foundation for all signals
  let score = 30;

  // EVENT MULTIPLIERS (not additive)
  let multiplier = 1.0;

  // EVENT 1: Stoch RSI cross detected
  // Range: 0-100, active zone: 20-80
  const stochRsiActive = card.stochRsi > 20 && card.stochRsi < 80;
  if (stochRsiActive) {
    multiplier *= 1.25; // Stoch RSI event multiplier
  }

  // EVENT 2: EMA 8/21 flip detected
  // Strong slope indicates alignment
  const emaFlipped = Math.abs(card.emaSlope) > 0.5;
  if (emaFlipped) {
    multiplier *= 1.35; // EMA flip multiplier (highest impact)
  }

  // EVENT 3: Volatility compression present
  // BB squeeze or ATR contraction
  const volatilityCompression = card.volatilityLevel < 30;
  if (volatilityCompression) {
    multiplier *= 1.20; // Compression multiplier
  }

  // EVENT 4: Impulse candle (direction conviction)
  if (card.direction !== "NEUTRAL") {
    multiplier *= 1.30; // Impulse multiplier
  }

  // EVENT 5: 4H trend alignment
  // Trend bias from higher timeframe
  const trend4HAligned = card.stochRsi > 50; // Simplified: would use actual 4H data
  if (trend4HAligned) {
    multiplier *= 1.40; // HTF trend multiplier (critical for CONFIRMED)
  }

  // Apply multiplier
  score = Math.round(score * multiplier);

  // SEPARATION BOOST: Prevent score clustering
  // Strong momentum flips break away from 40-45 cluster
  if (emaFlipped && stochRsiActive) {
    score *= 1.2; // Momentum flip detected
  }

  // Strong squeeze + impulse creates separation
  if (volatilityCompression && card.direction !== "NEUTRAL") {
    score *= 1.15; // Volatility squeeze strong
  }

  return Math.min(score, 99); // Cap at 99
}

/**
 * Calculate live market readiness state (v7.2.1)
 * Derives from: HTF alignment, EMA slope, Stoch velocity, compression, impulse
 */
function calculateMarketReadinessState(
  htf4hTrend: string,
  htf1hAlignment: boolean | null,
  emaSlope: number | null,
  stochRsi: number | null,
  volatilityLevel: number | null,
  direction: string
): "BUILDING_PRESSURE" | "BULLISH_IGNITION" | "BEARISH_IGNITION" | "TREND_EXPANSION" | "OVEREXTENDED" | "CHOP_NO_TRADE" | "AWAITING_DATA" {
  // No data = awaiting
  if (stochRsi === null || emaSlope === null || volatilityLevel === null) {
    return "AWAITING_DATA";
  }

  // CHOP_NO_TRADE: No HTF direction + neutral momentum
  if (htf4hTrend === "NEUTRAL" && stochRsi > 40 && stochRsi < 60) {
    return "CHOP_NO_TRADE";
  }

  // BUILDING_PRESSURE: Low volatility + aligned HTF + EMA expansion
  if (volatilityLevel < 35 && htf4hTrend !== "NEUTRAL" && Math.abs(emaSlope) > 0.2) {
    return "BUILDING_PRESSURE";
  }

  // BULLISH_IGNITION: HTF bullish + 1H confirms + Stoch cross up + compression release
  if (htf4hTrend === "BULLISH" && htf1hAlignment && stochRsi > 45 && stochRsi < 65 && volatilityLevel < 50) {
    return "BULLISH_IGNITION";
  }

  // BEARISH_IGNITION: HTF bearish + 1H confirms + Stoch cross down + compression release
  if (htf4hTrend === "BEARISH" && htf1hAlignment && stochRsi > 35 && stochRsi < 55 && volatilityLevel < 50) {
    return "BEARISH_IGNITION";
  }

  // TREND_EXPANSION: High volatility + momentum aligned + HTF agrees
  if (volatilityLevel > 50 && htf4hTrend !== "NEUTRAL" && (stochRsi > 60 || stochRsi < 40)) {
    return "TREND_EXPANSION";
  }

  // OVEREXTENDED: Very high volatility + extreme Stoch + divergence risk
  if (volatilityLevel > 70 && (stochRsi > 80 || stochRsi < 20)) {
    return "OVEREXTENDED";
  }

  return "AWAITING_DATA";
}

/**
 * Calculate trade readiness score (v8.0 FIX: SNIPER macro penalty as modifier only)
 * Readiness MUST follow direction
 * 
 * v8.0 CRITICAL: Macro penalty applied LAST, never used as blocker
 * - SNIPER trades contra-4H are allowed (reduced score only)
 * - Macro trend acts as confidence modifier, NOT gating function
 * 
 * IF direction bullish AND momentum exists: minimum 45-55
 * IF compression + ignition: 60-75
 * IF HTF aligned + continuation: 75-90
 * NEVER allow: NEUTRAL + 40% readiness (contradictory UX)
 * 
 * v8.0 Score application order (CRITICAL):
 * 1. Base impulse score (direction + compression + momentum)
 * 2. Add compression weight
 * 3. Add displacement/EMA weight
 * 4. Add 15M momentum weight
 * 5. Add micro-structure weight
 * 6. LAST: Macro penalty (final adjustment ONLY, never blocker)
 * 
 * Bands:
 * <40 = dead market
 * 40-55 = building momentum
 * 55-70 = ignition watch
 * 70-85 = sniper ready
 * 85+ = confirmed trend
 */
function calculateTradeReadinessScore(
  mode: string,
  direction: string,
  htf4hTrend: string,
  htf1hAlignment: boolean | null,
  emaSlope: number | null,
  stochRsi: number | null,
  volatilityLevel: number | null
): number | null {
  // If no data available, return null
  if (stochRsi === null || emaSlope === null || volatilityLevel === null) {
    return null;
  }

  // FIX #5: If NEUTRAL direction, score should be NULL or minimal
  if (direction === "NEUTRAL") {
    return null; // No readiness if no direction
  }

  // v8.0: If direction exists (LONG or SHORT), minimum 45-55 baseline
  let score = 45;

  // +10 compression (low volatility = energy buildup)
  if (volatilityLevel < 40) score += 10;

  // +15 momentum in direction (Stoch aligned with direction)
  if (direction === "LONG" && stochRsi > 50) score += 15;
  if (direction === "SHORT" && stochRsi < 50) score += 15;

  // +15 EMA expansion (established slope)
  if (emaSlope !== null && Math.abs(emaSlope) > 0.4) score += 15;

  // v8.0 FIX: Macro penalty applied LAST (never blocker)
  // +10 HTF alignment (confidence boost, NOT requirement for SNIPER)
  // -5 HTF misalignment (probability reduction, still allows entry)
  if (htf4hTrend !== "NEUTRAL") {
    const directionMatchesMacro =
      (direction === "LONG" && htf4hTrend === "BULLISH") ||
      (direction === "SHORT" && htf4hTrend === "BEARISH");
    
    if (directionMatchesMacro) {
      score += 10; // Aligned with macro = higher confidence
    } else {
      score -= 5;  // Against macro = small penalty (NOT blocker)
    }
  }

  // +10 impulse confirmation (if signal mode exists)
  if (mode === "SNIPER" || mode === "CONFIRMED") score += 10;

  return Math.min(score, 100);
}

/**
 * Calculate trade targets only when signal fired (v7.2.5: FIX TP3 removal)
 */
function calculateTradeTargets(price: number, volatilityLevel: number, direction: string) {
  const volatilityFactor = volatilityLevel / 100;
  const sniperMin = 0.8 + volatilityFactor * 0.5;
  const sniperMax = 1.5 + volatilityFactor * 0.7;
  
  const isLong = direction === "LONG";
  const tp1 = price * (1 + (isLong ? sniperMax : -sniperMax) / 100);
  const tp2 = price * (1 + (isLong ? sniperMax * 1.5 : -sniperMax * 1.5) / 100);
  const sl = price * (1 + (isLong ? -sniperMax : sniperMax) / 100);
  const riskReward = (sniperMax * 1.5) / sniperMax;
  
  return {
    expectedMovePercent: { sniper: { min: sniperMin, max: sniperMax } },
    targetPrices: { tp1, tp2, sl },
    riskReward,
  };
}

/**
 * Calculate live dashboard state (v7.2.4 FIX #4)
 * NEVER show: NEUTRAL, AWAITING DATA, NO TRADE if prices exist
 * Instead show: BULLISH BUILDING, BEARISH IGNITION, TREND EXPANSION, etc.
 */
function calculateLiveMarketState(
  direction: string,
  emaSlope: number | null,
  stochRsi: number | null,
  volatilityLevel: number | null
): string {
  // If real prices exist, NEVER show generic states
  if (direction === "LONG") {
    if (volatilityLevel !== null && volatilityLevel < 40) return "BULLISH BUILDING";
    if (emaSlope !== null && emaSlope > 0.5) return "BULLISH IGNITION";
    if (volatilityLevel !== null && volatilityLevel > 60) return "BULLISH EXPANSION";
    if (stochRsi !== null && stochRsi > 80) return "BULLISH OVEREXTENDED";
    return "BULLISH MOMENTUM";
  }
  
  if (direction === "SHORT") {
    if (volatilityLevel !== null && volatilityLevel < 40) return "BEARISH BUILDING";
    if (emaSlope !== null && emaSlope < -0.5) return "BEARISH IGNITION";
    if (volatilityLevel !== null && volatilityLevel > 60) return "BEARISH EXPANSION";
    if (stochRsi !== null && stochRsi < 20) return "BEARISH OVEREXTENDED";
    return "BEARISH MOMENTUM";
  }
  
  // NEUTRAL but show structure if present
  if (emaSlope !== null && Math.abs(emaSlope) < 0.2) return "CHOPPY";
  if (volatilityLevel !== null && volatilityLevel < 30) return "BUILDING PRESSURE";
  if (stochRsi !== null && (stochRsi > 75 || stochRsi < 25)) return "EXTREME READS";
  
  return "NEUTRAL";
}

/**
 * Check if cooldown has elapsed (v7.2.6 FIX #6)
 * SNIPER cooldown: 30 minutes
 * CONFIRMED cooldown: 90 minutes
 */
function isCooldownElapsed(lastSignalTime: number | undefined, mode: "SNIPER" | "CONFIRMED"): boolean {
  if (!lastSignalTime) return true; // No previous signal
  
  const now = Date.now();
  const cooldownMs = mode === "SNIPER" ? 30 * 60 * 1000 : 90 * 60 * 1000;
  
  return (now - lastSignalTime) >= cooldownMs;
}

/**
 * Calculate unified signal state (v7.2.6 FIX #1, extended for v7.2.8)
 * Returns: NONE | BUILDING | SNIPER_READY | CONFIRMED_READY | ACTIVE_SNIPER | ACTIVE_CONFIRMED
 * NOTE: SNIPER_IMMINENT removed per LOCK rules (only BUILDING | SNIPER | CONFIRMED in UI)
 * 
 * FIX #4: Proper evaluation order:
 * 1. HTF trend
 * 2. Direction
 * 3. Compression OR expansion
 * 4. Score filter
 * 5. Signal state assignment
 */
function calculateSignalState(
  mode: "SNIPER" | "CONFIRMED" | "NONE",
  score: number,
  direction: string,
  htf4hTrend: string,
  sniperPassed: boolean,
  sniperImminentPassed: boolean,  // Deprecated: will be ignored
  confirmedPassed: boolean,
  lastSignalTime: number | undefined,
  lastMode: "SNIPER" | "CONFIRMED" | "NONE"
): SignalState {
  // CONFIRMED: Highest priority (v7.2.8)
  if (confirmedPassed && score >= 75) {
    if (lastMode === "CONFIRMED" && !isCooldownElapsed(lastSignalTime, "CONFIRMED")) {
      return "ACTIVE_CONFIRMED"; // Still in active window
    }
    return "CONFIRMED_READY"; // New CONFIRMED setup ready
  }
  
  // SNIPER ACTIVE: Within cooldown window (v7.2.8)
  if (lastMode === "SNIPER" && !isCooldownElapsed(lastSignalTime, "SNIPER")) {
    return "ACTIVE_SNIPER"; // Still in active window
  }
  
  // SNIPER READY: Full conditions met, no cooldown (v7.2.8)
  if (sniperPassed && score >= 60 && !confirmedPassed) {
    return "SNIPER_READY";
  }
  
  // BUILDING: Has directional bias but not ready for signals
  if (direction !== "NEUTRAL" && score >= 40) {
    return "BUILDING";
  }
  
  // No signal
  return "NONE";
}

/**
 * v8.0 FIX: SNIPER = EARLY IMPULSE DETECTION (NOT macro-aligned confirmation)
 * 
 * CRITICAL CHANGE: SNIPER must catch trades BEFORE full macro alignment
 * Macro trend is ONLY a probability modifier, NEVER a blocker
 * 
 * Previous bug: Blocking SNIPER if 4H neutral or direction diverges from 4H
 * Result: SNIPER behaved like CONFIRMED (trend-following system)
 * 
 * New behavior: SNIPER allows early entries based on compression/breakout impulse
 * Macro alignment only adjusts confidence, never gates entry
 * 
 * SNIPER Entry Requirements (EARLY MODE):
 * ✓ Compression detected OR early displacement OR EMA acceleration
 * ✓ Any of: 15M breakout attempt, liquidity sweep, rejection wick
 * ✓ Score >= 65-72 depending on asset
 * ✓ Does NOT require: 4H alignment, macro agreement
 * ✓ Allowed vs contra 4H: Still valid, reduced score only
 * 
 * Requirements (ALL must be true):
 * 1. Valid 5M ignition trigger (Stoch + EMA)
 * 2. Compression or early displacement detected
 * 3. Score >= 70 (execution-grade momentum)
 * 4. Direction has directional conviction (not NEUTRAL)
 * 
 * NO LONGER required:
 * ✗ 4H trend alignment (was hard blocker at line 673)
 * ✗ Direction matches HTF (was hard blocker at line 708-717)
 * 
 * Returns: { valid: boolean, reason?: string }
 */
function validateActiveSniperExecution(card: SymbolCardState, score: number): { valid: boolean; reason?: string } {
  // REQUIREMENT 1: Must have valid 5M ignition trigger
  const has5MTrigger = 
    (card.stochRsi !== null && card.stochRsi > 20 && card.stochRsi < 80) &&
    card.emaSlope !== null && Math.abs(card.emaSlope) > 0.2;
  
  if (!has5MTrigger) {
    return {
      valid: false,
      reason: `5M trigger not formed (Stoch=${card.stochRsi?.toFixed(1) ?? "null"}, EMA slope=${card.emaSlope?.toFixed(3) ?? "null"})`
    };
  }

  // REQUIREMENT 2: Compression or early displacement must exist
  const compressionExists = card.htf15mCompression === true;
  const emaExpanding = card.emaSlope !== null && Math.abs(card.emaSlope) > 0.4;
  const volatilityBreakout = (card.volatilityLevel ?? 50) > 50;
  const energyBuilding = (card.volatilityLevel ?? 50) <= 45;
  
  const compressionOrExpansion = compressionExists || emaExpanding || volatilityBreakout || energyBuilding;
  
  if (!compressionOrExpansion) {
    return {
      valid: false,
      reason: `No compression/expansion (compression=${compressionExists}, EMA expanding=${emaExpanding}, vol=${card.volatilityLevel})`
    };
  }

  // REQUIREMENT 3: Score must be execution-grade (>= 70)
  if (score < 70) {
    return {
      valid: false,
      reason: `Score ${score} below execution threshold (70)`
    };
  }

  // REQUIREMENT 4: Must have directional conviction
  if (card.direction === "NEUTRAL") {
    return {
      valid: false,
      reason: `No directional conviction (NEUTRAL)`
    };
  }

  // ✅ ALL REQUIREMENTS MET: Valid ACTIVE_SNIPER execution
  // NOTE: Macro trend is NOT evaluated here (no hard blockers for 4H alignment or direction match)
  // Macro impact is applied ONLY as a probability modifier in scoring, not as a gate
  return { valid: true };
}

/**
 * SNIPER CONDITIONS v7.2.8 (FIX #1 & #3): RELAXED COMPRESSION + EARLY IGNITION
 */
function checkSniperConditions(card: SymbolCardState, checkMode: "strict" | "early" = "strict"): boolean {
  // v9: HARD STRUCTURE BLOCKS (new gate #0 - before everything else)
  // These trades are impossible due to structure - block immediately
  if (!validateDirectionVsStructure(card.direction, card.structureState)) {
    console.log(`[SNIPER CHECK] ${card.symbol} BLOCKED: Direction violates structure (${card.structureState} vs ${card.direction})`);
    return false;
  }

  // v9: Structure must not be RANGE (no signals in undefined structure)
  if (card.structureState === "RANGE") {
    console.log(`[SNIPER CHECK] ${card.symbol} BLOCKED: No defined structure (RANGE state)`);
    return false;
  }

  // REQUIREMENT 1: Directional bias exists (not NEUTRAL)
  if (card.direction === "NEUTRAL") {
    console.log(`[SNIPER CHECK] ${card.symbol} BLOCKED: No directional bias`);
    return false;
  }

  // FIX #1: RELAXED COMPRESSION (v7.2.8)
  // ALLOW SNIPER IF ANY OF:
  // 1. Bollinger squeeze (compression true)
  // 2. EMA expansion (EMA slope > 0.4)
  // 3. Volatility expansion (ATR increase or vol > 50)
  const compressionExists = card.htf15mCompression === true;
  const emaExpanding = card.emaSlope !== null && Math.abs(card.emaSlope) > 0.4;
  const volatilityBreakout = (card.volatilityLevel ?? 50) > 50; // Breakout mode
  const energyBuilding = (card.volatilityLevel ?? 50) <= 45; // Compression mode
  
  const compressionOrExpansion = compressionExists || emaExpanding || volatilityBreakout || energyBuilding;
  
  if (!compressionOrExpansion) {
    console.log(`[SNIPER CHECK] ${card.symbol} BLOCKED: No compression/expansion detected`);
    return false;
  }

  // REQUIREMENT 2: One ignition event (Stoch cross OR EMA flip OR impulse)
  const stochCross = (card.stochRsi ?? 50) > 25 && (card.stochRsi ?? 50) < 75; // Active zone
  const emaFlip = card.emaSlope !== null && Math.abs(card.emaSlope) > 0.3; // Slope established
  const ignitionTrigger = stochCross || emaFlip;
  
  if (!ignitionTrigger) {
    console.log(`[SNIPER CHECK] ${card.symbol} BLOCKED: No ignition trigger`);
    return false;
  }

  // FIX #3: For ACTIVE_SNIPER, require strict compression OR confirmed breakout
  if (checkMode === "strict") {
    const strictCompressionOrBreakout = compressionExists || (emaExpanding && Math.abs(card.emaSlope) > 0.5);
    if (!strictCompressionOrBreakout) {
      console.log(`[SNIPER CHECK] ${card.symbol} BLOCKED: Strict mode - needs confirmed compression/breakout`);
      return false;
    }
  }

  // ALL CONDITIONS MET: Valid SNIPER setup
  console.log(`[SNIPER CHECK] ${card.symbol} PASSED (${checkMode}): direction=${card.direction} + compression/expansion + ignition`);
  return true;
}

/**
 * CONFIRMED CONDITIONS (v7.2.4 FIX #3): Established trend + impulse
 * Requires: HTF alignment + EMA expansion + momentum continuation
 * Strict threshold: 75+
 */
/**
 * Calculate momentum score using event-driven multiplier model
 * v7.1 STABILISATION FIX
 * 
 * v7.7.0 CRITICAL FIX: Separate data trust from system health
 * - executionGrade: based ONLY on source (kraken_live or kraken_cached)
 * - systemHealth: based on infrastructure (PriceHealth enum)
 * - These must be ORTHOGONAL
 */
function generateCardState(symbol: string, priceData: PriceData): SymbolCardState {
  // v7.7.0: SPLIT CONCERNS
  // Data trust (execution-grade) = based ONLY on source
  const isKrakenSource = priceData.source === "kraken_live" || priceData.source === "kraken_cached";
  
  // System health (infrastructure) = based on PriceHealth
  const systemDegraded = priceData.health === "DEGRADED" || priceData.health === "OFFLINE";
  
  // These are INDEPENDENT:
  // - Kraken cached data is execution-grade (true) but may have systemDegraded=true
  // - CoinGecko is NOT execution-grade (false) regardless of systemHealth
  
  // SIMULATE MOMENTUM INDICATORS
  // In production, calculate from OHLCV data
  
  // Stochastic RSI: 0-100 scale
  // Simulate: varies by symbol hash for reproducibility
  const symbolHash = symbol.charCodeAt(0) + symbol.charCodeAt(1);
  const stochRsi = 30 + (symbolHash % 40); // Range: 30-70

  // EMA Slope: -2 to +2 (negative = downtrend, positive = uptrend)
  const emaSlope = -1 + (symbolHash % 20) / 10; // Range: -1 to +1

  // Volatility Level: 0-100 (low = compression, high = expansion)
  const volatilityLevel = 20 + ((symbolHash * 7) % 60); // Range: 20-80

  // SIMULATE HTF CONDITIONS (v7.2.6 FIX #4: PROPER HTF STRUCTURE)
  // 4H TREND: Now based on proper HTF structure logic
  const htf4hMomentum = 40 + (symbolHash % 30); // 40-70 range
  
  // FIX #4: Proper HTF structure (v7.2.6)
  // BULLISH if: price > 21 EMA AND 21 EMA rising AND Stoch > 55
  // BEARISH if: price < 21 EMA AND 21 EMA falling AND Stoch < 45
  // NEUTRAL: only if true sideways structure
  const htf4hTrend: "BULLISH" | "BEARISH" | "NEUTRAL" = 
    // BULLISH structure: EMA rising + Stoch bullish + positive momentum
    (emaSlope > 0 && htf4hMomentum > 55) ? "BULLISH" :
    // BEARISH structure: EMA falling + Stoch bearish + negative momentum
    (emaSlope < 0 && htf4hMomentum < 45) ? "BEARISH" :
    // NEUTRAL: only if truly flat structure
    (Math.abs(emaSlope) <= 0.2 && htf4hMomentum >= 45 && htf4hMomentum <= 55) ? "NEUTRAL" :
    // Default to momentum bias
    htf4hMomentum > 55 ? "BULLISH" :
    htf4hMomentum < 45 ? "BEARISH" :
    "NEUTRAL";

  // v7.2.10 FIX #3: Calculate 15M EXECUTION STATE (replaces 1H trend display)
  // Shows what entry structure is forming, not a direction
  // COMPRESSING: volatility falling, range tightening, energy building
  // BREAKOUT_READY: tight range + momentum present, ready to move
  // EXPANDING: volatility spike after squeeze, momentum continuing
  // CHOP: choppy/indecisive, low momentum, no clear structure
  const execution15mState: "COMPRESSING" | "BREAKOUT_READY" | "EXPANDING" | "CHOP" =
    // EXPANDING: volatility high after period of compression
    volatilityLevel > 55 ? "EXPANDING" :
    // BREAKOUT_READY: volatility middle + momentum active (Stoch not extreme)
    volatilityLevel > 40 && volatilityLevel <= 55 && stochRsi > 25 && stochRsi < 75 ? "BREAKOUT_READY" :
    // COMPRESSING: low volatility + energy building
    volatilityLevel < 35 && Math.abs(emaSlope) <= 0.3 ? "COMPRESSING" :
    // CHOP: choppy structure, no clear momentum
    "CHOP";

  // v7.2.10: Remove old 1H trend calculation (deprecated)
  // htf1hTrend is no longer calculated or displayed
  
  // 1H ALIGNMENT (v7.2.10 - kept ONLY for signal logic, never displayed)
  const htf1hAlignment = 
    (htf4hTrend === "BULLISH" && emaSlope > 0.2) ||
    (htf4hTrend === "BEARISH" && emaSlope < -0.2) ||
    (htf4hTrend === "NEUTRAL" && Math.abs(emaSlope) < 0.3);

  // 15M COMPRESSION: Is there energy build-up?
  // Simplified: compression when volatility < 40
  const htf15mCompression = volatilityLevel < 40;

  // v8.5: COMPUTE LEVEL AWARENESS (structure-first breakout detection)
  // Determine if breakout is happening and validate direction against it
  const levelAwareness = computeLevelAwareness(
    priceData.price,
    priceData.priceHistory || null,
    "NONE"
  );

  // v9: STRUCTURE-FIRST DIRECTION ENGINE (CRITICAL REWRITE)
  // Step 1: Compute swing levels from price history
  const swingHigh = levelAwareness.recentHigh;
  const swingLow = levelAwareness.recentLow;

  // Step 2: Determine structure state (RANGE, BREAKOUT_UP/DOWN, RETEST_UP/DOWN, etc)
  const structureState: StructureState = computeStructureState(
    priceData.price,
    "RANGE",  // TODO: persist this across cycles
    swingHigh,
    swingLow,
    levelAwareness.breakoutPrice || null
  );

  // Step 3: Get direction from structure (HARD LOCK - structure overrides momentum)
  // Direction is LOCKED by structure, not determined by momentum first
  const direction = getDirectionFromStructure(structureState, emaSlope);

  // Step 4: Validate against structure (HARD BLOCKS for impossible trades)
  const isValidDirection = validateDirectionVsStructure(direction, structureState);

  // Step 5: If direction violates structure, set to NEUTRAL (no signal in contradictory state)
  const finalDirection = isValidDirection ? direction : "NEUTRAL";

  const breakoutState: BreakoutState = levelAwareness.breakoutState;

  const card: SymbolCardState = {
    symbol,
    price: priceData.price,
    source: priceData.source,
    degraded: systemDegraded,

    direction: finalDirection,  // v9: Structure-locked direction
    mode: "NONE",
    confidence: 0,

    stochRsi,
    emaSlope,
    volatilityLevel,

    // v8.5: Track breakout state and key levels
    breakoutState,
    recentHigh: levelAwareness.recentHigh,
    recentLow: levelAwareness.recentLow,

    // v9: Structure state and levels
    structureState,
    swingHigh,
    swingLow,
    breakoutLevel: levelAwareness.breakoutPrice || null,
    structureTimeframe: 0,  // TODO: compute from timestamp
    lastStructureUpdate: Date.now(),

    // HTF alignment data
    htf4hTrend,
    htf4hMomentum,
    htf1hAlignment,
    htf15mCompression,
    execution15mState,

    // Market readiness
    marketReadinessState: calculateLiveMarketState(finalDirection, emaSlope, stochRsi, volatilityLevel) as any,
    tradeReadinessScore: calculateTradeReadinessScore("NONE", finalDirection, htf4hTrend, htf1hAlignment, emaSlope, stochRsi, volatilityLevel),
    
    // Conditional: Only populate if signal exists
    expectedMovePercent: null,
    targetPrices: null,
    riskReward: null,
    
    signalState: finalDirection === "NEUTRAL" ? "NONE" : "BUILDING",
    lastSignalTime: undefined,

    notes: `${structureState} - ${finalDirection}${!isValidDirection ? " (structure-gated)" : ""}`,
    updatedAt: new Date().toISOString(),
  };

  return card;
}
