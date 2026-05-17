/**
 * v8.2: UNIFIED MARKET STATE ENGINE
 * 
 * ONE canonical asset state per asset (BTC, ETH, SOL)
 * ONE fetch pass per cycle (no duplication)
 * ONE source of truth for price/metrics
 * 
 * Eliminates:
 * - 8x duplicate Kraken fetches
 * - Schema drift between pipelines
 * - Inconsistent card states
 * - Disappearing assets
 */

export interface CanonicalAssetState {
  // Identity
  symbol: string;
  normalizedSymbol: string;  // Canonical form: BTC, ETH, SOL
  
  // Price & Market Data (single source of truth)
  price: number;
  source: "kraken" | "coingecko";
  lastFetched: number;
  fetchAge: number;  // ms since fetch
  
  // Quality Metrics
  executionGrade: boolean;  // Kraken? (true) or degraded? (false)
  degraded: boolean;
  confidence: number;  // 0-1 market data quality
  
  // Execution Pipeline State
  signalState: "NEUTRAL" | "BUILDING" | "SNIPER_READY" | "ACTIVE_SNIPER" | "ACTIVE_CONFIRMED" | "EXIT";
  direction: "LONG" | "SHORT" | "NEUTRAL";
  mode: "SNIPER" | "SCALP" | "SWING" | "NONE";
  
  // Target/Stop Loss (set only for ACTIVE_SNIPER)
  targetPrices: { tp1: number; tp2: number; tp3: number } | null;
  stopLoss: number | null;
  riskReward: number | null;
  
  // HTF/Technical (execution grade only)
  htf4hTrend: "UP" | "DOWN" | "NEUTRAL" | null;
  htf4hMomentum: boolean | null;
  htf1hAlignment: boolean | null;
  execution15mState: "SNIPE" | "SCALP" | "CHOP" | null;
  
  // Metadata
  cycleId: string;
  updatedAt: string;
  notes?: string;
}

// Canonical state store (ONE per asset)
const canonicalStates = new Map<string, CanonicalAssetState>();

/**
 * Initialize canonical state for an asset
 * Called once per asset per cycle at fetch time
 */
export function initializeCanonicalState(
  symbol: string,
  price: number,
  source: "kraken" | "coingecko"
): CanonicalAssetState {
  const normalized = normalizeSymbol(symbol);
  
  const state: CanonicalAssetState = {
    symbol,
    normalizedSymbol: normalized,
    price,
    source,
    lastFetched: Date.now(),
    fetchAge: 0,
    executionGrade: source === "kraken",
    degraded: source !== "kraken",
    confidence: source === "kraken" ? 1.0 : 0.7,
    signalState: "NEUTRAL",
    direction: "NEUTRAL",
    mode: "NONE",
    targetPrices: null,
    stopLoss: null,
    riskReward: null,
    htf4hTrend: null,
    htf4hMomentum: null,
    htf1hAlignment: null,
    execution15mState: null,
    cycleId: `${Date.now()}-${normalized}`,
    updatedAt: new Date().toISOString(),
  };
  
  canonicalStates.set(normalized, state);
  return state;
}

/**
 * Update canonical state with signal engine results
 */
export function updateCanonicalState(
  normalized: string,
  updates: Partial<CanonicalAssetState>
): CanonicalAssetState {
  const existing = canonicalStates.get(normalized);
  if (!existing) {
    throw new Error(`No canonical state for ${normalized}`);
  }
  
  const updated = { ...existing, ...updates, updatedAt: new Date().toISOString() };
  canonicalStates.set(normalized, updated);
  return updated;
}

/**
 * Get canonical state for an asset
 */
export function getCanonicalState(normalized: string): CanonicalAssetState | null {
  return canonicalStates.get(normalized) || null;
}

/**
 * Get all canonical states as array (for snapshot)
 */
export function getAllCanonicalStates(): CanonicalAssetState[] {
  return Array.from(canonicalStates.values());
}

/**
 * Clear all canonical states (start fresh cycle)
 */
export function clearCanonicalStates(): void {
  canonicalStates.clear();
}

/**
 * Normalize symbol to canonical form
 * XXBTZUSD → BTC, XETHZUSD → ETH, XSOLZUSD → SOL
 */
function normalizeSymbol(symbol: string): string {
  const upper = symbol.toUpperCase();
  
  if (upper.includes("BTC") || upper.includes("XBT")) return "BTC";
  if (upper.includes("ETH")) return "ETH";
  if (upper.includes("SOL")) return "SOL";
  
  return upper;
}

/**
 * Export canonical state to card format (for snapshot)
 */
export function canonicalToCard(state: CanonicalAssetState): any {
  return {
    symbol: state.normalizedSymbol,
    price: state.price,
    source: state.source,
    degraded: state.degraded,
    signalState: state.signalState,
    direction: state.direction,
    mode: state.mode,
    targetPrices: state.targetPrices,
    stopLoss: state.stopLoss,
    riskReward: state.riskReward,
    htf4hTrend: state.htf4hTrend,
    htf4hMomentum: state.htf4hMomentum,
    htf1hAlignment: state.htf1hAlignment,
    execution15mState: state.execution15mState,
    confidence: state.confidence,
    cycleId: state.cycleId,
    updatedAt: state.updatedAt,
    notes: state.notes,
  };
}
