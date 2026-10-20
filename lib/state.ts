// lib/state.ts — v01 canonical state
// V28 trade architecture is stored here as the single active/history model.

import { Redis } from "./supabase-kv";
import { Signal } from "./strategy";

const redis = new Redis();

const LEGACY_SIGNALS_KEY = "cxswitch:signals";
const LEGACY_TRADES_KEY = "cxswitch:active_trades";
const ACTIVE_SIGNALS_KEY = "cxswitch:active_signals";
const SIGNAL_HISTORY_KEY = "cxswitch:signal_history";
const LATEST_ALERTS_KEY = "cxswitch:latest_alerts";
const CARD_RESETS_KEY = "cxswitch:card_resets";
const MARKET_KEY = "cxswitch:market";
const CRON_KEY = "cxswitch:last_cron";
const CRON_LOCK_KEY = "cxswitch:cron_lock";
const CRON_LOCK_TTL_SECONDS = 120;
const SNAPSHOT_KEY = "cxswitch:dashboard_snapshot";
const MIGRATION_FLAG_KEY = "cxswitch:migrated_v01";
const LAYERBASE_MIGRATION_FLAG_KEY = "cxswitch:migrated_to_layerbase_v1";
const COOLDOWN_KEY = "cxswitch:cooldowns";
const EXIT_ALERT_COOLDOWNS_KEY = "cxswitch:exit_alert_cooldowns";
const TELEGRAM_ALERT_KEY_PREFIX = "cxswitch:telegram_alert:";
const ONE_TIME_BTC_SHORT_CLEANUP_KEY = "cxswitch:cleanup:btc_short_20260923";
const SIGNAL_HISTORY_MAX = 50;
const TELEGRAM_ALERT_TTL_SECONDS = 60*60*6;
const CLEANUP_KEY = "cxswitch:cleanup:bandwidth_20261002_v1";
const LEGACY_1D_LOG_KEY = "cxswitch:1d_trend_log_v2";

// These cleanup markers are permanent one-time migrations. Cache successful checks
// within a warm serverless instance so every state read does not issue extra KV queries.
let btcShortCleanupVerified = false;
let historyCleanupVerified = false;

export interface ActiveTrade {
  id: string; pair: string; direction: "LONG" | "SHORT"; type: "ENTRY_1" | "ENTRY_2" | "ENTRY" | "REVERSAL_SHORT" | "REVERSAL_LONG";
  entry: number; stop: number; target: number; tp1?: number; tp2?: number;
  tp1HitAt?: number; tp2HitAt?: number; slToEntryAt?: number; timestamp: number; rr: number;
  status: "ACTIVE"; context?: any; sizeMultiplier?: number; version: number;
  holdAdvice?: { status: "healthy" | "warning" | "failed"; reason: string; newStop?: number; checkedAt: number };
}

export type HistoryStatus = "ACTIVE" | "TP_HIT" | "SL_HIT" | "FAILED" | "EXPIRED";
export interface SignalHistoryEntry {
  id: string; pair: string; direction: "LONG" | "SHORT"; type: "ENTRY_1" | "ENTRY_2" | "REVERSAL_SHORT" | "REVERSAL_LONG";
  entry: number; stop: number; target: number; tp1?: number; tp2?: number; tp3?: number;
  tp1HitAt?: number; tp2HitAt?: number; tp3HitAt?: number; slToEntryAt?: number; timestamp: number; rr: number;
  status: HistoryStatus; exitReason?: string; exitPrice?: number; exitTimestamp?: number; context?: any; version: number; confirmedManually?: boolean; confirmedAt?: number;
}


