const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

const cron = fs.readFileSync("app/api/cron/route.ts", "utf8");
const confirmRoute = fs.readFileSync("app/api/confirm-trade/route.ts", "utf8");
const dashboard = fs.readFileSync("app/page.tsx", "utf8");

test("MANUAL mode preserves explicitly confirmed positions without recovering unconfirmed alerts", () => {
  assert.ok(cron.includes('MANUAL mode — preserving ${active.length} explicitly confirmed active position'));
  assert.ok(cron.includes('EXECUTION_MODE==="MANUAL"?new Map<string,any>():historyAtStart'));
  assert.ok(!cron.includes('await setActiveSignals([]);'));
  assert.ok(!cron.includes('manual_mode_signal_not_entered'));
});

test("MANUAL entry alerts do not automatically create active positions", () => {
  assert.ok(cron.includes('if(EXECUTION_MODE==="AUTO"){\n   await addActiveSignal(signal);'));
  assert.ok(!cron.includes('if(EXECUTION_MODE==="MANUAL") await addActiveSignal(signal)'));
});

test("only an explicit dashboard confirmation activates a manual position", () => {
  assert.ok(dashboard.includes('I ENTERED THIS TRADE · ENABLE 4H MANAGEMENT'));
  assert.ok(dashboard.includes('fetch("/api/confirm-trade"'));
  assert.ok(confirmRoute.includes('confirmedManually: true'));
  assert.ok(confirmRoute.includes('latest.status = "ACTIVE"'));
});

test("confirmed manual positions are observed but never automatically executed in MANUAL mode", () => {
  assert.ok(cron.includes('await observeManualManagement(active,marketData);'));
  assert.ok(cron.includes('active=await manageActivePositions(active,marketData,managementByPair,alerts);'));
  assert.ok(cron.includes('no automatic execution'));
});
