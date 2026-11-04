const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

test("system metadata identifies the deployed V28 dual daily architecture", () => {
  const source = fs.readFileSync("lib/version.ts", "utf8");
  assert.ok(source.includes("CXSWITCH_VERSION = 28"));
  assert.ok(source.includes("V28 FAST/MACRO DAILY + SHARED 4H TRENDLINE"));
  assert.ok(source.includes("FAST 1D EMA5/13; MACRO 1D EMA8/21"));
  assert.doesNotMatch(source, /V31|7-STATE REGIME|4H STOCH RETEST/);
});
