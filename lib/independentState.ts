import { Redis } from "@upstash/redis";
import { Signal } from "./strategy";

const redis=new Redis({url:process.env.KV_REST_API_URL!,token:process.env.KV_REST_API_TOKEN!});
const HISTORY_KEY="cxswitch:independent_signal_history";
const ACTIVE_KEY="cxswitch:independent_active_signals";
const COOLDOWN_KEY="cxswitch:independent_cooldowns";
export type IndependentHistory=Signal & {status:"ACTIVE"|"TP_HIT"|"SL_HIT"|"EXPIRED";strategySource:string;strategyName:string;exitReason?:string;exitPrice?:number;exitTimestamp?:number};
export async function getIndependentHistory():Promise<IndependentHistory[]>{return(await redis.get<IndependentHistory[]>(HISTORY_KEY))||[];}
export async function appendIndependentSignal(signal:Signal):Promise<void>{const h=await getIndependentHistory();if(h.some(x=>x.id===signal.id))return;h.push({...signal,status:"ACTIVE",strategySource:signal.context?.strategySource||"UNKNOWN",strategyName:signal.context?.strategyName||signal.location||"Independent"});if(h.length>1000)h.splice(0,h.length-1000);await redis.set(HISTORY_KEY,h);const a=(await redis.get<Record<string,Signal>>(ACTIVE_KEY))||{};a[signal.id]=signal;await redis.set(ACTIVE_KEY,a);}
export async function getIndependentActive():Promise<Signal[]>{const a=(await redis.get<Record<string,Signal>>(ACTIVE_KEY))||{};return Object.values(a);}
export async function setIndependentStatus(id:string,status:IndependentHistory["status"],reason?:string,price?:number):Promise<void>{const h=await getIndependentHistory(),i=h.findIndex(x=>x.id===id);if(i>=0){h[i].status=status;h[i].exitReason=reason;h[i].exitPrice=price;h[i].exitTimestamp=Date.now();await redis.set(HISTORY_KEY,h);}const a=(await redis.get<Record<string,Signal>>(ACTIVE_KEY))||{};delete a[id];await redis.set(ACTIVE_KEY,a);}
export async function independentAlreadyFired(strategySource:string,candleTimestamp:number):Promise<boolean>{const h=await getIndependentHistory();return h.some(x=>x.context?.strategySource===strategySource&&x.context?.signalCandleTimestamp===candleTimestamp);}
export async function getIndependentCooldowns():Promise<Record<string,number>>{return(await redis.get<Record<string,number>>(COOLDOWN_KEY))||{};}
export async function setIndependentCooldowns(v:Record<string,number>):Promise<void>{await redis.set(COOLDOWN_KEY,v);}
