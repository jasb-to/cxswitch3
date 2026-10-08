# CXSwitch V28 — Strategy Reference

The production strategy lives in `lib/strategy.ts`. This document describes the active architecture only; obsolete experiments and legacy exchange modules are intentionally removed.

## Direction and timeframe hierarchy

- **1D EMA 5/13:** macro directional bias. EMA 5 above EMA 13 = LONG bias; EMA 5 below EMA 13 = SHORT bias, with the existing neutral/transition handling.
- **4H EMA 8/21:** longer-move direction and trade management. This remains the primary 4H management/reversal reference.
- **4H EMA 5/13:** faster visual diagnostic only. It helps show tactical direction changes but does not replace the 4H EMA 8/21 management hierarchy.
- **Jarvis:** observes, explains and reviews the setup; it does not create or flip a trading direction.

## Entries

### Entry 1 — early location setup

ENTRY_1 is deliberately simple:

- the 1D direction must be established;
- price must be near the validated 4H structural trendline/zone;
- the setup must be inside the configured location tolerance;
- StochRSI must be in the directional extreme (LONG <20 / SHORT >80);
- exhaustion protection remains active.

ENTRY_1 is an early setup. A structural breakout is not required for ENTRY_1.

### Entry 2 — persistent break → retest

ENTRY_2 is stateful and follows:

**BREAK → REMEMBER BREAK → PULLBACK → RETEST RECORDED BREAKOUT LEVEL → REJECTION/CONFIRMATION → STOCH CONFIRMATION → ENTRY_2**

The breakout level is recorded from the closed structural-break candle and persisted by pair.

- Breakout state remains valid for **48 hours**.
- Retest tolerance is **1.5%** of the recorded breakout level.
- LONG retest requires price to return to the level and close back above it with directional confirmation.
- SHORT retest requires price to return to the level and close back below it with directional confirmation.
- StochRSI confirmation remains LONG K 20–55 / SHORT K 45–80 with the existing K/D timing requirement.
- The state is cleared after the ENTRY_2 lifecycle is consumed so the same retest cannot repeatedly fire.

## Risk and management

- R:R is **risk/target information, not an entry gate**.
- Stops retain the structural/ATR calculation and liquidation-buffer checks.
- TP1/TP2 and position management remain separate from entry qualification.
- Existing 4H/1D reversal, chandelier and breakeven management logic remains active.
- Telegram alert lifecycle and deduplication remain active.

## Deliberately not used

The active strategy does **not** use Fib gates, weekly gates, daily pre-break gates, tactical direction overrides, counter-trend gates, MACD/ADX gates, confidence-score gates, or an additional multi-stage direction state machine.

Legacy experimental 1D trend-engine modules, alternate MEXC/CoinGecko market-data modules, and the unused structure-shift module have been removed to keep the production path auditable.
