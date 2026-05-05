# CXSwitch3 API Reference

## Overview

CXSwitch3 exposes three main HTTP endpoints:

1. **Signal Generation Cron** — Detects breakouts and creates new signals
2. **Position Management Cron** — Monitors open trades, confirms signals, closes at TP/SL
3. **Signal Retrieval** — Fetch all signals from the database

All cron endpoints require a `?secret=` query parameter for authorization.

---

## Endpoints

### 1. Signal Generation Cron

**Route:** `GET /api/cron`

**Authorization:** `?secret=abc123xyz789` (environment variable: `CRON_SECRET`)

**Frequency:** Every 10 minutes (via external cron-jobs.org)

**Purpose:** Scan 4H candles for trendline breakouts and create new EARLY signals

---

#### Request

```bash
curl "https://cxswitch3.vercel.app/api/cron?secret=abc123xyz789"
```

#### Response (Success)

```json
{
  "message": "Signal generation cron executed",
  "signals_count": 2,
  "logs": [
    "[BTC] $98,765.00 — LONG_SETUP — 3-touch resistance at $99,500 (0.7% away)",
    "[BTC] ✓ Created LONG EARLY signal at $98,765.00",
    "[ETH] $3,456.00 — NO_SETUP — 2-touch resistance at $3,500 (1.3% away)",
    "[SOL] $85.62 — SHORT_SETUP — broke 5-touch support at $84.50",
    "[SOL] ✓ Created SHORT EARLY signal at $85.62"
  ]
}
```

#### Response (Error)

```json
{
  "error": "Unauthorized",
  "message": "Invalid secret"
}
```

```json
{
  "error": "Internal Server Error",
  "message": "Supabase not connected"
}
```

---

#### Response Fields

| Field | Type | Description |
|-------|------|-------------|
| `message` | string | Status message |
| `signals_count` | number | Count of signals returned (not created) |
| `logs` | string[] | Detailed per-symbol logs |

#### Log Breakdown

Each log line shows:
- `[SYMBOL]` — BTC, ETH, or SOL
- `$PRICE` — Current 4H closing price
- `SETUP_TYPE` — LONG_SETUP, SHORT_SETUP, or NO_SETUP
- `SETUP_TEXT` — Human-readable description of market structure

Example log entries:

```
[BTC] $98,765.00 — LONG_SETUP — 3-touch resistance at $99,500 (0.7% away)
  → Breakout detected: price broke above 3-touch resistance by >0.5%

[ETH] $3,456.00 — NO_SETUP — 2-touch resistance at $3,500 (1.3% away)
  → Only 2-touch level found (need ≥3); price is 1.3% below

[SOL] $85.62 — SHORT_SETUP — broke 5-touch support at $84.50
  → Breakout detected: price broke below 5-touch support by >0.5%

[BTC] ✓ Created LONG EARLY signal at $98,765.00
  → New signal inserted successfully

[ETH] Active signal exists (EARLY) — skipping creation
  → EARLY signal already exists; waiting for CONFIRMED or expiry

[SOL] Expired stale EARLY signal (65m old) — allowing new signal
  → Old EARLY signal auto-expired (>60 min old); fresh signal allowed
```

---

#### Execution Flow

```
1. GET /api/cron?secret=abc123xyz789
2. Validate secret matches CRON_SECRET env var
3. FOR each symbol in [BTC, ETH, SOL]:
   a. Fetch 100 × 4H candles from Kraken
   b. Detect local pivots (highs/lows)
   c. Group pivots within 0.5% tolerance
   d. Find best 3+ touch levels (resistance/support)
   e. Check if price broke >0.5% above/below
   f. IF breakout AND no existing signal:
      - Create EARLY signal in Supabase
      - Log: "✓ Created [DIRECTION] signal"
   g. IF breakout AND stale EARLY exists (>60 min):
      - Expire old signal
      - Allow new signal creation
   h. ELSE:
      - Log setup status for debugging
4. Return all logs and signal count
```

---

### 2. Position Management Cron

**Route:** `GET /api/cron/positions`

**Authorization:** `?secret=abc123xyz789` (same CRON_SECRET)

**Frequency:** Every 5 minutes (via external cron-jobs.org)

**Purpose:** Monitor open trades, check TP/SL, promote EARLY → CONFIRMED, send Telegram alerts

---

#### Request

```bash
curl "https://cxswitch3.vercel.app/api/cron/positions?secret=abc123xyz789"
```

#### Response (Success)

