# CX Switch — Simple Directional Strategy

Implemented in `lib/strategy.ts`. The existing UI/design/layout is untouched.

## Entry rules

1. **1D direction only:** aggregate 4H candles to 1D; EMA(8) > EMA(21) with >0.5% spread = LONG only; EMA(8) < EMA(21) with >0.5% spread = SHORT only; otherwise NEUTRAL.
2. **4H location:** nearest permitted zone within 1 ATR: ascending swing-low trendline / EMA21 / prior swing low for LONG; descending swing-high trendline / EMA21 / prior swing high for SHORT.
3. **4H StochRSI timing:** LONG K crosses above D while K <40; SHORT K crosses below D while K >60.
4. **Execution:** current price entry; swing low/high +/-0.75 ATR stop; TP1 +/-5%; TP2 +/-10%; reject TP1 RR <1.5; management scales 50% at TP1 and moves stop to breakeven.

## Exhaustion veto

Exactly six entry vetoes: LONG K >=95, SHORT K <=5, LONG RSI >=78, SHORT RSI <=22, LONG close >3% above 4H EMA21, SHORT close >3% below 4H EMA21.

## Jarvis

- Direction against 1D = VETO.
- Direction agrees with 1D but disagrees with 4H EMA trend = WARN.
- K >90 LONG or K <10 SHORT = WARN.
- Otherwise GOOD.

Jarvis cannot create or flip a direction.

## Management

Order is: stop hit -> TP2 -> TP1 scale-out/breakeven -> 4H EMA reversal -> 1D EMA reversal -> opposite Stoch extreme -> thesis intact.

## Compatibility

Monitor/Redis functions are no-op stubs. Cycle runner returns `{enabled:false,status:"DISABLED"}`. No Fib, weekly gate, daily pre-break, tactical override, counter-trend, MACD, ADX gate, confidence score, trendline-rejection classification, or multi-stage direction state machine is used.
