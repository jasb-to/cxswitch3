// lib/entry0.ts — early 4H direction layer, separate from V28
// ENTRY_0 is a small/manual starter alert only. It never gates or changes V28.
// Trigger: confirmed closed-candle 4H 5/13 cross.
// Confirmation: 4H 8/21 must be turning in the same direction. We deliberately do NOT wait for the 8/21 cross.
// Exit: 4H 8/21 opposite cross.

import { Redis } from "@upstash/redis";
import type { Candle } from "./strategy";
import { get4HEmaDiagnostic } from "./ema-diagnostic";

const redis=new Redis({url:process.env.KV_REST_API_URL!,token:process.env.KV_REST_API_TOKEN!});
const ENTRY0_KEY="cxswitch:entry0_positions";
const ENTRY0_LAST_CROSS_KEY="cxswitch:entry0_last_cross";
type Entry0Position={pair:string;direction:"LONG"|"SHORT";entry:number;openedAt:number;crossTimestamp:number;ema5:number;ema13:number;ema8:number;ema21:number;stop:number;tp1:number;tp2:number;tp3:number};
function ema(a:number[],p:number){if(!a.length)return[];const k=2/(p+1),r=[a[0]];for(let i=1;i<a.length;i++)r.push(a[i]*k+r[i-1]*(1-k));return r;}
function atr(c:Candle[],p=14){if(c.length<2)return 0;const r:number[]=[];for(let i=Math.max(1,c.length-p);i<c.length;i++){const x=c[i],q=c[i-1];r.push(Math.max(x.high-x.low,Math.abs(x.high-q.close),Math.abs(x.low-q.close)));}return r.length?r.reduce((a,b)=>a+b,0)/r.length:0;}
function rsi(a:number[],p=14){if(a.length<2)return 50;let g=0,l=0,n=0;for(let i=Math.max(1,a.length-p);i<a.length;i++){const d=a[i]-a[i-1];if(d>0)g+=d;else l+=Math.abs(d);n++;}if(!n)return 50;const ag=g/n,al=l/n;if(al===0)return 100;return 100-100/(1+ag/al);}
function rsiSeries(a:number[],p=14){const r:number[]=[];for(let i=p;i<a.length;i++)r.push(rsi(a.slice(i-p,i+1),p));return r;}
function stochRsi(a:number[],rp=14,sp=14,ks=3,ds=3){const rv=rsiSeries(a,rp);if(rv.length<sp+ks-1)return{k:50,d:50};const raw:number[]=[];for(let i=sp-1;i<rv.length;i++){const w=rv.slice(i-sp+1,i+1),lo=Math.min(...w),hi=Math.max(...w);raw.push(hi===lo?50:(rv[i]-lo)/(hi-lo)*100);}const kv:number[]=[];for(let i=ks-1;i<raw.length;i++)kv.push(kv.length?raw.slice(i-ks+1,i+1).reduce((x,y)=>x+y,0)/ks:raw[i]);if(kv.length<ds)return{k:50,d:50};return{k:Math.round(kv.at(-1)!*10)/10,d:Math.round(kv.slice(-ds).reduce((x,y)=>x+y,0)/Math.min(ds,kv.length)*10)/10};}
function adx(c:Candle[],p=14){if(c.length<p+1)return 0;const tr:number[]=[],plus:number[]=[],minus:number[]=[];for(let i=1;i<c.length;i++){const x=c[i],q=c[i-1];tr.push(Math.max(x.high-x.low,Math.abs(x.high-q.close),Math.abs(x.low-q.close)));plus.push(x.high-q.high>q.low-x.low?Math.max(x.high-q.high,0):0);minus.push(q.low-x.low>x.high-q.high?Math.max(q.low-x.low,0):0);}const avgW=(a:number[])=>a.length?a.slice(0,p).reduce((x,y)=>x+y,0)/Math.min(p,a.length):0;let t=avgW(tr),pd=avgW(plus),md=avgW(minus),dx:number[]=[];for(let i=p;i<tr.length;i++){t=(t*(p-1)+tr[i])/p;pd=(pd*(p-1)+plus[i])/p;md=(md*(p-1)+minus[i])/p;const a=t?pd/t*100:0,b=t?md/t*100:0;dx.push(a+b===0?0:Math.abs(a-b)/(a+b)*100);}return dx.length?Math.round(dx.slice(-p).reduce((x,y)=>x+y,0)/Math.min(p,dx.length)*10)/10:0;}
function daily(c:Candle[]){const m=new Map<string,Candle[]>();for(const x of [...c].sort((a,b)=>a.timestamp-b.timestamp)){const d=new Date(x.timestamp),k=`${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;(m.get(k)||m.set(k,[]).get(k)!).push(x);}return[...m.values()].map(b=>({timestamp:b[0].timestamp,close:b.at(-1)!.close}));}
function dailyBias(c:Candle[]):"LONG"|"SHORT"|null{const d=daily(c);if(d.length<20)return null;const closes=d.map(x=>x.close),f=ema(closes,5).at(-1)!,s=ema(closes,13).at(-1)!;return f>s?"LONG":f<s?"SHORT":null;}
function ema821(c:Candle[]){const closes=c.map(x=>x.close),e8=ema(closes,8),e21=ema(closes,21),i=e8.length-1,p=i-1;return{ema8:e8[i],ema21:e21[i],ema8Prev:e8[p],ema21Prev:e21[p],ema8Slope:e8[i]-e8[p],bullCross:e8[p]<=e21[p]&&e8[i]>e21[i],bearCross:e8[p]>=e21[p]&&e8[i]<e21[i],timestamp:c.at(-1)?.timestamp??0};}
function tradeLevels(c:Candle[],entry:number,direction:"LONG"|"SHORT"){const a=atr(c),structural=direction==="LONG"?entry-a*2:entry+a*2,minRisk=0.008,maxRisk=0.035,stop=direction==="LONG"?Math.max(Math.min(structural,entry*(1-minRisk)),entry*(1-maxRisk)):Math.min(Math.max(structural,entry*(1+minRisk)),entry*(1+maxRisk)),risk=Math.abs(entry-stop),tp1=direction==="LONG"?entry+risk:entry-risk,tp2=direction==="LONG"?entry+risk*1.5:entry-risk*1.5,tp3=direction==="LONG"?entry+risk*2:entry-risk*2;return{stop,tp1,tp2,tp3,rr:1.5,expectedMove:Math.abs(tp3-entry)/entry*100};}
async function getPositions():Promise<Record<string,Entry0Position>>{return(await redis.get<Record<string,Entry0Position>>(ENTRY0_KEY))||{};}
async function setPositions(v:Record<string,Entry0Position>){await redis.set(ENTRY0_KEY,v);}
async function getLastCross():Promise<Record<string,number>>{return(await redis.get<Record<string,number>>(ENTRY0_LAST_CROSS_KEY))||{};}
async function setLastCross(v:Record<string,number>){await redis.set(ENTRY0_LAST_CROSS_KEY,v);}
export async function getEntry0Positions():Promise<Record<string,Entry0Position>>{return getPositions();}
export async function processEntry0(pair:string,c4:Candle[],price:number,v28Active:any[]|undefined){
 const ema513=get4HEmaDiagnostic(c4),bias=dailyBias(c4),e821=ema821(c4),positions=await getPositions(),lastCross=await getLastCross(),existing=positions[pair],actions:any[]=[];
 const closes=c4.map(x=>x.close),rsiVal=Math.round(rsi(closes,14)*10)/10,stoch=stochRsi(closes),adxVal=adx(c4),levels=tradeLevels(c4,price,ema513.direction==="BULLISH"?"LONG":"SHORT");
 if(existing){
  const exitCross=existing.direction==="LONG"?e821.bearCross:e821.bullCross;
  if(exitCross&&e821.timestamp>existing.crossTimestamp){delete positions[pair];lastCross[pair]=e821.timestamp;await setPositions(positions);await setLastCross(lastCross);actions.push({type:"EXIT_0",pair,direction:existing.direction,entry:existing.entry,exitPrice:price,exitTimestamp:e821.timestamp,reason:`4H 8/21 ${existing.direction==="LONG"?"bearish":"bullish"} cross — ENTRY_0 longevity trend has turned`,fourH513Label:ema513.label,dailyBias:bias,ema8:e821.ema8,ema21:e821.ema21,stop:existing.stop,tp1:existing.tp1,tp2:existing.tp2,tp3:existing.tp3,rr:1.5,expectedMove:Math.abs(existing.tp3-existing.entry)/existing.entry*100,adx:adxVal,rsi:rsiVal,stochK:stoch.k,stochD:stoch.d,confirmation:"4H 8/21 opposite cross"});}
  return actions;
 }
 if(!ema513.crossNow)return actions;
 const direction=ema513.direction==="BULLISH"?"LONG":ema513.direction==="BEARISH"?"SHORT":null;if(!direction)return actions;
 if(lastCross[pair]===ema513.closedCandleTimestamp)return actions;
 const eightTwentyOneConfirmed=direction==="LONG"?e821.ema8Slope>0&&e821.ema8>=e821.ema21-e821.ema8*0.0025:e821.ema8Slope<0&&e821.ema8<=e821.ema21+e821.ema8*0.0025;
 if(!eightTwentyOneConfirmed)return actions;
 const v28Same=v28Active?.some(x=>x?.pair===pair&&x?.direction===direction),v28Opp=v28Active?.some(x=>x?.pair===pair&&x?.direction!==direction);if(v28Opp||v28Same)return actions;
 const position:Entry0Position={pair,direction,entry:price,openedAt:Date.now(),crossTimestamp:ema513.closedCandleTimestamp,ema5:ema513.ema5,ema13:ema513.ema13,ema8:e821.ema8,ema21:e821.ema21,stop:levels.stop,tp1:levels.tp1,tp2:levels.tp2,tp3:levels.tp3};positions[pair]=position;lastCross[pair]=ema513.closedCandleTimestamp;await setPositions(positions);await setLastCross(lastCross);
 actions.push({type:"ENTRY_0",pair,direction,entry:price,crossTimestamp:ema513.closedCandleTimestamp,ema5:ema513.ema5,ema13:ema513.ema13,ema8:e821.ema8,ema21:e821.ema21,fourH513Label:ema513.label,dailyBias:bias,confirmation:`4H 8/21 turning ${direction} — 8 EMA slope aligned; no 8/21 cross required`,reason:`4H 5/13 ${direction==="LONG"?"bullish":"bearish"} cross confirmed by 4H 8/21 turning ${direction}`,stop:levels.stop,tp1:levels.tp1,tp2:levels.tp2,tp3:levels.tp3,rr:levels.rr,expectedMove:levels.expectedMove,adx:adxVal,rsi:rsiVal,stochK:stoch.k,stochD:stoch.d,trend:`4H 5/13 ${direction} / 8/21 turning ${direction}`,location:`4H 8 EMA ${e821.ema8.toFixed(2)} / 21 EMA ${e821.ema21.toFixed(2)}`,trigger:"4H 5/13 cross"});
 return actions;
}
