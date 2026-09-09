# Structure Shift — 48-hour observation test

**Started:** 2026-09-09 05:09 UTC  
**End:** 2026-09-11 05:09 UTC  
**Purpose:** test whether confirmed 4H market structure identifies directional change earlier than the existing V28 alignment, without changing V28 trading behaviour.

## Control

V28 ENTRY_1 / ENTRY_2 remains unchanged. No Structure Shift condition can gate, create, cancel, or modify a V28 trade.

## ENTRY_0

ENTRY_0 V2 is retired for this test. The ETH ENTRY_0 trade closed for approximately **+$20** before retirement.

## Structure Shift observation

The test watches BTC, ETH, SOL and HYPE using confirmed 4H swing highs/lows.

- LONG structure: higher high + higher low.
- SHORT structure: lower high + lower low.
- The protected level is the latest higher low in LONG structure or latest lower high in SHORT structure.
- A structural break is confirmed only when the closed 4H price crosses the protected level by at least 0.35 ATR.
- The observation layer uses ATR only to normalise the structural break threshold.
- No automatic trading action is taken.

## Data capture

Each newly closed 4H candle is recorded once per symbol in Redis under `cxswitch:structure_shift_test_log_v1`. This is the live source for the 48-hour comparison. The log records structure, state, protected level, break distance in ATR, swing levels, ATR and reason.

At the end of the test the observations should be exported here as an append-only dataset and compared with V28 alerts and the actual chart sequence.

## Comparison questions

1. Did Structure Shift identify a directional change before V28?
2. How many 4H candles earlier?
3. Did confirmed shifts precede a meaningful move rather than a small pullback?
4. How many false/temporary shifts occurred?
5. Did the detector agree with what was visually obvious on the chart?
6. Did any symbol repeatedly flip between states?

**Important:** this is an observation experiment, not a replacement for V28.