export async function runMigrationIfNeeded(): Promise<void> {
  if (await redis.get<boolean>(LAYERBASE_MIGRATION_FLAG_KEY, 0)) return;

  const lockKey = "cxswitch:migration:layerbase_v1_lock";
  const token = `migration-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const claimed = await redis.set(lockKey, { token, startedAt: Date.now() }, { nx: true, ex: 120 });
  if (claimed !== "OK") {
    for (let attempt = 0; attempt < 24; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 250));
      if (await redis.get<boolean>(LAYERBASE_MIGRATION_FLAG_KEY, 0)) return;
    }
    throw new Error("Layerbase state migration is already running; refusing to read uninitialised state");
  }

  try {
    if (await redis.get<boolean>(LAYERBASE_MIGRATION_FLAG_KEY, 0)) return;
    const rawUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!rawUrl || !serviceKey) throw new Error("Layerbase migration requires the existing Supabase source credentials");
    const url = rawUrl.trim().replace(/\/$/, "");
    const dashboardMatch = url.match(/supabase\.com\/dashboard\/project\/([a-z0-9]+)(?:\/|$)/i);
    const sourceUrl = dashboardMatch ? `https://${dashboardMatch[1]}.supabase.co` : url;
    const { createClient } = await import("@supabase/supabase-js");
    const source = createClient(sourceUrl, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
    const keys = [
      ACTIVE_SIGNALS_KEY, SIGNAL_HISTORY_KEY, LATEST_ALERTS_KEY,
      COOLDOWN_KEY, EXIT_ALERT_COOLDOWNS_KEY, CARD_RESETS_KEY, CRON_KEY,
      "cxswitch:v28_breakout_state", ONE_TIME_BTC_SHORT_CLEANUP_KEY,
      CLEANUP_KEY, MIGRATION_FLAG_KEY,
    ];
    const { data, error } = await source.from("cxswitch_kv")
      .select("key,value,expires_at").in("key", keys)
      .abortSignal(AbortSignal.timeout(8_000));
    if (error) throw new Error(`Source-state migration read failed: ${error.message}`);
    const rows = new Map((data ?? []).map((row: any) => [String(row.key), row]));
    const activeRow: any = rows.get(ACTIVE_SIGNALS_KEY);
    const historyRow: any = rows.get(SIGNAL_HISTORY_KEY);
    if (!activeRow || !Array.isArray(activeRow.value)) throw new Error("Migration safety check failed: source active_signals is missing or invalid");
    if (!historyRow || !Array.isArray(historyRow.value)) throw new Error("Migration safety check failed: source signal_history is missing or invalid");

    const active = activeRow.value.map((signal: any) => {
      const compact = { ...signal };
      delete compact.context;
      return compact;
    });
    const history = historyRow.value.slice(-SIGNAL_HISTORY_MAX).map((entry: any) => {
      const compact = { ...entry };
      delete compact.context;
      return compact;
    });
    const payloads: Array<[string, unknown, string | null]> = [
      [ACTIVE_SIGNALS_KEY, active, activeRow.expires_at ?? null],
      [SIGNAL_HISTORY_KEY, history, historyRow.expires_at ?? null],
    ];
    for (const key of [LATEST_ALERTS_KEY, COOLDOWN_KEY, EXIT_ALERT_COOLDOWNS_KEY, CARD_RESETS_KEY, CRON_KEY, "cxswitch:v28_breakout_state", ONE_TIME_BTC_SHORT_CLEANUP_KEY, CLEANUP_KEY, MIGRATION_FLAG_KEY]) {
      const row: any = rows.get(key);
      if (row) payloads.push([key, row.value, row.expires_at ?? null]);
    }

    // Preserve the valid BTC SHORT in the migrated active list; never let the
    // legacy one-time cleanup run against an empty destination marker.
    if (active.some((signal: any) => signal.pair === "BTC" && signal.direction === "SHORT") &&
        !rows.has(ONE_TIME_BTC_SHORT_CLEANUP_KEY)) {
      payloads.push([ONE_TIME_BTC_SHORT_CLEANUP_KEY, true, null]);
    }

    await Promise.all(payloads.map(async ([key, value, expiresAt]) => {
      const ttl = expiresAt ? Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000) : undefined;
      if (ttl !== undefined && ttl <= 0) return;
      const result = await redis.set(key, value, ttl ? { ex: ttl } : {});
      if (result !== "OK") throw new Error(`Migration write did not confirm for ${key}`);
    }));
    await redis.set(LAYERBASE_MIGRATION_FLAG_KEY, { completedAt: Date.now(), migratedKeys: payloads.length });
    console.log(`[STATE MIGRATION] Supabase -> Layerbase completed active=${active.length} history=${history.length} keys=${payloads.length}; caches and expiring Telegram dedupe keys intentionally not copied`);
  } finally {
    const lock = await redis.get<{ token?: string }>(lockKey, 0).catch(() => null);
    if (lock?.token === token) await redis.del(lockKey, 0).catch(() => 0);
  }
}

