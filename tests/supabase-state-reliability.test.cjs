const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

const kv = fs.readFileSync("lib/supabase-kv.ts", "utf8");
const state = fs.readFileSync("lib/state.ts", "utf8");
const cron = fs.readFileSync("app/api/cron/route.ts", "utf8");
const signals = fs.readFileSync("app/api/signals/route.ts", "utf8");
const telegram = fs.readFileSync("lib/telegram.ts", "utf8");

test("regular KV operations use two-second timeouts, one retry, and timing logs", () => {
  assert.ok(kv.includes("const DEFAULT_QUERY_TIMEOUT_MS = 2000"));
  assert.ok(kv.includes("const MAX_OPERATION_RETRIES = 1"));
  assert.ok(kv.includes("const RETRY_DELAY_MS = 200"));
  assert.ok(kv.includes("AbortSignal.timeout(timeoutMs)"));
  assert.ok(kv.includes("[KV] ${opName} took"));
  assert.ok(kv.includes("attempt=${attempt + 1} status=ok"));
  assert.ok(kv.includes("attempt=${attempt + 1} status=error"));
  assert.ok(kv.includes("}, 0);"), "NX claims must not blindly retry after ambiguous timeouts");
});

test("active state removes bulky context, preserves size, and logs payload bytes", () => {
  assert.ok(state.includes("delete stored.context"));
  assert.ok(state.includes("active_signals payload count="));
  assert.ok(state.includes("new TextEncoder().encode(JSON.stringify(compact)).length"));
  assert.ok(state.includes("sizeMultiplier:signal.sizeMultiplier"));
  assert.ok(!state.includes("timeoutMs:8000"));
  assert.ok(!state.includes("redis.set(ACTIVE_SIGNALS_KEY, active)"), "legacy cleanup must use the compacting setter");
});

test("cron batches new positions and commits active state once during reconciliation", () => {
  assert.ok(cron.includes("active=mergeNewSignalsIntoActive(active,newSignals);"));
  assert.ok(cron.includes("one compact write will occur after reconciliation"));
  assert.ok(!cron.includes("await addActiveSignal(signal);"));
  assert.ok(!cron.includes("serializeActiveStateWrite"));
  assert.equal((cron.match(/await setActiveSignals\(active\);/g) || []).length, 1);
});

test("cron uses a shared lock and safely reports state-store degradation", () => {
  assert.ok(state.includes("claimCronLock(token:string)"));
  assert.ok(state.includes("releaseCronLock(token:string)"));
  assert.ok(state.includes("CRON_LOCK_KEY,0"));
  assert.ok(state.includes("redis.del(CRON_LOCK_KEY,0)"));
  assert.ok(cron.includes("await claimCronLock(lockToken)"));
  assert.ok(cron.includes("await releaseCronLock(lockToken)"));
  assert.ok(cron.includes('"state_unavailable":"cron_failed"'));
  assert.ok(cron.includes("Distributed lock unavailable; refusing to evaluate signals without a lock"));
  assert.ok(cron.includes("success:!stateDegraded,degraded:stateDegraded"));
  assert.ok(cron.includes("Stage setMarketData skipped because state store is already degraded"));
  assert.ok(cron.includes("Skipped because the state store is already degraded this cycle"));
  assert.ok(cron.includes("if(/Supabase KV|TimeoutError|AbortError|KV .*failed|state store/i.test(String(e)))stateDegraded=true;"));
});

test("Telegram send is bounded and ambiguous delivery keeps the dedupe claim", () => {
  assert.ok(telegram.includes("signal:AbortSignal.timeout(6000)"));
  assert.ok(cron.includes("function isDefinitivelyRejectedBeforeDelivery(error:unknown):boolean"));
  assert.ok(cron.includes("status=ambiguous_delivery; retaining lifecycle claim to prevent a duplicate alert"));
  assert.ok(cron.includes("if(isDefinitivelyRejectedBeforeDelivery(e))"));
  assert.ok(cron.includes('const statusPrefix="Telegram sendMessage failed ("'));
  assert.ok(cron.includes('return status>=400&&status<500&&message.charAt(statusPrefix.length+3)===")"'));
  assert.ok(!cron.includes("catch(e){await releaseTelegramAlert(alertKey);"));
});

test("dashboard restores active-trade context from history rather than active KV", () => {
  assert.ok(signals.includes("const historyById=new Map(signalHistory.map((h:any)=>[h.id,h]))"));
  assert.ok(signals.includes("context:s.context??historical?.context"));
  assert.ok(signals.includes("const enrichedActive=activeForDisplay.map((s:any)=>"));
});
