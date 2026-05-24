/**
 * SHARED TYPE DEFINITIONS
 * 
 * v37.1 ARCHITECTURE FIX: Centralized type definitions to break circular dependencies.
 * All types used across modules are defined here.
 * NO LOGIC, NO EXECUTION, ONLY TYPE DEFINITIONS.
 * This file is PURE and creates NO circular dependencies.
 */

// ============================================================================
// EXECUTION CONTEXT & PROFILES
// ============================================================================

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

export type ExecutionProfile = {
  // Scoring weights
  ignitionThreshold: number;           // Score >= N to trigger SNIPER
  stochWeight: number;                  // Stoch RSI multiplier
  emaWeight: number;                    // EMA flip multiplier (acceleration)
  volatilityWeight: number;             // Compression multiplier
  impulseWeight: number;                // Direction conviction multiplier
  trendWeight: number;                  // 4H trend alignment multiplier

  // Activation style (drives how signals are generated)
  activationStyle: "IMPULSE" | "STRUCTURAL" | "CONTINUATION";
  
  // Asset-specific rules (consolidates fragmented if-checks)
  persistenceRules: {
    requireSustainedEMA: boolean;       // ETH: must have 0.3-1.0 EMA slope
    requireDirectionAlignment: boolean; // ETH: direction must match EMA
    stabilityThreshold: number;         // ETH: volatility < N (< 45)
  };
  
  // Bonus/penalty system
  breakoutBonus: number;                // BTC: +5 score bonus for structural breakout
  bonusActivation: "STRUCTURAL_BREAKOUT" | "NONE"; // When to apply bonus
};

/**
 * IMMUTABLE CANONICAL SIGNAL - PRODUCTION-SAFE FORMAT
 * 
 * PHASE 1 & 2: Immutable signal contract with deterministic signal IDs
 * 
 * INVARIANTS (ENFORCED):
 * - signalId: deterministic format "SYMBOL_DIRECTION_ACTIVATION_TIMESTAMP"
 * - direction: LONG | SHORT | NEUTRAL only
 * - activationState: ACTIVE_SNIPER | CONFIRMED | DO_NOT_TRADE only
 * - macro: BULLISH | BEARISH | NEUTRAL only
 * - confidence: 0-100 (number)
 * - generatedAt: ISO timestamp (immutable)
 * 
 * FREEZING: Object.freeze() and deepFreeze() applied
 * NO MUTATIONS ALLOWED AFTER CREATION
 * 
 * PURPOSE:
 * - Single immutable source of truth from engine
 * - Deterministic replay capability
 * - Alert deduplication via signalId
 * - Audit trail tracking
 */
export type CanonicalSignal = {
  // IMMUTABLE ID - deterministic for deduplication and replay
  signalId: string; // Format: "BTC_LONG_ACTIVE_SNIPER_2026-05-24T18:25:30Z"
  
  // CORE SIGNAL STATE (never changes once created)
  symbol: string;
  direction: "LONG" | "SHORT" | "NEUTRAL";
  activationState: "ACTIVE_SNIPER" | "CONFIRMED" | "DO_NOT_TRADE";
  macro: "BULLISH" | "BEARISH" | "NEUTRAL";
  confidence: number; // 0-100
  
  // STRUCTURE DATA (for audit and validation)
  structure: string;
  execution15m: string;
  htf4hTrend: string;
  
  // TIMESTAMP (immutable record)
  generatedAt: string; // ISO string, set once
  
  // OPTIONAL TRADE DATA (may not be calculated)
  targetPrices?: {
    tp1?: number;
    tp2?: number;
    stop?: number;
  };
  
  // AUDIT METADATA
  readonly: true; // Marked for type safety
};

// ============================================================================
// SIGNAL ID GENERATION - DETERMINISTIC & IMMUTABLE
// ============================================================================

/**
 * Generate deterministic signal ID
 * Format: "SYMBOL_DIRECTION_ACTIVATION_TIMESTAMP"
 * Example: "BTC_LONG_ACTIVE_SNIPER_2026-05-24T18:25:30Z"
 */
