const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

const cron = fs.readFileSync("app/api/cron/route.ts", "utf8");
const signals = fs.readFileSync("app/api/signals/route.ts", "utf8");
const version = fs.readFileSync("lib/version.ts", "utf8");
const dashboard = fs.readFileSync("app/page.tsx", "utf8");

test("CXSwitch tracks alert lifecycle without a manual confirmation mode", () => {
  assert.ok(!cron.includes("EXECUTION_MODE"));
  assert.ok(!cron.includes("MANUAL mode"));
  assert.ok(!version.includes("EXECUTION_MODE"));
  assert.ok(!signals.includes("executionMode"));
  assert.ok(!dashboard.includes('text="MANUAL"'));
});

test("every sent entry alert is tracked without confirming a user-entered trade", () => {
  assert.ok(cron.includes("await appendSignalHistory(signal);"));
  assert.ok(cron.includes("active=mergeNewSignalsIntoActive(active,newSignals);"));
  assert.ok(!cron.includes("await addActiveSignal(signal);"));
  assert.ok(cron.includes('h.status==="ACTIVE"&&(h.type==="ENTRY_1"||h.type==="ENTRY_2")'));
  assert.ok(!cron.includes("confirmedManually===true"));
  assert.ok(!cron.includes("/api/confirm-trade"));
});

test("alert lifecycle persists SL_HIT and TP_HIT from current market prices", () => {
  assert.ok(cron.includes("async function reconcileAlertOutcomes"));
  assert.ok(cron.includes('updateSignalHistoryStatus(alert.id,"SL_HIT","stop_hit",price)'));
  assert.ok(cron.includes('updateSignalHistoryStatus(alert.id,"TP_HIT","tp2_hit",price)'));
  assert.ok(cron.includes("await updateHistoryMilestonesBatch(active.map")); 
  assert.ok(!cron.includes("await updateHistoryMilestones(alert.id,price);"));
  assert.ok(cron.includes("active=await reconcileAlertOutcomes(active,marketData,alerts);"));
});

test("alert monitoring never places or closes exchange orders", () => {
  assert.ok(!cron.includes("placeFuturesReduceOnlyMarketOrder"));
  assert.ok(!cron.includes("moveFuturesStopToBreakeven"));
  assert.ok(!cron.includes("getFuturesPositions"));
  assert.ok(!cron.includes("reconcileExchangePositions"));
});

test("dashboard still distinguishes completed alert states", () => {
  assert.ok(signals.includes('h.status==="SL_HIT"||h.status==="FAILED"'));
  assert.ok(signals.includes('h.status!=="ACTIVE"'));
});
