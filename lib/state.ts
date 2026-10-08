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
const SNAPSHOT_KEY = "cxswitch:dashboard_snapshot";
const MIGRATION_FLAG_KEY = "cxswitch:migrated_v01";
const COOLDOWN_KEY = "cxswitch:cooldowns";
const TELEGRAM_ALERT_KEY_PREFIX = "cxswitch:telegram_alert:";
const ONE_TIME_BTC_SHORT_CLEANUP_KEY = "cxswitch:cleanup:btc_short_20260923";
const SIGNAL_HISTORY_MAX = 100;
const TELEGRAM_ALERT_TTL_SECONDS = 60*60*6;
const CLEANUP_KEY = "cxswitch:cleanup:bandwidth_20261002_v1";
const LEGACY_1D_LOG_KEY = "cxswitch:1d_trend_log_v2";

export interface ActiveTrade {
  id: string; pair: string; direction: "LONG" | "SHORT"; type: "ENTRY_1" | "ENTRY_2" | "ENTRY" | "REVERSAL_SHORT" | "REVERSAL_LONG";
  entry: number; stop: number; target: number; tp1?: number; tp2?: number;
  tp1HitAt?: number; tp2HitAt?: number; slToEntryAt?: number; timestamp: number; rr: number;
  status: "ACTIVE"; context: any; version: number;
  holdAdvice?: { status: "healthy" | "warning" | "failed"; reason: string; newStop?: number; checkedAt: number };
}

export type HistoryStatus = "ACTIVE" | "TP_HIT" | "SL_HIT" | "FAILED" | "EXPIRED";
export interface SignalHistoryEntry {
  id: string; pair: string; direction: "LONG" | "SHORT"; type: "ENTRY_1" | "ENTRY_2" | "REVERSAL_SHORT" | "REVERSAL_LONG";
  entry: number; stop: number; target: number; tp1?: number; tp2?: number; tp3?: number;
  tp1HitAt?: number; tp2HitAt?: number; tp3HitAt?: number; slToEntryAt?: number; timestamp: number; rr: number;
  status: HistoryStatus; exitReason?: string; exitPrice?: number; exitTimestamp?: number; context: any; version: number;
}


export async function runMigrationIfNeeded(): Promise<void> { return; }

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
  const cleaned = await redis.get<boolean>(ONE_TIME_BTC_SHORT_CLEANUP_KEY);
  if (!cleaned) {
    const bad = active.filter(t => t.pair === "BTC" && t.direction === "SHORT");
    if (bad.length) {
      active = active.filter(t => !(t.pair === "BTC" && t.direction === "SHORT"));
      await redis.set(ACTIVE_SIGNALS_KEY, active);
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
  }
  return active;
}
export async function setActiveSignals(signals: ActiveTrade[]): Promise<void> { await redis.set(ACTIVE_SIGNALS_KEY, signals); }
export async function addActiveSignal(signal: Signal): Promise<void> {
  const active = await getActiveSignals();
  const trade: ActiveTrade = {id:signal.id,pair:signal.pair,direction:signal.direction,type:signal.type,entry:signal.entry,stop:signal.stop,target:signal.tp2 ?? 0,tp1:signal.tp1,tp2:signal.tp2,timestamp:signal.timestamp,rr:signal.rr,status:"ACTIVE",context:signal.context,version:signal.version};
  const idx = active.findIndex(a => a.pair === signal.pair && a.direction === signal.direction);
  if (idx >= 0) active[idx] = {...active[idx],...trade}; else active.push(trade);
  await setActiveSignals(active);
  console.log(`[ACTIVE] Added ${signal.pair} ${signal.direction} ${signal.type} | TP1 ${trade.tp1 ?? "—"} | TP2 ${trade.tp2 ?? "—"}`);
}
export async function removeActiveSignal(pair:string,direction:"LONG"|"SHORT"):Promise<void>{const active=await getActiveSignals();const filtered=active.filter(a=>!(a.pair===pair&&a.direction===direction));if(filtered.length!==active.length){await setActiveSignals(filtered);console.log(`[ACTIVE] Removed ${pair} ${direction}`);}}
export async function removeActiveSignalById(id:string):Promise<void>{const active=await getActiveSignals();const filtered=active.filter(a=>a.id!==id);if(filtered.length!==active.length){await setActiveSignals(filtered);console.log(`[ACTIVE] Removed signal ${id}`);}}
export async function updateActiveTradeMilestones(id:string,price:number):Promise<ActiveTrade|undefined>{const active=await getActiveSignals();const trade=active.find(a=>a.id===id);if(!trade)return undefined;const hit=(level:number|undefined,direction:"LONG"|"SHORT")=>level!==undefined&&(direction==="LONG"?price>=level:price<=level);let changed=false;if(!trade.tp1HitAt&&hit(trade.tp1,trade.direction)){trade.tp1HitAt=Date.now();changed=true;console.log(`[MILESTONE] ${trade.pair} — TP1 reached @ ${price}`);}if(!trade.tp2HitAt&&hit(trade.tp2,trade.direction)){trade.tp2HitAt=Date.now();changed=true;console.log(`[MILESTONE] ${trade.pair} — TP2 reached @ ${price}`);}if(changed)await setActiveSignals(active);return trade;}
export async function getSignalHistory():Promise<SignalHistoryEntry[]>{
  const history=(await redis.get<SignalHistoryEntry[]>(SIGNAL_HISTORY_KEY))||[];
  const cleaned=await redis.get<boolean>(CLEANUP_KEY);
  if(!cleaned){
    const keep=Math.min(history.length, SIGNAL_HISTORY_MAX);
    if(history.length>keep) await redis.set(SIGNAL_HISTORY_KEY,history.slice(-keep));
    await redis.del(LEGACY_1D_LOG_KEY);
    await redis.set(CLEANUP_KEY,true);
    console.log(`[STATE CLEANUP] History retention complete: signal_history ${history.length} -> ${Math.min(history.length,keep)}; deleted legacy 1D v2 log`);
    return history.slice(-keep);
  }
  return history;
}
export async function setSignalHistory(history:SignalHistoryEntry[]):Promise<void>{await redis.set(SIGNAL_HISTORY_KEY,history);}

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

