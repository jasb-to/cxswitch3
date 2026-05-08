import type { Signal } from "./strategy";
import type { MarketContext } from "./strategy";

/**
 * Generate human-readable state of play explanation for signal cards
 * Describes what's happening in the current cycle for each symbol
 */
export function getStateOfPlay(signal: Signal | undefined, market: MarketContext | undefined): string {
  // Active signal takes priority - describe what the trade is doing
  if (signal) {
    switch (signal.state) {
      case "EARLY_OPEN":
        return "Breakout detected. Waiting for retest confirmation before continuation.";

      case "CONFIRMED":
        return "Breakout confirmed. Momentum phase active and tracking continuation.";

      case "END":
        if (signal.outcome === "TP") {
          return "First target reached. Trade is now in controlled exit / scaling phase.";
        }
        if (signal.outcome === "SL") {
          return "Invalidation hit. Setup has failed and cycle is complete.";
        }
        return "Trade completed. Awaiting new structure formation.";

      default:
        return "Trade in progress. Monitoring for phase transitions.";
    }
  }

  // No active signal - describe market structure state
  if (market) {
    switch (market.setup) {
      case "SHORT_SETUP":
        return "Bearish structure forming. Waiting for trigger confirmation.";

      case "LONG_SETUP":
        return "Bullish structure forming. Monitoring for breakout confirmation.";

      case "NO_SETUP":
        return "No active structure. Market is in consolidation phase.";

      case "ERROR":
        return "Market data unavailable. Check data freshness.";

      default:
        return "Scanning for structure formation.";
    }
  }

  return "Loading market state...";
}
