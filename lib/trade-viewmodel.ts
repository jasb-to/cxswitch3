/**
 * TRADE VIEWMODEL - Maps card → snapshot fields
 * 
 * CRITICAL: This layer translates from internal card format to SnapshotCard DTO format.
 * Must ensure field names match what frontend expects (targetPrices, riskReward).
 */

import { Card, StructureState } from "./types";

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
  
  // Trade Details - ALWAYS populated for SnapshotCard DTO compatibility
  // Frontend expects: targetPrices {tp1, tp2, sl} and riskReward
  targetPrices: { tp1: number; tp2: number; sl: number };
  riskReward: number;
  
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
 * Maps card.takeProfit/stopLoss → targetPrices for DTO compatibility
 */
export function buildTradeViewModel(card: Card, metadata?: any): TradeViewModel {
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
  
  // CRITICAL: Extract takeProfit/stopLoss and map to targetPrices DTO format
  const tp = (card as any).takeProfit || 0;
  const sl = (card as any).stopLoss || 0;
  const rr = (card as any).riskRewardRatio || 0;
  
  // Build viewmodel with ALWAYS-populated trade fields
  const viewModel: TradeViewModel = {
    symbol: card.symbol,
    price: card.price || 0,
    source: card.source || "kraken",
    
    direction: card.direction,
    signalState: card.signalState,
    activationState: derivedActivationState,
    
    structureState: card.structureState || "RANGE",
    structure: card.structure || "UNKNOWN",
    execution15mState: card.execution15mState || "CHOP",
    htf4hTrend: card.htf4hTrend || "NEUTRAL",
    
    confidence: card.confidence || 0,
    score: (card as any).score || 0,
    
    // CRITICAL FIX: Always populate targetPrices and riskReward for SnapshotCard DTO
    targetPrices: {
      tp1: tp,
      tp2: tp,
      sl: sl,
    },
    riskReward: rr,
    
    // Rejection reason only for DO_NOT_TRADE
    ...(derivedActivationState === "DO_NOT_TRADE" && { rejectionReason }),
    
    timestamp: new Date().toISOString(),
    notes: card.notes || "",
  };
  
  return viewModel;
}

/**
 * Validate that viewmodel has all required fields
 */
export function validateTradeViewModel(vm: TradeViewModel): void {
  const required = [
    "symbol",
    "direction",
    "signalState",
    "activationState",
    "structureState",
    "confidence",
    "targetPrices",
    "riskReward",
    "timestamp",
  ];
  
  for (const field of required) {
    if (!(field in vm) || vm[field as keyof TradeViewModel] === undefined) {
      throw new Error(
        `[VIEWMODEL_VIOLATION] Missing required field '${field}' in TradeViewModel for ${vm.symbol}`
      );
    }
  }
  
  // Ensure targetPrices has all three fields
  if (!vm.targetPrices.tp1 || !vm.targetPrices.tp2 || !vm.targetPrices.sl) {
    console.warn(
      `[VIEWMODEL_WARNING] ${vm.symbol} has incomplete targetPrices: ` +
      `tp1=${vm.targetPrices.tp1}, tp2=${vm.targetPrices.tp2}, sl=${vm.targetPrices.sl}`
    );
  }
}
