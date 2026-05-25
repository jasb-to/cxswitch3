/**
 * CLEAN API LAYER - Read-only TradeSignal output
 * 
 * No transformation, no mapping, no duplication
 * Just validates and returns the single source of truth
 */

import type { TradeSignal, ActiveTrade, NoTrade } from "./trade-signal-types";
import { assertValidActiveTrade } from "./trade-signal-types";

/**
 * Format array of TradeSignals for API response
 */
export function formatSignalResponse(signals: TradeSignal[]) {
  return {
    ready: true,
    signals: signals.map((signal) => {
      if (signal.state === "ACTIVE_TRADE") {
        // Validate before returning
        assertValidActiveTrade(signal);
        
        return {
          state: signal.state,
          symbol: signal.symbol,
          direction: signal.direction,
          entry: signal.entry,
          stopLoss: signal.stopLoss,
          targets: {
            tp1: signal.takeProfit1,
            tp2: signal.takeProfit2,
          },
          riskReward: signal.riskReward,
          confidence: signal.confidence,
          reason: signal.reason,
          structure: signal.structure,
          trend: signal.htf4hTrend,
          timestamp: signal.timestamp,
        };
      } else {
        // DO_NOT_TRADE - minimal response
        return {
          state: signal.state,
          reason: signal.reason,
        };
      }
    }),
  };
}


/**
 * Format for Telegram alert (only ACTIVE_TRADE)
 */
export function formatTelegramAlert(signal: TradeSignal): string | null {
  if (signal.state !== "ACTIVE_TRADE") {
    return null; // No alert for DO_NOT_TRADE
  }

  assertValidActiveTrade(signal);

  const lines = [
    `🚨 ${signal.direction} ${signal.symbol}`,
    "",
    `Entry: ${signal.entry.toFixed(4)}`,
    `TP1: ${signal.takeProfit1.toFixed(4)}`,
    `TP2: ${signal.takeProfit2.toFixed(4)}`,
    `SL: ${signal.stopLoss.toFixed(4)}`,
    `R:R: ${signal.riskReward.toFixed(2)}`,
    "",
    `Confidence: ${signal.confidence}%`,
    `Reason: ${signal.reason}`,
  ];

  return lines.join("\n");
}

/**
 * Format for database storage
 */
export function formatSignalForDB(signal: TradeSignal) {
  return {
    state: signal.state,
    ...(signal.state === "ACTIVE_TRADE" && {
      symbol: signal.symbol,
      direction: signal.direction,
      entry: signal.entry,
      stopLoss: signal.stopLoss,
      tp1: signal.takeProfit1,
      tp2: signal.takeProfit2,
      riskReward: signal.riskReward,
      confidence: signal.confidence,
      reason: signal.reason,
    }),
    ...(signal.state === "DO_NOT_TRADE" && {
      reason: signal.reason,
    }),
    timestamp: signal.timestamp || new Date().toISOString(),
  };
}
