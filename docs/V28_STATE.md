# V28 state and trade lifecycle

V28 is an early-breakout-first system:

1. 4H structural breakout → ENTRY_1
2. Recorded breakout retest → ENTRY_2
3. Continuation/retest → ADD

## Persistent breakout state

The cron runner persists the most recent V28 breakout per pair in Redis under:

`cxswitch:v28_breakout_state`

Each pair's value is a `BreakoutRecord`:

```ts
{
  direction: "LONG" | "SHORT",
  price: number,
  timestamp: number,
  candleIndex: number
}
```

The state is read before `generateSignal()` and updated when ENTRY_1 records a new breakout. This state must not be kept only in process memory because Vercel/serverless invocations are ephemeral.

## Expiry

`BREAKOUT_EXPIRY_CANDLES = 12`.

Because V28's breakout structure is 4H, this represents 48 hours / 12 four-hour candles. ENTRY_2 requires a recorded breakout in the same direction whose candle index is no more than 12 candles old and whose retest is within the configured recorded-breakout tolerance.

## Reset / migration note

If breakout state ever needs to be reset or migrated, inspect and update `cxswitch:v28_breakout_state` deliberately. Removing or changing this state can affect whether ENTRY_2 is eligible until a new ENTRY_1 records a breakout.

## Position lifecycle

- ENTRY_1: first confirmed 4H breakout.
- ENTRY_2: independent recorded-breakout retest; it does not require an active ENTRY_1.
- ADD: continuation/retest after an ENTRY_1 or ENTRY_2 position is active.
- 1D 5/13 is directional context only and does not gate a genuine 4H breakout.
