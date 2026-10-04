# CX Switch — Simple Directional Strategy

Implemented in `lib/strategy.ts`. The existing UI/design/layout is preserved.

## System Status

- **New strategy engine:** active.
- **Jarvis:** rewritten and active as deterministic `GOOD / WARN / VETO`; no LLM or trendline-rejection classifier.
- **Cron:** wired to the new `ENTRY` signal contract and runs strategy → Jarvis → alert → management.
- **Alerts:** display Entry, SL, TP1, TP2 and RR(TP1) separately.
- **Dashboard:** reflects direction, Entry/SL/TP1/TP2, current price, unrealized PnL %, management state and Jarvis verdict/reason.
- **Kraken Futures:** position reconciliation and execution use the Kraken Futures REST API, not the Spot OpenPositions endpoint.
- **Historical backtest:** no results are available yet; the six-month forward-return harness is added separately and must be run locally.

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

Monitor/Redis compatibility functions remain no-op stubs where required by the application. Legacy Cycle Runner and V28 breakout state have been removed. No Fib, weekly gate, daily pre-break, tactical override, counter-trend, MACD gate, ADX gate, confidence score, trendline-rejection classification, or multi-stage direction state machine is used.
