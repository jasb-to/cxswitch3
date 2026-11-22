const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const read = (file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");
const strategy = read("lib/strategy.ts");
const route = read("app/api/cron/route.ts");
const state = read("lib/state.ts");
const telegram = read("lib/telegram.ts");

test("V28 duplicate suppression is candle-scoped and KV-persisted", () => {
  assert.match(strategy, /const HYSTERESIS_BAND = 0\.005/);
  assert.match(strategy, /lastSignalCandleTimestamp/);
  assert.match(strategy, /isHysteresisBlocked\(/);
  assert.match(strategy, /getHysteresisState/);
  assert.match(strategy, /setHysteresisState/);
  assert.match(route, /loadTrendlinesFromKV\(\)/);
  assert.match(route, /saveTrendlinesToKV\(\)/);
  assert.match(state, /v28_hysteresis_state/);
});

test("ENTRY_2 may start independently and may continue a same-direction ENTRY_1", () => {
  assert.match(strategy, /entry2Continuation=activeMatch&&activeSignals\.some/);
  assert.match(strategy, /entry2Ready&&\(!activePairPosition\|\|entry2Continuation\)/);
  assert.match(strategy, /entry2Continuation=activeMatch&&_activeSignals\.some/);
});

test("4H EMA5/13 misalignment exits losing trades but never tightens profitable stops", () => {
  const start = strategy.indexOf("export function shouldHold(");
  assert.notEqual(start, -1);
  const hold = strategy.slice(start);
  assert.match(hold, /4h_ema5_13_misaligned_unprofitable_exit/);
  assert.match(hold, /momentumAligned===false&&!profitable/);
  assert.match(hold, /4h_ema5_13_misaligned_profitable_hold/);
  assert.doesNotMatch(hold, /newStop:s\.entry/);
  assert.doesNotMatch(hold, /tighten_stop_to_entry/);
});

test("cron management uses a live Kraken ticker and history mutations are serialized", () => {
  assert.match(route, /getCurrentPrice/);
  assert.ok(route.includes("currentPrice:Number(candles.livePrice)"));
  assert.match(state, /createSerialQueue/);
  assert.match(state, /runSignalHistoryMutation/);
});

test("stop-hit Telegram alerts require the original stop threshold to be reached", () => {
  assert.match(telegram, /actualStopReached/);
  assert.match(telegram, /hit stop at/);
  assert.match(route, /kind:"STOP_HIT",price,stop,reason:"sl_hit"/);
});

test("Telegram entry sender permits all three V28 signal types", () => {
  assert.match(telegram, /type!=="ENTRY_1"&&type!=="ENTRY_2"&&type!=="ADD"/);
  assert.match(route, /signalType:signal\.type/);
});

test("no-signal diagnostics report hysteresis rather than a generic missing Signal object", () => {
  assert.match(route, /startsWith\("\[HYSTERESIS\]"\)/);
  assert.match(route, /detail=\$\{snapshot\.strategyStatus\}/);
});
