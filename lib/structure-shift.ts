// lib/structure-shift.ts — isolated 4H market-structure observation layer
// ============================================================
// TEST ONLY: this module never gates, changes, or creates V28 trades.
// It detects structural direction shifts from confirmed 4H swing points.
// ATR is used only to make the structural break threshold scale with volatility.

import { Redis } from "@upstash/redis";
import type { Candle } from "./strategy";

const redis=new Redis({url:process.env.KV_REST_API_URL!,token:process.env.KV_REST_API_TOKEN!});
const LOG_KEY="cxswitch:structure_shift_test_log_v1";
const LAST_CANDLE_KEY="cxswitch:structure_shift_test_last_candle_v1";
const MAX_LOG_ROWS=2500;
const PIVOT=2;
const BREAK_ATR=0.35;

type Pivot={index:number;price:number;timestamp:number};
export type StructureShiftDirection="LONG"|"SHORT"|"NEUTRAL";
export type StructureShiftState="HEALTHY"|"WEAKENING"|"SHIFT_CONFIRMED"|"WATCHING";

export interface StructureShiftSnapshot{
  pair:string;
  timestamp:number;
  closedCandleTimestamp:number;
  price:number;
  structure:StructureShiftDirection;
  state:StructureShiftState;
  previousStructure:StructureShiftDirection;
  shiftTo:StructureShiftDirection;
  protectedLevel:number|null;
  protectedLevelTimestamp:number|null;
  breakDistanceAtr:number|null;
  breakConfirmed:boolean;
  lastHigh:number|null;
  previousHigh:number|null;
  lastLow:number|null;
  previousLow:number|null;
  atr:number;
  reason:string;
}

function atr(c:Candle[],p=14){
  if(c.length<2)return 0;
  const r:number[]=[];
  for(let i=Math.max(1,c.length-p);i<c.length;i++){
    const x=c[i],q=c[i-1];
    r.push(Math.max(x.high-x.low,Math.abs(x.high-q.close),Math.abs(x.low-q.close)));
  }
  return r.length?r.reduce((a,b)=>a+b,0)/r.length:0;
}

function pivots(c:Candle[],kind:"HIGH"|"LOW"){
  const r:Pivot[]=[];
  for(let i=PIVOT;i<c.length-PIVOT;i++){
    let ok=true;
    for(let j=1;j<=PIVOT;j++)ok=ok&&(kind==="HIGH"?c[i].high>c[i-j].high&&c[i].high>c[i+j].high:c[i].low<c[i-j].low&&c[i].low<c[i+j].low);
    if(ok)r.push({index:i,price:kind==="HIGH"?c[i].high:c[i].low,timestamp:c[i].timestamp});
  }
  return r;
}

export function detectStructureShift(pair:string,c:Candle[]):StructureShiftSnapshot{
  const closed=c.slice(0,-1);
  const last=closed.at(-1)??c.at(-1);
  const highs=pivots(closed,"HIGH"),lows=pivots(closed,"LOW");
  const h1=highs.at(-1)??null,h0=highs.at(-2)??null,l1=lows.at(-1)??null,l0=lows.at(-2)??null;
  const bullish=!!h1&&!!h0&&!!l1&&!!l0&&h1.price>h0.price&&l1.price>l0.price;
  const bearish=!!h1&&!!h0&&!!l1&&!!l0&&h1.price<h0.price&&l1.price<l0.price;
  const structure:StructureShiftDirection=bullish?"LONG":bearish?"SHORT":"NEUTRAL";
  const a=atr(closed),price=last?.close??0;
  const protectedLevel=structure==="LONG"?l1?.price??null:structure==="SHORT"?h1?.price??null:null;
  const protectedTs=structure==="LONG"?l1?.timestamp??null:structure==="SHORT"?h1?.timestamp??null:null;
  const breakAmount=protectedLevel===null?null:structure==="LONG"?protectedLevel-price:price-protectedLevel;
  const breakDistanceAtr=protectedLevel===null||a<=0?null:breakAmount!/a;
  const breakConfirmed=structure==="LONG"?price<protectedLevel!&&breakAmount!>=a*BREAK_ATR:structure==="SHORT"?price>protectedLevel!&&breakAmount!>=a*BREAK_ATR:false;
  const shiftTo:StructureShiftDirection=breakConfirmed?(structure==="LONG"?"SHORT":"LONG"):"NEUTRAL";
  let state:StructureShiftState="WATCHING";
  let reason="Structure is not yet directional enough to declare a protected trend.";
  if(breakConfirmed){state="SHIFT_CONFIRMED";reason=`Protected ${structure==="LONG"?"higher low":"lower high"} broken by ${breakDistanceAtr!.toFixed(2)} ATR.`;}
  else if(structure!=="NEUTRAL"){
    const approaching=breakDistanceAtr!==null&&breakDistanceAtr>=0&&breakDistanceAtr<=1;
    state=approaching?"WEAKENING":"HEALTHY";
    reason=approaching?`Protected ${structure==="LONG"?"higher low":"lower high"} is within ${breakDistanceAtr!.toFixed(2)} ATR.`:`${structure} structure remains intact.`;
  }
  return{pair,timestamp:Date.now(),closedCandleTimestamp:last?.timestamp??0,price,structure,state,previousStructure:"NEUTRAL",shiftTo,protectedLevel,protectedLevelTimestamp:protectedTs,breakDistanceAtr,breakConfirmed,lastHigh:h1?.price??null,previousHigh:h0?.price??null,lastLow:l1?.price??null,previousLow:l0?.price??null,atr:a,reason};
}

export async function recordStructureShiftSnapshot(snapshot:StructureShiftSnapshot){
  const last=await redis.get<Record<string,number>>(LAST_CANDLE_KEY)||{};
  if(last[snapshot.pair]===snapshot.closedCandleTimestamp)return false;
  const previous=(await redis.get<StructureShiftSnapshot[]>(LOG_KEY)||[]);
  const prior=previous.findLast(x=>x.pair===snapshot.pair);
  snapshot.previousStructure=prior?.structure??"NEUTRAL";
  const next=[...previous,snapshot].slice(-MAX_LOG_ROWS);
  last[snapshot.pair]=snapshot.closedCandleTimestamp;
  await redis.set(LOG_KEY,next);
  await redis.set(LAST_CANDLE_KEY,last);
  return true;
}

export async function getStructureShiftLog(){return(await redis.get<StructureShiftSnapshot[]>(LOG_KEY))||[];}
