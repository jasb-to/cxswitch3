const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

test("system metadata identifies the pure V28 single daily EMA5/13 architecture", () => {
  const source = fs.readFileSync("lib/version.ts", "utf8");
  assert.ok(source.includes("CXSWITCH_VERSION = 28"));
  assert.ok(source.includes("V28 SINGLE DAILY EMA5/13 + SHARED 4H TRENDLINE"));
  assert.ok(source.includes("1D EMA5/13"));
  assert.doesNotMatch(source, /FAST\/MACRO|FAST 1D|MACRO 1D|V31|7-STATE REGIME|4H STOCH RETEST/);
});
