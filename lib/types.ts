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
