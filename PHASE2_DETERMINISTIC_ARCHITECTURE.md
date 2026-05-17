# Phase 2: 6-Phase Deterministic Pipeline Architecture

**Status:** Design Document  
**Target:** v21.1.0  
**Goal:** Replace 2-pipeline architecture with single deterministic 6-phase execution

## Executive Summary

Current system (v8.5) has:
- 2 parallel pipelines (execution + display)
- 2 entry points (generateSetups + generateDisplayCards)
- Multiple direction inference paths
- ACTIVE_CONFIRMED legacy state
- Ephemeral breakout state

New system (v21.1.0) will have:
- **1 deterministic pipeline** with 6 sequential phases
- **1 entry point** (executeStrategy)
- **1 direction inference path** (structure-first)
- **ACTIVE_SNIPER only** (no CONFIRMED)
- **Persistent breakout state** across cycles

## The 6-Phase Pipeline

### Phase 1: Market Data Ingestion (Once-Only)
```
Input: { kraken: MarketData[], coingecko: MarketData[] }
Output: { kraken: ProcessedCandles[], coingecko: ProcessedCandles[] }

Actions:
- Normalize OHLCV data from both sources
- Compute base indicators (EMA, Stoch, volatility) from Kraken only
- Store display prices from CoinGecko (never used for execution logic)
- Cache computed candles for impulse engine

Risk Mitigation:
- Execute this phase once per cycle
- No mutations to input data
- Separate storage for Kraken vs CoinGecko
```

### Phase 2: Structure-First Direction Inference
```
Input: { kraken: ProcessedCandles, breakoutState: BreakoutState, levelTracking: LevelData }
Output: direction: "LONG" | "SHORT" | "NEUTRAL"

Actions:
- Compute recent swing levels (recentHigh, recentLow from 20-period candles)
- Detect breakout events (price crossing levels)
- Update breakout state machine (NONE → BREAKOUT_UP/DOWN → RETEST_PHASE)
- Derive direction from structure FIRST:
  * 4H macro trend (if not NEUTRAL)
  * Breakout state (never contradicts)
  * EMA slope (strong signals override)
  * Momentum/Stoch (tie-breaker only)
- Validate direction against breakout: reject if contradictory

Result: Deterministic direction that respects structure
```

### Phase 3: Canonical Impulse Calculation (One-Time)
```
Input: { direction, kraken_candles, level_data }
Output: impulse >= 0 (0-100 scale)

Actions:
- Compute impulse strength ONCE (currently: computeImpulseStrength)
- Check 5M ignition triggers (compression breakout)
- Factor in 15M execution state
- Apply macro momentum modifier (-5 for counter-macro)
- Result: Single impulse value per symbol

No mutations, no decay, no downgrades
```

### Phase 4: Quality Gating & State Assignment
```
Input: { impulse, direction, score }
Output: signalState, confidence

Actions:
- IF impulse >= 27 AND direction != NEUTRAL:
  → signalState = "ACTIVE_SNIPER"
  → confidence = impulse (0-100)
- ELSE IF direction != NEUTRAL:
  → signalState = "BUILDING"
  → confidence = 0 (or lower value)
- ELSE:
  → signalState = "NONE"
  → confidence = 0

State is IMMUTABLE once assigned (no later downgrades)
```

### Phase 5: Signal Enrichment & Metadata
```
Input: { signalState, direction, impulse, score, level_data }
Output: SymbolCardState with metadata

Actions:
- Populate execution metadata (entry, TP1, TP2, SL, R:R)
- Add breakout state and level tracking
- Compute trade readiness score
- Classify market context (EXPANDING, COMPRESSING, CHOP)
- Add display prices from CoinGecko (never affects logic)
- Populate notes (state reason, breakout phase, etc)

All data is additive (no mutations to previous phases)
```

### Phase 6: Atomic Snapshot & Output
```
Input: All enriched cards from Phase 5
Output: Atomic snapshot with ready flag

Actions:
- Collect all cards into array
- Set ready = true IFF cards.length === 3
- Capture timestamp (updatedAt)
- Lock snapshot (no post-processing)
- Return to caller

No mutations after this point
```

