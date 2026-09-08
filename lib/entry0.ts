// lib/entry0.ts — early 4H direction layer, separate from V28
// ENTRY_0 is a small/manual starter alert only. It never gates or changes V28.
// Confirmation rule: 4H 5/13 cross must agree with the current 1D 5/13 bias.
// Exit rule: 4H 8/21 cross against ENTRY_0 direction.

import { Redis } from "@upstash/redis";
import type { Candle } from "./strategy";
import { get4HEmaDiagnostic } from "./ema-diagnostic";

const redis=new Redis({url:process.env.KV_REST_API_URL!,token:process.env.KV_REST_API_TOKEN!});
const ENTRY0_KEY="cxswitch:entry0_positions";
const ENTRY0_LAST_CROSS_KEY="cxswitch:entry0_last_cross";
type Entry0Position={pair:string;direction:"LONG"|"SHORT";entry:number;openedAt:number;crossTimestamp:number;ema5:number;ema13:number;ema8:number;ema21:number};
function ema(a:number[],p:number){if(!a.length)return[];const k=2/(p+1),r=[a[0]];for(let i=1;i<a.length;i++)r.push(a[i]*k+r[i-1]*(1-k));return r;}
function daily(c:Candle[]){const m=new Map<string,Candle[]>();for(const x of [...c].sort((a,b)=>a.timestamp-b.timestamp)){const d=new Date(x.timestamp),k=`${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;(m.get(k)||m.set(k,[]).get(k)!).push(x);}return[...m.values()].map(b=>({timestamp:b[0].timestamp,close:b.at(-1)!.close}));}
function dailyBias(c:Candle[]):"LONG"|"SHORT"|null{const d=daily(c);if(d.length<20)return null;const closes=d.map(x=>x.close),f=ema(closes,5).at(-1)!,s=ema(closes,13).at(-1)!;return f>s?"LONG":f<s?"SHORT":null;}
function ema821(c:Candle[]){const closes=c.map(x=>x.close),e8=ema(closes,8),e21=ema(closes,21),i=e8.length-1,p=i-1;return{ema8:e8[i],ema21:e21[i],bullCross:e8[p]<=e21[p]&&e8[i]>e21[i],bearCross:e8[p]>=e21[p]&&e8[i]<e21[i],timestamp:c.at(-1)?.timestamp??0};}
async function getPositions():Promise<Record<string,Entry0Position>>{return(await redis.get<Record<string,Entry0Position>>(ENTRY0_KEY))||{};}
async function setPositions(v:Record<string,Entry0Position>){await redis.set(ENTRY0_KEY,v);}
async function getLastCross():Promise<Record<string,number>>{return(await redis.get<Record<string,number>>(ENTRY0_LAST_CROSS_KEY))||{};}
async function setLastCross(v:Record<string,number>){await redis.set(ENTRY0_LAST_CROSS_KEY,v);}
export async function processEntry0(pair:string,c4:Candle[],price:number,v28Active:any[]|undefined){
 const ema513=get4HEmaDiagnostic(c4),bias=dailyBias(c4),e821=ema821(c4),positions=await getPositions(),lastCross=await getLastCross(),existing=positions[pair],actions:any[]=[];
 if(existing){
  const exitCross=existing.direction==="LONG"?e821.bearCross:e821.bullCross;
  if(exitCross&&e821.timestamp>existing.crossTimestamp){delete positions[pair];lastCross[pair]=e821.timestamp;await setPositions(positions);await setLastCross(lastCross);actions.push({type:"EXIT_0",pair,direction:existing.direction,entry:existing.entry,exitPrice:price,exitTimestamp:e821.timestamp,reason:`4H 8/21 ${existing.direction==="LONG"?"bearish":"bullish"} cross — ENTRY_0 longevity trend has turned`,fourH513Label:ema513.label,dailyBias:bias});}
  return actions;
 }
 if(!ema513.crossNow)return actions;
 const direction=ema513.direction==="BULLISH"?"LONG":ema513.direction==="BEARISH"?"SHORT":null;if(!direction)return actions;
 if(lastCross[pair]===ema513.closedCandleTimestamp)return actions;
 // 4H direction must be confirmed by the current 1D 5/13 bias. 4H SHORT + 1D LONG = NO ENTRY_0.
 if(bias!==direction)return actions;
 const v28Same=v28Active?.some(x=>x?.pair===pair&&x?.direction===direction),v28Opp=v28Active?.some(x=>x?.pair===pair&&x?.direction!==direction);if(v28Opp||v28Same)return actions;
 const position:Entry0Position={pair,direction,entry:price,openedAt:Date.now(),crossTimestamp:ema513.closedCandleTimestamp,ema5:ema513.ema5,ema13:ema513.ema13,ema8:e821.ema8,ema21:e821.ema21};positions[pair]=position;lastCross[pair]=ema513.closedCandleTimestamp;await setPositions(positions);await setLastCross(lastCross);
 actions.push({type:"ENTRY_0",pair,direction,entry:price,crossTimestamp:ema513.closedCandleTimestamp,ema5:ema513.ema5,ema13:ema513.ema13,ema8:e821.ema8,ema21:e821.ema21,fourH513Label:ema513.label,dailyBias:bias,confirmation:"1D 5/13 aligned with 4H 5/13 cross",reason:`4H 5/13 ${direction==="LONG"?"bullish":"bearish"} cross confirmed by 1D ${bias} bias`});
 return actions;
}
