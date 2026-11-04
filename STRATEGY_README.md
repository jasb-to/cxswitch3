# CXSwitch V28 — Strategy Reference

The production strategy lives in lib/strategy.ts. This document describes the single-direction V28 architecture.

## Direction and global filters

- **One daily direction:** aggregate 4H candles into daily candles and compare EMA 5 with EMA 13. EMA 5 above EMA 13 = LONG; otherwise SHORT once at least 25 daily candles are available.
- **One shared trendline:** each pair has one trendline state and one KV key, using the pair symbol as the key.
- **Global 4H momentum:** EMA 5/13 must align with the daily direction for every entry type.
- **Global exhaustion:** block LONG when RSI >78 or Stoch K >95; block SHORT when RSI <22 or Stoch K <5. Also block when ADX >50 and Stoch K/D is turning against the daily direction.
- The global filters apply equally to ENTRY_1, ENTRY_2 and ADD.

## Original V28 triggers

The engine evaluates the following triggers in order. The first matching trigger is selected.

### ENTRY_1 — trendline proximity + Stoch extreme

- Price is within 1.2% of the shared trendline.
- LONG Stoch K <20; SHORT Stoch K >80.
- Global 4H momentum and exhaustion filters must pass.

### ENTRY_2 — trendline proximity + Stoch turn

- Price is within 1.2% of the shared trendline.
- Stoch turns with the daily direction: LONG K > D; SHORT K < D.
- Stoch must not still be at the directional extreme.
- Global 4H momentum and exhaustion filters must pass.

### ADD — confirmed trendline break

- Price breaks beyond the shared trendline by 0.8% in the daily direction.
- The latest candle confirms direction by candle colour and closing beyond the previous close.
- Price is aligned with 4H EMA 8/21.
- At least one of volume expansion (>1.3× the recent 10-candle average), Stoch momentum, or ADX >20 is present.
- Global 4H momentum and exhaustion filters must pass.

## Risk and management

- ENTRY_1 and ENTRY_2 use the wider of the recent 20-candle swing boundary and a 2 ATR stop.
- ADD retains the 0.5% trendline buffer and 1.5 ATR stop floor.
- The V28 5 ATR target is retained for ENTRY_1/ENTRY_2; TP2 mirrors TP1 for compatibility.
- The existing minimum R:R check, hysteresis, trendline KV persistence, signal lifecycle, stop/target management and Telegram alert handling remain in place.
- tp_hit remains a management exit and reconciles signal history to TP_HIT.
- Telegram displays the mirrored single target once, not as a trailing target.

## Deliberately not used

There is no separate FAST/MACRO daily track, no second trendline evaluation, and no separate ENTRY_1/ENTRY_2 direction or filter helper. All three entry types use the same daily direction and the same global 4H filters.