export async function runPersistenceCleanup(): Promise<{expired:number;telegramPruned:number}> {
  const expired=await redis.cleanupExpired();
  const telegramPruned=await redis.prunePrefix(TELEGRAM_ALERT_KEY_PREFIX,100);
  console.log(`[STATE CLEANUP] Supabase KV expired=${expired} telegram_alerts_pruned=${telegramPruned} retention=100`);
  return {expired,telegramPruned};
}

export async function getActiveSignals(): Promise<ActiveTrade[]> {
  await runMigrationIfNeeded();
  let active = (await redis.get<ActiveTrade[]>(ACTIVE_SIGNALS_KEY)) || [];
  // One-time cleanup for the BTC short that was identified as an invalid/stale position.
  // Preserve its history for auditability, but remove it from live position state so the
  // entry engine is allowed to evaluate BTC normally again.
  if (!btcShortCleanupVerified) {
    const cleaned = await redis.get<boolean>(ONE_TIME_BTC_SHORT_CLEANUP_KEY);
    if (cleaned) btcShortCleanupVerified = true;
    if (!cleaned) {
    const bad = active.filter(t => t.pair === "BTC" && t.direction === "SHORT");
    if (bad.length) {
      active = active.filter(t => !(t.pair === "BTC" && t.direction === "SHORT"));
      await setActiveSignals(active);
      const history = (await redis.get<SignalHistoryEntry[]>(SIGNAL_HISTORY_KEY)) || [];
      const badIds = new Set(bad.map(t => t.id));
      for (const h of history) {
        if (badIds.has(h.id) && h.status === "ACTIVE") {
          h.status = "FAILED";
          h.exitReason = "invalidated_bad_entry";
          h.exitTimestamp = Date.now();
        }
      }
      await redis.set(SIGNAL_HISTORY_KEY, history);
      const latest = await redis.get<Record<string,SignalHistoryEntry>>(LATEST_ALERTS_KEY) || {};
      if (latest.BTC && badIds.has(latest.BTC.id)) {
        latest.BTC.status = "FAILED";
        latest.BTC.exitReason = "invalidated_bad_entry";
        latest.BTC.exitTimestamp = Date.now();
        await redis.set(LATEST_ALERTS_KEY, latest);
      }
      console.log(`[STATE CLEANUP] Removed invalid BTC SHORT position(s): ${bad.map(t => t.id).join(", ")}`);
    }
      await redis.set(ONE_TIME_BTC_SHORT_CLEANUP_KEY, true);
      btcShortCleanupVerified = true;
    }
  }
  return active;
}
export async function setActiveSignals(signals: ActiveTrade[]): Promise<void> {
  const compact = signals.map(signal => {
    const stored = { ...signal };
    delete stored.context;
    return stored;
  });
  const payloadBytes = new TextEncoder().encode(JSON.stringify(compact)).length;
  console.log(`[STATE] active_signals payload count=${compact.length} bytes=${payloadBytes}`);
  if (payloadBytes > 10 * 1024) console.warn(`[STATE] active_signals payload exceeds 10KB: ${payloadBytes} bytes`);
  await redis.set(ACTIVE_SIGNALS_KEY, compact);
}
export async function addActiveSignal(signal: Signal): Promise<void> {
  const active = await getActiveSignals();
  const trade: ActiveTrade = {id:signal.id,pair:signal.pair,direction:signal.direction,type:signal.type,entry:signal.entry,stop:signal.stop,target:signal.tp2 ?? 0,tp1:signal.tp1,tp2:signal.tp2,timestamp:signal.timestamp,rr:signal.rr,status:"ACTIVE",sizeMultiplier:signal.sizeMultiplier,version:signal.version};
  const idx = active.findIndex(a => a.pair === signal.pair && a.direction === signal.direction);
  if (idx >= 0) {
    const previous = { ...active[idx] };
    delete previous.context;
    active[idx] = {...previous,...trade};
  } else active.push(trade);
  await setActiveSignals(active);
  console.log(`[ACTIVE] Added ${signal.pair} ${signal.direction} ${signal.type} | TP1 ${trade.tp1 ?? "—"} | TP2 ${trade.tp2 ?? "—"}`);
}
export async function removeActiveSignal(pair:string,direction:"LONG"|"SHORT"):Promise<void>{const active=await getActiveSignals();const filtered=active.filter(a=>!(a.pair===pair&&a.direction===direction));if(filtered.length!==active.length){await setActiveSignals(filtered);console.log(`[ACTIVE] Removed ${pair} ${direction}`);}}
export async function removeActiveSignalById(id:string):Promise<void>{const active=await getActiveSignals();const filtered=active.filter(a=>a.id!==id);if(filtered.length!==active.length){await setActiveSignals(filtered);console.log(`[ACTIVE] Removed signal ${id}`);}}
export async function updateActiveTradeMilestones(id:string,price:number):Promise<ActiveTrade|undefined>{const active=await getActiveSignals();const trade=active.find(a=>a.id===id);if(!trade)return undefined;const hit=(level:number|undefined,direction:"LONG"|"SHORT")=>level!==undefined&&(direction==="LONG"?price>=level:price<=level);let changed=false;if(!trade.tp1HitAt&&hit(trade.tp1,trade.direction)){trade.tp1HitAt=Date.now();changed=true;console.log(`[MILESTONE] ${trade.pair} — TP1 reached @ ${price}`);}if(!trade.tp2HitAt&&hit(trade.tp2,trade.direction)){trade.tp2HitAt=Date.now();changed=true;console.log(`[MILESTONE] ${trade.pair} — TP2 reached @ ${price}`);}if(changed)await setActiveSignals(active);return trade;}
export async function getSignalHistory():Promise<SignalHistoryEntry[]>{
  const history=(await redis.get<SignalHistoryEntry[]>(SIGNAL_HISTORY_KEY))||[];
  const compact=history.slice(-SIGNAL_HISTORY_MAX).map(entry=>{const stored={...entry};delete stored.context;return stored;});
  const changed=compact.length!==history.length||history.some(entry=>Object.prototype.hasOwnProperty.call(entry,"context"));
  if(changed){
    const bytes=new TextEncoder().encode(JSON.stringify(compact)).length;
    try {
      await redis.set(SIGNAL_HISTORY_KEY,compact);
      console.log(`[STATE CLEANUP] Compacted signal_history count=${history.length}->${compact.length} bytes=${bytes}`);
    } catch (error) {
      console.warn(`[STATE CLEANUP] signal_history compaction write failed; continuing with compact in-memory history bytes=${bytes}: ${String(error)}`);
    }
  }
  if(!historyCleanupVerified){
    const cleaned=await redis.get<boolean>(CLEANUP_KEY);
    if(cleaned) historyCleanupVerified=true;
    else {
      await redis.del(LEGACY_1D_LOG_KEY);
      await redis.set(CLEANUP_KEY,true);
      historyCleanupVerified=true;
      console.log(`[STATE CLEANUP] History retention complete: signal_history ${history.length} -> ${compact.length}; deleted legacy 1D v2 log`);
    }
  }
  return compact;
}
export async function setSignalHistory(history:SignalHistoryEntry[]):Promise<void>{
  const compact=history.slice(-SIGNAL_HISTORY_MAX).map(entry=>{const stored={...entry};delete stored.context;return stored;});
  const bytes=new TextEncoder().encode(JSON.stringify(compact)).length;
  console.log(`[STATE] signal_history payload count=${compact.length} bytes=${bytes}`);
  if(bytes>100*1024) console.warn(`[STATE] signal_history payload exceeds 100KB: ${bytes} bytes`);
  await redis.set(SIGNAL_HISTORY_KEY,compact);
}

