# Research ADR — BTC / SOL / HYPE — 2026-09-15

Status: Research-only. Nothing in this document authorizes production deployment.

## BTC — rejected

Hypothesis tested: 4H trend-continuation pullback after 50 EMA confirmation, symmetric long/short.

Decision: reject for the current sample.

Evidence: corrected daily regime alignment still produced 27 consecutive losses in 34 discovery trades; only about 29% of trades reached +1R MFE. Exit sweeps did not rescue the concept. Wider Chandelier variants were worse, and the short branch remained strongly negative.

Research conclusion: **4H BTC trend-continuation pullback entries are rejected for this sample; residual evidence points to mean-reverting behaviour at that timeframe.**

Archived future hypothesis (do not run until SOL/HYPE branches settle): long-only mean reversion, price above 200D, limit entry at 4H 50 EMA touch, RSI(14) < 35 at touch, stop 1.5 ATR below touch, fixed 1R/1.5R/2R exits. Kill if expectancy < 0 and fewer than ~35% of trades reach +1R MFE.

## SOL — active research

Frozen tradeable hypothesis: SOL/BTC > 50D relative-strength ratio, with BTC > 200D as the risk-regime gate. Do not stack a 5% pullback filter.

Infrastructure: strict causal as-of daily joins and forward-fill sensitivity differed on only 2 of 269 days (0.74%).

Next tests: winner concentration, exposure-matched benchmark, 30D/50D/100D robustness (50D remains the frozen specification), and exits limited to ratio-cross-below-50D versus fixed time-stop.

Approval remains unavailable until a longer rolling walk-forward supplies a materially larger effective sample.

## HYPE — active hypothesis, attribution research only

Frozen tradeable hypothesis: >=15% drawdown from prior 60D high while price remains above 200D EMA, then measure/participate in the subsequent recovery window. Unlock classification is not the trigger.

Calendar research: contemporaneous reports corroborate monthly core-contributor unlocks on/around the 6th of the month; third-party calendars also show 29th events, but recipient classification for those events is not sufficiently primary-source verified. Therefore no contributor/ecosystem mechanism claim is approved.

Next tests: beta-adjusted performance versus BTC, non-overlapping event clustering, frozen recent-event holdout, and primary/independent cross-checking of recipient categories. The realistic endpoint is forward paper-trading / tiny probationary sizing, not forcing a production-grade historical N out of a short HYPE history.

## Research discipline

- Every result is timestamp-causal.
- Discovery and holdout rules are frozen before new scoring.
- Parameter variants are robustness checks, not optimization targets.
- No research branch changes production signal generation without a separate approval decision.
