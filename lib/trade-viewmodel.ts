/**
 * TRADE VIEWMODEL - Single Source of Truth for UI, Alerts, API
 * 
 * This is the ONLY object that should be used for display, alerts, and API responses.
 * It ALWAYS contains complete trade metadata, never strips fields based on state.
 * 
 * CRITICAL RULE: Even DO_NOT_TRADE must have all context fields populated.
 */

import { Card, StructureState } from "./types";

export type TradeViewModel = {
  // Identity
  symbol: string;
  price: number;
  source: "kraken" | "coingecko";
  
  // State (never omitted)
  direction: "LONG" | "SHORT" | "NEUTRAL";
  signalState: string;
  activationState: "ACTIVE_SNIPER" | "CONFIRMED" | "DO_NOT_TRADE";
  
  // Structure Context (ALWAYS populated, never stripped)
  structureState: StructureState;
  structure: string;
  execution15mState: "COMPRESSING" | "BREAKOUT_READY" | "EXPANDING" | "CHOP";
  htf4hTrend: string;
  
  // Scoring & Confidence
  confidence: number;
  score: number;
  
  // Trade Details (populated if actionable, reason if not)
  entryPrice?: number;
  takeProfit?: number;
  stopLoss?: number;
  riskRewardRatio?: number;
  
  // Rejection Metadata (why this card is DO_NOT_TRADE)
  rejectionReason?: string;
  
  // Timing
  timestamp: string;
  signalAge?: number;
  
  // Display Notes
  notes: string;
};

/**
 * Build unified trade viewmodel from card
 * ✅ FIX #4: activationState is DERIVED from signalState
 * CRITICAL: activationState is UI-only, NEVER used for dispatcher logic
 */
export function buildTradeViewModel(card: Card, metadata?: any): TradeViewModel {
  // ✅ FIX #4: Derive activationState from signalState (engine truth)
  // signalState → engine output (ACTIVE_SNIPER, CONFIRMED, DO_NOT_TRADE, etc)
  // activationState → UI display (simplified to ACTIVE_SNIPER, CONFIRMED, or DO_NOT_TRADE)
  const derivedActivationState: "ACTIVE_SNIPER" | "CONFIRMED" | "DO_NOT_TRADE" = 
    card.signalState === "ACTIVE_SNIPER" ? "ACTIVE_SNIPER" :
    card.signalState === "CONFIRMED" ? "CONFIRMED" :
    "DO_NOT_TRADE";
  
  // Compute rejection reason if needed
  let rejectionReason: string | undefined;
  
    if (derivedActivationState === "DO_NOT_TRADE") {
      if (card.direction === "NEUTRAL") {
        rejectionReason = "Neutral direction - no directional bias";
      } else if (card.execution15mState === "CHOP") {
        rejectionReason = "15m execution showing chop - no entry setup";
      } else if (card.confidence < 50) {
        rejectionReason = `Low confidence: ${card.confidence.toFixed(0)}%`;
      } else {
        rejectionReason = "Structure does not support execution";
      }
    }
  
  // Build complete viewmodel - NEVER skip fields
  const viewModel: TradeViewModel = {
    // Identity (always present)
    symbol: card.symbol,
    price: card.price || 0,
    source: card.source || "kraken",
    
    // State (always present, even if rejected)
    direction: card.direction,
    signalState: card.signalState,
    activationState: derivedActivationState,
    
    // Structure (CRITICAL: always populated)
    structureState: card.structureState || "RANGE",
    structure: card.structure || "UNKNOWN",
    execution15mState: card.execution15mState || "CHOP",
    htf4hTrend: card.htf4hTrend || "NEUTRAL",
    
    // Scoring
    confidence: card.confidence || 0,
    score: (card as any).score || 0,
    
    // Trade Details (only if actionable - both ACTIVE_SNIPER and CONFIRMED have trade details)
    ...(( derivedActivationState === "ACTIVE_SNIPER" || derivedActivationState === "CONFIRMED") && {
      entryPrice: card.price || 0, // Use current price as entry point
      takeProfit: (card as any).takeProfit || 0,
      stopLoss: (card as any).stopLoss || 0,
      riskRewardRatio: (card as any).riskRewardRatio || 0,
    }),
    
    // Rejection reason (only if rejected)
    ...(derivedActivationState === "DO_NOT_TRADE" && { rejectionReason }),
    
    // Timing
    timestamp: new Date().toISOString(),
    
    // Notes for display
    notes: card.notes || "",
  };
  
  return viewModel;
}

/**
 * Ensure viewmodel has all required fields for UI/alerts
 * Fails fast if critical fields are missing
 */
export function validateTradeViewModel(vm: TradeViewModel): void {
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
}
