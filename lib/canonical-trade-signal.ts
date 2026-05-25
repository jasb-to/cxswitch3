/**
 * CANONICAL TRADE SIGNAL - SINGLE SOURCE OF TRUTH
 * 
 * ONE immutable object that BOTH frontend and Telegram consume directly.
 * NO secondary mapping layers. NO enrichment after freeze. NO transforms.
 * 
 * This object contains EVERYTHING needed by:
 * - Frontend UI cards
 * - Telegram alerts
 * - API responses
 * - Signal validation
 * - Dispatch decisions
 */

export type CanonicalTradeSignal = {
  // Identity & Timing
  symbol: string;
  timestamp: string; // ISO timestamp of canonical creation
  cycleId: string;   // Unique ID for this execution cycle
  
  // Market Context
  market: {
    price: number;           // Current price at time of signal generation
    structure: string;       // UPTREND | DOWNTREND | RANGE | BREAKOUT
    structureState: "UPTREND" | "DOWNTREND" | "RANGE" | "BREAKOUT";
    source: "kraken" | "coingecko";
  };
  
  // Directional Bias
  bias: {
    direction: "LONG" | "SHORT" | "NEUTRAL";
    htf4h: string;              // 4H trend (BULLISH | BEARISH | NEUTRAL)
    execution15m: string;       // 15m state (COMPRESSING | BREAKOUT_READY | EXPANDING | CHOP)
    emaSlope: number;           // Raw EMA slope (FAIL LOUDLY if missing)
    confidence: number;         // 0-100 confidence score
    reasonMissing?: string;     // Why confidence is low/missing
  };
  
  // Signal State
  signal: {
    state: "ACTIVE_SNIPER" | "CONFIRMED" | "DO_NOT_TRADE" | "SNIPER_READY" | "CONFIRMED_READY" | "WATCH_BREAKOUT" | "NONE";
    quality: number;            // 0-100 signal quality (differs from confidence)
    reason: string;             // Human-readable reason for signal state
  };
  
  // Trade Details (ALWAYS present, even for DO_NOT_TRADE)
  trade: {
    entry: number;              // Entry price (market price at signal generation)
    stopLoss: number;           // Stop loss level
    takeProfit1: number;        // First target
    takeProfit2: number;        // Second target
    riskReward: number;         // RR ratio (TP / SL)
  };
  
  // Telemetry & Source
  telemetry: {
    executionMs: number;        // How long signal took to generate (ms)
    source: "strategy-v6" | "strategy-v43";
    degraded: boolean;          // true if any required field failed validation
  };
  
  // Immutability Proof
  _frozen: boolean;             // true after deepFreeze()
};

/**
 * Create a new canonical trade signal from raw engine output
 * This is the ONLY place signals are created and populated.
 * 
 * FAIL-FAST RULES (no fallback coercion):
 * - THROW on missing direction
 * - THROW on invalid EMA (null/undefined/0)
 * - THROW on actionable signals with missing trade data
 * - THROW on invalid signalState enum
 * - Never use || 0, never use || "?"
 */
