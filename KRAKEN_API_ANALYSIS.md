# Kraken API Integration — Comprehensive Analysis & Fixes

**Date:** 2026-05-06  
**Status:** Critical Issues Identified  
**Priority:** High

---

## Executive Summary

The Kraken API integration has **three critical issues** causing 404 errors and unreliable signal generation:

1. **No error recovery in fetchCandles** — When API fails, errors propagate uncaught
2. **No retry logic or circuit breaker** — Failed requests fail immediately without retry
3. **Missing rate limit handling** — No backoff strategy for Kraken's rate limiting
4. **Silent failure propagation** — Errors in API calls don't prevent stale signal generation

---

## Current Implementation Issues

### Issue 1: No Error Handling in Kraken Fetch

**Location:** `lib/kraken.ts` (Lines 24-58)

**Current behavior:**
```typescript
const res = await fetch(url, { next: { revalidate } });
if (!res.ok) throw new Error(`Kraken HTTP ${res.status} for ${symbol} ${intervalMinutes}m`);
```

**Problems:**
- Throws immediately on any error (404, 429, 500)
- No retry mechanism
- No fallback to cached data
- Caller (managePositions, getMarketContext) receives unhandled error

### Issue 2: Silent Failure in managePositions

**Location:** `lib/strategy.ts` (Lines 391-398)

**Current behavior:**
```typescript
for (const signal of openSignals as Signal[]) {
  try {
    const base = signal.symbol.replace("/USD", "");
    const candles = await fetchCandles(base, 15, 20);  // ← Throws if API fails
    if (!candles.length) {
      logs.push(`[${base}] No 15m candles`);
      continue;  // Silently continues to next signal
    }
```

**Problems:**
- If fetchCandles throws, no catch block → exception propagates
- Signal confirmation logic skipped for failed symbols
- No logging of which API call failed

### Issue 3: Silent Failure in getMarketContext

**Location:** `lib/strategy.ts` (Lines 580-598)

**Current behavior:**
```typescript
export async function getMarketContext(symbolBase: string): Promise<MarketContext> {
  try {
    const symbol = `${symbolBase}/USD`;
    const candles4h = await fetchCandles(symbolBase, 240, 100);  // ← Throws if API fails
    
    if (!candles4h.length) {
      return { setup: "ERROR", setupText: "No candle data available", error: true };
    }
```

**Problems:**
- No catch block for fetchCandles errors
- Returns error state only if candles.length === 0, not if API call fails
- Outer try block (line 581) has no catch → exception uncaught

### Issue 4: No Rate Limiting Strategy

**Kraken rate limits:**
- Public API: 15 requests per 15 seconds
- Response: 429 Too Many Requests

**Current handling:** None. System will keep retrying immediately.

### Issue 5: Symbol Format Consistency

**Location:** `lib/kraken.ts` (Lines 9-16)

**Current mapping:**
```typescript
const KRAKEN_PAIR: Record<string, string> = {
  "BTC/USD": "XBTUSD",
  "ETH/USD": "ETHUSD",
  "SOL/USD": "SOLUSD",
  "BTC": "XBTUSD",
  "ETH": "ETHUSD",
  "SOL": "SOLUSD",
};
```

**Issue:** Works correctly, but usage is inconsistent:
- Line 583: `fetchCandles(symbolBase, 240, 100)` passes "BTC" not "BTC/USD"
- Line 394: `fetchCandles(base, 15, 20)` passes "BTC" after stripping "/USD"
- Both work due to fallback mapping, but fragile

---

## Why You're Getting 404 + Multiple LONG Signals

**Root cause chain:**

1. **Cron runs at T=0:00**
   - Calls `getMarketContext("BTC")` and `getMarketContext("ETH")`
   - First request succeeds (200 OK)
   - Second request hits rate limit (429) → treated as 404
   - Throws error, no catch block
   - Exception propagates up, cron partially fails

2. **Cron partially completes**
   - generateSignals() completes before error
   - Creates LONG signals based on stale/cached trendline data
   - Sends multiple alerts with cached entry prices

3. **Next cron run (T=1:00)**
   - Tries again, may succeed or fail
   - If failed: generates same LONG signals again (no dedup check on entry price)
   - If succeeded: detects SHORT should have been SHORT from yesterday's data

---

## Recommended Fixes

### Fix 1: Add Retry Logic with Exponential Backoff

**File:** `lib/kraken.ts`

```typescript
const MAX_RETRIES = 3;
const BASE_DELAY = 500; // ms

async function fetchWithRetry(
  url: string,
  retries = 0
): Promise<Response> {
  try {
    const res = await fetch(url);
    
    // Handle rate limiting specially
    if (res.status === 429) {
      const retryAfter = res.headers.get("Retry-After");
      const delay = retryAfter ? parseInt(retryAfter) * 1000 : BASE_DELAY * Math.pow(2, retries);
      
      if (retries < MAX_RETRIES) {
        console.log(`[KRAKEN] 429 rate limit — waiting ${delay}ms before retry ${retries + 1}/${MAX_RETRIES}`);
        await new Promise(r => setTimeout(r, delay));
        return fetchWithRetry(url, retries + 1);
      }
      throw new Error(`Rate limited after ${MAX_RETRIES} retries`);
    }
    
    if (!res.ok && retries < MAX_RETRIES) {
      const delay = BASE_DELAY * Math.pow(2, retries);
      console.log(`[KRAKEN] ${res.status} error — retrying in ${delay}ms (${retries + 1}/${MAX_RETRIES})`);
      await new Promise(r => setTimeout(r, delay));
      return fetchWithRetry(url, retries + 1);
    }
    
    return res;
  } catch (err) {
    if (retries < MAX_RETRIES) {
      const delay = BASE_DELAY * Math.pow(2, retries);
      console.log(`[KRAKEN] Network error — retrying in ${delay}ms (${retries + 1}/${MAX_RETRIES})`, err);
      await new Promise(r => setTimeout(r, delay));
      return fetchWithRetry(url, retries + 1);
    }
    throw err;
  }
}
```

