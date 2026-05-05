# CXSwitch3 Trading Strategy Documentation

## Overview

CXSwitch3 is an automated crypto trading signal generator that detects trendline breakouts on 4-hour (4H) candlestick charts for BTC/USD, ETH/USD, and SOL/USD. It identifies valid support/resistance levels through multi-touch trendline analysis, fires entry signals on confirmed breakouts, manages live positions, and validates trades through on-chain momentum confirmation.

---

## System Architecture

### Core Components

1. **Strategy Engine** (`lib/strategy.ts`)
   - Trendline detection and pivot analysis
   - Breakout signal generation
   - Position lifecycle management
   - Signal state transitions (EARLY → CONFIRMED → END)

2. **Cron Jobs**
   - `/api/cron/route.ts` — Signal generation (runs every 10 minutes)
   - `/api/cron/positions/route.ts` — Position management (runs every 5 minutes)

3. **Data Sources**
   - Kraken REST API for historical OHLCV candles
   - Supabase PostgreSQL for signal persistence
   - Telegram Bot API for real-time alerts

4. **Frontend Dashboard** (`app/page.tsx`)
   - Live signal display with state (EARLY/CONFIRMED/END)
   - 4-point checklist: 4H Trendbreak → 15M Setup → 5M Entry → Momentum
   - Real-time price tracking and trendline levels

---

## Signal Generation Flow

### 1. Trendline Detection (`getMarketContext`)

**Input:** Symbol (BTC, ETH, SOL)
**Process:**
- Fetch 100 × 4H candles from Kraken
- Extract local pivot highs (resistance) and lows (support)
- Group pivots within 0.5% tolerance to find multi-touch levels
- Filter for levels with ≥3 touches (valid trendlines)

**Output:**
```typescript
{
  symbol: "BTC/USD",
  price: 98765,
  swingHigh: 99500,      // Best resistance (3+ touches)
  swingLow: 97200,       // Best support (3+ touches)
  setup: "LONG_SETUP",   // or "SHORT_SETUP" or "NO_SETUP"
  setupText: "3-touch resistance at $99,500 (0.7% away)",
  trendlines: 2          // Count of valid levels found
}
```

### 2. Breakout Detection

**LONG Setup Trigger:**
- Price breaks **0.5% above** a valid 3-touch resistance level
- Indicates reversal from supply zone

**SHORT Setup Trigger:**
- Price breaks **0.5% below** a valid 3-touch support level
- Indicates reversal from demand zone

### 3. Signal Generation (`generateSignals`)

**When:** Every 10 minutes via `/api/cron`

**Logic:**
```
FOR each symbol in [BTC, ETH, SOL]:
  1. Call getMarketContext(symbol)
  2. IF market.setup == "LONG_SETUP" AND no existing signal:
     - Create EARLY signal with:
       - entry_price = current price
       - stop_loss = swingLow (or price × 0.97 if null)
       - take_profit = price × 1.03 (3% target)
       - confidence = 70%
       - breakout_level = resistance level
  3. IF market.setup == "SHORT_SETUP" AND no existing signal:
     - Create EARLY signal (mirrored logic)
  4. IF existing EARLY signal is >1 hour old:
     - Expire with outcome="EXPIRED"
     - Allow fresh breakout to create new signal
```

**Duplicate Prevention:**
- Safe check for existing EARLY/CONFIRMED signals
- Stale EARLY signals (>60 min) are auto-expired to allow reset

---

## Position Management

### 1. Real-Time Monitoring (`managePositions`)

**When:** Every 5 minutes via `/api/cron/positions`

**Per Open Signal:**
1. Fetch latest 20 × 15M candles for the symbol
2. Check candle HIGH/LOW against TP and SL levels
3. Update signal state based on outcome

### 2. Take Profit / Stop Loss

**Detection Logic:**
- Uses candle **HIGH and LOW** (not just close)
- Prevents missed fills between cron intervals

