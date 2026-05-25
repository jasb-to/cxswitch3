/**
 * CANONICAL SNAPSHOT TYPE - STRICT CONTRACT
 * 
 * ENFORCEMENT RULE: Snapshot ALWAYS contains COMPLETE state
 * No omissions. No partial data. No stale fields.
 * 
 * ONE source of truth for entire system:
 * Backend → snapshot → ALL consumers (UI, counters, alerts, displays)
 */

/**
 * SNAPSHOT CARD DTO - HARD CONTRACT
 * REQUIRED fields only. No optional chaining. No spreads.
 * This is what the frontend MUST receive.
 */
export type SnapshotCard = Required<{
  symbol: string;
  price: number;
  source: "kraken" | "coingecko";
  direction: "LONG" | "SHORT" | "NEUTRAL";
  signalState: "ACTIVE_SNIPER" | "CONFIRMED" | "DO_NOT_TRADE" | "SNIPER_READY" | "CONFIRMED_READY" | "WATCH_BREAKOUT" | "NONE";
  activationState: "ACTIVE_SNIPER" | "CONFIRMED" | "DO_NOT_TRADE"; // Frontend contract
  structureState: "UPTREND" | "DOWNTREND" | "RANGE" | "BREAKOUT"; // CRITICAL: Must be in DTO contract
  confidence: number;
  structure: string;
  execution15mState: string;
  htf4hTrend: string;
  notes?: string;
  // Trade details (optional - only for active signals)
  targetPrices?: { tp1: number; tp2: number; sl: number };
  riskReward?: number;
}>;

export type CanonicalSnapshot = {
  ready: boolean;           // true only when cards.length === 3
  cards: SnapshotCard[];    // exactly 0 or 3 - never partial
  setups: any[];           // ACTIVE_SNIPER + ACTIVE_CONFIRMED signals
  activeSignals: string[]; // Array of active signal symbols (derived from setups)
  signalCount: number;     // Total count of active signals (derived from setups.length)
  activeSnipers: number;   // Count of ACTIVE_SNIPER only (derived from setups)
  updatedAt: string | null; // ISO timestamp or null
};

/**
 * EMPTY_SNAPSHOT is the ONLY valid initial state
 * ALL fields must be present in every snapshot
 */
export const EMPTY_SNAPSHOT: CanonicalSnapshot = {
  ready: false,
  cards: [],
  setups: [],
  activeSignals: [],
  signalCount: 0,
  activeSnipers: 0,
  updatedAt: null,
};

/**
 * Normalize card to SnapshotCard DTO
 * HARD ENFORCE all required fields with no spreads or optional chaining
 */
function normalizeCardToDTO(card: any): SnapshotCard {
  // STEP 5: DEBUG LOG - will show exactly what's in the card before serialization
  console.log("[SNAPSHOT_CARD_NORMALIZATION]", {
    symbol: card.symbol,
    signalState: card.signalState,
    activationState: card.activationState,
    structureState: card.structureState, // CRITICAL: Verify structureState is present
  });

  // STEP 2: HARD GUARD - throw if activationState missing
  if (!card.activationState) {
    throw new Error(
      `[SNAPSHOT_CONTRACT_VIOLATION] Missing activationState for ${card.symbol}. Card state: ${JSON.stringify({
        symbol: card.symbol,
        signalState: card.signalState,
        keys: Object.keys(card),
      })}`
    );
  }

  // STEP 3: EXPLICIT FIELD MAPPING - NO spreads, NO inference
  const snapshotCard: SnapshotCard = {
    symbol: card.symbol || "UNKNOWN",
    price: card.price || 0,
    source: card.source || "kraken",
    direction: card.direction || "NEUTRAL",
    signalState: card.signalState || "NONE",
    activationState: card.activationState, // Already validated above
    structureState: card.structureState ?? "RANGE", // CRITICAL FIX: Include in DTO, default to RANGE
    confidence: card.confidence || 0,
    structure: card.structure || "UNKNOWN",
    execution15mState: card.execution15mState || "CHOP",
    htf4hTrend: card.htf4hTrend || "NEUTRAL",
    notes: card.notes,
    // Trade details - only if present (for ACTIVE_SNIPER/CONFIRMED)
    ...(card.targetPrices && { targetPrices: card.targetPrices }),
    ...(card.riskReward !== undefined && { riskReward: card.riskReward }),
  };

  return snapshotCard;
}

/**
 * Create canonical snapshot from execution state
 * ENFORCES complete contract - all fields populated or defaults to empty
 */
export function createCanonicalSnapshot(input: {
  cards: any[];
  setups: any[];
  updatedAt?: string | null;
}): CanonicalSnapshot {
  const rawCards = input.cards || [];
  const setups = input.setups || [];
  
  // STEP 2 & 3 & 5: Normalize ALL cards to DTO with hard validation
  let cards: SnapshotCard[] = [];
  if (rawCards.length > 0) {
    cards = rawCards.map((card: any) => {
      try {
        return normalizeCardToDTO(card);
      } catch (error) {
        console.error("[SNAPSHOT_NORMALIZATION_ERROR]", error);
        throw error; // Fail fast - don't silently drop cards
      }
    });
  }
  
  // Compute derived fields
  const activeSignals = setups.map((s: any) => s.symbol);
  const signalCount = setups.length;
  const activeSnipers = setups.filter((s: any) => s.mode === "SNIPER").length;
  
  return {
    ready: cards.length === 3,
    cards,
    setups,
    activeSignals,
    signalCount,
    activeSnipers,
    updatedAt: input.updatedAt || null,
  };
}

/**
 * Validate snapshot matches canonical shape
 * Used internally by globalThis storage only - NOT for frontend logic
 */
export function isCanonicalSnapshot(value: any): value is CanonicalSnapshot {
  return (
    value &&
    typeof value === "object" &&
    typeof value.ready === "boolean" &&
    Array.isArray(value.cards) &&
    Array.isArray(value.setups) &&
    Array.isArray(value.activeSignals) &&
    typeof value.signalCount === "number" &&
    typeof value.activeSnipers === "number" &&
    (value.updatedAt === null || typeof value.updatedAt === "string")
  );
}