```json
{
  "message": "Position management cron executed",
  "confirmed_count": 1,
  "logs": [
    "[BTC] EARLY LONG — close $98,850 H $98,900 L $98,700 | TP $101,665 SL $97,323",
    "[BTC] EARLY — holding: true, momentum: true, move: 0.23%",
    "[BTC] EARLY → CONFIRMED (confidence: 85%, move: 0.23%)",
    "[TELEGRAM] Sent CONFIRMED alert for BTC/USD",
    "[ETH] CONFIRMED LONG — close $3,480 H $3,485 L $3,475 | TP $3,581 SL $3,367",
    "[ETH] CONFIRMED — position active",
    "[SOL] EARLY SHORT — close $85.40 H $85.60 L $85.20 | TP $82.94 SL $87.86",
    "[SOL] SL HIT — exit $87.85 PNL -$2.48"
  ]
}
```

#### Response Fields

| Field | Type | Description |
|-------|------|-------------|
| `message` | string | Status message |
| `confirmed_count` | number | Count of newly CONFIRMED signals this run |
| `logs` | string[] | Detailed per-signal logs |

---

#### Log Breakdown

Each log line shows position status:

**Price Update:**
```
[BTC] EARLY LONG — close $98,850 H $98,900 L $98,700 | TP $101,665 SL $97,323
  → close: latest 15M candle close
  → H/L: candle high/low used for TP/SL detection
  → TP/SL: target and stop levels
```

**Confirmation Check:**
```
[BTC] EARLY — holding: true, momentum: true, move: 0.23%
  → holding: price stayed >0.1% above entry for 2+ closes
  → momentum: last close > previous close (for LONG)
  → move: % change between last two closes
```

**State Transition:**
```
[BTC] EARLY → CONFIRMED (confidence: 85%, move: 0.23%)
  → Promotion to CONFIRMED
  → Confidence increased 70% → 85%
  → Telegram alert queued
```

**TP Hit:**
```
[ETH] TP HIT — exit $3,580.50 PNL $124.50
  → candle.high >= take_profit level
  → Exit price = take_profit × 0.999 (slippage)
  → PNL = exit_price - entry_price (LONG) or entry_price - exit_price (SHORT)
  → Signal state → END
  → outcome = "TP"
```

**SL Hit:**
```
[SOL] SL HIT — exit $87.85 PNL -$2.48
  → candle.high >= stop_loss level (SHORT) or candle.low <= stop_loss (LONG)
  → Exit price = stop_loss × (1 ± slippage)
  → Signal state → END
  → outcome = "SL"
```

**Telegram Alert:**
```
[TELEGRAM] Sent CONFIRMED alert for BTC/USD
  → Telegram message dispatched to chat
  → alert_sent = true in Supabase
  → Prevents duplicate alerts on future cron runs
```

---

#### Execution Flow

```
1. GET /api/cron/positions?secret=abc123xyz789
2. Validate secret
3. Fetch all EARLY and CONFIRMED signals from Supabase
4. FOR each open signal:
   a. Fetch latest 20 × 15M candles from Kraken
   b. Get latest candle (close, high, low)
   c. Check if already processed this candle (last_checked_candle == candle.time)
      - IF YES: skip (prevent duplicate processing)
      - IF NO: continue
   d. Check if candle.high/low hit TP or SL
      - IF TP HIT: calc PNL with 0.1% slippage, set state=END, outcome=TP
      - IF SL HIT: calc PNL with 0.1% slippage, set state=END, outcome=SL
   e. IF state still EARLY:
      - Check confirmation criteria:
        * 2+ recent closes holding ±0.1% of entry?
        * Last close stronger than prev (momentum)?
        * |close_change| > 0.2%?
      - IF all true: promote to CONFIRMED, confidence 70% → 85%, queue Telegram
      - Update last_checked_candle
   f. IF CONFIRMED and alert_sent=false:
      - Send Telegram message with 🟢 emoji
      - Set alert_sent=true
   g. Update last_checked_candle regardless of state
5. Return logs and confirmed_count
```

---

### 3. Fetch All Signals

**Route:** `GET /api/signals`

**Authorization:** None (public read)

**Purpose:** Retrieve all signals with current state

---

#### Request

```bash
curl "https://cxswitch3.vercel.app/api/signals"
```

