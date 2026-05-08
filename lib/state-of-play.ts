import type { Signal } from "./strategy";
import type { MarketContext } from "./strategy";

/**
 * Generate contextual cycle explanation for each symbol
 * Explains market phase without exposing technical scores or gates
 * 
 * SNIPER/CONFIRMED strategy cycle:
 * EARLY_OPEN: Momentum expansion beginning — tight invalidation, small stop
 * CONFIRMED: Retest holding — continuation phase, dynamic runner extension
 * NO_SETUP: Structure recognized but not yet triggered
 */
export function getStateOfPlay(signal: Signal | undefined, market: MarketContext | undefined): string {
  // Active signal: describe trade phase
  if (signal) {
    switch (signal.state) {
      case "EARLY_OPEN":
        const direction = signal.direction === "LONG" ? "bullish" : "bearish";
        return `Momentum expansion beginning from ${direction} structure. Waiting for retest confirmation.`;

      case "CONFIRMED":
        return `Retest holding — continuation phase active. TP1 protected, managing runner with trailed stop.`;

      case "END":
        if (signal.outcome === "TP") {
          return "Target hit. Wave expansion captured. Cycle complete.";
        }
        if (signal.outcome === "SL") {
          return "Invalidation hit. Structure failed. Cycle reset.";
        }
        if (signal.outcome === "STRUCTURE_INVALIDATED") {
          return "Structure collapsed. Entry invalidated. New cycle beginning.";
        }
        return "Trade ended. New cycle starting.";

      default:
        return "Trade in progress. Monitoring structure.";
    }
  }

  // No active signal: describe market structure state
  if (market) {
    switch (market.setup) {
      case "SHORT_SETUP":
        return "Bearish structure recognized. Waiting for momentum expansion to trigger entry.";

      case "LONG_SETUP":
        return "Bullish structure recognized. Waiting for momentum expansion to trigger entry.";

      case "NO_SETUP":
        return "Market cycling through consolidation. Structure not yet defined.";

      case "ERROR":
        return "Market data unavailable. Check connection status.";

      default:
        return "Analyzing market structure formation.";
    }
  }

  return "Loading market context...";
}