## Architecture Diagrams

### Current (v8.5) - 2-Pipeline
```
Kraken → generateSetups()
           ↓
         [Card 1, Card 2, Card 3]
         Signals: ACTIVE_SNIPER, BUILDING, SNIPER_READY
         
CoinGecko → generateDisplayCards()
             ↓
           [Card 1, Card 2, Card 3]
           Signals: SNIPER_READY, CONFIRMED_READY, BUILDING

Alert System: Must gate ACTIVE_CONFIRMED (legacy complexity)
```

### Target (v21.1.0) - 1-Pipeline, 6-Phases
```
Kraken + CoinGecko
   ↓
Phase 1: Ingest & normalize (once-only)
   ↓
Phase 2: Structure-first direction (deterministic)
   ↓
Phase 3: Canonical impulse (one-time calculation)
   ↓
Phase 4: Quality gating (ACTIVE_SNIPER gate)
   ↓
Phase 5: Enrichment (metadata, display prices, notes)
   ↓
Phase 6: Atomic snapshot (ready flag, lock, return)

Result: One clean signal flow, one direction inference path
```

## Implementation Order (Reverse)

Build from Phase 6 upward to ensure dependencies are clear:

1. **Phase 6 First:** Define snapshot structure and atomicity
2. **Phase 5 Next:** Implement enrichment with snapshot structure in mind
3. **Phase 4:** Quality gating logic (inputs to Phase 5)
4. **Phase 3:** Impulse engine (simpler than direction)
5. **Phase 2:** Structure-first direction (uses Phase 1 output)
6. **Phase 1 Last:** Market data ingestion (used by all phases)

## Type System (Simplified for v21.1.0)

### Reduced SignalState (from 8 → 5)
```typescript
type SignalState = 
  | "NONE"            // No signal
  | "BUILDING"        // Directional bias, waiting for impulse
  | "ACTIVE_SNIPER"   // Impulse >= 27, ready for trade
  | "WATCH_BREAKOUT"  // Breakout detected, holding direction
  | "AWAITING";       // Placeholder for future features
```

### Simplified SymbolCardState
```typescript
type SymbolCardState = {
  // Core execution data
  symbol: string;
  direction: "LONG" | "SHORT" | "NEUTRAL";
  signalState: SignalState;
  impulse: number;
  confidence: number;
  
  // Market context (Phase 5 enrichment)
  breakoutState: BreakoutState;
  recentHigh: number;
  recentLow: number;
  
  // Trade metadata (Phase 5)
  entry: number;
  tp1: number;
  tp2: number;
  sl: number;
  riskReward: number;
  
  // Display data (CoinGecko, Phase 5)
  displayPrice: number;
  
  // Metadata
  updatedAt: string;
  notes: string;
};
```

## Key Design Principles

1. **Deterministic:** Same input → same output, always
2. **Structure-First:** Levels and breakout state before momentum
3. **One-Time:** Calculations happen once per phase, not repeatedly
4. **Immutable State:** Once signalState set, never changed
5. **Atomic Snapshot:** All-or-nothing output, no partial updates
6. **No Post-Processing:** No mutations after state assignment

## Success Criteria

- [ ] Single entry point: executeStrategy()
- [ ] 6 sequential phases, each with clear input/output
- [ ] Direction inference: 1 deterministic path (no fallback branches)
- [ ] ACTIVE_SNIPER only (ACTIVE_CONFIRMED deleted)
- [ ] Breakout state persistent across cycles
- [ ] File size: 1159 → ~600 lines
- [ ] Functions: 27 → 15
- [ ] All tests pass with new architecture

## Next Steps

1. Build Phase 6 snapshot structure
2. Implement Phase 5 enrichment
3. Implement Phase 4 quality gating
4. Implement Phase 3 impulse engine
5. Implement Phase 2 direction inference
6. Implement Phase 1 data ingestion
7. Wire all phases together in executeStrategy()
8. Delete legacy code (generateSetups, generateDisplayCards, CONFIRMED logic)
