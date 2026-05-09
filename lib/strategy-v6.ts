/**
 * STRATEGY ENGINE v6 - PURE SCANNER
 * 
 * Input: Market snapshot only
 * Output: Array of symbol cards + setups
 * 
 * NO STATE, NO DB ACCESS, NO DECISIONS
 * Pure evaluation engine - returns UI-ready card state
 */

import type { PriceData } from "./price-router";

// EMERGENCY DEBUG MODE - Set to true to see raw scores and all candidates
const DEBUG_MODE = true;

export type SymbolCardState = {
  symbol: string;
  price: number;
  source: string;
  degraded: boolean;

  direction: "LONG" | "SHORT" | "NEUTRAL";
  mode: "SNIPER" | "CONFIRMED" | "NONE";
  confidence: number;

  structure: "BREAKOUT" | "RANGE" | "COMPRESSION" | "NO_STRUCTURE";

  checklist: {
    trend4H: boolean;
    breakout15M: boolean;
    trigger5M: boolean;
    volatility: boolean;
    volume: boolean;
  };

  triggerActive: boolean;
  notes: string;
  updatedAt: string;
};

export type Setup = {
  symbol: string;
  mode: "SNIPER" | "CONFIRMED";
  direction: "LONG" | "SHORT";
  score: number;
  reason: string;
  price: number;
};

/**
 * Generate symbol card states + setups from market snapshot
 * PURE FUNCTION - takes market data, returns cards + setups
 * No DB access, no state, no side effects
 */
export async function generateSetups(market: Record<string, PriceData>): Promise<{ cards: SymbolCardState[]; setups: Setup[] }> {
  const cards: SymbolCardState[] = [];
  const setups: Setup[] = [];
  const candidates: any[] = [];

  for (const [symbol, priceData] of Object.entries(market)) {
    if (priceData.price === 0) {
      console.log(`[SCAN] ${symbol} no data`);
      continue;
    }

    // Generate card state for this symbol
    const card = generateCardState(symbol, priceData);
    cards.push(card);

    // Score for signal generation (TEMPORARY EMERGENCY THRESHOLDS)
    // SNIPER: 35+ (lowered from 55)
    // CONFIRMED: 55+ (lowered from 75)
    // MINIMUM: 30+ generates signal
    const score = calculateScore(card);
    
    if (DEBUG_MODE) {
      candidates.push({
        symbol,
        score,
        direction: card.direction,
        structure: card.structure,
      });
    }

    // Evaluate for SNIPER setup (score >= 35)
    if (score >= 35) {
      card.mode = "SNIPER";
      card.confidence = Math.min(score, 99);
      card.notes = `SNIPER signal score=${score}`;
      
      setups.push({
        symbol,
        mode: "SNIPER",
        direction: card.direction,
        score: card.confidence,
        reason: card.notes,
        price: card.price,
      });
      console.log(`[SCAN] ${symbol} SNIPER ${card.direction} score=${score}`);
    }
    // Evaluate for CONFIRMED setup (score >= 55)
    else if (score >= 55) {
      card.mode = "CONFIRMED";
      card.confidence = Math.min(score, 99);
      card.notes = `CONFIRMED signal score=${score}`;
      
      setups.push({
        symbol,
        mode: "CONFIRMED",
        direction: card.direction,
        score: card.confidence,
        reason: card.notes,
        price: card.price,
      });
      console.log(`[SCAN] ${symbol} CONFIRMED ${card.direction} score=${score}`);
    }
    // EMERGENCY: Allow weak signals (score >= 30)
    else if (score >= 30) {
      card.mode = "SNIPER";
      card.confidence = Math.min(score, 50);
      card.notes = `MONITORING - score=${score}`;
      card.direction = "NEUTRAL";
      
      setups.push({
        symbol,
        mode: "SNIPER",
        direction: "NEUTRAL",
        score: card.confidence,
        reason: `Weak signal score=${score}`,
        price: card.price,
      });
      console.log(`[SCAN] ${symbol} WEAK score=${score}`);
    }
    else if (card.mode === "NONE") {
      console.log(`[SCAN] ${symbol} no setup (score=${score})`);
    }
  }

  if (DEBUG_MODE) {
    console.log("[DEBUG] All candidates:", candidates);
    console.log("[DEBUG] Final setups:", setups.length);
  }

  return { cards, setups };
}

/**
 * Calculate raw score for signal evaluation
 * EMERGENCY PATCH: Much more lenient scoring
 */
function calculateScore(card: SymbolCardState): number {
  let score = 0;

  // Base score from checklist (each item = 15 points)
  if (card.checklist.trend4H) score += 15;
  if (card.checklist.breakout15M) score += 20;
  if (card.checklist.trigger5M) score += 20;
  if (card.checklist.volatility) score += 15;
  if (card.checklist.volume) score += 15;

  // Structure bonus (EMERGENCY: allow weak structure)
  if (card.structure === "BREAKOUT") score += 20;
  else if (card.structure === "RANGE") score += 10;
  else if (card.structure === "COMPRESSION") score += 5;
  // NO_STRUCTURE gets 0 bonus but doesn't block signal anymore

  // Direction momentum (if detected)
  if (card.direction !== "NEUTRAL") score += 10;

  return score;
}

/**
 * Generate symbol card state from market data
 * Returns UI-ready object with all checklist items, structure, confidence, etc.
 * NO DB, NO STATE, PURE EVALUATION
 * 
 * RULE: All prices are valid (price > 0), regardless of source.
 * degraded flag ONLY for UI indication, NOT for signal logic.
 */
function generateCardState(symbol: string, priceData: PriceData): SymbolCardState {
  // Placeholder evaluation - in production, this would analyze:
  // - Structure breaks (BREAKOUT, RANGE, COMPRESSION)
  // - EMA alignment for trend
  // - Volume and momentum indicators
  // - Risk/reward setup

  // degraded is purely informational - source doesn't affect signal validity
  const degraded = priceData.source !== "kraken_live";

  // EMERGENCY: Allow weak structure to still generate signals
  // Default to RANGE instead of NO_STRUCTURE
  let structure: "BREAKOUT" | "RANGE" | "COMPRESSION" | "NO_STRUCTURE" = "RANGE";

  // EMERGENCY: Lower volatility floor (0.05 instead of 0.2)
  const volatility = 0.15; // Simulated - would be calculated from price data

  // For now, default to NEUTRAL/NONE until analysis is added
  const card: SymbolCardState = {
    symbol,
    price: priceData.price,
    source: priceData.source,
    degraded,

    direction: "NEUTRAL",
    mode: "NONE",
    confidence: 0,

    structure,

    checklist: {
      trend4H: false,
      breakout15M: false,
      trigger5M: false,
      volatility: volatility >= 0.05, // EMERGENCY: 0.05 floor instead of 0.2
      volume: false,
    },

    triggerActive: false,
    notes: "Monitoring market",
    updatedAt: new Date().toISOString(),
  };

  return card;
}

