/**
 * Market Status Mapping
 * 
 * Maps data source to display label and styling.
 * CRITICAL: Never treat fallback/cached as "empty"
 */

export type MarketStatusLabel = "LIVE" | "FALLBACK" | "CACHED" | "UNKNOWN";
export type MarketStatusColor = "green" | "yellow" | "gray";

export type MarketStatus = {
  label: MarketStatusLabel;
  color: MarketStatusColor;
};

export function getMarketStatus(source: string): MarketStatus {
  switch (source) {
    case "kraken_live":
      return { label: "LIVE", color: "green" };
    
    case "coingecko":
      return { label: "FALLBACK", color: "yellow" };
    
    case "cached":
      return { label: "CACHED", color: "gray" };
    
    default:
      return { label: "UNKNOWN", color: "gray" };
  }
}

export function isDegraded(source: string): boolean {
  return source !== "kraken_live";
}