// Persistent Telegram alert idempotency. The key represents a lifecycle event
// (for ENTRY_1/ENTRY_2 this is the breakout record), not a transient signal id.
export async function claimTelegramAlert(key:string):Promise<boolean>{
  const redisKey=`${TELEGRAM_ALERT_KEY_PREFIX}${key}`;
  const result=await redis.set(redisKey,Date.now(),{nx:true,ex:TELEGRAM_ALERT_TTL_SECONDS});
  return result === "OK";
}
export async function releaseTelegramAlert(key:string):Promise<void>{
  await redis.del(`${TELEGRAM_ALERT_KEY_PREFIX}${key}`);
}

// Latest alert is separate from active position state and full history. Card resets only hide
// the latest-alert pointer for that symbol; they never delete or mutate history/positions.
export async function getCardResets():Promise<Record<string,number>>{return(await redis.get<Record<string,number>>(CARD_RESETS_KEY))||{};}
export async function reconcileSymbolCard(pair:string):Promise<{pair:string;resetAt:number;hiddenAlertId?:string;resetActiveIds:string[];activePosition:boolean}> {
  const now=Date.now();
  const resets=await getCardResets();
  const latest=await redis.get<Record<string,SignalHistoryEntry>>(LATEST_ALERTS_KEY) || {};
  const hiddenAlertId=latest[pair]?.id;

  // A manual reset is a hard return to scanning mode. It must clear every
  // live/display pointer for this symbol, even when the position was already
  // removed by exit management before the user pressed RESET / RE-SYNC.
  resets[pair]=now;
  await redis.set(CARD_RESETS_KEY,resets);

  const active=await getActiveSignals();
  const resetTrades=active.filter(x=>x.pair===pair);
  if(resetTrades.length){
    await setActiveSignals(active.filter(x=>x.pair!==pair));
  }

  // Expire any still-ACTIVE history for this pair as part of the reset. This
  // also prevents latestAlertMomentum() from resurrecting an old exit state.
  const history=await getSignalHistory();
  let historyChanged=false;
  for(const h of history){
    if(h.pair===pair&&h.status==="ACTIVE"){
      h.status="EXPIRED";
      h.exitReason="manual_symbol_reset";
      h.exitTimestamp=now;
      historyChanged=true;
    }
  }
  if(historyChanged) await setSignalHistory(history);

  // Always remove the persisted latest-alert pointer. getLatestAlerts() will
  // respect the reset timestamp and therefore will not derive this old alert
  // back from history.
  const latestAfter=await redis.get<Record<string,SignalHistoryEntry>>(LATEST_ALERTS_KEY)||{};
  delete latestAfter[pair];
  await redis.set(LATEST_ALERTS_KEY,latestAfter);

  console.log(`[CARD] ${pair} — RESET / RE-SYNC at ${new Date(now).toISOString()} | active removed=${resetTrades.length} | history expired=${historyChanged?"yes":"no"} | latest alert hidden=${hiddenAlertId||"none"}`);
  return {pair,resetAt:now,hiddenAlertId,resetActiveIds:resetTrades.map(x=>x.id),activePosition:false};
}

