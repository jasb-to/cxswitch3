/**
 * v24.2.0: CENTRALIZED SIGNAL CONFIGURATION
 * INVARIANT 1: All pipeline constants defined in ONE place
 * No missing constants, no hardcoded magic numbers
 */

// ============================================================================
// PHASE 1: Impulse Calculation Thresholds
// ============================================================================
export const IMPULSE_CONFIG = {
  // Base thresholds
  SNIPER_ELIGIBLE: 25,        // Minimum impulse to create setup
  IMPULSE_DECAY_CHECK: 27,    // Gate 2: Minimum impulse strength
  IMPULSE_DECAY_RATIO: 0.80,  // Gate 5: Minimum 80% of previous impulse
  
  // Spike rejection
  SINGLE_CYCLE_MIN: 5,        // Minimum impulse for single-cycle signal
  MULTI_CYCLE_THRESHOLD: 15,  // Threshold for multi-cycle confirmation
} as const;

// ============================================================================
// PHASE 2: Quality Filter Gates
// ============================================================================
export const QUALITY_GATES = {
  // Gate 1: Directional consistency
  DIRECTION_CONSISTENCY_CYCLES: 2,  // Must be consistent for 2 cycles
  
  // Gate 2: Impulse strength & decay
  IMPULSE_MIN_STRENGTH: 27,    // Minimum impulse to fire
  
  // Gate 3: Confidence gating
  CONFIDENCE_MIN_GATE: 40,     // v24.2: Minimum confidence to pass quality filter
  CONFIDENCE_SNIPER: 58,       // v23.1: Practical SNIPER threshold (deprecated, use CONFIDENCE_MIN_GATE)
  CONFIDENCE_CONFIRMED: 70,    // High confidence floor (for reference)
  
  // Gate 4: Signal validity window
  SIGNAL_VALIDITY_CANDLES: 4,  // Signal remains valid for 4 candles
  SIGNAL_VALIDITY_MS: 4 * 60 * 1000,  // 4 minutes in milliseconds
  
  // Gate 5: Decay detection on existing signal
  EXISTING_DECAY_RATIO: 0.80,  // Minimum 80% of trigger impulse to maintain
} as const;

// ============================================================================
// PHASE 3: State Derivation
// ============================================================================
export const STATE_CONFIG = {
  // Impulse-based eligibility (not confidence-based)
  SNIPER_ELIGIBLE: 25,         // Same as IMPULSE_CONFIG.SNIPER_ELIGIBLE
  
  // Direction validation
  REQUIRE_DIRECTIONAL_BIAS: true,  // No NEUTRAL direction for ACTIVE_SNIPER
} as const;

// ============================================================================
// PHASE 4: Setup Creation
// ============================================================================
export const SETUP_CONFIG = {
  // Entry/TP/SL calculation
  VOLATILITY_DEFAULT: 0.30,   // Default 30% if volatility null
  VOLATILITY_FACTOR: 1.0,     // Multiplier for volatility bands
  
  // Setup validity
  REQUIRE_VALID_DIRECTION: true,  // Setup needs LONG or SHORT
} as const;

// ============================================================================
// PHASE 5: Persistence & Snapshot
// ============================================================================
export const PERSISTENCE_CONFIG = {
  // Snapshot atomicity
  REQUIRE_ALL_SYMBOLS: true,   // All symbols must process successfully
  ALLOW_PARTIAL_SNAPSHOT: false,  // Never write incomplete snapshots
  
  // Per-symbol isolation
  CATCH_PER_SYMBOL: true,      // Wrap each symbol with try-catch
  FALLBACK_STATE: "BUILDING",  // Fallback state for symbol errors
} as const;

// ============================================================================
// DIAGNOSTIC & LOGGING
// ============================================================================
export const LOGGING_CONFIG = {
  LOG_SETUP_GUARD: true,       // Log [SETUP_GUARD] at creation
  LOG_GATE_TRACE: true,        // Log [GATE_TRACE] for quality filter
  LOG_STATE_DERIVATION: true,  // Log [STATE_DERIVATION]
  LOG_SNAPSHOT_WRITES: true,   // Log [SNAPSHOT_*] for persistence
  LOG_SYMBOL_ISOLATION: true,  // Log [SYMBOL_*] for per-symbol errors
} as const;

// ============================================================================
// VALIDATE CONFIG AT IMPORT TIME
// ============================================================================
export function validateConfig() {
  const errors: string[] = [];
  
  // Check all required constants are defined and not null/undefined
  if (!IMPULSE_CONFIG.SNIPER_ELIGIBLE || IMPULSE_CONFIG.SNIPER_ELIGIBLE <= 0) {
    errors.push("IMPULSE_CONFIG.SNIPER_ELIGIBLE must be > 0");
  }
  
  if (!QUALITY_GATES.CONFIDENCE_MIN_GATE || QUALITY_GATES.CONFIDENCE_MIN_GATE <= 0) {
    errors.push("QUALITY_GATES.CONFIDENCE_MIN_GATE must be > 0");
  }
  
  if (!PERSISTENCE_CONFIG.REQUIRE_ALL_SYMBOLS) {
    errors.push("PERSISTENCE_CONFIG.REQUIRE_ALL_SYMBOLS must be true");
  }
  
  if (errors.length > 0) {
    throw new Error(
      `[CONFIG_VALIDATION_ERROR] Configuration invalid:\n${errors.join("\n")}`
    );
  }
  
  console.log("[CONFIG_VALIDATED] All constants defined and valid");
  return true;
}

// Validate on import
validateConfig();
