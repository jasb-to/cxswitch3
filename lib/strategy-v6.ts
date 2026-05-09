/**
 * SNIPER ENGINE v7.0 - MOMENTUM IGNITION SYSTEM
 * 
 * Converts from structure-based scanner to momentum wave detector
 * Uses Stochastic RSI + EMA Stack + Volatility Compression
 * 
 * NO STATE, NO DB ACCESS, PURE EVALUATION
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

  // Momentum indicators
  stochRsi: number;
  emaSlope: number;
  volatilityLevel: number;

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
};

/**
 * Generate symbol card states + setups from market snapshot
 * PURE FUNCTION - momentum-based detection
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

    // Score using NEW momentum-based system
    const score = calculateMomentumScore(card);
    
    console.log(`[SCAN] ${symbol} score=${score} direction=${card.direction} stoch=${card.stochRsi.toFixed(1)} emaSlope=${card.emaSlope.toFixed(2)}`);

    // ONLY generate setups with directional conviction
    // NO NEUTRAL SIGNALS ALLOWED

    // CONFIRMED THRESHOLD: 75+ (strong multi-timeframe alignment)
    if (score >= 75 && card.direction !== "NEUTRAL") {
      card.mode = "CONFIRMED";
      card.confidence = Math.min(score, 99);
      card.notes = `CONFIRMED LONG ${score}` + (card.direction === "LONG" ? "" : " ");
      
      setups.push({
        symbol,
        mode: "CONFIRMED",
        direction: card.direction,
        score: card.confidence,
        reason: `CONFIRMED ${card.direction} - momentum + EMA + compression`,
        price: card.price,
        momentum: {
          stochRsiSignal: `Stoch RSI: ${card.stochRsi.toFixed(1)}`,
          emaStackSignal: card.direction === "LONG" ? "8 EMA above 21 EMA" : "8 EMA below 21 EMA",
          volatilitySignal: card.volatilityLevel < 30 ? "Compression detected" : "Normal volatility",
          trend4H: true,
        },
      });
      console.log(`[ALERT] ${symbol} CONFIRMED ${card.direction} score=${score}`);
    }
    // SNIPER THRESHOLD: 60+ (wave ignition detected)
    else if (score >= 60 && card.direction !== "NEUTRAL") {
      card.mode = "SNIPER";
      card.confidence = Math.min(score, 99);
      card.notes = `SNIPER ${card.direction} ${score}`;
      
      setups.push({
        symbol,
        mode: "SNIPER",
        direction: card.direction,
        score: card.confidence,
        reason: `SNIPER ${card.direction} - momentum wave entry`,
        price: card.price,
        momentum: {
          stochRsiSignal: `Stoch RSI: ${card.stochRsi.toFixed(1)}`,
          emaStackSignal: card.direction === "LONG" ? "8 EMA turning up" : "8 EMA turning down",
          volatilitySignal: card.volatilityLevel < 30 ? "Compression → expansion" : "Normal",
          trend4H: true,
        },
      });
      console.log(`[ALERT] ${symbol} SNIPER ${card.direction} score=${score}`);
    }
    else {
      console.log(`[SCAN] ${symbol} below threshold (score=${score})`);
    }
  }

  return { cards, setups };
}

/**
 * NEW SCORING SYSTEM (v7.0)
 * 
 * +25 → 4H trend alignment
 * +20 → EMA stack alignment (8/21 slope or cross)
 * +20 → Stoch RSI momentum shift
 * +20 → volatility compression present
 * +15 → impulse candle detected
 * 
 * RANGE: 0-100
 * SNIPER: ≥60
 * CONFIRMED: ≥75
 */
function calculateMomentumScore(card: SymbolCardState): number {
  let score = 0;

  // 1. TREND ALIGNMENT (+25)
  // Simulate 4H trend detection
  const trend4H = card.stochRsi > 50; // Placeholder: would use actual 4H analysis
  if (trend4H) {
    score += 25;
  }

  // 2. EMA STACK ALIGNMENT (+20)
  // 8 EMA slope relative to 21 EMA
  const emaAligned = Math.abs(card.emaSlope) > 0.5; // Strong slope
  if (emaAligned) {
    score += 20;
  }

  // 3. STOCHASTIC RSI MOMENTUM (+20)
  // Detect momentum shift (not just overbought/oversold)
  const stochMomentum = card.stochRsi > 20 && card.stochRsi < 80; // Active momentum zone
  if (stochMomentum) {
    score += 20;
  }

  // 4. VOLATILITY COMPRESSION (+20)
  // BB squeeze or ATR contraction
  if (card.volatilityLevel < 30) {
    score += 20;
  }

  // 5. IMPULSE CANDLE DETECTED (+15)
  // Simulate: directional conviction
  if (card.direction !== "NEUTRAL") {
    score += 15;
  }

  return score;
}

/**
 * Generate symbol card state from market data
 * Simulates momentum indicators: Stoch RSI, EMA slope, Volatility
 * 
 * In production, these would come from actual candle data
 */
function generateCardState(symbol: string, priceData: PriceData): SymbolCardState {
  // Degrade is purely informational
  const degraded = priceData.source !== "kraken_live";

  // SIMULATE MOMENTUM INDICATORS
  // In production, calculate from OHLCV data
  
  // Stochastic RSI: 0-100 scale
  // Simulate: varies by symbol hash for reproducibility
  const symbolHash = symbol.charCodeAt(0) + symbol.charCodeAt(1);
  const stochRsi = 30 + (symbolHash % 40); // Range: 30-70

  // EMA Slope: -2 to +2 (negative = downtrend, positive = uptrend)
  const emaSlope = -1 + (symbolHash % 20) / 10; // Range: -1 to +1

  // Volatility Level: 0-100 (low = compression, high = expansion)
  const volatilityLevel = 20 + (symbolHash % 60); // Range: 20-80

  // Determine direction based on momentum signals
  let direction: "LONG" | "SHORT" | "NEUTRAL" = "NEUTRAL";
  
  // LONG condition: stochRsi rising + EMA slope positive + compression
  if (stochRsi > 45 && emaSlope > 0 && volatilityLevel < 40) {
    direction = "LONG";
  }
  // SHORT condition: stochRsi falling + EMA slope negative + compression
  else if (stochRsi < 55 && emaSlope < 0 && volatilityLevel < 40) {
    direction = "SHORT";
  }
  // Otherwise NEUTRAL - no directional conviction

  const card: SymbolCardState = {
    symbol,
    price: priceData.price,
    source: priceData.source,
    degraded,

    direction,
    mode: "NONE",
    confidence: 0,

    stochRsi,
    emaSlope,
    volatilityLevel,

    notes: direction !== "NEUTRAL" ? `Momentum: ${direction}` : "Waiting for setup",
    updatedAt: new Date().toISOString(),
  };

  return card;
}
