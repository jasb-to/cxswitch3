// lib/strategy.ts — v60 "v28 core + anti-chase staged risk"
// ============================================================
// V28 ENTRY_1 / ENTRY_2 architecture is preserved.
// ADD is execution-gated: it can only add to an existing position,
// must occur on a genuine trendline retest, and is blocked when momentum
// is materially overextended. TP/SL are sized for the user's manual 20x
// execution rather than using distant 20-candle extremes.
// Daily bias remains 5/13 because it is intentionally faster than 8/21.
// Execution is manual: CXSwitch never needs exchange credentials.
// Liquidation is informational and never blocks an alert.

export interface Candle { timestamp:number; open:number; high:number; low:number; close:number; volume:number; }
export interface Signal {
  id:string; pair:string; direction:"LONG"|"SHORT"; type:"ENTRY_1"|"ENTRY_2"|"ADD";
  scale:"ENTRY_1"|"ENTRY_2"|"ADD"|null; entry:number; stop:number; target:number;
  tp1?:number; tp2?:number; tp3?:number; confidence:number; rr:number; adx:number; rsi:number;
  stochK:number; stochD:number; expectedMove:number; reason:string; timestamp:number; version:number;
  trend?:string; location?:string; trigger?:string; context?:any;
}
export interface SignalResult { signals?:Signal[]; signal?:Signal; market?:any; debug:string[]; }
export const CURRENT_SIGNAL_VERSION = 60;

const MIN_RR=1.25, TL_THRESHOLD=0.012;
const DAILY_FAST=5, DAILY_SLOW=13, TF_FAST=8, TF_SLOW=21;
const ENTRY_ATR=2, ADD_ATR=1.25;
export const EXECUTION_LEVERAGE=20;
export const EXECUTION_MMR=0.01;
export const LIQUIDATION_BUFFER=0.005;

// Risk is deliberately bounded because alerts are executed manually at 20x.
// The alert must never be rejected because the structural stop is too far away:
// instead the displayed stop is brought inside the usable execution envelope.
const ENTRY_MIN_RISK_PCT=0.008;
const ENTRY_MAX_RISK_PCT=0.035;
const ADD_MIN_RISK_PCT=0.008;
const ADD_MAX_RISK_PCT=0.025;
const STOP_EXECUTION_BUFFER=0.01;

// ADD protection: do not chase a vertical move.
const ADD_MAX_RSI_LONG=80;
const ADD_MIN_RSI_SHORT=20;
const ADD_MAX_STOCH_LONG=85;
const ADD_MIN_STOCH_SHORT=15;
const ADD_MAX_TL_DISTANCE=0.025;

