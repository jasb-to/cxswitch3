# CXSwitch V28 — Strategy Reference

The production strategy lives in `lib/strategy.ts`. V28 uses one shared 4H trendline, two daily direction roles, and a staged alert lifecycle.

## Direction and one shared trendline

- **Macro direction:** aggregate the 4H candles into daily candles and compare daily EMA 8 with EMA 21. This supplies the macro bias for ENTRY_2, ADD and the shared trendline orientation.
- **Fast direction:** daily EMA 5/13 is a separate fast directional input for ENTRY_1 only.
- **One shared trendline:** each pair has one 4H trendline fitted from 4H swing pivots and one pair-level persisted state key. The line is oriented by the daily EMA 8/21 macro direction.
- ENTRY_1, ENTRY_2 and ADD all use the same shared 4H trendline. There is no separate FAST trendline and MACRO trendline.
- Legacy `pair:FAST|MACRO:DIRECTION` persisted trendline keys are collapsed into one pair-level line on load, preferring the previous MACRO line.

## Entry stages

The raw trigger priority is ENTRY_1, then ENTRY_2, then ADD.

### ENTRY_1 — initial fast entry

- Daily EMA 5/13 supplies the fast direction.
- Price is within 1.2% of the shared 4H trendline.
- Stoch RSI is extreme in the fast direction: LONG K <20; SHORT K >80.
- It opens only when there is no active position for that pair.
- This is the first, smaller entry stage in the user's manual scale-in plan.

### ENTRY_2 — macro confirmation / second entry

- Daily EMA 8/21 supplies the macro direction.
- Price is within 1.2% of the same shared 4H trendline.
- Stoch RSI is turning with the macro direction: LONG K > D; SHORT K < D.
- Stoch must no longer be at the directional extreme.
- ENTRY_2 can be the first signal in a lifecycle when ENTRY_1 never fired. It does not require a prior ENTRY_1.
- When an active same-direction ENTRY_1 exists and hysteresis is at ENTRY_1, ENTRY_2 advances that lifecycle. It does not open a duplicate trade on top of an unrelated active position.

### ADD — confirmed 4H breakout / final scale-in

- A same-pair, same-direction active position must exist.
- Price breaks beyond the shared trendline by 0.8% in the daily macro direction.
- The latest 4H candle confirms direction by candle colour and closing beyond the previous close.
- Price is aligned with 4H EMA 8/21.
- 4H EMA 5/13 momentum is aligned with the daily macro direction.
- Directional Stoch exhaustion remains capped: LONG K >95 and SHORT K <5 block the signal.
- Once the 4H break and confirmation conditions line up, ADD is eligible to alert. ADD is the final stage.

## Staged hysteresis

- Persisted state records the last stage, the last signal price and the stage-state expiry.
- The normal progression is ENTRY_1 → ENTRY_2 → ADD.
- ENTRY_2 can also start a lifecycle directly when there was no ENTRY_1.
- The price hysteresis band is 0.5%. A repeated signal at the same stage is suppressed while price remains within that band; a transition to the next stage is not blocked by the previous stage's band.
- ENTRY_1 and ENTRY_2 stage state lasts 24 hours; ADD stage state lasts 4 hours. These are stage-state lifetimes, not delays that force the next stage to wait 24 or 4 hours.
- State is persisted through KV across cron/serverless invocations.

## Stops, targets and regime sizing

- ENTRY_1 and ENTRY_2 use the wider of the recent 20-candle swing boundary and a 2 ATR stop.
- ENTRY_1 and ENTRY_2 use a 5 ATR target; TP2 mirrors TP1 for compatibility.
- ADD retains the 0.5% trendline buffer and 1.5 ATR stop floor. The target respects swing levels and the minimum 1.5 R:R requirement.
- A 15x liquidation-buffer clamp is applied to protective stops. R:R is recalculated after the clamp and the signal is rejected if it falls below 1.5.
- The macro regime sizing multiplier is 0.5x in LOW/CHOP conditions and 1x otherwise. This multiplier is not the same thing as the user's manual ENTRY_1/ENTRY_2/ADD scale-in allocation.
- There is no global RSI or ADX exhaustion veto. ADX remains diagnostic; it is not an ADD prerequisite. The directional Stoch hard cap remains.

## Trade management and alerts

- Signal validity checks cover TTL, missed entry, stop and target.
- Daily EMA 8/21 reversal can exit an unprofitable trade.
- An opposite Stoch extreme can exit a trade.
- 4H EMA 5/13 momentum is used for management: a profitable misaligned trade can be held with its stop tightened to entry; an unprofitable misaligned trade exits.
- ENTRY_1, ENTRY_2 and ADD use the normal Telegram/JARVIS review, dispatch, history and active-state pipeline.
- Signals are research/paper alerts. The system does not place or close exchange orders.

## Dashboard and market context

Market snapshots expose daily macro direction, ENTRY_1 fast direction, daily and 4H EMAs, 4H and daily Stoch RSI, RSI, ADX, the shared trendline and distance, regime, momentum alignment and exhaustion status.
