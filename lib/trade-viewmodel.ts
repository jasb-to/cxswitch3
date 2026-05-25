/**
 * TRADE VIEWMODEL - Maps card → snapshot fields
 * 
 * CRITICAL: This layer translates from internal card format to SnapshotCard DTO format.
 * Must ensure field names match what frontend expects (targetPrices, riskReward).
 */

import { Card, StructureState } from "./types";
import { logForensicPoint } from "./forensic-logger";

export type TradeViewModel = {
  // Identity
  symbol: string;
  price: number;
  source: "kraken" | "coingecko";
  
  // State
  direction: "LONG" | "SHORT" | "NEUTRAL";
  signalState: string;
  activationState: "ACTIVE_SNIPER" | "CONFIRMED" | "DO_NOT_TRADE";
  
  // Structure Context
  structureState: StructureState;
  structure: string;
  execution15mState: string;
  htf4hTrend: string;
  
  // Scoring
  confidence: number;
  score: number;
  
  // Trade Details - null for DO_NOT_TRADE, populated for actionable states
  // For DO_NOT_TRADE cards: { tp1: null, tp2: null, sl: null, riskReward: null }
  // For ACTIVE_SNIPER/CONFIRMED: { tp1: real_value, tp2: real_value, sl: real_value, riskReward: real_value }
  targetPrices: { tp1: number; tp2: number; sl: number } | null;
  riskReward: number | null;
  
  // Rejection Metadata
  rejectionReason?: string;
  
  // Timing
  timestamp: string;
  signalAge?: number;
  
  // Display Notes
  notes: string;
};

/**
 * Build trade viewmodel from card
 * 
 * CRITICAL: Extract ACTUAL properties from frozen card
 * - targetPrices: { tp1, tp2, sl } - ALWAYS use nested extraction
 * - riskReward: number - ALWAYS use ?? null, NEVER || 0
 * - NEVER manufacture synthetic zero defaults
 */
export function buildTradeViewModel(card: Card, metadata?: any): TradeViewModel {
  const symbol = card.symbol;
  
  // FORENSIC POINT 1: Log input card state
  logForensicPoint("CARD_INPUT", card, symbol);
  
  // Derive activation state from signal state
  const derivedActivationState: "ACTIVE_SNIPER" | "CONFIRMED" | "DO_NOT_TRADE" = 
    card.signalState === "ACTIVE_SNIPER" ? "ACTIVE_SNIPER" :
    card.signalState === "CONFIRMED" ? "CONFIRMED" :
    "DO_NOT_TRADE";
  
  // Compute rejection reason
  let rejectionReason: string | undefined;
  if (derivedActivationState === "DO_NOT_TRADE") {
    if (card.direction === "NEUTRAL") {
      rejectionReason = "Neutral direction";
    } else if (card.execution15mState === "CHOP") {
      rejectionReason = "15m showing chop";
    } else if (card.confidence < 50) {
      rejectionReason = `Low confidence: ${card.confidence.toFixed(0)}%`;
    } else {
      rejectionReason = "Structure does not support entry";
    }
  }
  
  // CRITICAL FIX: Extract from ACTUAL card properties
  // Card has: card.targetPrices { tp1, tp2, sl } and card.riskReward
  // Use ?? null to preserve absence, NEVER use || 0
  const tp1 = card.targetPrices?.tp1 ?? null;
  const tp2 = card.targetPrices?.tp2 ?? null;
  const sl = card.targetPrices?.sl ?? null;
  const rr = card.riskReward ?? null;
  
  // Build viewmodel with ALWAYS-populated trade fields
  const viewModel: TradeViewModel = {
    symbol: card.symbol,
    price: card.price || 0,
    source: card.source || "kraken",
    
    direction: card.direction,
    signalState: card.signalState,
    activationState: derivedActivationState,
    
    // CRITICAL: Structure/market context MUST have real values, never "UNKNOWN"
    // If source is missing, use BUILDING state (card doesn't know yet)
    structureState: card.structureState || "RANGE",
    structure: card.structure ? String(card.structure) : "BUILDING",
    execution15mState: card.execution15mState || "EVALUATING",
    htf4hTrend: card.htf4hTrend || "EVALUATING",
    
    confidence: card.confidence || 0,
    score: (card as any).score || 0,
    
    // CRITICAL FIX: Only populate targetPrices/riskReward if ALL values exist
    // For DO_NOT_TRADE, these will be null
    // For ACTIVE_SNIPER/CONFIRMED, they must ALL have valid values
    targetPrices: (tp1 !== null && tp2 !== null && sl !== null) 
      ? { tp1, tp2, sl }
      : null,
    riskReward: rr,
    
    // Rejection reason only for DO_NOT_TRADE
    ...(derivedActivationState === "DO_NOT_TRADE" && { rejectionReason }),
    
    timestamp: new Date().toISOString(),
    notes: card.notes || "",
  };
  
  // FORENSIC POINT 3: Log constructed viewmodel BEFORE returning
  logForensicPoint("VIEWMODEL_OUTPUT", viewModel, symbol);
  
  // HARD VALIDATION: For actionable signals, trade details MUST be present
  if ((card.signalState === "ACTIVE_SNIPER" || card.signalState === "CONFIRMED") && !viewModel.targetPrices) {
    throw new Error(
      `[VIEWMODEL_VALIDATION] ${symbol} is ${card.signalState} but missing targetPrices. ` +
      `tp1=${tp1}, tp2=${tp2}, sl=${sl}`
    );
  }
  
  return viewModel;
}

/**
 * Validate that viewmodel has all required fields
 * CRITICAL: Hard gate for DO_NOT_TRADE - skip ALL validation
 */
export function validateTradeViewModel(vm: TradeViewModel): void {
  // 🧊 CRITICAL FIX: Skip validation entirely for inactive signals
  if (vm.signalState === "DO_NOT_TRADE") {
    return;
  }

  // Only validate basic fields that must always exist
  const required = [
    "symbol",
    "direction",
    "signalState",
    "activationState",
    "structureState",
    "confidence",
    "timestamp",
  ];
  
  for (const field of required) {
    if (!(field in vm) || vm[field as keyof TradeViewModel] === undefined) {
      throw new Error(
        `[VIEWMODEL_VIOLATION] Missing required field '${field}' in TradeViewModel for ${vm.symbol}`
      );
    }
  }
  
  // HARD VALIDATION: Actionable signals MUST have trade details
  if ((vm.signalState === "ACTIVE_SNIPER" || vm.signalState === "CONFIRMED") && !vm.targetPrices) {
    throw new Error(
      `[VIEWMODEL_VIOLATION] Actionable signal ${vm.symbol} missing targetPrices`
    );
  }
  
  // Validate that if targetPrices exists, all three values are present
  if (vm.targetPrices && (!vm.targetPrices.tp1 || !vm.targetPrices.tp2 || !vm.targetPrices.sl)) {
    throw new Error(
      `[VIEWMODEL_VIOLATION] ${vm.symbol} has incomplete targetPrices: ` +
      `tp1=${vm.targetPrices.tp1}, tp2=${vm.targetPrices.tp2}, sl=${vm.targetPrices.sl}`
    );
  }
}