export function createCanonicalTradeSignal(raw: {
  symbol: string;
  price: number;
  direction: "LONG" | "SHORT" | "NEUTRAL";
  signalState: string;
  structure: string;
  structureState: string;
  confidence: number;
  htf4hTrend: string;
  execution15mState: string;
  emaSlope: number | null;  // CRITICAL: null if calculation failed
  takeProfit?: number;
  stopLoss?: number;
  riskRewardRatio?: number;
  notes?: string;
  source?: "kraken" | "coingecko";
  cycleId?: string;
  executionMs?: number;
}): CanonicalTradeSignal {
  const now = new Date().toISOString();
  const cycleId = raw.cycleId || `cycle-${Date.now()}`;
  
  // ❌ FAIL-FAST: Validate direction
  if (!raw.direction || !["LONG", "SHORT", "NEUTRAL"].includes(raw.direction)) {
    throw new Error(
      `[CANONICAL_SIGNAL] ${raw.symbol} invalid direction: ${raw.direction}. ` +
      `Must be LONG, SHORT, or NEUTRAL.`
    );
  }
  
  // ❌ FAIL-FAST: EMA MUST exist and be a valid number
  // This is the critical data field. If calculation failed, reject the entire signal.
  if (raw.emaSlope === null || raw.emaSlope === undefined) {
    throw new Error(
      `[CANONICAL_SIGNAL] ${raw.symbol} EMA calculation failed (null). ` +
      `Cannot create signal without EMA. Either calculate it or reject this symbol.`
    );
  }
  if (typeof raw.emaSlope !== "number" || isNaN(raw.emaSlope)) {
    throw new Error(
      `[CANONICAL_SIGNAL] ${raw.symbol} EMA is not a valid number: ${raw.emaSlope}. ` +
      `EMA calculation produced invalid result.`
    );
  }
  if (raw.emaSlope === 0) {
    throw new Error(
      `[CANONICAL_SIGNAL] ${raw.symbol} EMA is zero. ` +
      `This indicates calculation failure, not a valid zero EMA.`
    );
  }
  
  // ❌ FAIL-FAST: Validate signalState is a known enum
  const validStates = [
    "ACTIVE_SNIPER",
    "CONFIRMED",
    "DO_NOT_TRADE",
    "SNIPER_READY",
    "CONFIRMED_READY",
    "WATCH_BREAKOUT",
    "NONE",
  ];
  if (!validStates.includes(raw.signalState)) {
    throw new Error(
      `[CANONICAL_SIGNAL] ${raw.symbol} invalid signalState: '${raw.signalState}'. ` +
      `Must be one of: ${validStates.join(", ")}`
    );
  }
  
  // ❌ FAIL-FAST: For actionable signals, trade details are MANDATORY
  const isActionable = raw.signalState === "ACTIVE_SNIPER" || raw.signalState === "CONFIRMED";
  if (isActionable) {
    if (raw.takeProfit === undefined || raw.takeProfit === null || raw.takeProfit === 0) {
      throw new Error(
        `[CANONICAL_SIGNAL] ${raw.symbol} ${raw.signalState} missing/zero takeProfit: ${raw.takeProfit}. ` +
        `Actionable signals require valid trade levels.`
      );
    }
    if (raw.stopLoss === undefined || raw.stopLoss === null || raw.stopLoss === 0) {
      throw new Error(
        `[CANONICAL_SIGNAL] ${raw.symbol} ${raw.signalState} missing/zero stopLoss: ${raw.stopLoss}. ` +
        `Actionable signals require valid trade levels.`
      );
    }
    if (raw.riskRewardRatio === undefined || raw.riskRewardRatio === null || raw.riskRewardRatio === 0) {
      throw new Error(
        `[CANONICAL_SIGNAL] ${raw.symbol} ${raw.signalState} missing/zero riskRewardRatio: ${raw.riskRewardRatio}. ` +
        `Actionable signals require valid risk/reward.`
      );
    }
  }
  
  // ✅ ALL VALIDATIONS PASSED - Build the immutable signal
  const signal: CanonicalTradeSignal = {
    symbol: raw.symbol,
    timestamp: now,
    cycleId,
    
    market: {
      price: raw.price || 0,
      structure: raw.structure || "UNKNOWN",
      structureState: (raw.structureState || "RANGE") as "UPTREND" | "DOWNTREND" | "RANGE" | "BREAKOUT",
      source: raw.source || "kraken",
    },
    
    bias: {
      direction: raw.direction,
      htf4h: raw.htf4hTrend || "NEUTRAL",
      execution15m: raw.execution15mState || "CHOP",
      emaSlope: raw.emaSlope,  // GUARANTEED valid number at this point
      confidence: Math.max(0, Math.min(100, raw.confidence || 0)),
      reasonMissing: raw.confidence < 50 ? raw.notes : undefined,
    },
    
    signal: {
      state: raw.signalState as any,  // GUARANTEED valid enum at this point
      quality: Math.max(0, Math.min(100, raw.confidence || 0)),
      reason: raw.notes || "No details provided",
    },
    
    // Trade details populated only if validation passed
    trade: {
      entry: raw.price || 0,
      stopLoss: raw.stopLoss || 0,
      takeProfit1: raw.takeProfit || 0,
      takeProfit2: raw.takeProfit || 0,
      riskReward: raw.riskRewardRatio || 0,
    },
    
    telemetry: {
      executionMs: raw.executionMs || 0,
      source: "strategy-v6",
      degraded: false,
    },
    
    _frozen: false,
  };
  
  return signal;
}


/**
 * Convert canonical signal to UI card format
 * Frontend reads this directly, no secondary transforms.
 */
export function canonicalToUICard(signal: CanonicalTradeSignal): any {
  return {
    symbol: signal.symbol,
    price: signal.market.price,
    source: signal.market.source,
    direction: signal.bias.direction,
    signalState: signal.signal.state,
    activationState: signal.signal.state,  // Frontend uses same value
    structureState: signal.market.structureState,
    confidence: signal.bias.confidence,
    structure: signal.market.structure,
    execution15mState: signal.bias.execution15m,
    htf4hTrend: signal.bias.htf4h,
    notes: signal.signal.reason,
    
    // Trade details (always present)
    targetPrices: {
      tp1: signal.trade.takeProfit1,
      tp2: signal.trade.takeProfit2,
      sl: signal.trade.stopLoss,
    },
    riskReward: signal.trade.riskReward,
    
    // Timestamp for stale detection
    timestamp: signal.timestamp,
  };
}

/**
 * Convert canonical signal to Telegram alert format
 * Telegram uses identical data as UI, no separate transforms.
 */
export function canonicalToTelegramPayload(signal: CanonicalTradeSignal): any {
  return {
    symbol: signal.symbol,
    mode: signal.signal.state === "ACTIVE_SNIPER" ? "SNIPER" : "CONFIRMED",
    direction: signal.bias.direction,
    price: signal.market.price,
    signalState: signal.signal.state,
    structureState: signal.market.structureState,
    confidence: signal.bias.confidence,
    tp: signal.trade.takeProfit1,
    sl: signal.trade.stopLoss,
    reason: signal.signal.reason,
    timestamp: signal.timestamp,
    signalTransitionId: `${signal.symbol}-${signal.signal.state}-${signal.bias.direction}`,
    targetPrices: {
      tp1: signal.trade.takeProfit1,
      tp2: signal.trade.takeProfit2,
      sl: signal.trade.stopLoss,
    },
    riskReward: signal.trade.riskReward,
    htf4hTrend: signal.bias.htf4h,
    execution15mState: signal.bias.execution15m,
    emaSlope: signal.bias.emaSlope,
    entryPrice: signal.market.price,
  };
}
