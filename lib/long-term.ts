import { aggregateTo1D, getCandles, Candle, krakenPairFormat } from "./kraken";
export type LongTermState={stage:"BTC_ACCUMULATION"|"BTC_TO_ETH_ROTATION"|"ETH_CORE_ALT_BUILD"|"CYCLE_PROFIT_TAKING";stageLabel:string;action:string;confidence:"LOW"|"MEDIUM"|"HIGH";btcScore:number;rotationScore:number;altScore:number;riskScore:number;btcPrice:number;ethPrice:number;ethBtc:number;btcDrawdown:number;breadth:number;btcTrend:string;ethTrend:string;currentModel:string;targetModel:string;targetText:string;nextStage:string;reasons:string[];blockers:string[];updatedAt:number};
const EMA=(a:number[],p:number)=>{if(!a.length)return[];const k=2/(p+1),r=[a[0]];for(let i=1;i<a.length;i++)r.push(a[i]*k+r[i-1]*(1-k));return r};
const RSI=(a:number[],p=14)=>{if(a.length<p+1)return 50;let g=0,l=0;for(let i=a.length-p;i<a.length;i++){const d=a[i]-a[i-1];if(d>0)g+=d;else l-=d}if(l===0)return 100;return 100-100/(1+(g/p)/(l/p))};
const clamp=(n:number)=>Math.max(0,Math.min(100,Math.round(n)));
function trend(c:Candle[]){const d=aggregateTo1D(c),a=d.map(x=>x.close);if(a.length<20)return{label:"NEUTRAL",rsi:50};const e20=EMA(a,20).at(-1)!,e50=EMA(a,50).at(-1)!,p=a.at(-1)!;return{label:p>e20&&e20>e50?"BULLISH":p<e20&&e20<e50?"BEARISH":"MIXED",rsi:RSI(a)}}
async function candles(pair:string){return getCandles(krakenPairFormat(pair),240)}
export async function getLongTermState():Promise<LongTermState>{
 const [btc,eth,sol,hype,xrp,link,avax,doge,sui]=await Promise.all([candles("BTC/USD"),candles("ETH/USD"),candles("SOL/USD"),candles("HYPE/USD"),candles("XRP/USD"),candles("LINK/USD"),candles("AVAX/USD"),candles("DOGE/USD"),candles("SUI/USD")]);
 const btcPrice=btc.at(-1)?.close??0,ethPrice=eth.at(-1)?.close??0,bt=trend(btc),et=trend(eth),alts=[sol,hype,xrp,link,avax,doge,sui].map(trend),breadth=clamp(alts.filter(x=>x.label==="BULLISH").length/alts.length*100),ethBtc=ethPrice/btcPrice,ethBtc30=(eth.at(-180)?.close??ethPrice)/(btc.at(-180)?.close??btcPrice),relPct=(ethBtc/ethBtc30-1)*100;
 const highs=btc.slice(-540).map(x=>x.high),recentHigh=Math.max(...highs),drawdown=Math.max(0,(recentHigh-btcPrice)/recentHigh*100),accumTargetLow=recentHigh*.90,accumTargetHigh=recentHigh*.95;
 const btcScore=clamp(50+Math.min(drawdown,35)*1.1+(bt.label==="BEARISH"?10:bt.label==="MIXED"?5:-5)+(bt.rsi<45?10:bt.rsi<55?5:0));
 const rotationScore=clamp(50+Math.min(30,Math.max(-30,relPct*4))+(et.label==="BULLISH"?15:et.label==="MIXED"?5:-15)+(bt.label==="BEARISH"?15:bt.label==="MIXED"?5:-5));
 const altScore=clamp(30+breadth*.55+(et.label==="BULLISH"?15:0)+Math.max(-10,Math.min(10,relPct*2)));
 const riskScore=clamp((bt.rsi>72?30:bt.rsi>65?18:0)+(et.rsi>72?25:et.rsi>65?12:0)+(breadth>80?25:breadth>65?12:0)+(altScore>80?20:0));
 // Stage 1 is the default and remains active until a genuine BTC→ETH rotation is confirmed.
 // Rotation requires ETH/BTC to outperform its 30-day relative baseline by 5%+, ETH to be bullish,
 // and BTC to have lost its bullish daily structure. This prevents hot RSI/alt breadth from skipping stages.
 const rotationConfirmed=relPct>=5&&et.label==="BULLISH"&&bt.label!=="BULLISH";
 const altConfirmed=rotationConfirmed&&relPct>=10&&breadth>=70&&altScore>=68;
 const profitConfirmed=altConfirmed&&riskScore>=75;
 let stage:LongTermState["stage"]="BTC_ACCUMULATION";
 if(rotationConfirmed)stage="BTC_TO_ETH_ROTATION";
 if(altConfirmed)stage="ETH_CORE_ALT_BUILD";
 if(profitConfirmed)stage="CYCLE_PROFIT_TAKING";
 const stageLabel={BTC_ACCUMULATION:"BTC ACCUMULATION PHASE",BTC_TO_ETH_ROTATION:"BTC → ETH ROTATION PHASE",ETH_CORE_ALT_BUILD:"ETH + ALT BUILD PHASE",CYCLE_PROFIT_TAKING:"CYCLE PROFIT TAKING PHASE"}[stage];
 const action=stage==="BTC_ACCUMULATION"?"BUY BTC ON WEAKNESS":stage==="BTC_TO_ETH_ROTATION"?"WATCH / BEGIN BTC → ETH ROTATION":stage==="ETH_CORE_ALT_BUILD"?"BUILD TOWARD 50% ETH / 50% ALTS":"DE-RISK IN STAGES";
 const targetText=stage==="BTC_ACCUMULATION"?`Preferred BTC accumulation zone: ${Math.round(accumTargetLow).toLocaleString()}–${Math.round(accumTargetHigh).toLocaleString()}`:stage==="BTC_TO_ETH_ROTATION"?`Rotation target: ETH/BTC ≥ ${(ethBtc30*1.05).toFixed(5)} with confirmation`:stage==="ETH_CORE_ALT_BUILD"?(altScore>=82?"Target allocation: ETH 40% · ALTS 60%":"Target allocation: ETH 50% · ALTS 50%"):"Protect gains progressively";
 const blockers:string[]=[];
 if(!rotationConfirmed){if(relPct<5)blockers.push(`ETH/BTC relative strength only ${relPct.toFixed(1)}% vs 30-day baseline`);if(et.label!=="BULLISH")blockers.push("ETH daily trend is not bullish enough");if(bt.label==="BULLISH")blockers.push("BTC daily structure is still bullish — rotation is not confirmed");}
 if(stage!=="BTC_ACCUMULATION"&&breadth<70)blockers.push("Broad alt participation not yet confirmed");
 const reasons=stage==="BTC_ACCUMULATION"?[`BTC ${bt.label} · RSI ${bt.rsi.toFixed(0)}`,`${drawdown.toFixed(1)}% BTC drawdown from recent 4H high`,`BTC remains the primary accumulation asset`,`ETH/BTC rotation has not met the confirmation threshold`]:[`BTC ${bt.label} · RSI ${bt.rsi.toFixed(0)}`,`ETH ${et.label} · ETH/BTC ${ethBtc.toFixed(5)}`,`ETH/BTC relative strength ${relPct.toFixed(1)}% vs 30-day baseline`,`Alt breadth ${breadth}% bullish`];
 const currentModel=stage==="BTC_ACCUMULATION"?"BTC accumulation · prioritise BTC":stage==="BTC_TO_ETH_ROTATION"?"BTC → ETH transition":stage==="ETH_CORE_ALT_BUILD"?"ETH 50% · ALTS 50% (default)":"Reduce risk progressively";
 const targetModel=stage==="ETH_CORE_ALT_BUILD"?(altScore>=82?"ETH 40% · ALTS 60%":"ETH 50% · ALTS 50%"):stage==="BTC_TO_ETH_ROTATION"?"ETH-led transition":"Next stage determines allocation";
 return{stage,stageLabel,action,confidence:stage==="BTC_ACCUMULATION"?"HIGH":Math.max(rotationScore,altScore)>=75?"HIGH":"MEDIUM",btcScore,rotationScore,altScore,riskScore,btcPrice,ethPrice,ethBtc,btcDrawdown:drawdown,breadth,btcTrend:bt.label,ethTrend:et.label,currentModel,targetModel,targetText,nextStage:stage==="BTC_ACCUMULATION"?"BTC → ETH":stage==="BTC_TO_ETH_ROTATION"?"ETH + ALT BUILD":stage==="ETH_CORE_ALT_BUILD"?"PROFIT TAKING":"CASH / PRESERVATION",reasons,blockers,updatedAt:Date.now()};
}