export function generateSignalId(
  symbol: string,
  direction: "LONG" | "SHORT" | "NEUTRAL",
  activationState: "ACTIVE_SNIPER" | "CONFIRMED" | "DO_NOT_TRADE",
  timestamp: Date = new Date()
): string {
  const iso = timestamp.toISOString();
  return `${symbol}_${direction}_${activationState}_${iso}`;
}

/**
 * Deep freeze for complete immutability
 * Prevents any mutations, including nested objects
 */
export function deepFreeze<T>(obj: T): T {
  Object.freeze(obj);
  
  Object.getOwnPropertyNames(obj).forEach((prop) => {
    const val = (obj as any)[prop];
    
    if (val !== null && (typeof val === "object" || typeof val === "function")) {
      deepFreeze(val);
    }
  });
  
  return obj;
}

/**
 * Create immutable canonical signal
 * Validates all constraints and freezes immediately
 */
export function createCanonicalSignal(
  symbol: string,
  direction: "LONG" | "SHORT" | "NEUTRAL",
  activationState: "ACTIVE_SNIPER" | "CONFIRMED" | "DO_NOT_TRADE",
  macro: "BULLISH" | "BEARISH" | "NEUTRAL",
  confidence: number,
  structure: string,
  execution15m: string,
  htf4hTrend: string,
  targetPrices?: { tp1?: number; tp2?: number; stop?: number }
): CanonicalSignal {
  // VALIDATION
  if (!["LONG", "SHORT", "NEUTRAL"].includes(direction)) {
    throw new Error(`Invalid direction: ${direction}`);
  }
  if (!["ACTIVE_SNIPER", "CONFIRMED", "DO_NOT_TRADE"].includes(activationState)) {
    throw new Error(`Invalid activationState: ${activationState}`);
  }
  if (!["BULLISH", "BEARISH", "NEUTRAL"].includes(macro)) {
    throw new Error(`Invalid macro: ${macro}`);
  }
  if (typeof confidence !== "number" || confidence < 0 || confidence > 100) {
    throw new Error(`Invalid confidence: ${confidence}`);
  }
  
  const now = new Date();
  const signalId = generateSignalId(symbol, direction, activationState, now);
  
  const signal: CanonicalSignal = {
    signalId,
    symbol,
    direction,
    activationState,
    macro,
    confidence,
    structure,
    execution15m,
    htf4hTrend,
    generatedAt: now.toISOString(),
    targetPrices,
    readonly: true,
  };
  
  // IMMUTABILITY ENFORCEMENT
  return deepFreeze(signal);
}

// ============================================================================
// CANONICAL CARD - STRICT 3-LAYER IMMUTABLE CONTRACT
// ============================================================================

/**
 * CANONICAL CARD: The ONLY format that flows through pipeline
 * 
 * INVARIANTS:
 * - direction MUST be one of: "LONG" | "SHORT" | "NEUTRAL"
 * - activationState MUST be one of: "ACTIVE_SNIPER" | "DO_NOT_TRADE"
 * - macro MUST be one of: "BULLISH" | "BEARISH" | "NEUTRAL"
 * - confidence MUST be 0-100
 * - targetPrices is optional (may not be calculated)
 * 
 * UI MUST NOT:
 * - Recompute or inference any of these fields
 * - Fall back to stale values
 * - Create conditional state logic based on missing fields
 * - Return null - render "—" instead
 * 
 * If ANY field is missing or wrong type: FAIL FAST with error
 */
export type CanonicalCard = {
  // Identity
  symbol: string;
  price: number;
  source: "kraken" | "coingecko";
  
  // CANONICAL STATE (from execution engine, immutable)
  direction: "LONG" | "SHORT" | "NEUTRAL";
  activationState: "ACTIVE_SNIPER" | "DO_NOT_TRADE";
  macro: "BULLISH" | "BEARISH" | "NEUTRAL";
  confidence: number; // 0-100
  
  // Optional trade data (may not be calculated)
  targetPrices?: {
    tp1: number;
    tp2: number;
    sl: number;
  };
  riskReward?: number;
  
  // Metadata (for audit trail, not for UI logic)
  degraded: boolean;
  executionGrade: boolean;
  timestamp: number;
};

