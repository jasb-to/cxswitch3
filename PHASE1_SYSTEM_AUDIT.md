# Phase 1: Complete System Audit & Architecture Analysis

**File:** lib/strategy-v6.ts (1159 lines)  
**Audit Date:** 2026-05-17  
**Status:** In Progress

## System Overview

### Current Architecture (v8.5 with Level-Awareness)
The system executes 2 parallel pipelines:
1. **Execution Pipeline** (Kraken) → strategy engine → ACTIVE_SNIPER/ACTIVE_CONFIRMED states
2. **Display Pipeline** (CoinGecko) → separate cards → SNIPER_READY/CONFIRMED_READY states

### Key Exported Functions
```
- executeStrategy(markets, options) → { setups, cards, alerts }
- generateSetups(markets) → Setup[]
- generateDisplayCards(markets) → SymbolCardState[]
```

### Type System
- SignalState: 8 states including new WATCH_BREAKOUT
- SymbolCardState: Card representation with indicators
- BreakoutState: NONE, BREAKOUT_UP, BREAKOUT_DOWN, RETEST_PHASE
- LevelAwareness: Key level tracking

## CONTAMINATION ANALYSIS

### Issue 1: ACTIVE_CONFIRMED Still Present (Line 209, 330+)
- System still generates ACTIVE_CONFIRMED states
- v21.1.0 plan specifies: NO ACTIVE_CONFIRMED, only ACTIVE_SNIPER
- Affects: Signal state logic, alert triggers, UI display

### Issue 2: Multiple Direction Inference Points
- Lines 1065-1110: Main direction inference (momentum-first historically)
- Now enhanced with v8.5 breakout-awareness
- But still has fallback logic that may be incomplete

### Issue 3: Card Generation Mutations
- Display cards created separately from execution
- Both paths compute similar logic independently
- Risk of divergence and inconsistency

### Issue 4: Breakout State Not Persisted
- v8.5 computes breakout state fresh each cycle
- Should track across cycles for retest phase continuity
- Currently: `computeLevelAwareness(price, null, "NONE")` always starts NONE

## ARCHITECTURE STRENGTHS (Keep)

1. **Dual Pipeline Separation**
   - Execution (Kraken real-time) ✓
   - Display (CoinGecko async) ✓
   - Proper isolation

2. **Level Awareness Layer**
   - Breakout detection working ✓
   - Direction validation against breakouts ✓
   - WATCH_BREAKOUT state prevents contradictions ✓

3. **Impulse-Based Quality Filter**
   - computeImpulseStrength() existing ✓
   - Used for impulse >= 27 → ACTIVE_SNIPER ✓
   - Score propagation verified ✓

## ARCHITECTURE WEAKNESSES (Fix in v21.1.0)

1. **Not Truly Deterministic**
   - Direction inference has multiple branches
   - Fallback logic present (default LONG bias historically)
   - Need single deterministic path

2. **ACTIVE_CONFIRMED Still Running**
   - Creates parallel state branches
   - Alert system must gate it (adds complexity)
   - v21.1.0: DELETE entirely

3. **Post-Processing Risk**
   - Card mutations possible after creation
   - Direction may be overridden or modified
   - v21.1.0: Lock state at creation

4. **Breakout State Ephemeral**
   - Resets each cycle
   - Retest phase continuity lost
   - v21.1.0: Add state persistence layer

## FUNCTION-BY-FUNCTION BREAKDOWN

### Entry Points (3 total)
1. `executeStrategy()` - Main orchestrator
2. `generateSetups()` - Execution pipeline
3. `generateDisplayCards()` - Display pipeline

### Core Calculations (4 main)
1. `computeImpulseStrength()` - Impulse engine
2. `calculateTradeReadinessScore()` - Confidence scoring
3. `calculateLiveMarketState()` - Market classification
4. `computeLevelAwareness()` - Breakout detection (v8.5)

### Direction Logic (2 paths)
1. Main direction inference (lines 1065-1110) - MAIN PATH
2. Direction validation with breakout awareness (lines 1106-1110) - v8.5 ADDITION

### State Machine (8 states)
- NONE, BUILDING, SNIPER_READY, CONFIRMED_READY, ACTIVE_SNIPER, ACTIVE_CONFIRMED, WATCH_BREAKOUT
- v21.1.0: Reduce to 5 (NONE, BUILDING, ACTIVE_SNIPER, WATCHING, classification metadata)

### Card Creation (2 templates)
- Execution cards (with ACTIVE_SNIPER)
- Display cards (with SNIPER_READY)
- Should converge to single deterministic path

## v21.1.0 MIGRATION REQUIREMENTS

### Phase 2: Architecture
- [ ] Define 6-phase pipeline
- [ ] Remove ACTIVE_CONFIRMED execution path
- [ ] Consolidate direction inference to single function
- [ ] Add state persistence for breakout tracking

### Phase 3: Consolidation
- [ ] Delete CONFIRMED logic from generateSetups()
- [ ] Remove display-specific mutations
- [ ] Merge candle processing (Phase 1)

### Phase 4: Direction Engine
- [ ] Make direction truly structure-first
- [ ] Incorporate breakout state as primary signal
- [ ] Add level-aware validation as hard gate
- [ ] Document precedence rules

### Phase 5: Terminal ACTIVE_SNIPER
- [ ] Once impulse >= 27, state = ACTIVE_SNIPER (immutable)
- [ ] Remove any later downgrades
- [ ] Gate at alert level if needed

### Phase 6: Clean Output
- [ ] Snapshot creation with no post-processing
- [ ] Remove all mutations after state assignment
- [ ] Direct persistence

## SUCCESS METRICS

- [ ] File size: 1159 → ~600 lines (50% reduction)
- [ ] Functions: 27 → 15 (consolidation)
- [ ] Execution passes: 2 → 1 (deterministic)
- [ ] ACTIVE_CONFIRMED: Present → Deleted
- [ ] Breakout state: Ephemeral → Persisted
- [ ] Direction inference: 3 paths → 1 deterministic path

## NEXT STEPS

1. Document all current functions with data flow
2. Map dependency graph
3. Identify exact lines to delete vs refactor
4. Create Phase 2 detailed implementation plan