**Exit Calculation (with 0.1% slippage):**

For LONG:
```
TP Exit Price = take_profit × 0.999
PNL = exit_price - entry_price

SL Exit Price = stop_loss × 0.999
PNL = exit_price - entry_price
```

For SHORT:
```
TP Exit Price = take_profit × 1.001
PNL = entry_price - exit_price

SL Exit Price = stop_loss × 1.001
PNL = entry_price - exit_price
```

**Outcome Tracking:**
- `outcome = "TP"` → Signal closed with profit
- `outcome = "SL"` → Signal stopped out with loss
- `outcome = "EXPIRED"` → Stale signal never confirmed

### 3. State Promotion: EARLY → CONFIRMED

**Requirements (all must be true):**
1. **Price Holding:** 2+ recent 15M closes within ±0.1% of entry
2. **Momentum:** Last close must be stronger than previous:
   - LONG: lastClose > prevClose
   - SHORT: lastClose < prevClose
3. **Move Strength:** |lastClose - prevClose| / prevClose > 0.2%
   - Prevents weak, choppy candles from confirming

**On Confirmation:**
- Confidence increases from 70% → 85%
- `last_checked_candle` updated to prevent reprocessing
- Telegram alert sent with 🟢 (green) emoji
- `alert_sent = true` to prevent duplicate alerts

### 4. Candle Deduplication

**Problem:** Cron runs every 5 minutes; if no new candle forms, same data gets reprocessed

**Solution:**
- Every processed signal stores `last_checked_candle = candle.time` (Unix seconds)
- Before processing, check if `latest.time == signal.last_checked_candle`
- If match: Skip (already processed this candle)
- If different: Process new candle

---

## Database Schema

### `signals` Table

```sql
CREATE TABLE signals (
  id SERIAL PRIMARY KEY,
  symbol TEXT NOT NULL,           -- "BTC/USD", "ETH/USD", "SOL/USD"
  direction TEXT NOT NULL,        -- "LONG" or "SHORT"
  state TEXT NOT NULL,            -- "EARLY", "CONFIRMED", "END"
  entry_price NUMERIC NOT NULL,
  stop_loss NUMERIC NOT NULL,
  take_profit NUMERIC NOT NULL,
  confidence INT DEFAULT 70,      -- 70-95%
  breakout_level NUMERIC,         -- Resistance or support level that triggered
  pnl NUMERIC,                    -- PNL in USD if ended
  outcome TEXT,                   -- "TP", "SL", or "EXPIRED"
  alert_sent BOOLEAN DEFAULT false, -- Guard for Telegram dedupe
  last_checked_candle BIGINT,     -- Unix seconds (candle dedup key)
  created_at TIMESTAMP DEFAULT now(),
  updated_at TIMESTAMP DEFAULT now(),
  
  CONSTRAINT signals_outcome_check 
    CHECK (outcome IS NULL OR outcome = ANY (ARRAY['TP','SL','EXPIRED']))
);
```

---

## API Endpoints

### 1. Signal Generation

**Endpoint:** `GET /api/cron?secret=abc123xyz789`

**Response:**
```json
{
  "message": "Signal generation cron executed",
  "signals_count": 2,
  "logs": [
    "[BTC] $98,765 — LONG_SETUP — 3-touch resistance at $99,500 (0.7% away)",
    "[BTC] ✓ Created LONG EARLY signal at $98,765.00",
    "[ETH] $3,456 — NO_SETUP — waiting",
    "[SOL] $85.62 — 7-touch resistance at $87.00 (1.6% away)",
    "[SOL] Active signal exists (EARLY) — skipping creation"
  ]
}
```

**Logs Include:**
- Market context for each symbol
- Breakout detection status
- Signal creation success/failure
- Stale signal expiry

---

### 2. Position Management

**Endpoint:** `GET /api/cron/positions?secret=abc123xyz789`