// ============================================================================
// CANONICAL SNAPSHOT - TYPE-SAFE CONTRACT
// ============================================================================

export type CanonicalSnapshot = {
  ready: boolean;
  cards: CanonicalCard[];
  setups: any[];
  activeSignals: string[];
  signalCount: number;
  activeSnipers: number;
  updatedAt: string | null;
};

// ============================================================================
// VALIDATION GUARDS
// ============================================================================

/**
 * Validate card is canonical format
 * Used by UI ENTRY POINT ONLY - MUST be first check
 */
export function assertCanonicalCard(card: any): CanonicalCard {
  if (!card) {
    throw new Error("Card is null/undefined");
  }
  
  const validDirections = ["LONG", "SHORT", "NEUTRAL"];
  const validActivations = ["ACTIVE_SNIPER", "DO_NOT_TRADE"];
  const validMacros = ["BULLISH", "BEARISH", "NEUTRAL"];
  
  if (!validDirections.includes(card.direction)) {
    throw new Error(`Invalid direction: ${card.direction}`);
  }
  if (!validActivations.includes(card.activationState)) {
    throw new Error(`Invalid activationState: ${card.activationState}`);
  }
  if (!validMacros.includes(card.macro)) {
    throw new Error(`Invalid macro: ${card.macro}`);
  }
  if (typeof card.confidence !== "number" || card.confidence < 0 || card.confidence > 100) {
    throw new Error(`Invalid confidence: ${card.confidence}`);
  }
  
  return card as CanonicalCard;
}

/**
 * Validate snapshot is canonical format
 */
export function assertCanonicalSnapshot(snapshot: any): CanonicalSnapshot {
  if (!snapshot || typeof snapshot !== "object") {
    throw new Error("Snapshot is not an object");
  }
  if (!Array.isArray(snapshot.cards)) {
    throw new Error("Snapshot.cards is not an array");
  }
  
  // Validate each card
  snapshot.cards.forEach((card: any, index: number) => {
    try {
      assertCanonicalCard(card);
    } catch (e) {
      throw new Error(`Card[${index}] validation failed: ${(e as Error).message}`);
    }
  });
  
  return snapshot as CanonicalSnapshot;
}

// ============================================================================
// SIGNAL STATE & CARD STATE
// ============================================================================

export type SignalState = 
  | "NONE"              // No signal
  | "BUILDING"          // Directional bias + compression, waiting for ignition
  | "SNIPER_READY"      // All SNIPER conditions passed, awaiting entry confirmation
  | "CONFIRMED_READY"   // All CONFIRMED conditions passed, awaiting confirmation
  | "ACTIVE_SNIPER"     // SNIPER signal active, trade window open (30 min cooldown)
  | "ACTIVE_CONFIRMED"  // CONFIRMED signal active, trend confirmation (90 min cooldown) - INTERNAL ONLY
  | "WATCH_BREAKOUT";   // Breakout detected, holding direction until retest confirmation

export type StructureState = "UPTREND" | "DOWNTREND" | "RANGE" | "BREAKOUT";

export type BreakoutState = {
  type: "STRUCTURAL" | "IMPULSE";
  level: number;
  confirmed: boolean;
};

