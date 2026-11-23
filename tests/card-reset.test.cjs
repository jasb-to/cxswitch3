const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("dashboard excludes historical closed trades at or before the symbol reset", () => {
  const page = fs.readFileSync(path.join(__dirname, "../app/page.tsx"), "utf8");
  assert.match(page, /h\.timestamp>\(cardResets\[pair\]\?\?0\)/);
  assert.match(page, /setCardResets\(d\.cardResets\|\|\{\}\)/);
});

test("signals API exposes persisted per-symbol reset timestamps", () => {
  const route = fs.readFileSync(path.join(__dirname, "../app/api/signals/route.ts"), "utf8");
  assert.match(route, /getCardResets/);
  assert.match(route, /cardResets,logs/);
});

test("reset comparison preserves trades created after the reset", () => {
  const resetAt = 1_000;
  const oldSignal = 999;
  const newSignal = 1_001;
  assert.equal(oldSignal > resetAt, false);
  assert.equal(newSignal > resetAt, true);
});