export async function getLatestAlerts():Promise<Record<string,SignalHistoryEntry>>{
  await runMigrationIfNeeded();
  const latest=await redis.get<Record<string,SignalHistoryEntry>>(LATEST_ALERTS_KEY) || {};
  const resets=await getCardResets();
  const visible:Record<string,SignalHistoryEntry>={};
  for(const [pair,alert] of Object.entries(latest)) if(!resets[pair] || alert.timestamp>resets[pair]) visible[pair]=alert;
  if(Object.keys(visible).length)return visible;
  const history=await getSignalHistory();const derived:Record<string,SignalHistoryEntry>={};
  for(const h of history) if((!resets[h.pair]||h.timestamp>resets[h.pair])&&(!derived[h.pair]||h.timestamp>derived[h.pair].timestamp)) derived[h.pair]=h;
  if(Object.keys(derived).length) await redis.set(LATEST_ALERTS_KEY,{...latest,...derived});
  return derived;
}

export async function appendSignalHistory(signal:Signal):Promise<void>{const history=await getSignalHistory();if(history.some(h=>h.id===signal.id)){console.log(`[HISTORY] Signal ${signal.id} already recorded`);return;}const entry:SignalHistoryEntry={id:signal.id,pair:signal.pair,direction:signal.direction,type:signal.type,entry:signal.entry,stop:signal.stop,target:signal.tp2 ?? 0,tp1:signal.tp1,tp2:signal.tp2,timestamp:signal.timestamp,rr:signal.rr,status:"ACTIVE",version:signal.version};history.push(entry);if(history.length>SIGNAL_HISTORY_MAX)history.splice(0,history.length-SIGNAL_HISTORY_MAX);await setSignalHistory(history);const latest=await redis.get<Record<string,SignalHistoryEntry>>(LATEST_ALERTS_KEY)||{};latest[entry.pair]=entry;await redis.set(LATEST_ALERTS_KEY,latest);console.log(`[HISTORY] Appended ${signal.pair} ${signal.direction} ${signal.type} | TP1 ${entry.tp1 ?? "—"} | TP2 ${entry.tp2 ?? "—"} | latest alert persisted`);}
export async function updateSignalHistoryStatus(id:string,status:HistoryStatus,exitReason?:string,exitPrice?:number):Promise<void>{const history=await getSignalHistory();const idx=history.findIndex(h=>h.id===id);if(idx<0){console.log(`[HISTORY] Warning: could not find ${id}`);return;}history[idx].status=status;if(exitReason)history[idx].exitReason=exitReason;if(exitPrice!==undefined)history[idx].exitPrice=exitPrice;history[idx].exitTimestamp=Date.now();await setSignalHistory(history);const latest=await redis.get<Record<string,SignalHistoryEntry>>(LATEST_ALERTS_KEY)||{};if(latest[history[idx].pair]?.id===id){latest[history[idx].pair]=history[idx];await redis.set(LATEST_ALERTS_KEY,latest);}console.log(`[HISTORY] Updated ${id} -> ${status}${exitReason?` (${exitReason})`:""}`);}
export async function updateHistoryMilestonesBatch(updates:{id:string;price:number}[]):Promise<void>{
  if(!updates.length)return;
  const history=await getSignalHistory();
  const latest=await redis.get<Record<string,SignalHistoryEntry>>(LATEST_ALERTS_KEY)||{};
  const byId=new Map<string,number>(updates.map(x=>[x.id,x.price] as [string,number]));
  let historyChanged=false,latestChanged=false;
  for(const h of history){
    const price=byId.get(h.id);
    if(price===undefined||!Number.isFinite(price))continue;
    const hit=(level:number|undefined,direction:"LONG"|"SHORT")=>level!==undefined&&(direction==="LONG"?price>=level:price<=level);
    let changed=false;
    if(!h.tp1HitAt&&hit(h.tp1,h.direction)){h.tp1HitAt=Date.now();changed=true;}
    if(!h.tp2HitAt&&hit(h.tp2,h.direction)){h.tp2HitAt=Date.now();changed=true;}
    if(changed){
      historyChanged=true;
      if(latest[h.pair]?.id===h.id){latest[h.pair]=h;latestChanged=true;}
      console.log(`[MILESTONE] ${h.pair} — batched target milestone updated @ ${price}`);
    }
  }
  if(historyChanged)await setSignalHistory(history);
  if(latestChanged)await redis.set(LATEST_ALERTS_KEY,latest);
}
export async function updateHistoryMilestones(id:string,price:number):Promise<SignalHistoryEntry|undefined>{const history=await getSignalHistory();const h=history.find(x=>x.id===id);if(!h)return undefined;const hit=(level:number|undefined,direction:"LONG"|"SHORT")=>level!==undefined&&(direction==="LONG"?price>=level:price<=level);let changed=false;if(!h.tp1HitAt&&hit(h.tp1,h.direction)){h.tp1HitAt=Date.now();changed=true;}if(!h.tp2HitAt&&hit(h.tp2,h.direction)){h.tp2HitAt=Date.now();changed=true;}if(changed){await setSignalHistory(history);const latest=await redis.get<Record<string,SignalHistoryEntry>>(LATEST_ALERTS_KEY)||{};if(latest[h.pair]?.id===id){latest[h.pair]=h;await redis.set(LATEST_ALERTS_KEY,latest);}}return h;}
export async function updateHistoryStopMilestone(id:string,stop:number):Promise<SignalHistoryEntry|undefined>{const history=await getSignalHistory();const h=history.find(x=>x.id===id);if(!h)return undefined;const atEntry=Math.abs(stop-h.entry)<=Math.max(Math.abs(h.entry)*0.000001,0.000001);if(!h.slToEntryAt&&atEntry){h.slToEntryAt=Date.now();await setSignalHistory(history);const latest=await redis.get<Record<string,SignalHistoryEntry>>(LATEST_ALERTS_KEY)||{};if(latest[h.pair]?.id===id){latest[h.pair]=h;await redis.set(LATEST_ALERTS_KEY,latest);}console.log(`[MILESTONE] ${h.pair} — SL moved to entry @ ${stop}`);}return h;}
export async function getCooldowns():Promise<Record<string,number>>{return(await redis.get<Record<string,number>>(COOLDOWN_KEY))||{};}
export async function setCooldowns(cooldowns:Record<string,number>):Promise<void>{await redis.set(COOLDOWN_KEY,cooldowns);}
export async function getExitAlertCooldowns():Promise<Record<string,number>>{return(await redis.get<Record<string,number>>(EXIT_ALERT_COOLDOWNS_KEY))||{};}
export async function setExitAlertCooldowns(cooldowns:Record<string,number>):Promise<void>{await redis.set(EXIT_ALERT_COOLDOWNS_KEY,cooldowns);}
export async function getMarketData():Promise<any[]>{return(await redis.get<any[]>(MARKET_KEY))||[];}
// Market data is a dashboard snapshot, not the source of truth for signal calculations.
 // Bound this relatively large write so a transient Supabase/network stall cannot consume the cron budget.
