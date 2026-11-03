const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

const strategy = fs.readFileSync("lib/strategy.ts", "utf8");
const cron = fs.readFileSync("app/api/cron/route.ts", "utf8");
const state = fs.readFileSync("lib/state.ts", "utf8");
const telegram = fs.readFileSync("lib/telegram.ts", "utf8");

test("active pair and direction suppress a new signal independently of entry price", () => {
  assert.ok(strategy.includes("activeSignals:Array<{pair:string;direction:Direction}>=[]"));
  assert.ok(strategy.includes("active.pair===pair&&active.direction===s.direction"));
  assert.ok(cron.includes("entry2AlreadyFired,active.map((x:any)=>({pair:x.pair,direction:x.direction}))"));
});

test("Chandelier uses the 10-candle extreme with a 3 ATR offset", () => {
  assert.ok(strategy.includes("window=closed4h.slice(-10)"));
  assert.ok(strategy.includes("Math.max(...window.map(z=>z.high))-3*volatility"));
  assert.ok(strategy.includes("Math.min(...window.map(z=>z.low))+3*volatility"));
  assert.ok(strategy.includes('reason:"chandelier_stop_update"'));
  assert.ok(strategy.includes('reason:"chandelier_trailing_stop"'));
});

test("structural exits require both the Stoch extreme and latest closed EMA5/13 cross", () => {
  assert.ok(strategy.includes("st.k<20&&bearishCross"));
  assert.ok(strategy.includes("st.k>80&&bullishCross"));
  assert.ok(strategy.includes("ema5[prev]>=ema13[prev]&&ema5[last]<ema13[last]"));
  assert.ok(strategy.includes("ema5[prev]<=ema13[prev]&&ema5[last]>ema13[last]"));
  assert.doesNotMatch(strategy, /rsiNow>=78|rsiNow<=22|4h_ema_reversal_confirmed|1d_ema_reversal_confirmed/);
});

test("Chandelier ratchets are persisted only when tighter and exits remove active positions", () => {
  assert.ok(state.includes("export async function updateActiveSignalStop"));
  assert.ok(state.includes('direction==="LONG"?newStop>current:newStop<current'));
  assert.ok(cron.includes('hold.reason==="chandelier_stop_update"'));
  assert.ok(cron.includes("updateActiveSignalStop(alert.pair,alert.direction,hold.newStop)"));
  assert.ok(cron.includes("active.splice(activeIndex,1)"));
  assert.ok(cron.includes('updateSignalHistoryStatus(alert.id,"FAILED",hold.reason,price)'));
});

test("hard stops remain active but TP1/TP2 are not operational exits", () => {
  assert.ok(cron.includes("const stopHit=Number.isFinite(stop)&&stop>0"));
  assert.doesNotMatch(cron, /targetHit|tp2_hit/);
  assert.doesNotMatch(strategy, /calculateTargetsFromPivots|export function calculateTargets\(/);
});

test("Telegram management alert describes the new structural exit accurately", () => {
  assert.ok(telegram.includes("Confirmed chandelier trailing-stop breach. EXIT TRADE."));
  assert.ok(telegram.includes("4H Stoch RSI extreme + EMA 5/13 cross confirmed on the latest closed candle"));
});