**Response:**
```json
{
  "message": "Position management cron executed",
  "confirmed_count": 1,
  "logs": [
    "[BTC] EARLY LONG — close $98,850 H $98,900 L $98,700 | TP $101,665 SL $97,323",
    "[BTC] EARLY — holding: true, momentum: true, move: 0.23%",
    "[BTC] EARLY → CONFIRMED (confidence: 85%, move: 0.23%)",
    "[ETH] CONFIRMED LONG — close $3,480 H $3,485 L $3,475 | TP $3,581 SL $3,367",
    "[ETH] CONFIRMED — position active",
    "[SOL] EARLY SHORT — close $85.40 H $85.60 L $85.20 | TP $82.94 SL $87.86",
    "[SOL] SL HIT — exit $87.85 PNL -$2.48"
  ]
}
```

**Logs Include:**
- Current price action (close, high, low)
- TP/SL levels
- Confirmation checks (holding, momentum, move strength)
- EARLY → CONFIRMED transitions
- TP/SL hits with PNL
- Telegram alerts on CONFIRMED signals

---

### 3. Fetch All Signals

**Endpoint:** `GET /api/signals`

**Response:**
```json
{
  "signals": [
    {
      "id": 42,
      "symbol": "BTC/USD",
      "direction": "LONG",
      "state": "CONFIRMED",
      "entry_price": 98765,
      "stop_loss": 97323,
      "take_profit": 101665,
      "confidence": 85,
      "breakout_level": 99500,
      "pnl": null,
      "outcome": null,
      "alert_sent": true,
      "last_checked_candle": 1234567890,
      "created_at": "2026-05-05T14:23:00Z",
      "updated_at": "2026-05-05T14:28:15Z"
    },
    {
      "id": 41,
      "symbol": "ETH/USD",
      "direction": "LONG",
      "state": "END",
      "entry_price": 3456,
      "stop_loss": 3367,
      "take_profit": 3581,
      "confidence": 85,
      "breakout_level": 3500,
      "pnl": 98.50,
      "outcome": "TP",
      "alert_sent": true,
      "last_checked_candle": 1234567860,
      "created_at": "2026-05-05T12:15:00Z",
      "updated_at": "2026-05-05T12:42:30Z"
    }
  ]
}
```

---

## Signal States & Lifecycle

```
                    ┌─────────────┐
                    │   NO SETUP  │ (waiting for breakout)
                    └─────────────┘
                           ↓
                    ┌─────────────┐
                    │ LONG/SHORT  │ ← breakout detected
                    │   SETUP     │
                    └─────────────┘
                           ↓
         ╔═════════════════════════════════╗
         ║  Signal Created: EARLY state    ║
         ║  entry_price = current price    ║
         ║  confidence = 70%               ║
         ║  alert_sent = false             ║
         ║  Telegram: 🟡 EARLY alert       ║
         ╚═════════════════════════════════╝
                           ↓
              ┌────────────────────────┐
              │ Holds for 2+ candles + │
              │ momentum + 0.2% move?  │
              └────────────────────────┘
              │ YES           │ NO
              ↓               ↓
         [CONFIRMED]    [Stay EARLY]
         confidence→85%      ↓
         alert_sent→true     │
         Telegram: 🟢        │
              ↓              │
              ├──────────────┤
              │              │
              ↓              ↓
         [TP HIT]      [SL HIT]     [EXPIRED >1h]
         outcome→TP    outcome→SL   outcome→EXPIRED
         state→END     state→END    state→END
         PNL calc      PNL calc     PNL = null
         Telegram      Telegram     (new signal allowed)
              ↓              ↓              ↓
         ╔═══════════════════════════════════════╗
         ║  Signal Closed: END state             ║
         ║  outcome = "TP" | "SL" | "EXPIRED"   ║
         ║  alert_sent = true                    ║
         ║  updated_at = current timestamp       ║
         ╚═══════════════════════════════════════╝
```

---

## Key Parameters

