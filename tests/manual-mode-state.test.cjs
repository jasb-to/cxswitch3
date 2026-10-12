const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

const cron = fs.readFileSync("app/api/cron/route.ts", "utf8");
const confirmRoute = fs.readFileSync("app/api/confirm-trade/route.ts", "utf8");
const dashboard = fs.readFileSync("app/page.tsx", "utf8");

test("MANUAL mode preserves explicitly confirmed positions without recovering unconfirmed alerts", () => {
  assert.match(cron, /MANUAL mode — preserving \$\{active\.length\} explicitly confirmed active position/);
  assert.match(cron, /EXECUTION_MODE==="MANUAL"\?new Map<string,any>\(\):historyAtStart/);
  assert.doesNotMatch(cron, /await setActiveSignals\(\[\]\);/);
  assert.doesNotMatch(cron, /manual_mode_signal_not_entered/);
});

test("MANUAL entry alerts do not automatically create active positions", () => {
  assert.match(cron, /if\(EXECUTION_MODE==="AUTO"\)\{[\s\S]*?await addActiveSignal\(signal\);/);
  assert.doesNotMatch(cron, /if\(EXECUTION_MODE==="MANUAL"\)\s*await addActiveSignal\(signal\)/);
});

test("only an explicit dashboard confirmation activates a manual position", () => {
  assert.match(dashboard, /I ENTERED THIS TRADE · ENABLE 4H MANAGEMENT/);
  assert.match(dashboard, /fetch\("\/api\/confirm-trade"/);
  assert.match(confirmRoute, /confirmedManually:true/);
  assert.match(confirmRoute, /latest\.status = "ACTIVE"/);
});

test("confirmed manual positions are observed for 4H management without auto-execution", () => {
  assert.match(cron, /await observeManualManagement\(active,marketData\);/);
  assert.match(cron, /no automatic execution/);
  assert.doesNotMatch(cron, /placeFuturesReduceOnlyMarketOrder\(trade\.pair,trade\.direction/);
});