export async function appendSignalHistory(signal:Signal):Promise<void>{const history=await getSignalHistory();if(history.some(h=>h.id===signal.id)){console.log(`[HISTORY] Signal ${signal.id} already recorded`);return;}const entry:SignalHistoryEntry={id:signal.id,pair:signal.pair,direction:signal.direction,type:signal.type,entry:signal.entry,stop:signal.stop,target:signal.tp2 ?? signal.target,tp1:signal.tp1,tp2:signal.tp2,tp3:signal.tp3,timestamp:signal.timestamp,rr:signal.rr,status:"ACTIVE",context:signal.context,version:signal.version};history.push(entry);if(history.length>SIGNAL_HISTORY_MAX)history.splice(0,history.length-SIGNAL_HISTORY_MAX);await setSignalHistory(history);const latest=await redis.get<Record<string,SignalHistoryEntry>>(LATEST_ALERTS_KEY)||{};latest[entry.pair]=entry;await redis.set(LATEST_ALERTS_KEY,latest);console.log(`[HISTORY] Appended ${signal.pair} ${signal.direction} ${signal.type} | TP1 ${entry.tp1 ?? "—"} | TP2 ${entry.tp2 ?? "—"} | latest alert persisted`);}
export async function updateSignalHistoryStatus(id:string,status:HistoryStatus,exitReason?:string,exitPrice?:number):Promise<void>{const history=await getSignalHistory();const idx=history.findIndex(h=>h.id===id);if(idx<0){console.log(`[HISTORY] Warning: could not find ${id}`);return;}history[idx].status=status;if(exitReason)history[idx].exitReason=exitReason;if(exitPrice!==undefined)history[idx].exitPrice=exitPrice;history[idx].exitTimestamp=Date.now();await setSignalHistory(history);const latest=await redis.get<Record<string,SignalHistoryEntry>>(LATEST_ALERTS_KEY)||{};if(latest[history[idx].pair]?.id===id){latest[history[idx].pair]=history[idx];await redis.set(LATEST_ALERTS_KEY,latest);}console.log(`[HISTORY] Updated ${id} -> ${status}${exitReason?` (${exitReason})`:""}`);}
export async function updateHistoryMilestones(id:string,price:number):Promise<SignalHistoryEntry|undefined>{const history=await getSignalHistory();const h=history.find(x=>x.id===id);if(!h)return undefined;const hit=(level:number|undefined,direction:"LONG"|"SHORT")=>level!==undefined&&(direction==="LONG"?price>=level:price<=level);let changed=false;if(!h.tp1HitAt&&hit(h.tp1,h.direction)){h.tp1HitAt=Date.now();changed=true;}if(!h.tp2HitAt&&hit(h.tp2,h.direction)){h.tp2HitAt=Date.now();changed=true;}if(!h.tp3HitAt&&hit(h.tp3,h.direction)){h.tp3HitAt=Date.now();changed=true;}if(changed){await setSignalHistory(history);const latest=await redis.get<Record<string,SignalHistoryEntry>>(LATEST_ALERTS_KEY)||{};if(latest[h.pair]?.id===id){latest[h.pair]=h;await redis.set(LATEST_ALERTS_KEY,latest);}}return h;}
export async function updateHistoryStopMilestone(id:string,stop:number):Promise<SignalHistoryEntry|undefined>{const history=await getSignalHistory();const h=history.find(x=>x.id===id);if(!h)return undefined;const atEntry=Math.abs(stop-h.entry)<=Math.max(Math.abs(h.entry)*0.000001,0.000001);if(!h.slToEntryAt&&atEntry){h.slToEntryAt=Date.now();await setSignalHistory(history);const latest=await redis.get<Record<string,SignalHistoryEntry>>(LATEST_ALERTS_KEY)||{};if(latest[h.pair]?.id===id){latest[h.pair]=h;await redis.set(LATEST_ALERTS_KEY,latest);}console.log(`[MILESTONE] ${h.pair} — SL moved to entry @ ${stop}`);}return h;}
export async function getCooldowns():Promise<Record<string,number>>{return(await redis.get<Record<string,number>>(COOLDOWN_KEY))||{};}
export async function setCooldowns(cooldowns:Record<string,number>):Promise<void>{await redis.set(COOLDOWN_KEY,cooldowns);}
export async function getMarketData():Promise<any[]>{return(await redis.get<any[]>(MARKET_KEY))||[];}
export async function setMarketData(data:any[]):Promise<void>{await redis.set(MARKET_KEY,data);}
export async function getLastCronRun():Promise<number>{const data=await redis.get<{timestamp:number}>(CRON_KEY);return data?.timestamp||0;}
export async function setLastCronRun(ts:number):Promise<void>{await redis.set(CRON_KEY,{timestamp:ts});}
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
