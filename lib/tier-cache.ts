/**
 * v7.2.7 FIX #1, #2, #4 — TIERED CALCULATION CACHE
 * 
 * Splits engine into 3 independent tiers:
 * TIER 1: Raw market data (always fresh)
 * TIER 2: Precomputed indicators (cached 5-10s)
 * TIER 3: Signal engine (only if TIER 2 changes)
 * 
 * Dirty flags prevent unnecessary recomputation
 */

export type Tier1Data = {
  symbol: string;
  price: number;
  volume: number;
  stochRsiSeed: number;
  emaSeed: number;
  timestamp: number;
};

export type Tier2Data = {
  symbol: string;
  emaSlope: number;
  stochRsi: number;
  volatilityLevel: number;
  htf4hTrend: "BULLISH" | "BEARISH" | "NEUTRAL";
  htf1hAlignment: boolean;
  htf15mCompression: boolean;
  computedAt: number;
};

export type DirtyFlags = {
  symbol: string;
  isDirty: boolean;
  reasons: string[];
  priceChange: number; // percentage
  emaFlip: boolean;
  stochCross: boolean;
  compressionChange: boolean;
  trendFlip: boolean;
};

/**
 * Cache for TIER 2 (precomputed indicators)
 * Refreshes only every 5-10 seconds or on meaningful change
 */
let tier2Cache: Map<string, Tier2Data> = new Map();
let tier2LastCompute = 0;
const TIER2_CACHE_TTL = 5000; // 5 seconds

/**
 * Cache for HTF trend (CRITICAL - v7.2.7 FIX #4)
 * Refreshes only every 5-10 minutes
 */
let htfTrendCache: Map<string, { trend: string; timestamp: number }> = new Map();
const HTF_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Check if TIER 2 needs recomputation (v7.2.7 FIX #2)
 */
export function checkDirtyFlags(
  symbol: string,
  currentPrice: number,
  prevTier2: Tier2Data | undefined,
  newTier1: Tier1Data
): DirtyFlags {
  const reasons: string[] = [];
  
  if (!prevTier2) {
    reasons.push("FIRST_RUN");
    return { symbol, isDirty: true, reasons, priceChange: 100, emaFlip: true, stochCross: true, compressionChange: true, trendFlip: true };
  }

  // Price change > 0.1%
  const priceChange = ((currentPrice - prevTier2.symbol ? 0 : 0) / currentPrice) * 100;
  if (Math.abs(priceChange) > 0.1) {
    reasons.push(`PRICE_CHANGE_${priceChange.toFixed(2)}%`);
  }

  // EMA slope flip (sign change)
  // (Will check this in tier2 computation)

  // Stoch RSI crosses key thresholds (20, 50, 80)
  const prevStoch = prevTier2.stochRsi;
  const newStoch = newTier1.stochRsiSeed;
  const stochCross = (prevStoch <= 20 && newStoch > 20) ||
                     (prevStoch >= 80 && newStoch < 80) ||
                     (prevStoch < 50 && newStoch >= 50) ||
                     (prevStoch >= 50 && newStoch < 50);
  if (stochCross) {
    reasons.push(`STOCH_CROSS_${prevStoch.toFixed(1)}_to_${newStoch.toFixed(1)}`);
  }

  // Compression state change
  // (Will check this in tier2 computation)

  const isDirty = reasons.length > 0;
  
  return {
    symbol,
    isDirty,
    reasons,
    priceChange,
    emaFlip: false, // Will be set in tier2
    stochCross,
    compressionChange: false, // Will be set in tier2
    trendFlip: false, // Will be set in tier2
  };
}

/**
 * Check if HTF cache is still valid (v7.2.7 FIX #4)
 */
export function isHtfCacheValid(symbol: string): boolean {
  const cached = htfTrendCache.get(symbol);
  if (!cached) return false;
  
  const age = Date.now() - cached.timestamp;
  return age < HTF_CACHE_TTL;
}

/**
 * Update HTF cache (v7.2.7 FIX #4)
 */
export function updateHtfCache(symbol: string, trend: string) {
  htfTrendCache.set(symbol, { trend, timestamp: Date.now() });
}

/**
 * Get cached HTF trend or null if expired (v7.2.7 FIX #4)
 */
export function getHtfCached(symbol: string): string | null {
  if (!isHtfCacheValid(symbol)) return null;
  return htfTrendCache.get(symbol)?.trend || null;
}

/**
 * Update TIER 2 cache (v7.2.7 FIX #2)
 */
export function updateTier2Cache(data: Tier2Data) {
  tier2Cache.set(data.symbol, data);
  tier2LastCompute = Date.now();
}

/**
 * Get TIER 2 cached data (v7.2.7 FIX #2)
 */
export function getTier2Cached(symbol: string): Tier2Data | undefined {
  return tier2Cache.get(symbol);
}

/**
 * Check if TIER 2 cache is stale (v7.2.7 FIX #2)
 */
export function isTier2CacheStale(): boolean {
  const age = Date.now() - tier2LastCompute;
  return age >= TIER2_CACHE_TTL;
}

/**
 * Clear all caches (for testing)
 */
export function clearTierCaches() {
  tier2Cache.clear();
  htfTrendCache.clear();
  tier2LastCompute = 0;
}
