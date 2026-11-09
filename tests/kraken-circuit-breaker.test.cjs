const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

const kraken = fs.readFileSync("lib/kraken.ts", "utf8");
const cron = fs.readFileSync("app/api/cron/route.ts", "utf8");

test("Kraken OHLC requests have a hard timeout and do not retry maintenance failures", () => {
  assert.match(kraken, /rateFetch\(url\.toString\(\), undefined, 4000, 1\)/);
  assert.match(kraken, /const attempts = retryable \? Math\.max\(1, maxAttempts\) : 1/);
  assert.match(kraken, /attempt \+ 1 < attempts/);
});

test("Kraken OHLC circuit breaker is pair-scoped and opens after three consecutive failures", () => {
  assert.match(kraken, /const OHLC_MAX_CONSECUTIVE_FAILURES = 3/);
  assert.match(kraken, /const ohlcFailureState = new Map<string, \{ failures: number; openedAt\?: number \}>\(\)/);
  assert.match(kraken, /ohlcFailureState\.get\(pair\)/);
  assert.match(kraken, /failures >= OHLC_MAX_CONSECUTIVE_FAILURES/);
  assert.match(kraken, /ohlcFailureState\.set\(pair, \{ failures, openedAt \}\)/);
  assert.match(kraken, /ohlcFailureState\.delete\(pair\)/);
  assert.match(kraken, /OHLC_CIRCUIT_COOLDOWN_MS = 60_000/);
  assert.match(kraken, /markKrakenOhlcPairSuccess\(pair: string\)/);
  assert.match(cron, /markKrakenOhlcPairSuccess\(krakenPairFormat\(pair\+"\\/USD"\)\)/);
});

test("Cron skips incomplete pairs and aborts marketData=0 before position management or signal evaluation", () => {
  assert.match(cron, /Promise\.allSettled\(\[/);
  assert.match(cron, /if\(!c1\.length\|\|!c4\.length\|\|!c15\.length\)/);
  assert.match(cron, /export const maxDuration = 60/);
  const guard = cron.indexOf('if(preflightMarketData.length===0)');
  const management = cron.indexOf("observeAlertManagement(active,preflightMarketData,alerts)");
  const evaluation = cron.indexOf("generateSignal(pair,c1,c4,c15");
  assert.ok(guard >= 0, "market-data guard exists");
  assert.ok(management > guard, "position management is after market-data guard");
  assert.ok(evaluation > guard, "signal evaluation is after market-data guard");
  assert.match(cron.slice(guard, management), /market data unavailable, skipping signal evaluation/);
  assert.match(cron.slice(guard, management), /status|marketData:0/);
  assert.doesNotMatch(cron.slice(guard, management), /setActiveSignals\(/);
});
