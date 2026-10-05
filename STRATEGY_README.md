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
3. **4H StochRSI timing:** ENTRY_1 fires in the directional extreme (LONG K <20 / SHORT K >80). ENTRY_2 is a fresh 4H K/D cross with K in the recovery band (LONG 20–55 / SHORT 45–80).
4. **Execution:** current price entry; trend entries use the farther of the latest 4H structural swing and a 1.5× 4H ATR stop; reversal entries use the farther of the last 5 closed 15M extreme and 1× 4H ATR. TP1/TP2 are +/-5%/+/-10% for trend entries and +/-3%/+/-6% for reversals.

## Exhaustion veto

Six exhaustion rule types remain unchanged: LONG Stoch K >=95 / SHORT Stoch K <=5 are checked on both 4H and 15M; LONG RSI >=78 / SHORT RSI <=22 and the 3% price-vs-4H-EMA21 checks remain on 4H.

## Jarvis

- Direction against 1D = VETO.
- Direction agrees with 1D but disagrees with 4H EMA trend = WARN.
- K >90 LONG or K <10 SHORT = WARN.
- Otherwise GOOD.

Jarvis cannot create or flip a direction.

## Management

Order is: stop hit -> TP2 -> TP1 scale-out/breakeven -> 4H EMA reversal -> 1D EMA reversal -> opposite Stoch extreme -> thesis intact. Exit on 4H EMA(8/21) reversal unless the trade is +2% in profit and the 1D is still aligned, in which case the stop is tightened and the trade is held.

## Jarvis State Narration

Each cron cycle emits one greppable `[JARVIS STATE]` line per pair as a calm, plain-English sentence. The verdict and gate logic are unchanged; only the wording is human-readable.

Examples:
- `[JARVIS STATE] ETH — Watching. 1D bullish, 4H has turned up. Price is at the zone, just above the 4H EMA21. Stoch is at 50 on the 15M and needs to pull back below 20 before a long can fire. Not yet.`
- `[JARVIS STATE] BTC — Quiet. 1D bullish, 4H is bullish. Price is well away from the support zone. The 15M Stoch is waiting for a qualifying cross before considering an entry.`

## Compatibility

Monitor/Redis compatibility functions remain no-op stubs where required by the application. Legacy Cycle Runner and V28 breakout state have been removed. No Fib, weekly gate, daily pre-break, tactical override, counter-trend, MACD gate, ADX gate, confidence score, trendline-rejection classification, or multi-stage direction state machine is used.
