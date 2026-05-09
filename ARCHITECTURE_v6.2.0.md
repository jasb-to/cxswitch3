# v6.2.0 RICH CARDS ARCHITECTURE

## Overview

Restored advanced symbol cards while maintaining pure scanner architecture. Cards now display rich metadata (checklist, structure, confidence, direction, mode) derived fresh from market data on every cron cycle—never persisted, never reconciled.

## Architecture

### Backend (Pure Scanner)

**Market Layer** (`market-data-layer.ts`)
- Fetches prices from Kraken + CoinGecko fallback
- Returns market snapshot with LIVE/DEGRADED status badges
- RULE: Never null prices for tracked symbols (BTC, ETH, SOL)

**Strategy Engine** (`strategy-v6.ts`)
- Pure function: market snapshot → symbol cards + setups
- Returns `SymbolCardState` objects with:
  - Price, source, degraded flag
  - Direction (LONG/SHORT/NEUTRAL), mode (SNIPER/CONFIRMED/NONE), confidence
  - Structure (BREAKOUT/RANGE/COMPRESSION/NO_STRUCTURE)
  - Checklist (trend4H, breakout15M, trigger5M, volatility, volume)
  - Notes and trigger status
- NO DB access, NO state, PURE evaluation only

**Cron Pipeline** (`/api/cron`)
1. Refresh market cache → logs LIVE/CACHED status
2. Generate cards + setups → returns both
3. Check cooldown → send Telegram alerts for setups only
4. Return { cards, setups, sent }

**Snapshot API** (`/api/signals`)
- Returns cards array (NEVER null prices)
- Degraded flag = source !== "kraken_live"
- Card state includes all UI metadata

### Frontend (Rich Rendering)

**SymbolCard Component** (`page.tsx`)
- Renders full metadata: structure, checklist, confidence, direction, mode
- Color-coded by direction (LONG=green, SHORT=red, NEUTRAL=gray)
- Checklist items with checkmarks/circles
- Live price always displayed (never "—" or "NO DATA")
- Source badge (LIVE=green, DEGRADED=amber)

**Dashboard** (`page.tsx`)
- Shows asset count (always 3: BTC, ETH, SOL)
- Shows signal count (only active setups)
- Auto-refresh every 30s
- Renders all 3 symbol cards in grid (never hides any)

## Key Fixes

### 1. Snapshot Contract
**BEFORE (broken)**
```typescript
if (source !== "kraken_live") {
  degraded = true;
  price = null;  // ← WRONG: causes "NO DATA"
}
```

**AFTER (correct)**
```typescript
price: priceData.price,  // ← Always has value
degraded: priceData.source !== "kraken_live",  // ← Just a flag
```

### 2. Card Metadata
**BEFORE**
- Cards had only price + state (EARLY_OPEN, CONFIRMED, END)
- No structure, checklist, confidence, direction metadata

**AFTER**
- Cards include full SymbolCardState object
- Derived fresh every cron, never persisted
- UI renders all metadata in structured format

### 3. UI Rendering
**BEFORE**
- Showed "NO DATA" when market degraded
- Hid missing symbols
- No checklist or structure display

**AFTER**
- Always shows symbol cards with live price (cached or live)
- LIVE badge (green) when kraken_live
- DEGRADED badge (amber) when using fallback
- Rich checklist with ✓/○ indicators
- Structure labels (BREAKOUT, etc.)
- Confidence percentage

## API Response Format

```typescript
{
  cards: [
    {
      symbol: "BTC",
      price: 95832.50,
      source: "kraken_live",
      degraded: false,
      
      direction: "LONG",
      mode: "SNIPER",
      confidence: 68,
      
      structure: "BREAKOUT",
      checklist: {
        trend4H: true,
        breakout15M: true,
        trigger5M: false,
        volatility: true,
        volume: true
      },
      
      triggerActive: false,
      notes: "Compression breakout with expanding range",
      updatedAt: "2026-05-09T14:23:45.000Z"
    }
  ],
  setups: [
    {
      symbol: "ETH",
      mode: "CONFIRMED",
      direction: "LONG",
      score: 78,
      reason: "Retest holding with momentum",
      price: 3456.78
    }
  ],
  fetchedAt: 1715337825000
}
```

## Execution Flow

### Every Minute (Cron)
1. Refresh market (fetch + cache)
2. Generate cards + setups (pure evaluation)
3. Check cooldown (per symbol + mode + direction)
4. Send Telegram alerts (setups only, never cards)
5. Return full response

### UI Render
1. Fetch `/api/signals` (30s refresh)
2. Receive cards + setups
3. Render SymbolCard for each card
4. Display setup count, asset count
5. Show LIVE/DEGRADED badges
6. Render checklist with indicators

## Rules Enforced

✓ Market layer always returns prices (never null)  
✓ Snapshot degrades gracefully (fallback with badge)  
✓ Strategy engine is pure (no DB, no state, no persistence)  
✓ Cards derived fresh every cycle (never stale)  
✓ UI always renders all symbols (never hides)  
✓ Prices always visible (cached or live)  
✓ Checklist metadata always present  
✓ Setup alerts only (not card updates)  
✓ No reconciliation, no lifecycle, no outcomes  

## Version

v6.2.0 — Rich Cards with Pure Scanner Architecture
