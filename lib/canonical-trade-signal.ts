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
 * RULES:
 * - FAIL LOUDLY on missing EMA, direction, or trade data
 * - NEVER default EMA to 0
 * - NEVER skip validation
 * - Return with _frozen: false (caller must freeze after all mutations)
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
  
  // CRITICAL VALIDATION: Fail loudly on missing data
  if (!raw.direction || !["LONG", "SHORT", "NEUTRAL"].includes(raw.direction)) {
    throw new Error(`[CANONICAL_SIGNAL] ${raw.symbol} has invalid direction: ${raw.direction}`);
  }
  
  // CRITICAL: EMA must exist and be a number. NEVER default to 0
  if (raw.emaSlope === null || raw.emaSlope === undefined || typeof raw.emaSlope !== "number") {
    throw new Error(
      `[CANONICAL_SIGNAL] ${raw.symbol} EMA calculation failed: ${raw.emaSlope}. ` +
      `Cannot create signal without EMA. Return null/reject instead.`
    );
  }
  
  // For ACTIVE_SNIPER/CONFIRMED, trade details are mandatory
  const isActionable = raw.signalState === "ACTIVE_SNIPER" || raw.signalState === "CONFIRMED";
  if (isActionable) {
    if (typeof raw.takeProfit !== "number" || raw.takeProfit === 0) {
      throw new Error(`[CANONICAL_SIGNAL] ${raw.symbol} ACTIVE_SNIPER missing takeProfit`);
    }
    if (typeof raw.stopLoss !== "number" || raw.stopLoss === 0) {
      throw new Error(`[CANONICAL_SIGNAL] ${raw.symbol} ACTIVE_SNIPER missing stopLoss`);
    }
    if (typeof raw.riskRewardRatio !== "number" || raw.riskRewardRatio === 0) {
      throw new Error(`[CANONICAL_SIGNAL] ${raw.symbol} ACTIVE_SNIPER missing riskRewardRatio`);
    }
  }
  
  // Build the immutable signal
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
      emaSlope: raw.emaSlope,  // ALREADY VALIDATED - not null
      confidence: Math.max(0, Math.min(100, raw.confidence || 0)),
      reasonMissing: raw.confidence < 50 ? raw.notes : undefined,
    },
    
    signal: {
      state: (raw.signalState || "NONE") as any,
      quality: Math.max(0, Math.min(100, raw.confidence || 0)),
      reason: raw.notes || "No details provided",
    },
    
    // CRITICAL: Trade details ALWAYS present, even for DO_NOT_TRADE
    // This allows frontend to display "why not" with context
    trade: {
      entry: raw.price || 0,
      stopLoss: raw.stopLoss || 0,
      takeProfit1: raw.takeProfit || 0,
      takeProfit2: raw.takeProfit || 0,  // Both targets same for now
      riskReward: raw.riskRewardRatio || 0,
    },
    
    telemetry: {
      executionMs: raw.executionMs || 0,
      source: "strategy-v6",
      degraded: false,  // Updated below if any field is 0/missing
    },
    
    _frozen: false,
  };
  
  // Check for degraded signals (missing critical data)
  if (!signal.bias.emaSlope || signal.trade.riskReward === 0) {
    signal.telemetry.degraded = true;
    console.warn(`[CANONICAL_SIGNAL_DEGRADED] ${signal.symbol}: missing EMA or RR`);
  }
  
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
