const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

const telegram = fs.readFileSync("lib/telegram.ts", "utf8");

test("Telegram reads Jarvis skeptic warnings from the Jarvis review and signal context", () => {
  assert.match(telegram, /jarvis\?\.skepticWarning/);
  assert.match(telegram, /ctx\.skepticWarning/);
});

test("a skeptic warning replaces the ordinary GOOD/WARN verdict and is appended last", () => {
  assert.match(telegram, /const skepticLine=skepticReason\?\x60⚠️ JARVIS SKEPTIC: \$\{skepticReason\}\x60:""/);
  assert.match(telegram, /skepticLine \? "" : jarvis\?\.verdict \? \x60JARVIS: \$\{jarvis\.verdict\}\x60 : ""/);
  assert.match(telegram, /reasonText,\s*skepticLine/);
});

test("Telegram normalizes the Jarvis warning prefix without duplicating it", () => {
  assert.match(telegram, /replace\(\/\^\\\[JARVIS SKEPTIC\\\]\\s\*WARNING:\\s\*\/i/);
  assert.match(telegram, /replace\(\/\^⚠️\\s\*JARVIS SKEPTIC:\\s\*\/i/);
});
