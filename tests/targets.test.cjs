const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

test("signal target fields are 15 ATR safety values, not operational profit exits", () => {
  const source = fs.readFileSync(require.resolve("../lib/strategy.ts"), "utf8");
  assert.match(source, /entry\+15\*a/);
  assert.match(source, /entry-15\*a/);
  assert.doesNotMatch(source, /calculateTargetsFromPivots|export function calculateTargets\(/);
});

test("cron reconciliation does not close positions on TP1 or TP2", () => {
  const source = fs.readFileSync(require.resolve("../app/api/cron/route.ts"), "utf8");
  assert.doesNotMatch(source, /targetHit|tp2_hit/);
  assert.match(source, /updateActiveSignalStop\(alert\.pair,alert\.direction,hold\.newStop\)/);
});

test("cron persists and ratchets Chandelier stops only in the tighter direction", () => {
  const source = fs.readFileSync(require.resolve("../app/api/cron/route.ts"), "utf8");
  assert.match(source, /hold\.reason==="chandelier_stop_update"/);
  assert.match(source, /alert\.direction==="LONG"\?hold\.newStop>oldStop:hold\.newStop<oldStop/);
  assert.match(source, /\[CHANDELIER\].*stop updated/);
});

test("state persistence updates active signals and active history with the tighter stop", () => {
  const source = fs.readFileSync(require.resolve("../lib/state.ts"), "utf8");
  assert.match(source, /export async function updateActiveSignalStop/);
  assert.match(source, /await setActiveSignals\(active\)/);
  assert.match(source, /entry\.stop=newStop/);
});