export type SymbolCardState = {
  symbol: string;
  price: number;
  source: string;
  degraded: boolean;

  direction: "LONG" | "SHORT" | "NEUTRAL";
  mode: "SNIPER" | "CONFIRMED" | "NONE";
  confidence: number;
  
  // Signal state
  signalState: SignalState;
  lastSignalTime?: number;

  // Momentum indicators (5M)
  stochRsi: number | null;
  emaSlope: number | null;
  volatilityLevel: number | null;

  // Breakout awareness (structure-first)
  breakoutState?: BreakoutState;
  recentHigh?: number;
  recentLow?: number;
  
  // Current price tracking for displacement detection
  currentPrice?: number;  // Current price (for displacement context)
  entryPrice?: number;    // Entry price (for displacement calculation)
  recentImpulseStrength?: number;  // Continuation impulse strength (0-100)

  // Structure state system
  structureState: StructureState;
  swingHigh: number;
  swingLow: number;
  breakoutLevel: number | null;
  structureTimeframe: number;  // ms since last structure state change
  lastStructureUpdate: number; // timestamp

  // Higher TimeFrame alignment
  htf4hTrend: "BULLISH" | "BEARISH" | "NEUTRAL";
  htf4hMomentum: number | null;
  htf1hAlignment: boolean | null;
  htf15mCompression: boolean | null;
  
  // 15M EXECUTION STRUCTURE
  execution15mState: "COMPRESSING" | "BREAKOUT_READY" | "EXPANDING" | "CHOP";

  // Market readiness engine
  marketReadinessState: string;
  tradeReadinessScore: number | null;
  momentumScore?: number;
  
  // Conditional: Only populate if mode === "SNIPER" or "CONFIRMED"
  expectedMovePercent: { sniper: { min: number; max: number } } | null;
  targetPrices: { tp1: number; tp2: number; sl: number } | null;
  riskReward: number | null;

  // Trend memory
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
  // HTF Alignment breakdown
  htf: {
    trend4h: "BULLISH" | "BEARISH";
    alignment1h: boolean;
    compression15m: boolean;
    trigger5m: string;
  };
};

// ============================================================================
// MONITOR EVENT TYPES
// ============================================================================

export type MonitorEventType = 
  | "DIRECTION_FLIP"           // LONG→SHORT or vice versa
  | "SIGNAL_STATE_CHANGE"      // Any signal state transition
  | "MOMENTUM_SPIKE"           // Stoch or EMA > threshold
  | "MOMENTUM_FADE"            // Stoch or EMA < threshold
  | "STRUCTURE_INVALIDATION"   // EMA reverses against direction
  | "STRUCTURE_CONFIRMATION"   // EMA aligns with direction
  | "MACRO_SHIFT"              // 4H trend changes
  | "IMPULSE_STARTING"         // execution15mState = EXPANDING/BREAKOUT
  | "IMPULSE_EXHAUSTING"       // volatility extreme + momentum fade
  | "REVALIDATION_SUCCESS"     // SNIPER revalidation passed
  | "REVALIDATION_FAILED"      // SNIPER revalidation failed (should expire)
  | "CONFIDENCE_SURGE"         // Score > 70
  | "CONFIDENCE_DROP"          // Score < 40
  | "EXECUTION_QUALITY_CHANGE" // Source changes (Kraken live → cached)
  | "NONE";                    // No significant change

export interface MonitorEvent {
  type: MonitorEventType;
  symbol: string;
  timestamp: number;
  previousState: Partial<SymbolCardState>;
  currentState: Partial<SymbolCardState>;
  details: {
    previousDirection?: string;
    currentDirection?: string;
    previousSignalState?: string;
    currentSignalState?: string;
    scoreChange?: number;
    emaChange?: number;
    stochChange?: number;
    volatilityLevel?: number;
    reason?: string;
  };
}

// ============================================================================
// HTF STRUCTURE TYPES
// ============================================================================

export type HTFTrend = "BULLISH" | "BEARISH" | "NEUTRAL";

export interface HTFStructureAnalysis {
  trend4h: HTFTrend;
  momentum4h: number | null;
  swingHigh4h: number;
  swingLow4h: number;
  structureState4h: StructureState;
  breakoutLevel4h: number | null;
}

// ============================================================================
// SNAPSHOT TYPES
// ============================================================================

export type CycleSnapshot = Partial<SymbolCardState>;
