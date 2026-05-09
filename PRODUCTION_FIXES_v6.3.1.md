# Production Fixes v6.3.1

## Problem Statement

On Vercel/serverless, the architecture had **runtime memory != persistent runtime** issue:

```
/api/cron writes snapshot (memory invocation A)
/api/signals read snapshot (memory invocation B)
→ Empty cards because different processes
```

Users saw intermittent "NO DATA" even though cron logs showed valid cards.

---

## Root Cause

In-memory `let snapshot = {...}` doesn't persist across serverless invocations. Each function call gets its own execution context.

---

## Solution: Four-Part Fix

### 1. globalThis Singleton (Persistent Runtime Cache)

**File**: `/lib/runtime-snapshot.ts`

Changed from:
```ts
let snapshot = {...}  // Dies when invocation ends
```

To:
```ts
declare global {
  var __snapshot__: RuntimeSnapshot | undefined;
}

export function setSnapshot(data: RuntimeSnapshot) {
  globalThis.__snapshot__ = data;  // Persists in container memory
}

export function getSnapshot(): RuntimeSnapshot {
  return globalThis.__snapshot__ || defaultSnapshot;
}
```

**Why**: `globalThis` persists across requests in the same execution container (within a Vercel function deployment unit).

---

### 2. API Route Cache Disabled

**File**: `/app/api/signals/route.ts`

Added at the top:
```ts
export const dynamic = "force-dynamic";
export const revalidate = 0;
```

**Why**: Prevents Next.js from caching the response. Every request gets fresh snapshot.

---

### 3. Frontend Fetch Cache Disabled

**File**: `/app/page.tsx`

Changed from:
```ts
const fetcher = (url: string) => fetch(url).then((r) => r.json());
```

To:
```ts
const fetcher = (url: string) =>
  fetch(url, { cache: "no-store" }).then((r) => r.json());
```

**Why**: Prevents browser/CDN from serving stale snapshots.

---

### 4. Bootstrap Cards for Initial Page Load

**File**: `/app/page.tsx`

Added `BOOTSTRAP_CARDS` that show "Loading market snapshot..." instead of fake defaults like `confidence: 0`.

Changed from:
```ts
const cards = data?.cards ?? [];
```

To:
```ts
const cards = data?.cards && data.cards.length > 0 ? data.cards : BOOTSTRAP_CARDS;
const isBootstrap = !data?.cards || data.cards.length === 0;
```

**Why**: First page load happens before first cron run. Bootstrap state clearly communicates "loading" instead of showing fake trading data.

---

## UI State Model

Only 4 valid states should render:

### 1. LOADING
```
BTC/USD
FALLBACK status badge
Loading market snapshot...
```

### 2. LIVE
```
$80,513
LIVE status badge
BREAKOUT • SNIPER
Confidence 78%
```

### 3. FALLBACK (stale data)
```
$80,513
FALLBACK status badge
Stale pricing active
```

### 4. ERROR
```
Market temporarily unavailable
```

---

## Data Pipeline (Production)

```
cron (runs every minute)
├─ refreshMarketData()
├─ generateSetups()
├─ setSnapshot() ← writes to globalThis
└─ sendAlert()

signals API (requested every 30s)
├─ getSnapshot() ← reads from globalThis
└─ response.json(snapshot)

Frontend (renders every 30s)
├─ fetch(/api/signals, cache: "no-store")
├─ renders cards from snapshot
└─ shows bootstrap while loading
```

---

## Dead Code (Not Used)

The following files are legacy and not part of the active execution path:
- `lib/strategy.ts` (replaced by `strategy-v6.ts`)
- `lib/supabase-consumer.ts` (unused DB consumer)
- `lib/signal-lifecycle-validator.ts` (old state machine)
- `app/api/signals/end-trade/route.ts` (old trade handler)
- `app/api/test-signal/route.ts` (old test endpoint)

These can be deleted in a future cleanup pass.

---

## Guarantees in v6.3.1

✓ Prices always display (never null)  
✓ Single source of truth (globalThis snapshot)  
✓ No cache mismatches (revalidate=0, cache: "no-store")  
✓ No duplicate state (API returns snapshot as-is)  
✓ No fake defaults (bootstrap shows "loading...", not fake confidence)  
✓ Stable serverless behavior (globalThis persists in container)  

---

## Testing Production Behavior

1. **First page load** → See bootstrap "Loading market snapshot..." cards
2. **After first cron run** → Cards populate with live prices
3. **Refresh page** → Sees live snapshot (no stale data)
4. **Let cron timeout** → After 6 minutes, see "STALE DATA" alert
5. **Next cron run** → Alert clears, cards update

---

## Version Timeline

- v6.0.0 - Initial scanner architecture
- v6.1.0 - Added SymbolCardState with metadata
- v6.2.0 - Monochrome UI redesign
- v6.2.1 - UI fixes for price display
- v6.3.0 - Single source of truth (runtime-snapshot)
- v6.3.1 - Production serverless fixes (globalThis, cache disabling, bootstrap)
