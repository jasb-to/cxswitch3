// Independent asset strategies. Kept separate from V28 so every alert carries its originating strategy.
import { Candle, Signal } from "./strategy";

type Direction="LONG"|"SHORT";
type Rule=(z:Features,d:Direction)=>boolean;
interface Features{close:number;atr:number;rsi:number;roc:number;trend:1|-1;e5:number;e13:number;e20:number;e50:number;vol:number;atrExp:number;bull:boolean;bear:boolean;body:number;upper:number;lower:number;hh:number;ll:number;}
interface StrategyConfig{name:string;source:string;direction:Direction;rules:Rule[];}

const avg=(a:number[])=>a.length?a.reduce((s,x)=>s+x,0)/a.length:0;
const ema=(a:number[],p:number)=>{if(!a.length)return[];const k=2/(p+1),r=[a[0]];for(let i=1;i<a.length;i++)r.push(a[i]*k+r[i-1]*(1-k));return r};
function features(c:Candle[]):Features|null{if(c.length<60)return null;const cl=c.map(x=>x.close),e5=ema(cl,5),e13=ema(cl,13),e20=ema(cl,20),e50=ema(cl,50);let g=0,l=0;for(let i=Math.max(1,cl.length-14);i<cl.length;i++){const d=cl[i]-cl[i-1];if(d>0)g+=d;else l-=d}const rsi=l?100-100/(1+(g/14)/(l/14)):100;const tr:number[]=[];for(let i=Math.max(1,c.length-14);i<c.length;i++){const x=c[i],p=c[i-1];tr.push(Math.max(x.high-x.low,Math.abs(x.high-p.close),Math.abs(x.low-p.close)))}const atr=avg(tr);const prev:number[]=[];for(let i=Math.max(1,c.length-28);i<c.length-14;i++){const x=c[i],p=c[i-1];prev.push(Math.max(x.high-x.low,Math.abs(x.high-p.close),Math.abs(x.low-p.close)))}const x=c.at(-1)!,range=x.high-x.low||1,body=Math.abs(x.close-x.open)/range;return{close:x.close,atr,rsi,roc:(x.close-c[Math.max(0,c.length-7)].close)/(atr||x.close),trend:e20.at(-1)!>e50.at(-1)!?1:-1,e5:e5.at(-1)!,e13:e13.at(-1)!,e20:e20.at(-1)!,e50:e50.at(-1)!,vol:x.volume/(avg(c.slice(-21,-1).map(z=>z.volume))||x.volume),atrExp:atr/(avg(prev)||atr),bull:x.close>x.open&&body>=.4,bear:x.close<x.open&&body>=.4,body,upper:(x.high-Math.max(x.open,x.close))/range,lower:(Math.min(x.open,x.close)-x.low)/range,hh:Math.max(...c.slice(-21,-1).map(z=>z.high)),ll:Math.min(...c.slice(-21,-1).map(z=>z.low))};}
const trendOpposed=(z:Features,d:Direction)=>z.trend===(d==="LONG"?-1:1);
const momentumNeg=(z:Features,d:Direction)=>d==="LONG"?z.roc<0:z.roc>0;
const priceEma20=(z:Features,d:Direction)=>d==="LONG"?z.close>z.e20:z.close<z.e20;
const rsiExtreme=(z:Features,d:Direction)=>d==="LONG"?z.rsi<=30:z.rsi>=70;
const momentumPos=(z:Features,d:Direction)=>d==="LONG"?z.roc>0:z.roc<0;
const rsiHigh=(z:Features)=>z.rsi>=60;

// These are deliberately independent of V28. BTC has the previously validated trend-opposed long hypothesis;
// SOL uses the best SOL holdout candidate found so far; HYPE uses the more data-rich Momentum-Neg + Price-EMA20 lead.
const CONFIGS:StrategyConfig[]=[
 {name:"BTC Trend-Opposed Long",source:"BTC_RESEARCH_01",direction:"LONG",rules:[trendOpposed]},
 {name:"SOL Trend-Opposed + RSI-Extreme Short",source:"SOL_RESEARCH_01",direction:"SHORT",rules:[trendOpposed,rsiExtreme]},
 {name:"HYPE Momentum-Negative + Price-EMA20 Long",source:"HYPE_RESEARCH_01",direction:"LONG",rules:[momentumNeg,priceEma20]},
 // ETH is intentionally isolated behind its own config and is replaced with the tested ETH winner before activation.
 {name:"ETH Independent Research",source:"ETH_RESEARCH_01",direction:"LONG",rules:[momentumPos,rsiHigh]},
];

export function getIndependentStrategyConfigs(){return CONFIGS.map(x=>({name:x.name,source:x.source,direction:x.direction}));}

export function generateIndependentSignal(pair:string,candles4h:Candle[],currentPrice:number):Signal|null{
 const completed=candles4h.length>1?candles4h.slice(0,-1):candles4h;const z=features(completed);if(!z)return null;
 const cfg=CONFIGS.find(x=>x.source.startsWith(`${pair}_`));if(!cfg)return null;
 if(!cfg.rules.every(rule=>rule(z,cfg.direction)))return null;
 // Only fire on a fresh directional trigger from the completed candle, not every cron tick.
 const prev=completed.slice(0,-1);const p=features(prev);if(!p)return null;
 const triggered=cfg.direction==="LONG"?(z.bull||z.e5>z.e13&&p.e5<=p.e13):(z.bear||z.e5<z.e13&&p.e5>=p.e13);
 if(!triggered)return null;
 const entry=currentPrice,risk=Math.max(1.5*z.atr,entry*.008),stop=cfg.direction==="LONG"?entry-risk:entry+risk,target=cfg.direction==="LONG"?entry+2*risk:entry-2*risk;
 const now=Date.now(),id=`${cfg.source}_${pair}_${cfg.direction}_${Math.floor(now/1000)}`;
 return{id,pair,direction:cfg.direction,type:"ENTRY_1",scale:"ENTRY_1",entry,stop,target,tp1:cfg.direction==="LONG"?entry+risk:entry-risk,tp2:target,tp3:target,confidence:Math.min(99,55+Math.max(0,Math.abs(z.roc)*10)),rr:2,adx:0,rsi:z.rsi,stochK:0,stochD:0,expectedMove:Math.round(Math.abs(target-entry)/entry*1000)/10,reason:`Independent ${cfg.name} fired on completed 4H candle`,timestamp:now,version:29,trend:z.trend===1?"BULLISH":"BEARISH",location:cfg.name,trigger:"INDEPENDENT_4H",context:{strategySource:cfg.source,strategyName:cfg.name,engine:"INDEPENDENT",rules:cfg.rules.length,features:{rsi:z.rsi,roc:z.roc,trend:z.trend,ema20:z.e20,atr:z.atr},v28Compatible:false}};
}