| Parameter | Value | Purpose |
|-----------|-------|---------|
| **Symbols** | BTC, ETH, SOL | Assets monitored |
| **Candle Period** | 4H (signal gen) | Longer timeframe for trend |
| **Candle Period** | 15M (position mgmt) | Confirmation and exit |
| **Resistance/Support Tolerance** | 0.5% | Grouping nearby pivots |
| **Min Touches** | 3 | Valid trendline threshold |
| **Breakout Threshold** | 0.5% | Distance above/below level |
| **EARLY Expiry** | 60 minutes | Auto-expire stale signals |
| **CONFIRMED Requirements** | 2 closes + momentum + 0.2% move | Confirmation criteria |
| **TP Target** | Price × 1.03 | 3% profit target |
| **SL Buffer** | swingLow or price × 0.97 | Risk management |
| **Slippage** | 0.1% | Exit fill calculation |
| **Cron: Signals** | Every 10 min | Generation frequency |
| **Cron: Positions** | Every 5 min | Management frequency |

---

## Telegram Integration

### Alert Format

**EARLY Signal (🟡):**
```
🟡 BTC/USD — LONG (EARLY)

Entry:       $98,765
Stop Loss:   $97,323
Take Profit: $101,665

Confidence: 70%

Reason:
Breakout with early momentum. Awaiting 15m confirmation.
```

**CONFIRMED Signal (🟢):**
```
🟢 ETH/USD — SHORT (CONFIRMED)

Entry:       $3,456
Stop Loss:   $3,581
Take Profit: $3,358

Confidence: 85%

Reason:
Breakout confirmed with sustained momentum across recent closes.
```

### Alert Guard

- Alerts only fire on **newly CONFIRMED signals** in current cron run
- `alert_sent = true` after first Telegram send
- Prevents duplicate alerts across multiple cron executions

---

## Debugging & Monitoring

### Cron Logs

Both cron endpoints return detailed logs for each symbol:

```
[SYMBOL] PRICE SETUP_TYPE SETUP_TEXT
```

Example:
```
[BTC] $98,765 — LONG_SETUP — 3-touch resistance at $99,500 (0.7% away)
[ETH] $3,456 — NO_SETUP — 2-touch support at $3,300 (4.5% away)
[SOL] $85.62 — SHORT_SETUP — broke 5-touch support at $84.50
```

### Key Metrics

- **trendlines:** Count of valid (3+ touch) support/resistance levels found
- **distanceToHigh/Low:** Percentage away from nearest trendline
- **moveStrength:** Recent candle momentum as % change
- **confidence:** Signal strength (70-95%)
- **PNL:** Closed trade profit/loss in USD

### Why No Signal?

**Check these in order:**

1. **No Setup Yet**
   - Price hasn't broken any 3-touch trendline by 0.5%
   - Wait for larger price moves or trendline formation

2. **Existing EARLY Signal**
   - Signal already created, waiting for CONFIRMED promotion
   - Will expire after 60 minutes if no confirmation

3. **Only 2 Touches Detected**
   - Not enough touches to form valid trendline
   - Need 3+ at same level (within 0.5% tolerance)

4. **Price Below Breakout Threshold**
   - Price touching but not 0.5% above resistance
   - Requires confirmed breakout, not just proximity

---

## Version History

- **v1.3.0:** Telegram message formatting, test button removal
- **v1.2.0:** Trendline detection system, pivot analysis
- **v1.1.0:** Initial signal generation with swing levels
- **v1.0.0:** Project scaffold

---

## Recovery & Backup

This document serves as the **complete specification** for CXSwitch3. If the app fails:

1. **Database Recovery:** All signal history stored in Supabase `signals` table
2. **Code Recovery:** This document defines all logic; redeploy from repo
3. **State Recovery:** Last signal state persisted; cron will resume on next run
4. **Alert History:** Supabase `telegram_alerts` table logs all sent notifications

---

*Last Updated: 2026-05-05 | v1.3.0*
