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

  for (const [symbol, priceData] of Object.entries(market)) {
    if (priceData.price === 0) {
      console.log(`[SCAN] ${symbol} no data`);
      continue;
    }

    // Generate card state for this symbol
    const card = generateCardState(symbol, priceData);
    cards.push(card);

    // Evaluate for SNIPER setup (score >= 55)
    if (card.mode === "SNIPER") {
      setups.push({
        symbol,
        mode: "SNIPER",
        direction: card.direction,
        score: card.confidence,
        reason: card.notes,
        price: card.price,
      });
      console.log(`[SCAN] ${symbol} SNIPER ${card.direction} score=${card.confidence}`);
    }

    // Evaluate for CONFIRMED setup (score >= 75)
    if (card.mode === "CONFIRMED") {
      setups.push({
        symbol,
        mode: "CONFIRMED",
        direction: card.direction,
        score: card.confidence,
        reason: card.notes,
        price: card.price,
      });
      console.log(`[SCAN] ${symbol} CONFIRMED ${card.direction} score=${card.confidence}`);
    }

    if (card.mode === "NONE") {
      console.log(`[SCAN] ${symbol} no setup`);
    }
  }

  return { cards, setups };
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

  // For now, default to NEUTRAL/NONE until analysis is added
  const card: SymbolCardState = {
    symbol,
    price: priceData.price,
    source: priceData.source,
    degraded,

    direction: "NEUTRAL",
    mode: "NONE",
    confidence: 0,

    structure: "NO_STRUCTURE",

    checklist: {
      trend4H: false,
      breakout15M: false,
      trigger5M: false,
      volatility: false,
      volume: false,
    },

    triggerActive: false,
    notes: "Waiting for setup",
    updatedAt: new Date().toISOString(),
  };

  return card;
}

