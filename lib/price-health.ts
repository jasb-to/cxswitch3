/**
 * Price Health Tracking & Control
 * 
 * Manages three states:
 * LIVE → ticker active, full system operational
 * DEGRADED → fallback candle prices only, limited operations (UI + signal generation only)
 * OFFLINE → no price data, system frozen except display
 */

export type PriceHealthStatus = "LIVE" | "DEGRADED" | "OFFLINE";

export interface PriceHealth {
  status: PriceHealthStatus;
  symbol: string;
  priceSource: "ticker" | "fallback_candle" | "none";
  lastTickerCheck: number; // timestamp
  tickerFailCount: number; // consecutive failures
  reason?: string;
}

/**
 * Determine price health based on price source and history
 */
export function determinePriceHealth(
  priceSource: "ticker" | "fallback_candle" | undefined,
  tickerFailCount: number = 0
): PriceHealthStatus {
  // OFFLINE: no price source at all
  if (!priceSource || priceSource === "none") {
    return "OFFLINE";
  }

  // DEGRADED: using fallback (candle close), ticker is down
  if (priceSource === "fallback_candle") {
    return "DEGRADED";
  }

  // LIVE: active ticker feed
  if (priceSource === "ticker") {
    return "LIVE";
  }

  return "OFFLINE";
}

/**
 * Check if system should allow signal generation
 * LIVE and DEGRADED allow generation (UI state)
 * OFFLINE blocks generation
 */
export function canGenerateSignals(status: PriceHealthStatus): boolean {
  return status === "LIVE" || status === "DEGRADED";
}

/**
 * Check if system should allow TP/SL execution and state reconciliation
 * Only LIVE allows these time-sensitive operations
 * DEGRADED blocks to prevent false triggers
 */
export function canExecuteTradeLogic(status: PriceHealthStatus): boolean {
  return status === "LIVE";
}

/**
 * Check if system should allow invalidation checks
 * Only LIVE allows invalidation (requires live structure data)
 * DEGRADED blocks to prevent false invalidations
 */
export function canValidateStructure(status: PriceHealthStatus): boolean {
  return status === "LIVE";
}

/**
 * Get human-readable status message for UI banner
 */
export function getPriceHealthMessage(health: PriceHealth): string {
  switch (health.status) {
    case "LIVE":
      return "✓ Live ticker active — full system operational";
    case "DEGRADED":
      return `⚠ ${health.symbol} ticker unavailable — using fallback prices only. No live execution (reconciliation paused).`;
    case "OFFLINE":
      return `✗ ${health.symbol} data offline — system frozen until connection restored`;
    default:
      return "System status unknown";
  }
}

/**
 * Track price health across all symbols in a scan
 */
export function aggregatePriceHealth(healthChecks: PriceHealth[]): {
  overallStatus: PriceHealthStatus;
  healthySymbols: number;
  degradedSymbols: number;
  offlineSymbols: number;
} {
  let healthyCount = 0;
  let degradedCount = 0;
  let offlineCount = 0;

  for (const health of healthChecks) {
    switch (health.status) {
      case "LIVE":
        healthyCount++;
        break;
      case "DEGRADED":
        degradedCount++;
        break;
      case "OFFLINE":
        offlineCount++;
        break;
    }
  }

  // Overall status: if any offline, whole system offline; if any degraded, system degraded; else live
  let overallStatus: PriceHealthStatus = "LIVE";
  if (offlineCount > 0) {
    overallStatus = "OFFLINE";
  } else if (degradedCount > 0) {
    overallStatus = "DEGRADED";
  }

  return {
    overallStatus,
    healthySymbols: healthyCount,
    degradedSymbols: degradedCount,
    offlineSymbols: offlineCount,
  };
}