export async function setMarketData(data:any[]):Promise<void>{await redis.set(MARKET_KEY,data);}
export async function getLastCronRun():Promise<number>{const data=await redis.get<{timestamp:number}>(CRON_KEY);return data?.timestamp||0;}
export async function setLastCronRun(ts:number):Promise<void>{await redis.set(CRON_KEY,{timestamp:ts});}

// Shared atomic lock prevents overlapping cron executions across Vercel instances.
export async function claimCronLock(token:string):Promise<boolean>{
  try {
    const result=await redis.set(CRON_LOCK_KEY,{token,startedAt:Date.now()},{nx:true,ex:CRON_LOCK_TTL_SECONDS});
    return result==="OK";
  } catch (claimError) {
    // A client timeout is ambiguous: Postgres may have committed the atomic NX
    // insert even though Vercel never received its response. Verify ownership
    // with a single read before failing closed; never retry the claim itself.
    const message=claimError instanceof Error?claimError.message:String(claimError);
    if(!/TimeoutError|AbortError|aborted due to timeout/i.test(message)) throw claimError;
    try {
      const lock=await redis.get<{token?:string}>(CRON_LOCK_KEY,0);
      if(lock?.token===token) {
        console.warn("[CRON LOCK] Claim response timed out, but ownership was verified by token; proceeding with the acquired lock");
        return true;
      }
      console.warn("[CRON LOCK] Claim response timed out and ownership could not be verified; refusing to evaluate signals");
    } catch (verifyError) {
      console.warn(`[CRON LOCK] Ownership verification failed after ambiguous claim timeout: ${String(verifyError)}`);
    }
    throw claimError;
  }
}
export async function releaseCronLock(token:string):Promise<void>{
  const lock=await redis.get<{token?:string}>(CRON_LOCK_KEY,0);
  if(lock?.token!==token)return;
  await redis.del(CRON_LOCK_KEY,0);
}
export async function saveDashboardSnapshot(snapshot:any):Promise<void>{await redis.set(SNAPSHOT_KEY,{...snapshot,timestamp:Date.now()});}
export async function loadDashboardSnapshot():Promise<any|null>{const data=await redis.get<any>(SNAPSHOT_KEY);if(!data)return null;const age=Date.now()-(data?.timestamp||0);if(age>20*60*1000)console.warn(`[SNAPSHOT] Stale — ${Math.round(age/60000)}min old`);return data;}

export async function getLastBreakout(pair:string):Promise<import("./strategy").BreakoutRecord|undefined>{
  const state=(await redis.get<Record<string,import("./strategy").BreakoutRecord>>("cxswitch:v28_breakout_state"))||{};
  return state[pair];
}
export async function setLastBreakout(pair:string,record:import("./strategy").BreakoutRecord):Promise<void>{
  const state=(await redis.get<Record<string,import("./strategy").BreakoutRecord>>("cxswitch:v28_breakout_state"))||{};
  state[pair]=record;
  await redis.set("cxswitch:v28_breakout_state",state);
}
export async function clearLastBreakout(pair:string):Promise<void>{
  const state=(await redis.get<Record<string,import("./strategy").BreakoutRecord>>("cxswitch:v28_breakout_state"))||{};
  delete state[pair];
  await redis.set("cxswitch:v28_breakout_state",state);
}
