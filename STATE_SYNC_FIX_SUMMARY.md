# State Synchronization Fix - UI Counter Now Reflects Execution Layer

## Problem Statement

The signals counter (displayed on dashboard) was out of sync with the execution layer:
- UI showed: "SIGNALS: 0" even when engine had ACTIVE_SNIPER trades
- Root cause: `setups` array never populated in canonical snapshot
- Frontend tried to read `setups` but it was always undefined
- Result: Signals counter always zero, traders had no visibility

## Root Cause Analysis

**Before fix:**
```typescript
// canonical-snapshot.ts - missing setups field
export type CanonicalSnapshot = {
  ready: boolean;
  cards: any[];        // ✓ populated
  updatedAt: string | null; // ✓ populated
  // setups: any[];    // ✗ MISSING!
};

// cron/route.ts - only passing cards, not setups
setSnapshot({
  updatedAt: new Date().toISOString(),
  cards: canonicalCards,
  // setups: setups,  // ✗ NOT PASSED
});

// page.tsx - trying to read setups that don't exist
const activeCount = setups.length; // Always 0 or undefined
```

## Solution Implemented

### 1. Extended CanonicalSnapshot Type
Added `setups` array to canonical snapshot type:
```typescript
export type CanonicalSnapshot = {
  ready: boolean;
  cards: any[];
  setups: any[];  // NEW: Array of ACTIVE_SNIPER signals
  updatedAt: string | null;
};
```

### 2. Updated Empty Snapshot
Ensured EMPTY_SNAPSHOT includes setups:
```typescript
export const EMPTY_SNAPSHOT: CanonicalSnapshot = {
  ready: false,
  cards: [],
  setups: [],  // NEW
  updatedAt: null,
};
```

### 3. Pass Setups from Cron
Now sends active setups to snapshot:
```typescript
setSnapshot({
  updatedAt: new Date().toISOString(),
  cards: canonicalCards.length === 3 ? canonicalCards : [],
  setups: setups,  // NEW: Include ACTIVE_SNIPER signals
});
```

### 4. Display Signal State in UI
Enhanced TradeDecisionPanel to show signal state:
```typescript
// Display ACTIVE_SNIPER badge when signal is active
const isActiveSignal = signalState === "ACTIVE_SNIPER" || signalState === "ACTIVE_CONFIRMED";
if (isActiveSignal) {
  <span className="ACTIVE_SNIPER badge">
    {signalState}
  </span>
}
```

## Impact

**Before:**
- SIGNALS counter: Always 0
- UI showed no indication of active trades
- Traders had no visibility into execution state
- State desynchronized between backend and frontend

**After:**
- SIGNALS counter: Accurately reflects active setups
- UI shows which cards have ACTIVE_SNIPER state
- Color-coded badges (cyan for SNIPER, green for CONFIRMED)
- Single source of truth in canonical snapshot
- Full state synchronization

## Architecture Improvement

```
BEFORE: Backend → Execution (setups created) → Alert queue
        Frontend → UI (shows 0 signals) ✗ Desync

AFTER:  Backend → Execution (setups created) → Snapshot + Alert queue
        Frontend → UI (reads setups from snapshot, shows count) ✓ Sync
```

## Files Changed

1. `lib/canonical-snapshot.ts` - Added setups to type
2. `app/api/cron/route.ts` - Pass setups to setSnapshot()
3. `app/page.tsx` - Display signal state badges

## Verification

✅ Build: All 10 routes compiled
✅ UI: Loads without errors
✅ Display: Signal state badges show correctly
✅ State: Properly synchronized from execution to display

## Result

The system now maintains a single source of truth for active signals, with the canonical snapshot serving as the bridge between the execution layer (backend) and presentation layer (frontend).
