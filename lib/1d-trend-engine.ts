// lib/1d-trend-engine.ts — frozen 7-day 1D trend experiment
// Diagnostic only: NEVER gates or changes V28 execution.
import { Candle } from "./kraken";

type Direction = "BULL" | "BEAR" | "NEUTRAL";
export type TrendState = "BULL_ESTABLISHED" | "BULL_WEAKENING" | "TRANSITION" | "BEAR_DEVELOPING" | "BEAR_ESTABLISHED";

const EMA_FAST=20, EMA_MID=50, EMA_SLOW=200, PIVOT_W=2, PERSISTENCE=2;
const avg=(a:number[])=>a.length?a.reduce((x,y)=>x+y,0)/a.length:0;
function ema(a:number[],p:number){if(!a.length)return[];const k=2/(p+1),r=[a[0]];for(let i=1;i<a.length;i++)r.push(a[i]*k+r[i-1]*(1-k));return r;}
function adx(c:Candle[],p=14){if(c.length<p*2+1)return 0;const tr:number[]=[],plus:number[]=[],minus:number[]=[];for(let i=1;i<c.length;i++){const x=c[i],q=c[i-1];tr.push(Math.max(x.high-x.low,Math.abs(x.high-q.close),Math.abs(x.low-q.close)));plus.push(x.high-q.high>q.low-x.low?Math.max(x.high-q.high,0):0);minus.push(q.low-x.low>x.high-q.high?Math.max(q.low-x.low,0):0);}const w=(a:number[])=>{let r=avg(a.slice(0,p));const out=[r];for(let i=p;i<a.length;i++){r=(r*(p-1)+a[i])/p;out.push(r);}return out};const t=w(tr),pd=w(plus),md=w(minus),dx=t.map((v,i)=>{const a=pd[i]/v*100,b=md[i]/v*100;return a+b?Math.abs(a-b)/(a+b)*100:0});return Math.round((avg(dx.slice(-p))*1)*10)/10;}
function pivots(c:Candle[]){const highs:{i:number;p:number}[]=[],lows:{i:number;p:number}[]=[];for(let i=PIVOT_W;i<c.length-PIVOT_W;i++){let hi=true,lo=true;for(let j=1;j<=PIVOT_W;j++){hi&&=c[i].high>c[i-j].high&&c[i].high>c[i+j].high;lo&&=c[i].low<c[i-j].low&&c[i].low<c[i+j].low;}if(hi)highs.push({i,p:c[i].high});if(lo)lows.push({i,p:c[i].low});}return{highs,lows};}
function structure(c:Candle[]){const {highs,lows}=pivots(c),h=highs.slice(-2),l=lows.slice(-2);if(h.length<2||l.length<2)return{direction:"NEUTRAL" as Direction,label:"MIXED",protectedLevel:null,lastPivotAge:null};const bull=h[1].p>h[0].p&&l[1].p>l[0].p;const bear=h[1].p<h[0].p&&l[1].p<l[0].p;const last=Math.max(h[1].i,l[1].i);return{direction:bull?"BULL":bear?"BEAR":"NEUTRAL",label:bull?"HH/HL":bear?"LH/LL":"MIXED",protectedLevel:bull?l[1].p:bear?h[1].p:null,lastPivotAge:c.length-1-last};}
function momentum(c:Candle[]){const closes=c.map(x=>x.close),f=ema(closes,12),s=ema(closes,26),m=f.at(-1)!-s.at(-1)!,pm=f.at(-2)!-s.at(-2)!;return{direction:m>0?"BULL":m<0?"BEAR":"NEUTRAL" as Direction, state:m===0?"FLAT":m>pm?"RISING":"FALLING", value:m};}
function early513(c:Candle[]){const closes=c.map(x=>x.close),f=ema(closes,5),s=ema(closes,13),sp=f.at(-1)!-s.at(-1)!,prev=f.at(-2)!-s.at(-2)!;return{direction:sp>0?"BULL":sp<0?"BEAR":"NEUTRAL" as Direction,cross:sp!==0&&Math.sign(sp)!==Math.sign(prev),spreadPct:s.at(-1)!?sp/s.at(-1)!*100:0};}
function emaContext(c:Candle[]){const closes=c.map(x=>x.close),e20=ema(closes,20),e50=ema(closes,50),e200=ema(closes,200),p=closes.at(-1)!;const a=e20.at(-1)!,b=e50.at(-1)!,d=e200.at(-1)!;const bull=p>a&&a>b&&b>d,bear=p<a&&a<b&&b<d;return{direction:bull?"BULL":bear?"BEAR":"NEUTRAL" as Direction,alignment:bull?"20>50>200":bear?"20<50<200":"MIXED",slope20:a-e20.at(-2)!,slope50:b-e50.at(-2)!};}
function nextCandidate(structDir:Direction,emaDir:Direction,fastDir:Direction,adxNow:number,adxPrev:number,momDir:Direction):TrendState{
 if(structDir==="BULL"){
  if(emaDir==="BULL" && fastDir!=="BEAR")return adxNow>=20&&adxNow>=adxPrev?"BULL_ESTABLISHED":"BULL_WEAKENING";
  return "BULL_WEAKENING";
 }
 if(structDir==="BEAR"){
  if(emaDir==="BEAR" && fastDir!=="BULL")return adxNow>=20&&adxNow>=adxPrev?"BEAR_ESTABLISHED":"BEAR_DEVELOPING";
  return "BEAR_DEVELOPING";
 }
 if(fastDir==="BEAR" && momDir==="BEAR")return "BEAR_DEVELOPING";
 if(fastDir==="BULL" && momDir==="BULL")return "BULL_WEAKENING";
 return "TRANSITION";
}
export interface TrendEngineResult{state:TrendState;direction:"BULL"|"BEAR"|"NEUTRAL";previousState?:TrendState;candidateState:TrendState;structure:any;ema:any;fast513:any;adx:number;adxPrev:number;momentum:any;price:number;protectedLevel:number|null;explanation:string;parameters:{pivotWidth:number;persistence:number;};}
export function evaluate1DTrend(c:Candle[],previousState?:TrendState):TrendEngineResult{
 const completed=c.slice(0,-1); const src=completed.length>=30?completed: c; const s=structure(src),e=emaContext(src),f=early513(src),m=momentum(src);const ad=adx(src),adp=adx(src.slice(0,-1));const candidate=nextCandidate(s.direction,e.direction,f.direction,ad,adp,m.direction);
 const stable=previousState===candidate?candidate:(previousState&&((previousState.startsWith("BULL")&&candidate.startsWith("BULL"))||(previousState?.startsWith("BEAR")&&candidate.startsWith("BEAR")))?previousState:"TRANSITION");
 const direction=stable.startsWith("BULL")?"BULL":stable.startsWith("BEAR")?"BEAR":"NEUTRAL";
 const explanation=`Structure ${s.label}; EMA ${e.alignment}; 5/13 ${f.direction}${f.cross?" CROSS":""}; ADX ${ad.toFixed(1)}; momentum ${m.direction}/${m.state}; candidate ${candidate}; state ${stable}`;
 return{state:stable,direction,previousState,candidateState:candidate,structure:s,ema:e,fast513:f,adx:ad,adxPrev:adp,momentum:m,price:src.at(-1)!.close,protectedLevel:s.protectedLevel,explanation,parameters:{pivotWidth:PIVOT_W,persistence:PERSISTENCE}};
}
