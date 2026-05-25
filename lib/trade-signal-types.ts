/**
 * SINGLE SOURCE OF TRUTH - TradeSignal Model
 * 
 * Only two valid states exist:
 * 1. ACTIVE_TRADE - fully valid, all fields populated
 * 2. DO_NOT_TRADE - only reason field populated
 * 
 * NO transformation layers, NO snapshots, NO canonical variants
 */

export type TradeSignal = ActiveTrade | NoTrade;

/**
 * ACTIVE_TRADE: Market conditions warrant a trade entry
 * ALL fields are mandatory and must be valid numbers > 0
 */
export interface ActiveTrade {
  state: "ACTIVE_TRADE";
  symbol: string;
  direction: "LONG" | "SHORT";
  
  // Entry setup - all required, all > 0
  entry: number;           // Current market price
  stopLoss: number;        // Hard stop level
  takeProfit1: number;     // First target
  takeProfit2: number;     // Second target
  riskReward: number;      // Risk/reward ratio
  
  // Context
  confidence: number;      // 0-100
  reason: string;          // Why this trade fires
  structure: string;       // Market structure state
  htf4hTrend: string;      // Higher timeframe trend
  timestamp: string;       // ISO timestamp
}

/**
 * NO_TRADE: Market conditions do not warrant entry
 * ONLY reason is populated, NO trade fields
 */
export interface NoTrade {
  state: "DO_NOT_TRADE";
  reason: string;
}

/**
 * Market data input to strategy engine
 */
export interface MarketData {
  symbol: string;
  price: number;
  emaShort: number;
  emaLong: number;
  ema1h: number;
  ema4h: number;
  htf4hTrend: string;
  structure: string;
  volumeProfile: {
    high: number;
    low: number;
  };
}

/**
 * Validation result for fail-fast checking
 */
export function validateActiveTrade(trade: any): trade is ActiveTrade {
  if (trade.state !== "ACTIVE_TRADE") return false;
  if (!trade.symbol || typeof trade.symbol !== "string") return false;
  if (!["LONG", "SHORT"].includes(trade.direction)) return false;
  if (!isValidTradeLevel(trade.entry)) return false;
  if (!isValidTradeLevel(trade.stopLoss)) return false;
  if (!isValidTradeLevel(trade.takeProfit1)) return false;
  if (!isValidTradeLevel(trade.takeProfit2)) return false;
  if (!isValidTradeLevel(trade.riskReward)) return false;
  if (typeof trade.confidence !== "number" || trade.confidence < 0 || trade.confidence > 100) return false;
  return true;
}

/**
 * Check if value is valid for trade levels (must be > 0)
 */
function isValidTradeLevel(value: any): boolean {
  return typeof value === "number" && value > 0 && isFinite(value);
}

/**
 * Fail-fast validation - throws if invalid
 */
export function assertValidActiveTrade(trade: any): asserts trade is ActiveTrade {
  if (trade.state !== "ACTIVE_TRADE") {
    throw new Error(`Expected ACTIVE_TRADE, got ${trade.state}`);
  }
  if (!trade.symbol || typeof trade.symbol !== "string") {
    throw new Error("Missing symbol");
  }
  if (!["LONG", "SHORT"].includes(trade.direction)) {
    throw new Error(`Invalid direction: ${trade.direction}`);
  }
  
  const fields = ["entry", "stopLoss", "takeProfit1", "takeProfit2", "riskReward"];
  for (const field of fields) {
    if (!isValidTradeLevel(trade[field])) {
      throw new Error(`Invalid ${field}: ${trade[field]} (must be number > 0)`);
    }
  }
  
  if (typeof trade.confidence !== "number" || trade.confidence < 0 || trade.confidence > 100) {
    throw new Error(`Invalid confidence: ${trade.confidence} (must be 0-100)`);
  }
}