const avg=(a:number[])=>a.length?a.reduce((x,y)=>x+y,0)/a.length:0;
function ema(a:number[],p:number){if(!a.length)return[];const k=2/(p+1),r=[a[0]];for(let i=1;i<a.length;i++)r.push(a[i]*k+r[i-1]*(1-k));return r;}
function atr(c:Candle[],p=14){const r:number[]=[];for(let i=Math.max(1,c.length-p);i<c.length;i++){const x=c[i],q=c[i-1];r.push(Math.max(x.high-x.low,Math.abs(x.high-q.close),Math.abs(x.low-q.close)));}return avg(r);}
function rsi(a:number[],p=14){if(a.length<2)return 50;let g=0,l=0,n=0;for(let i=Math.max(1,a.length-p);i<a.length;i++){const d=a[i]-a[i-1];if(d>0)g+=d;else l+=Math.abs(d);n++;}if(!n)return 50;const ag=g/n,al=l/n;if(al===0)return 100;return 100-100/(1+ag/al);}
function rsiSeries(a:number[],p=14){const r:number[]=[];for(let i=p;i<a.length;i++)r.push(rsi(a.slice(i-p,i+1),p));return r;}
function stochRsi(a:number[],rp=14,sp=14,ks=3,ds=3){const rv=rsiSeries(a,rp);if(rv.length<sp+ks-1)return{k:50,d:50};const raw:number[]=[];for(let i=sp-1;i<rv.length;i++){const w=rv.slice(i-sp+1,i+1),lo=Math.min(...w),hi=Math.max(...w);raw.push(hi===lo?50:(rv[i]-lo)/(hi-lo)*100);}const kv:number[]=[];for(let i=ks-1;i<raw.length;i++)kv.push(avg(raw.slice(i-ks+1,i+1)));if(kv.length<ds)return{k:50,d:50};return{k:Math.round(kv.at(-1)!*10)/10,d:Math.round(avg(kv.slice(-ds))*10)/10};}
function wilder(a:number[],p:number){if(!a.length)return[];const seed=a.slice(0,p);const r=[avg(seed)];for(let i=p;i<a.length;i++)r.push((r.at(-1)!*(p-1)+a[i])/p);return r;}
function adx(c:Candle[],p=14){if(c.length<p+1)return 0;const tr:number[]=[],plus:number[]=[],minus:number[]=[];for(let i=1;i<c.length;i++){const x=c[i],q=c[i-1];tr.push(Math.max(x.high-x.low,Math.abs(x.high-q.close),Math.abs(x.low-q.close)));plus.push(x.high-q.high>q.low-x.low?Math.max(x.high-q.high,0):0);minus.push(q.low-x.low>x.high-q.high?Math.max(q.low-x.low,0):0);}const t=wilder(tr,p),pd=wilder(plus,p),md=wilder(minus,p),dx:number[]=[];for(let i=0;i<t.length;i++){const a=pd[i]/t[i]*100,b=md[i]/t[i]*100;dx.push(a+b===0?0:Math.abs(a-b)/(a+b)*100);}const out=wilder(dx,p);return Math.round((out.at(-1)||0)*10)/10;}
function daily(c:Candle[]){const m=new Map<string,Candle[]>();for(const x of [...c].sort((a,b)=>a.timestamp-b.timestamp)){const d=new Date(x.timestamp),k=`${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;(m.get(k)||m.set(k,[]).get(k)!).push(x);}return [...m.values()].map(b=>({timestamp:b[0].timestamp,open:b[0].open,high:Math.max(...b.map(x=>x.high)),low:Math.min(...b.map(x=>x.low)),close:b.at(-1)!.close,volume:b.reduce((s,x)=>s+x.volume,0)}));}
function bias(c:Candle[]):"LONG"|"SHORT"|null{if(c.length<20)return null;const a=c.map(x=>x.close),f=ema(a,DAILY_FAST).at(-1)!,s=ema(a,DAILY_SLOW).at(-1)!;return f>s?"LONG":f<s?"SHORT":null;}
function strength(c:Candle[],d:"LONG"|"SHORT"){const h=c.slice(-20).map(x=>x.high),l=c.slice(-20).map(x=>x.low);return d==="LONG"&&h.at(-1)!>Math.max(...h.slice(0,-1))||d==="SHORT"&&l.at(-1)!<Math.min(...l.slice(0,-1))?"STRONG":"MEDIUM";}
function pivots(c:Candle[],d:"LONG"|"SHORT"){const r:{index:number;price:number;timestamp:number}[]=[];for(let i=3;i<c.length-3;i++){const lo=c[i].low<c[i-1].low&&c[i].low<c[i-2].low&&c[i].low<c[i+1].low&&c[i].low<c[i+2].low;const hi=c[i].high>c[i-1].high&&c[i].high>c[i-2].high&&c[i].high>c[i+1].high&&c[i].high>c[i+2].high;if(d==="LONG"&&lo)r.push({index:i,price:c[i].low,timestamp:c[i].timestamp});if(d==="SHORT"&&hi)r.push({index:i,price:c[i].high,timestamp:c[i].timestamp});}return r;}
function trendline(c:Candle[],d:"LONG"|"SHORT"){const p=pivots(c,d).slice(-5);if(p.length<3)return null;const n=p.length,sx=p.reduce((s,x)=>s+x.index,0),sy=p.reduce((s,x)=>s+x.price,0),sxy=p.reduce((s,x)=>s+x.index*x.price,0),sx2=p.reduce((s,x)=>s+x.index*x.index,0),den=n*sx2-sx*sx;if(!den)return null;const slope=(n*sxy-sx*sy)/den,intercept=(sy-slope*sx)/n;return{slope,intercept,price:slope*(c.length-1)+intercept};}
function opposite(pair:string,d:"LONG"|"SHORT",trades:any[]|undefined){return !!trades?.some(t=>(t.pair===pair||t.symbol===pair)&&t.direction===(d==="LONG"?"SHORT":"LONG"));}
function sameDirection(pair:string,d:"LONG"|"SHORT",trades:any[]|undefined){return !!trades?.some(t=>(t.pair===pair||t.symbol===pair)&&t.direction===d);}
export function estimateLiquidationPrice(entry:number,direction:"LONG"|"SHORT"){return direction==="LONG"?entry*(1-1/EXECUTION_LEVERAGE+EXECUTION_MMR):entry*(1+1/EXECUTION_LEVERAGE-EXECUTION_MMR);}
export function liquidationSafeBoundary(entry:number,direction:"LONG"|"SHORT"){const liq=estimateLiquidationPrice(entry,direction);return direction==="LONG"?liq*(1+LIQUIDATION_BUFFER):liq*(1-LIQUIDATION_BUFFER);}
function executionStop(entry:number,structural:number,direction:"LONG"|"SHORT",isAdd:boolean){const minRisk=isAdd?ADD_MIN_RISK_PCT:ENTRY_MIN_RISK_PCT,maxRisk=isAdd?ADD_MAX_RISK_PCT:ENTRY_MAX_RISK_PCT;const liq=estimateLiquidationPrice(entry,direction);const safe=direction==="LONG"?liq*(1+STOP_EXECUTION_BUFFER):liq*(1-STOP_EXECUTION_BUFFER);if(direction==="LONG"){const minStop=entry*(1-maxRisk),maxStop=entry*(1-minRisk);return Math.max(Math.min(structural,maxStop),minStop,safe);}const minStop=entry*(1+minRisk),maxStop=entry*(1+maxRisk);return Math.min(Math.max(structural,minStop),maxStop,safe);}
function roundPrice(n:number){return Math.round(n*100000)/100000;}
function retestConfirmed(c:Candle[],dir:"LONG"|"SHORT",tl:number,price:number){const last=c.at(-1),prev=c.at(-2);if(!last||!prev)return false;const dist=Math.abs((price-tl)/tl);if(dist>ADD_MAX_TL_DISTANCE)return false;if(dir==="LONG")return last.close>tl&&last.low<=tl*1.012&&last.close>=prev.close;return last.close<tl&&last.high>=tl*0.988&&last.close<=prev.close;}

export function generateSignal(pair:string,candles1h:Candle[],candles4h:Candle[],candles15m:Candle[],activeTrades?:any[],currentPrice?:number):SignalResult{
 const debug:string[]=[];const now=Date.now();if(candles4h.length<30){debug.push("Insufficient data");return{debug};}
 const d1=daily(candles4h),dir=bias(d1);if(!dir){debug.push("1D trend unclear");return{debug};}if(opposite(pair,dir,activeTrades)){debug.push("Opposite direction active");return{debug};}
 const tl=trendline(candles4h,dir);if(!tl){debug.push("No trendline");return{debug};}
 const price=currentPrice??candles4h.at(-1)!.close,dist=(price-tl.price)/tl.price,near=Math.abs(dist)<TL_THRESHOLD,beyond=dir==="LONG"?price>tl.price*1.008:price<tl.price*.992;
 const closes=candles4h.map(x=>x.close),st=stochRsi(closes),last=candles4h.at(-1)!,prev=candles4h.at(-2)!;const e8=ema(closes,TF_FAST).at(-1)!,e21=ema(closes,TF_SLOW).at(-1)!;
 const rsiVal=Math.round(rsi(closes)*10)/10,turn=dir==="LONG"?st.k>st.d:st.k<st.d,extreme=dir==="LONG"?st.k<20:st.k>80;const confirm=dir==="LONG"?last.close>last.open&&last.close>prev.close:last.close<last.open&&last.close<prev.close;const vol=last.volume>avg(candles4h.slice(-10).map(x=>x.volume))*1.3;const aligned=dir==="LONG"?price>e8&&price>e21:price<e8&&price<e21;const momentum=dir==="LONG"?st.k>st.d:st.k<st.d;const adxVal=adx(candles4h);
 const hasPosition=sameDirection(pair,dir,activeTrades);
 let raw:"ENTRY_1"|"ENTRY_2"|"ADD"|null=near&&extreme?"ENTRY_1":near&&turn&&!extreme?"ENTRY_2":beyond&&confirm&&aligned&&(vol||momentum||adxVal>20)?"ADD":null;
 debug.push(`1D: ${dir} ${strength(d1,dir)} | TL: ${tl.price.toFixed(2)} | Price: ${price.toFixed(2)} | Dist: ${(dist*100).toFixed(2)}% | RSI: ${rsiVal} | Stoch: ${st.k}/${st.d}`);
 if(raw==="ADD"){
   if(!hasPosition){debug.push("ADD blocked: no active same-direction position — ADD is never a standalone entry");raw=null;}
   else if(!retestConfirmed(candles4h,dir,tl.price,price)){debug.push(`ADD blocked: no confirmed TL retest (distance ${(Math.abs(dist)*100).toFixed(2)}%, max ${ADD_MAX_TL_DISTANCE*100}%)`);raw=null;}
   else if((dir==="LONG"&&(rsiVal>=ADD_MAX_RSI_LONG||st.k>=ADD_MAX_STOCH_LONG))||(dir==="SHORT"&&(rsiVal<=ADD_MIN_RSI_SHORT||st.k<=ADD_MIN_STOCH_SHORT))){debug.push(`ADD blocked: momentum overextended (RSI ${rsiVal}, Stoch ${st.k}/${st.d}) — wait for pullback/retest`);raw=null;}
 }
 if(!raw){const state=near?"NEAR_TL":beyond?"BEYOND_TL":"FAR_FROM_TL";debug.push(`State: ${state} | No signal`);return{market:marketSnapshot(pair,candles4h,dir,tl.price,price,st,adxVal),debug};}
 const atrVal=atr(candles4h),lows=candles4h.slice(-10).map(x=>x.low),highs=candles4h.slice(-10).map(x=>x.high),entry=price,isAdd=raw==="ADD";
 const structuralStop=dir==="LONG"?Math.min(Math.min(...lows),entry-atrVal*(isAdd?ADD_ATR:ENTRY_ATR)):Math.max(Math.max(...highs),entry+atrVal*(isAdd?ADD_ATR:ENTRY_ATR));
 const liquidation=estimateLiquidationPrice(entry,dir),safeBoundary=liquidationSafeBoundary(entry,dir),stop=executionStop(entry,structuralStop,dir,isAdd),risk=Math.abs(entry-stop);
 debug.push(`[RISK] Structural SL ${structuralStop.toFixed(5)} | Execution SL ${stop.toFixed(5)} | Est. liquidation ${liquidation.toFixed(5)} | safety boundary ${safeBoundary.toFixed(5)}`);
 if(!risk){debug.push("Zero risk");return{market:marketSnapshot(pair,candles4h,dir,tl.price,price,st,adxVal),debug};}
 // Realistic staged targets: 1R to bank something, 2R as the main target, 3R as the runner.
 const tp1=dir==="LONG"?entry+risk:entry-risk;
 const tp2=dir==="LONG"?entry+risk*2:entry-risk*2;
 const tp3=dir==="LONG"?entry+risk*3:entry-risk*3;
 const target=tp2,rr=2;
 const expectedMove=Math.abs(tp3-entry)/entry*100;
 const s:Signal={id:`${pair}_${now}`,pair,direction:dir,type:raw,scale:raw,entry:roundPrice(entry),stop:roundPrice(stop),target:roundPrice(target),tp1:roundPrice(tp1),tp2:roundPrice(tp2),tp3:roundPrice(tp3),confidence:raw==="ENTRY_1"?55:raw==="ENTRY_2"?65:80,rr,adx:adxVal,rsi:rsiVal,stochK:st.k,stochD:st.d,expectedMove:Math.round(expectedMove*10)/10,reason:`${dir} ${raw} | 1D ${strength(d1,dir)} | ${isAdd?"confirmed TL retest":"TL approach"} | RSI ${rsiVal} | Stoch ${st.k}/${st.d} | TP1 ${tp1.toFixed(2)} | TP2 ${tp2.toFixed(2)} | TP3 ${tp3.toFixed(2)}`,timestamp:now,version:CURRENT_SIGNAL_VERSION,trend:`${dir} ${strength(d1,dir)}`,location:near?"NEAR_TL":"BEYOND_TL",trigger:"FIRED",context:{marketPhase:`${dir} ${strength(d1,dir)}`,structure:"4H trendline",momentum:`RSI ${rsiVal} | Stoch ${st.k}/${st.d}`,pullback:isAdd?"confirmed_retest":"active",risk:{safe:true,estimatedLiquidation:roundPrice(liquidation),safeBoundary:roundPrice(safeBoundary),structuralStop:roundPrice(structuralStop),executionStop:roundPrice(stop),leverage:EXECUTION_LEVERAGE,maxRiskPct:(isAdd?ADD_MAX_RISK_PCT:ENTRY_MAX_RISK_PCT)*100},stages:{tp1:roundPrice(tp1),tp2:roundPrice(tp2),tp3:roundPrice(tp3),tp1R:1,tp2R:2,tp3R:3}}};
 debug.push(`SIGNAL: ${raw} ${dir} @ ${s.entry} | SL ${s.stop} | TP1 ${s.tp1} | TP2 ${s.tp2} | TP3 ${s.tp3} | RR ${s.rr}`);
 return{signal:s,signals:[s],market:marketSnapshot(pair,candles4h,dir,tl.price,price,st,adxVal),debug};
}

function marketSnapshot(pair:string,c:Candle[],dir:"LONG"|"SHORT",tl:number,price:number,st:{k:number;d:number},adxVal:number){const closes=c.map(x=>x.close),near=Math.abs((price-tl)/tl)<TL_THRESHOLD,beyond=dir==="LONG"?price>tl*1.008:price<tl*.992;const e8=ema(closes,TF_FAST).at(-1)!,e21=ema(closes,TF_SLOW).at(-1)!,r=rsi(closes);let momentumState="NEUTRAL";if((dir==="LONG"&&r>=80)||(dir==="SHORT"&&r<=20))momentumState="OVEREXTENDED";else if((dir==="LONG"&&r>=70)||(dir==="SHORT"&&r<=30))momentumState="HOT";else if((dir==="LONG"&&st.k<20)||(dir==="SHORT"&&st.k>80))momentumState="PULLBACK";return{pair,price:Math.round(price*100)/100,timestamp:Date.now(),trend:`${dir} ${strength(daily(c),dir)}`,location:near?"NEAR_TL":beyond?"BEYOND_TL":"FAR_FROM_TL",trigger:near?"READY":beyond?"WAITING":"WAITING",adx:adxVal,rsi:Math.round(r*10)/10,stochK:st.k,stochD:st.d,trendlinePrice:Math.round(tl*100)/100,distToTrendline:Math.round(Math.abs((price-tl)/tl)*10000)/100,ema8_4h:Math.round(e8*100)/100,ema21_4h:Math.round(e21*100)/100,momentumState};}

export function getMarketSnapshot(pair:string,candles1h:Candle[],candles4h:Candle[],candles15m:Candle[]){const d=daily(candles4h),dir=bias(d);if(!dir)return{pair,price:candles4h.at(-1)?.close||0,timestamp:Date.now(),trend:"FLAT",location:"NONE",trigger:"NO_BIAS",adx:0,rsi:0,stochK:0,stochD:0,trendlinePrice:0,distToTrendline:0,momentumState:"NEUTRAL"};const tl=trendline(candles4h,dir),price=candles4h.at(-1)?.close||0;if(!tl)return{pair,price,timestamp:Date.now(),trend:`${dir} ${strength(d,dir)}`,location:"NONE",trigger:"WAITING",adx:adx(candles4h),rsi:rsi(candles4h.map(x=>x.close)),stochK:50,stochD:50,trendlinePrice:0,distToTrendline:0,momentumState:"NEUTRAL"};const st=stochRsi(candles4h.map(x=>x.close));const base=marketSnapshot(pair,candles4h,dir,tl.price,price,st,adx(candles4h));const estimatedLiquidation=estimateLiquidationPrice(price,dir),safeBoundary=liquidationSafeBoundary(price,dir);return{...base,risk:{estimatedLiquidation:roundPrice(estimatedLiquidation),safeBoundary:roundPrice(safeBoundary),leverage:EXECUTION_LEVERAGE}};}

export interface ValidityCheck{valid:boolean;reason:string;exited:boolean;state?:"VALID"|"STALE"|"INVALID";}
export function isSignalStillValid(s:Signal,p:number,now=Date.now()):ValidityCheck{const ttl=s.type==="ADD"?4*60*60*1000:24*60*60*1000;if(now-s.timestamp>ttl)return{valid:false,reason:"expired_ttl",exited:true,state:"STALE"};if(s.direction==="LONG"&&p<=s.stop)return{valid:false,reason:"sl_hit",exited:true,state:"INVALID"};if(s.direction==="SHORT"&&p>=s.stop)return{valid:false,reason:"sl_hit",exited:true,state:"INVALID"};const finalTarget=s.tp3??s.target;if(s.direction==="LONG"&&p>=finalTarget)return{valid:false,reason:"tp3_hit",exited:true,state:"STALE"};if(s.direction==="SHORT"&&p<=finalTarget)return{valid:false,reason:"tp3_hit",exited:true,state:"STALE"};const distance=Math.abs((p-s.entry)/s.entry),staleDistance=s.type==="ADD"?0.025:0.05;if(distance>staleDistance)return{valid:false,reason:"price_too_far_from_alert",exited:false,state:"STALE"};return{valid:true,reason:"active",exited:false,state:"VALID"};}

export interface HoldResult{shouldHold:boolean;reason:string;newStop?:number;scaleOut?:{level:number;size:number;label:string};}
export function shouldHold(s:Signal,c:Candle[],p:number):HoldResult{
 const d=daily(c),dir=bias(d),st=stochRsi(c.map(x=>x.close));
 if(dir&&dir!==s.direction&&((s.direction==="LONG"&&p<=s.entry)||(s.direction==="SHORT"&&p>=s.entry)))return{shouldHold:false,reason:"trend_reversed_unprofitable"};
 const risk=Math.abs(s.entry-s.stop);
 if(risk){const r=s.direction==="LONG"?(p-s.entry)/risk:(s.entry-p)/risk;const tp1R=1,tp2R=2;
   if(r>=tp2R)return{shouldHold:true,reason:"tp2_hit_lock_2r",newStop:s.direction==="LONG"?s.entry+risk:s.entry-risk,scaleOut:{level:s.tp2??s.entry,size:.25,label:"TP2"}};
   if(r>=tp1R)return{shouldHold:true,reason:"tp1_hit_scale_out_50",newStop:s.entry,scaleOut:{level:s.tp1??s.entry,size:.5,label:"TP1"}};
 }
 // Stoch overextension is now an informational/profit-protection state, not an automatic exit.
 if((s.direction==="LONG"&&st.k>80)||(s.direction==="SHORT"&&st.k<20))return{shouldHold:true,reason:"stoch_extended_profit_protection"};
 const v=isSignalStillValid(s,p);return{shouldHold:v.valid,reason:v.reason};
}
export function shouldHoldCompat(s:Signal,c4:Candle[],c1:Candle[],p:number){return shouldHold(s,c4,p);}
export function filterExpiredSignals(signals:Signal[],prices:Record<string,number>,now?:number){const active:Signal[]=[],exited:{signal:Signal;reason:string}[]=[];for(const s of signals){const p=prices[s.pair];if(p===undefined){active.push(s);continue;}const v=isSignalStillValid(s,p,now);v.valid?active.push(s):exited.push({signal:s,reason:v.reason});}return{active,exited};}
export type TradeStatus="ACTIVE"|"TP_HIT"|"SL_HIT"|"EXPIRED";
export function checkTradeStatus(s:Signal,p:number,now=Date.now()):TradeStatus{const v=isSignalStillValid(s,p,now);if(v.reason==="expired_ttl")return"EXPIRED";if(s.direction==="LONG"){if(p>=(s.tp3??s.target))return"TP_HIT";if(p<=s.stop)return"SL_HIT";}else{if(p<=(s.tp3??s.target))return"TP_HIT";if(p>=s.stop)return"SL_HIT";}return v.state==="STALE"?"EXPIRED":"ACTIVE";}
export function rebuildStateFromTrades(_:Record<string,any>):void{return;}
export function recordTradeExit(_:string,__ :"LONG"|"SHORT",___:string,____:number,_____:Candle[]=[]):void{return;}
export async function getMonitorState(_:string){return undefined;}
export async function clearMonitorState(_:string){return;}
export async function setMonitorState(_:string,__:any){return;}
export function setRedisClient(_:any){return;}
export async function generateSignalCompat(pair:string,c1:Candle[],c4:Candle[],c15:Candle[],activeTrades?:any[],price?:number){return generateSignal(pair,c1,c4,c15,activeTrades,price);}
export function isSignalStillValidBool(s:Signal,p:number){return isSignalStillValid(s,p).valid;}
export function resetAlertProgression(_:string,__:"LONG"|"SHORT"){return;}
export function clearDedupState(){return;}
