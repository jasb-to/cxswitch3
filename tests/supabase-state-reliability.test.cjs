const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

const kv = fs.readFileSync("lib/supabase-kv.ts", "utf8");
const state = fs.readFileSync("lib/state.ts", "utf8");
const cron = fs.readFileSync("app/api/cron/route.ts", "utf8");
const signals = fs.readFileSync("app/api/signals/route.ts", "utf8");
const telegram = fs.readFileSync("lib/telegram.ts", "utf8");

test("Supabase KV operations use bounded timeouts, controlled retries, and timing logs", () => {
  assert.ok(kv.includes("const DEFAULT_QUERY_TIMEOUT_MS = 8_000"));
  assert.ok(kv.includes("const MAX_OPERATION_RETRIES = 1"));
  assert.ok(kv.includes("const RETRY_DELAY_MS = 250"));
  assert.ok(kv.includes("AbortSignal.timeout(timeoutMs)"));
  assert.ok(kv.includes("SUPABASE_URL"));
  assert.ok(kv.includes("SUPABASE_SERVICE_ROLE_KEY"));
  assert.ok(kv.includes('cxswitch_kv?select=value,expires_at&key=eq.'));
  assert.ok(kv.includes('"rpc/cxswitch_kv_claim"'));
  assert.ok(kv.includes('"rpc/cxswitch_kv_cleanup_expired"'));
  assert.ok(kv.includes('method: "POST"'));
  assert.ok(kv.includes("[KV] ${opName} took"));
  assert.ok(kv.includes("attempt=${attempt + 1} status=ok"));
  assert.ok(kv.includes("attempt=${attempt + 1} status=error"));
  assert.ok(kv.includes("options.nx ? 0 : MAX_OPERATION_RETRIES"), "NX claims must not blindly retry after ambiguous timeouts");
  assert.ok(kv.includes("PostgREST applies the token predicate and DELETE in one SQL statement"));
  assert.ok(kv.includes('process.env.CXSWITCH_KV_PROVIDER?.trim().toLowerCase() === "layerbase"'), "Layerbase must be explicit opt-in; Supabase is the default");
});

test("Layerbase cutover migrates bounded critical state before serving reads", () => {
  assert.ok(state.includes("LAYERBASE_MIGRATION_FLAG_KEY"));
  assert.ok(state.includes('from("cxswitch_kv")'));
  assert.ok(state.includes('.select("key,value,expires_at").in("key", keys)'));
  assert.ok(state.includes("source active_signals is missing or invalid"));
  assert.ok(state.includes("source signal_history is missing or invalid"));
  assert.ok(state.includes("historyRow.value.slice(-SIGNAL_HISTORY_MAX)"));
  assert.ok(state.includes("Supabase -> Layerbase completed"));
  assert.ok(state.includes("refusing to read uninitialised state"));
  assert.ok(state.includes("cxswitch:cleanup:btc_short_20260923"));
  assert.ok(state.includes("cxswitch:exit_alert_cooldowns"));
  assert.ok(!state.includes('keys.push(TELEGRAM_ALERT_KEY_PREFIX'));
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
  assert.ok(state.includes("redis.compareAndDelete(CRON_LOCK_KEY,token)"));
  assert.ok(state.includes("Atomic compare-and-delete"));
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
