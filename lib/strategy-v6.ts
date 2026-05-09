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

  // Momentum indicators (5M)
  stochRsi: number;
  emaSlope: number;
  volatilityLevel: number;

  // Higher TimeFrame alignment (v7.1.1)
  htf4hTrend: "BULLISH" | "BEARISH" | "NEUTRAL"; // 4H trend direction
  htf4hMomentum: number; // 4H momentum strength (0-100)
  htf1hAlignment: boolean; // Does 1H momentum agree with 4H?
  htf15mCompression: boolean; // Is 15M showing compression?

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
  // HTF Alignment breakdown (v7.1.1)
  htf: {
    trend4h: "BULLISH" | "BEARISH";
    alignment1h: boolean;
    compression15m: boolean;
    trigger5m: string;
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

    // CONFIRMED ALERT: score >= 75 AND confirmed conditions met
    if (score >= 75 && card.direction !== "NEUTRAL" && checkConfirmedConditions(card)) {
      card.mode = "CONFIRMED";
      card.confidence = Math.min(score, 99);
      card.notes = `CONFIRMED ${card.direction} trend continuation ${score}`;
      
      setups.push({
        symbol,
        mode: "CONFIRMED",
        direction: card.direction,
        score: card.confidence,
        reason: `CONFIRMED ${card.direction} - EMA + impulse + HTF alignment`,
        price: card.price,
        momentum: {
          stochRsiSignal: `Stoch RSI: ${card.stochRsi.toFixed(1)}`,
          emaStackSignal: card.direction === "LONG" ? "8 EMA above 21 EMA" : "8 EMA below 21 EMA",
          volatilitySignal: card.volatilityLevel < 30 ? "Compression detected" : "Normal volatility",
          trend4H: card.stochRsi > 50,
        },
      });
      console.log(`[ALERT] ${symbol} CONFIRMED ${card.direction} score=${score}`);
    }
    // SNIPER ALERT: score >= 60 AND sniper conditions met (HTF alignment + LTF ignition)
    else if (score >= 60 && card.direction !== "NEUTRAL" && checkSniperConditions(card)) {
      card.mode = "SNIPER";
      card.confidence = Math.min(score, 99);
      card.notes = `SNIPER ${card.direction} ignition ${score}`;
      
      setups.push({
        symbol,
        mode: "SNIPER",
        direction: card.direction,
        score: card.confidence,
        reason: `SNIPER ${card.direction} - HTF aligned ignition event`,
        price: card.price,
        momentum: {
          stochRsiSignal: `Stoch RSI: ${card.stochRsi.toFixed(1)}`,
          emaStackSignal: card.direction === "LONG" ? "8 EMA turning up" : "8 EMA turning down",
          volatilitySignal: card.volatilityLevel < 40 ? "Compression active" : "Normal",
          trend4H: card.htf4hTrend !== "NEUTRAL",
        },
        // HTF Breakdown for Telegram alerts
        htf: {
          trend4h: card.htf4hTrend as "BULLISH" | "BEARISH",
          alignment1h: card.htf1hAlignment,
          compression15m: card.htf15mCompression,
          trigger5m: card.stochRsi > 20 && card.stochRsi < 80 ? "Stoch RSI cross" : "EMA flip",
        },
      });
      console.log(`[ALERT] ${symbol} SNIPER ${card.direction} score=${score} | 4H:${card.htf4hTrend} 1H:${card.htf1hAlignment} 15M:${card.htf15mCompression}`);
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
  // BASE SCORE - foundation for all signals
  let score = 30;

  // EVENT MULTIPLIERS (not additive)
  let multiplier = 1.0;

  // EVENT 1: Stoch RSI cross detected
  // Range: 0-100, active zone: 20-80
  const stochRsiActive = card.stochRsi > 20 && card.stochRsi < 80;
  if (stochRsiActive) {
    multiplier *= 1.25; // Stoch RSI event multiplier
  }

  // EVENT 2: EMA 8/21 flip detected
  // Strong slope indicates alignment
  const emaFlipped = Math.abs(card.emaSlope) > 0.5;
  if (emaFlipped) {
    multiplier *= 1.35; // EMA flip multiplier (highest impact)
  }

  // EVENT 3: Volatility compression present
  // BB squeeze or ATR contraction
  const volatilityCompression = card.volatilityLevel < 30;
  if (volatilityCompression) {
    multiplier *= 1.20; // Compression multiplier
  }

  // EVENT 4: Impulse candle (direction conviction)
  if (card.direction !== "NEUTRAL") {
    multiplier *= 1.30; // Impulse multiplier
  }

  // EVENT 5: 4H trend alignment
  // Trend bias from higher timeframe
  const trend4HAligned = card.stochRsi > 50; // Simplified: would use actual 4H data
  if (trend4HAligned) {
    multiplier *= 1.40; // HTF trend multiplier (critical for CONFIRMED)
  }

  // Apply multiplier
  score = Math.round(score * multiplier);

  // SEPARATION BOOST: Prevent score clustering
  // Strong momentum flips break away from 40-45 cluster
  if (emaFlipped && stochRsiActive) {
    score *= 1.2; // Momentum flip detected
  }

  // Strong squeeze + impulse creates separation
  if (volatilityCompression && card.direction !== "NEUTRAL") {
    score *= 1.15; // Volatility squeeze strong
  }

  return Math.min(score, 99); // Cap at 99
}

/**
 * SNIPER CONDITIONS v7.1.1: HTF ALIGNMENT ENFORCEMENT
 * 
 * SNIPER = HTF directional bias + mid timeframe compression + LTF ignition trigger
 * NOT = 5M trigger by itself
 */
function checkSniperConditions(card: SymbolCardState): boolean {
  // REQUIREMENT 1: 4H TREND ALIGNED
  // 4H must establish macro directional bias (NEVER NEUTRAL)
  const trend4hAligned = card.htf4hTrend !== "NEUTRAL";
  if (!trend4hAligned) {
    console.log(`[SNIPER CHECK] ${card.symbol} BLOCKED: No 4H trend alignment`);
    return false;
  }

  // REQUIREMENT 2: 1H MOMENTUM ALIGNED
  // 1H must confirm directional continuation (must agree with 4H)
  const alignment1hConfirmed = card.htf1hAlignment;
  if (!alignment1hConfirmed) {
    console.log(`[SNIPER CHECK] ${card.symbol} BLOCKED: 1H momentum disagrees with 4H`);
    return false;
  }

  // REQUIREMENT 3: 15M COMPRESSION EXISTS
  // 15M must show compression (BB squeeze or ATR contraction)
  const compression15mActive = card.htf15mCompression;
  if (!compression15mActive) {
    console.log(`[SNIPER CHECK] ${card.symbol} BLOCKED: No 15M compression detected`);
    return false;
  }

  // REQUIREMENT 4: 5M IGNITION TRIGGER
  // 5M provides entry timing (Stoch cross, EMA flip, or impulse candle)
  const stochRsiActive = card.stochRsi > 20 && card.stochRsi < 80; // Active zone
  const emaFlipped = Math.abs(card.emaSlope) > 0.5; // Slope flip
  const ignitionTrigger = stochRsiActive || emaFlipped;
  if (!ignitionTrigger) {
    console.log(`[SNIPER CHECK] ${card.symbol} BLOCKED: No 5M ignition trigger`);
    return false;
  }

  // ALL CONDITIONS MET: Valid SNIPER setup
  console.log(`[SNIPER CHECK] ${card.symbol} PASSED: 4H ${card.htf4hTrend} + 1H aligned + 15M compression + 5M trigger`);
  return true;
}

/**
 * CONFIRMED CONDITIONS: Established trend + impulse + HTF alignment
 * Full multi-timeframe setup - trend continuation
 */
function checkConfirmedConditions(card: SymbolCardState): boolean {
  // CONFIRMED requires:
  // 1. EMA alignment established (8 > 21 or 8 < 21)
  // 2. Impulse candle already occurred
  // 3. HTF trend agrees (4H bias)
  
  const emaAligned = Math.abs(card.emaSlope) > 0.5; // Established alignment
  const impulseActive = card.direction !== "NEUTRAL"; // Directional conviction
  const hftrendAgreed = card.stochRsi > 50; // Simplified 4H trend
  
  return emaAligned && impulseActive && hftrendAgreed;
}

/**
 * Calculate momentum score using event-driven multiplier model
 * v7.1 STABILISATION FIX
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
  const volatilityLevel = 20 + ((symbolHash * 7) % 60); // Range: 20-80

  // SIMULATE HTF CONDITIONS (v7.1.1)
  // 4H TREND: Establish macro directional bias
  const htf4hMomentum = 40 + (symbolHash % 30); // 40-70 range
  const htf4hTrend: "BULLISH" | "BEARISH" | "NEUTRAL" = 
    htf4hMomentum > 60 ? "BULLISH" : 
    htf4hMomentum < 40 ? "BEARISH" : 
    "NEUTRAL";

  // 1H ALIGNMENT: Does 1H momentum confirm the 4H trend?
  // Simplified: 1H aligns if EMA slope matches 4H direction
  const htf1hAlignment = 
    (htf4hTrend === "BULLISH" && emaSlope > 0.2) ||
    (htf4hTrend === "BEARISH" && emaSlope < -0.2) ||
    (htf4hTrend === "NEUTRAL" && Math.abs(emaSlope) < 0.3);

  // 15M COMPRESSION: Is there energy build-up?
  // Simplified: compression when volatility < 40
  const htf15mCompression = volatilityLevel < 40;

  // Determine direction based on momentum signals
  let direction: "LONG" | "SHORT" | "NEUTRAL" = "NEUTRAL";
  
  // LONG condition: stochRsi rising + EMA slope positive + compression + 4H bullish
  if (stochRsi > 45 && emaSlope > 0 && volatilityLevel < 40 && htf4hTrend === "BULLISH") {
    direction = "LONG";
  }
  // SHORT condition: stochRsi falling + EMA slope negative + compression + 4H bearish
  else if (stochRsi < 55 && emaSlope < 0 && volatilityLevel < 40 && htf4hTrend === "BEARISH") {
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

    // HTF alignment data
    htf4hTrend,
    htf4hMomentum,
    htf1hAlignment,
    htf15mCompression,

    notes: direction !== "NEUTRAL" ? `Momentum: ${direction}` : "Waiting for setup",
    updatedAt: new Date().toISOString(),
  };

  return card;
}