#### Response

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
      "last_checked_candle": 1714943400,
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
      "last_checked_candle": 1714943340,
      "created_at": "2026-05-05T12:15:00Z",
      "updated_at": "2026-05-05T12:42:30Z"
    },
    {
      "id": 40,
      "symbol": "SOL/USD",
      "direction": "SHORT",
      "state": "END",
      "entry_price": 85.62,
      "stop_loss": 87.86,
      "take_profit": 82.94,
      "confidence": 70,
      "breakout_level": 84.50,
      "pnl": -2.48,
      "outcome": "SL",
      "alert_sent": true,
      "last_checked_candle": 1714943280,
      "created_at": "2026-05-05T10:05:00Z",
      "updated_at": "2026-05-05T10:15:22Z"
    }
  ]
}
```

#### Response Field Definitions

| Field | Type | Values | Description |
|-------|------|--------|-------------|
| `id` | number | 1+ | Unique signal ID in Supabase |
| `symbol` | string | "BTC/USD", "ETH/USD", "SOL/USD" | Asset pair |
| `direction` | string | "LONG", "SHORT" | Trade direction |
| `state` | string | "EARLY", "CONFIRMED", "END" | Signal lifecycle state |
| `entry_price` | number | 1000+ | Price where signal was created |
| `stop_loss` | number | > 0 | Loss limit price |
| `take_profit` | number | > entry_price | Profit target price |
| `confidence` | number | 70-95 | Certainty % |
| `breakout_level` | number | > 0 | Resistance/support level that triggered |
| `pnl` | number \| null | -500 to +5000 | Dollar profit/loss per unit (null if open) |
| `outcome` | string \| null | "TP", "SL", "EXPIRED" | How signal closed (null if open) |
| `alert_sent` | boolean | true, false | Telegram alert dispatched |
| `last_checked_candle` | number \| null | Unix seconds | Dedup: last candle.time processed |
| `created_at` | string (ISO8601) | 2026-05-05T... | Signal creation timestamp |
| `updated_at` | string (ISO8601) | 2026-05-05T... | Last state change timestamp |

---

## Signal Filtering & Analysis

### Active Signals

```bash
# Get only EARLY and CONFIRMED (open positions)
curl "https://cxswitch3.vercel.app/api/signals" \
  | jq '.signals[] | select(.state != "END")'
```

### Closed Signals (with PNL)

```bash
# Get all closed signals with outcome
curl "https://cxswitch3.vercel.app/api/signals" \
  | jq '.signals[] | select(.state == "END")'
```

### Win Rate

```bash
# Count TP vs SL
curl "https://cxswitch3.vercel.app/api/signals" \
  | jq '.signals[] | select(.outcome == "TP" or .outcome == "SL")' \
  | jq -s 'group_by(.outcome) | map({outcome: .[0].outcome, count: length})'
```

### Total PNL

```bash
# Sum all realized trades
curl "https://cxswitch3.vercel.app/api/signals" \
  | jq '.signals[] | select(.state == "END" and .pnl != null)' \
  | jq -s 'map(.pnl) | add'
```

---

## Cron Setup (External Scheduler)

### Signal Generation (Every 10 minutes)

**Cron Service:** [cron-jobs.org](https://cron-jobs.org)

**URL:** `https://cxswitch3.vercel.app/api/cron?secret=abc123xyz789`

**Schedule:** `*/10 * * * *` (every 10 minutes)

**Expected Response:**
- HTTP 200 with JSON
- ~5-10 seconds execution time

### Position Management (Every 5 minutes)

**URL:** `https://cxswitch3.vercel.app/api/cron/positions?secret=abc123xyz789`

**Schedule:** `*/5 * * * *` (every 5 minutes)

**Expected Response:**
- HTTP 200 with JSON
- ~3-5 seconds execution time

---

## Error Handling

### Invalid Secret

```json
{
  "error": "Unauthorized",
  "message": "Invalid secret"
}
```

### Supabase Connection Error

```json
{
  "error": "Internal Server Error",
  "message": "Supabase connection failed"
}
```

### Kraken API Error

```json
{
  "error": "Internal Server Error",
  "message": "Failed to fetch candles for BTC"
}
```

---

## Rate Limiting

- No hard rate limits (Vercel serverless)
- Kraken API: 15 requests per second per IP (respected via cron scheduling)
- Supabase: 100k read operations/month on free tier (easily accommodated)

---

## Monitoring & Debugging

### Check Last Cron Run

```bash
# Inspect cron route logs in Vercel
# https://vercel.com/[org]/cxswitch3/logs?functionName=api%2Fcron
```

### Manual Signal Creation Test

```bash
curl -X POST "https://cxswitch3.vercel.app/api/test-signal" \
  -H "Content-Type: application/json"
```

(Note: Test button removed from UI in v1.3.0; endpoint may still exist)

---

## Version History

- **v1.3.0** — API documentation, Telegram formatting
- **v1.2.0** — Trendline breakout detection
- **v1.1.0** — Initial cron infrastructure
- **v1.0.0** — Project scaffold

---

*Last Updated: 2026-05-05 | v1.3.0*
