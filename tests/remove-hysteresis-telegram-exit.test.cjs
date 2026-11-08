const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const read = (file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");
const strategy = read("lib/strategy.ts");
const route = read("app/api/cron/route.ts");
const state = read("lib/state.ts");
const telegram = read("lib/telegram.ts");

test("strategy has no price-movement hysteresis lock or hysteresis KV state", () => {
  for (const token of ["HYSTERESIS_BAND", "hysteresisStore", "getHysteresis(", "setHysteresis(", "loadHysteresisFromKV", "saveHysteresisToKV"]) {
    assert.doesNotMatch(strategy, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.doesNotMatch(state, /getHysteresisState|setHysteresisState|v28_hysteresis_state/);
  assert.doesNotMatch(route, /loadHysteresisFromKV|saveHysteresisToKV|add_hysteresis_4h/);
});

test("ENTRY_2 continuation is derived from the active ENTRY_1 position, not a lock", () => {
  assert.match(strategy, /activeSignals\.some\(x=>x\.pair===pair&&x\.direction===macro\.direction&&x\.type==="ENTRY_1"\)/);
  assert.match(strategy, /_activeSignals\.some\(x=>x\.pair===pair&&x\.direction===macro\.direction&&x\.type==="ENTRY_1"\)/);
});

test("4H momentum-misaligned exit has explicit non-stop Telegram wording", () => {
  assert.match(route, /hold\.reason==="4h_ema5_13_misaligned_unprofitable_exit"\?"4H_MOMENTUM_MISALIGNED"/);
  assert.match(route, /reason:hold\.reason/);
  assert.match(telegram, /update\.reason==="4h_ema5_13_misaligned_unprofitable_exit"/);
  assert.match(telegram, /closed at \$\{formatPrice\(update\.price\)\} \(4H Momentum Misaligned\)/);
});