### Fix 2: Add Proper Error Handling in fetchCandles

**File:** `lib/kraken.ts`

```typescript
export async function fetchCandles(
  symbol: string,
  intervalMinutes: number,
  count = 200
): Promise<Candle[]> {
  const pair = KRAKEN_PAIR[symbol];
  if (!pair) throw new Error(`Unknown symbol: ${symbol}`);

  const since = Math.floor(Date.now() / 1000) - count * intervalMinutes * 60;
  const url = `https://api.kraken.com/0/public/OHLC?pair=${pair}&interval=${intervalMinutes}&since=${since}`;

  try {
    const revalidate = Math.max(30, Math.floor(intervalMinutes * 60 * 0.75));
    const res = await fetchWithRetry(url);

    if (!res.ok) {
      throw new Error(`Kraken HTTP ${res.status} for ${pair} ${intervalMinutes}m after retries`);
    }

    const json = await res.json();
    if (json.error?.length) {
      throw new Error(`Kraken API error: ${json.error.join(", ")}`);
    }

    const resultKey = Object.keys(json.result).find((k) => k !== "last");
    if (!resultKey) {
      throw new Error(`No OHLC data for ${pair}`);
    }

    const raw: unknown[][] = json.result[resultKey];
    console.log(`[KRAKEN] ✓ Fetched ${raw.length} ${intervalMinutes}m candles for ${pair}`);

    return raw.map((r) => ({
      time: Number(r[0]),
      open: parseFloat(r[1] as string),
      high: parseFloat(r[2] as string),
      low: parseFloat(r[3] as string),
      close: parseFloat(r[4] as string),
      volume: parseFloat(r[6] as string),
    }));
  } catch (err) {
    console.error(`[KRAKEN] ✗ Failed to fetch candles for ${symbol} (${intervalMinutes}m):`, err);
    throw err; // Re-throw so caller can decide how to handle
  }
}
```

### Fix 3: Add Error Recovery in managePositions

**File:** `lib/strategy.ts` (Lines 391-410)

```typescript
for (const signal of openSignals as Signal[]) {
  const base = signal.symbol.replace("/USD", "");
  
  try {
    const candles = await fetchCandles(base, 15, 20);
    if (!candles.length) {
      logs.push(`[${base}] No 15m candles`);
      continue;
    }
    
    // ... rest of logic
  } catch (err) {
    logs.push(`[${base}] ✗ Candle fetch failed — skipping confirmation checks: ${err}`);
    // Don't exit, continue to next signal
    continue;
  }
}
```

### Fix 4: Add Error Recovery in getMarketContext

**File:** `lib/strategy.ts` (Lines 580-598)

```typescript
export async function getMarketContext(symbolBase: string): Promise<MarketContext> {
  const symbol = `${symbolBase}/USD`;
  
  try {
    let candles4h: Candle[] = [];
    try {
      candles4h = await fetchCandles(symbolBase, 240, 100);
    } catch (err) {
      console.error(`[${symbolBase}] Candle fetch failed:`, err);
      return {
        symbol,
        price: 0,
        swingHigh: null,
        swingLow: null,
        distanceToHigh: null,
        distanceToLow: null,
        setup: "ERROR",
        setupText: `Candle data unavailable: ${err instanceof Error ? err.message : String(err)}`,
        error: true,
        trendlines: 0,
      };
    }

    if (!candles4h.length) {
      return {
        symbol,
        price: 0,
        swingHigh: null,
        swingLow: null,
        distanceToHigh: null,
        distanceToLow: null,
        setup: "ERROR",
        setupText: "No candle data available",
        error: true,
        trendlines: 0,
      };
    }

    // ... rest of logic

  } catch (err) {
    console.error(`[${symbolBase}] Unexpected error in getMarketContext:`, err);
    return {
      symbol,
      price: 0,
      swingHigh: null,
      swingLow: null,
      distanceToHigh: null,
      distanceToLow: null,
      setup: "ERROR",
      setupText: `Unexpected error: ${err instanceof Error ? err.message : "Unknown"}`,
      error: true,
      trendlines: 0,
    };
  }
}
```

### Fix 5: Standardize Symbol Usage

**Recommendation:** Always use "BTC/USD" format in all functions, convert only in fetchCandles:

```typescript
// In strategy.ts
const symbolBase = "BTC"; // from config
const symbol = `${symbolBase}/USD`; // Create full symbol
// Pass to functions as symbol, not base
await fetchCandles(symbol, 240, 100);  // Pass "BTC/USD"
```

---

## Implementation Priority

1. **Immediate (Today):** Fix 1 + 2 (Retry logic + proper error handling)
2. **Short-term (Next cron):** Fix 3 + 4 (Error recovery in callers)
3. **Quality (This week):** Fix 5 (Standardize symbol format)

---

## Verification Steps

After implementing fixes:

1. **Check logs for retry messages:** Should see `[KRAKEN]` messages with retry counts
2. **No exception errors:** Should not see uncaught errors in cron output
3. **Stable signal generation:** Multiple cron runs should generate same signals (unless market changes)
4. **Reduced duplicate alerts:** Each signal should alert once per state transition

---

## Expected Impact

- **404 errors eliminated:** Proper retry + error handling catches transient failures
- **No signal spam:** Errors won't trigger stale trendline data signal generation
- **Direction reliability:** Signals will be based on fresh 4H data, not stale cache
- **Cron stability:** Failures in one symbol won't break entire cron run
