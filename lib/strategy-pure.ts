/**
 * PURE STRATEGY ENGINE - Single responsibility
 * 
 * Input: MarketData
 * Output: TradeSignal (either ACTIVE_TRADE or DO_NOT_TRADE)
 * 
 * Rules:
 * - No state mutations
 * - No partial returns
 * - Fail-fast on invalid data
 * - Return complete signal or explicit rejection
 */

import type { TradeSignal, ActiveTrade, NoTrade, MarketData } from "./trade-signal-types";

export function generateTradeSignal(market: MarketData): TradeSignal {
  // Step 1: Validate market data exists
  if (!market.symbol || !market.price || market.price <= 0) {
    return {
      state: "DO_NOT_TRADE",
      reason: "Invalid market data: missing symbol or price",
    };
  }

  // Step 2: Check EMA alignment (fundamental requirement)
  if (market.emaShort === null || market.emaLong === null) {
    return {
      state: "DO_NOT_TRADE",
      reason: "EMA calculation failed - cannot establish trend",
    };
  }

  // Step 3: Determine direction from EMA
  const direction = market.emaShort > market.emaLong ? "LONG" : "SHORT";

  // Step 4: Check structure (market condition)
  const isCleanStructure = checkStructure(market);
  if (!isCleanStructure) {
    return {
      state: "DO_NOT_TRADE",
      reason: `Market structure unclear: ${market.structure}`,
    };
  }

  // Step 5: Calculate trade levels
  const tradeSetup = calculateTradeSetup(market, direction);
  if (!tradeSetup) {
    return {
      state: "DO_NOT_TRADE",
      reason: "Trade setup incomplete - cannot calculate levels",
    };
  }

  // Step 6: Validate trade setup is complete
  try {
    const signal: ActiveTrade = {
      state: "ACTIVE_TRADE",
      symbol: market.symbol,
      direction,
      entry: market.price,
      stopLoss: tradeSetup.stopLoss,
      takeProfit1: tradeSetup.takeProfit1,
      takeProfit2: tradeSetup.takeProfit2,
      riskReward: tradeSetup.riskReward,
      confidence: tradeSetup.confidence,
      reason: `${direction} setup confirmed by structure and EMA alignment`,
      structure: market.structure,
      htf4hTrend: market.htf4hTrend,
      timestamp: new Date().toISOString(),
    };

    // Fail-fast validation
    validateSignalComplete(signal);
    return signal;
  } catch (err) {
    return {
      state: "DO_NOT_TRADE",
      reason: `Setup validation failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Check if market structure supports a trade
 */
function checkStructure(market: MarketData): boolean {
  // Only trade in clear structures
  const validStructures = ["UPTREND", "DOWNTREND", "BREAKOUT"];
  return validStructures.includes(market.structure);
}

/**
 * Calculate trade levels from market data
 * Returns null if cannot calculate valid levels
 */
function calculateTradeSetup(
  market: MarketData,
  direction: "LONG" | "SHORT"
): {
  stopLoss: number;
  takeProfit1: number;
  takeProfit2: number;
  riskReward: number;
  confidence: number;
} | null {
  const atr = calculateATR(market);
  if (!atr || atr <= 0) {
    return null;
  }

  if (direction === "LONG") {
    // Stop below structure
    const stopLoss = market.volumeProfile.low * 0.99; // 1% below low
    const riskPips = market.price - stopLoss;

    // Targets at 1:1 and 2:1
    const takeProfit1 = market.price + riskPips;
    const takeProfit2 = market.price + riskPips * 2;

    if (takeProfit1 <= market.price || takeProfit2 <= takeProfit1 || stopLoss >= market.price) {
      return null;
    }

    return {
      stopLoss,
      takeProfit1,
      takeProfit2,
      riskReward: (takeProfit2 - market.price) / (market.price - stopLoss),
      confidence: calculateConfidence(market),
    };
  } else {
    // SHORT direction
    const stopLoss = market.volumeProfile.high * 1.01; // 1% above high
    const riskPips = stopLoss - market.price;

    const takeProfit1 = market.price - riskPips;
    const takeProfit2 = market.price - riskPips * 2;

    if (takeProfit1 >= market.price || takeProfit2 >= takeProfit1 || stopLoss <= market.price) {
      return null;
    }

    return {
      stopLoss,
      takeProfit1,
      takeProfit2,
      riskReward: (market.price - takeProfit2) / (stopLoss - market.price),
      confidence: calculateConfidence(market),
    };
  }
}

/**
 * Calculate ATR-like volatility measure
 */
function calculateATR(market: MarketData): number | null {
  if (!market.volumeProfile.high || !market.volumeProfile.low) {
    return null;
  }

  const range = market.volumeProfile.high - market.volumeProfile.low;
  return range > 0 ? range : null;
}

/**
 * Calculate confidence score 0-100
 */
function calculateConfidence(market: MarketData): number {
  let score = 50; // Base

  // EMA alignment increases confidence
  if (Math.abs(market.emaShort - market.emaLong) > market.price * 0.01) {
    score += 20;
  }

  // Trend alignment from 4H
  if (market.htf4hTrend === "UPTREND" || market.htf4hTrend === "DOWNTREND") {
    score += 15;
  }

  // Structure confirmation
  if (market.structure === "BREAKOUT") {
    score += 10;
  }

  return Math.min(100, score);
}

/**
 * Strict validation - throws on any invalid field
 */
function validateSignalComplete(signal: ActiveTrade): void {
  if (!signal.symbol) throw new Error("Missing symbol");
  if (!["LONG", "SHORT"].includes(signal.direction)) throw new Error("Invalid direction");
  if (signal.entry <= 0) throw new Error("Invalid entry price");
  if (signal.stopLoss <= 0) throw new Error("Invalid stop loss");
  if (signal.takeProfit1 <= 0) throw new Error("Invalid takeProfit1");
  if (signal.takeProfit2 <= 0) throw new Error("Invalid takeProfit2");
  if (signal.riskReward <= 0) throw new Error("Invalid riskReward");

  // Validate logical relationships
  if (signal.direction === "LONG") {
    if (signal.stopLoss >= signal.entry) {
      throw new Error("LONG: stopLoss must be below entry");
    }
    if (signal.takeProfit1 <= signal.entry) {
      throw new Error("LONG: takeProfit1 must be above entry");
    }
    if (signal.takeProfit2 <= signal.takeProfit1) {
      throw new Error("LONG: takeProfit2 must be above takeProfit1");
    }
  } else {
    // SHORT
    if (signal.stopLoss <= signal.entry) {
      throw new Error("SHORT: stopLoss must be above entry");
    }
    if (signal.takeProfit1 >= signal.entry) {
      throw new Error("SHORT: takeProfit1 must be below entry");
    }
    if (signal.takeProfit2 >= signal.takeProfit1) {
      throw new Error("SHORT: takeProfit2 must be below takeProfit1");
    }
  }
}
