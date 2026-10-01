// lib/telegram.ts — canonical CXSwitch alerts
import { CXSWITCH_VERSION } from "./version";

const formatPrice=(value:any)=>{
  if(value===undefined||value===null||value==="-")return "-";
  const n=Number(value);
  if(!Number.isFinite(n))return String(value);
  if(Math.abs(n)>=1000)return n.toFixed(0);
  if(Math.abs(n)>=1)return n.toFixed(2);
  if(Math.abs(n)>=0.1)return n.toFixed(3);
  return n.toFixed(5);
};

export async function sendAlert(signal:any){
  const token=process.env.TELEGRAM_BOT_TOKEN,chatId=process.env.TELEGRAM_CHAT_ID;
  if(!token||!chatId)throw new Error("Telegram alerting is not configured: TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID missing");

  const type=signal.signalType||signal.state;
  const emoji=signal.signalEmoji||(type==="ENTRY_1"?"🟢":type==="ENTRY_2"?"🟠":type==="ENTRY_0"?"🟡":type==="ADD"?"🔵":type==="EXIT_0"?"🔴":type==="EXIT"?"🔴":"📊");
  const labels:Record<string,string>={ENTRY_0:"ENTRY ⓪",ENTRY_1:"ENTRY ①",ENTRY_2:"ENTRY ②",ADD:"ADD",ENTRY:"ENTRY",EXIT_0:"EXIT ⓪",EXIT:"EXIT"};
  const label=labels[type]||signal.state;
  const dir=signal.bias==="LONG"?"📈":"📉";
  const tp1=signal.takeProfit1??signal.context?.stages?.tp1??"-";
  const tp2=signal.takeProfit2??signal.context?.stages?.tp2??signal.takeProfit??"-";
  // Derive Expected Move from the actual displayed entry/price and TP2 so the
  // Telegram value cannot drift from the TP2 shown in the alert.
  const expectedMove=typeof (signal.price??signal.entry)==="number"&&typeof tp2==="number"&&Number(signal.price??signal.entry)!==0
    ? Math.round((Math.abs(tp2-Number(signal.price??signal.entry))/Math.abs(Number(signal.price??signal.entry)))*1000)/10
    : signal.expectedMove??"-";
  const guard=signal.context?.entryGuard;
  const fourH513=signal.fourH513Label||signal.context?.fourH513?.label||"NEUTRAL";
  const exitPlan=signal.context?.exitPlan;
  const trendAlignment=signal.context?.trendAlignment||signal.context?.risk?.trendAlignment;
  const sizeMultiplier=signal.context?.sizeMultiplier??signal.context?.risk?.sizeMultiplier;

  const fibLevel=Array.isArray(guard?.referenceFib)?guard.referenceFib[1]:undefined;
  const maxEntry=guard?.maxEntry??fibLevel;
  const tl=typeof guard?.referenceTrendline==="number"?guard.referenceTrendline:null;
  const tlDistance=typeof guard?.trendlineDistancePct==="number"?guard.trendlineDistancePct:null;
  const entryZone=type==="ENTRY_1"&&typeof maxEntry==="number"
    ? `Entry zone: ${signal.bias==="LONG"?"≤":"≥"} ${formatPrice(maxEntry)}`
    : "";
  const tlLine=type==="ENTRY_1"&&tl!==null
    ? `TL: ${formatPrice(tl)} · distance: ${tlDistance!==null?tlDistance.toFixed(2)+"%":"—"}`
    : "";

  const addText=type==="ADD"?`\n🔵 ADD DETAILS\nSize: ${sizeMultiplier?`x${sizeMultiplier}`:"reduced"}${trendAlignment?` · ${trendAlignment}`:""}\nReason: ${signal.reason||"next wave after pullback/retest with thesis intact"}\n`:"";
  const exitText=exitPlan?`\nExit plan: TP1 ${exitPlan.tp1Pct}% | TP2 ${exitPlan.tp2Pct}%\nAfter TP1: ${exitPlan.afterTp1} | After TP2: ${exitPlan.afterTp2}\nRunner: ${exitPlan.runner}\n`:"";
  const entry0Text=type==="ENTRY_0"?`\nENTRY_0 confirmation: ${signal.confirmation||"1D 5/13 aligned with 4H 5/13 cross"}\nLongevity exit: 4H 8/21 opposite cross\n`:type==="EXIT_0"?`\nENTRY_0 exit: ${signal.reason||"4H 8/21 opposite cross"}\n`:"";

  const jarvis=signal.jarvis;
  const jarvisLine=jarvis?.verdict
    ? `JARVIS: ${jarvis.verdict} · ${jarvis.summary||""}`
    : "";
  const context=signal.context||{};
  const trigger=signal.trigger||context.entry1Trigger||"";
  const dailyBreakout=context.dailyBreakout;
  const runway=context.runway;
  const dailyFade=context.dailyFade;
  const setupLine=type==="ENTRY_1"&&trigger ? `Setup: ${trigger}` : "";
  const dailyLine=type==="ENTRY_1"
    ? dailyFade?.shortWatch
      ? `1D Fade Watch: ${dailyFade.failedBreak?"FAILED BREAKOUT":"RESISTANCE APPROACH"} · Stoch ${dailyFade.stochK??"-"}/${dailyFade.stochD??"-"}`
      : dailyBreakout
        ? `1D Breakout: ${dailyBreakout.direction||"—"} · level ${formatPrice(dailyBreakout.level??dailyBreakout.price)}`
        : "1D Breakout: not exposed"
    : "";
  const runwayLine=type==="ENTRY_1"&&runway
    ? `Runway: ${runway.pct!==null&&runway.pct!==undefined?runway.pct.toFixed(2)+"%":"—"}${runway.preferred?" · preferred":""}${runway.obstacle!==null&&runway.obstacle!==undefined?` · obstacle ${formatPrice(runway.obstacle)}`:""}`
    : "";
  const location=context.locationQuality;
  const compression=context.compression;
  const market=context.marketHealth;
  const qualityLine=type==="ENTRY_1"&&location
    ? `Location: ${location.quality} · Fib ${location.nearFib?"YES":"NO"} · level ${location.nearSwing?"YES":"NO"} · compression ${compression?.compressed?"YES":"NO"}`
    : "";
  const marketLine=market
    ? `Market: BTC.D ${market.btcDominance??"—"} (${market.btcDominanceChange24h!=null?(market.btcDominanceChange24h>=0?"+":"")+market.btcDominanceChange24h.toFixed(2)+"pp":"—"}) · USDT.D ${market.usdtDominance??"—"} (${market.usdtDominanceChange24h!=null?(market.usdtDominanceChange24h>=0?"+":"")+market.usdtDominanceChange24h.toFixed(2)+"pp":"—"}) · TOTAL ${market.totalMarketCapChange24h!=null?(market.totalMarketCapChange24h>=0?"+":"")+market.totalMarketCapChange24h.toFixed(2)+"%":"—"} · ALT ${market.altContext}`
    : "";

  const lines=[
    `${emoji} CX SWITCH v${CXSWITCH_VERSION} — ${label}`,"",
    `${dir} ${signal.symbol} — ${signal.bias}`,"",
    `Price: ${formatPrice(signal.price??signal.entry)}`,"",
    jarvisLine,"",
    setupLine,
    dailyLine,
    runwayLine,
    qualityLine,
    marketLine,
    entryZone,
    `4H 5/13: ${fourH513}`,"",
    `SL: ${formatPrice(signal.stopLoss)}`,
    `TP1: ${formatPrice(tp1)}`,
    `TP2: ${formatPrice(tp2)}`,
    `RR: ${signal.rr??"-"}`,"",
    `Expected Move: ${expectedMove}%`,
    signal.reason||""
  ].join("\n");

  const response=await fetch(`https://api.telegram.org/bot${token}/sendMessage`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({chat_id:chatId,text:lines})});
  if(!response.ok){
    const body=await response.text().catch(()=>"");
    throw new Error(`Telegram sendMessage failed (${response.status}): ${body.slice(0,300)}`);
  }
}


export async function sendJarvisUpdate(update:{
  portfolioState:string;
  location:string;
  changes:Array<{pair:string;decision:"STAY IN TRADE"|"EXIT TRADE";reason:string}>;
  summary:string;
  timestamp?:string;
} ){
  const token=process.env.TELEGRAM_BOT_TOKEN,chatId=process.env.TELEGRAM_CHAT_ID;
  if(!token||!chatId)throw new Error("Telegram alerting is not configured: TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID missing");
  const exit=update.changes.some(x=>x.decision==="EXIT TRADE");
  const decision=exit?"EXIT TRADE":"STAY IN TRADE";
  const emoji=exit?"🔴":"🟢";
  const lines=[
    `${emoji} JARVIS — ${decision}`,"",
    ...update.changes.map(x=>`${x.pair}: ${x.decision}${x.reason?" — "+x.reason:""}`),
    "",
    "JARVIS active-trade decision changed; portfolio/momentum diagnostics remain dashboard-only.",
    `Time: ${update.timestamp||new Date().toISOString()}`
  ].join("\n");
  const response=await fetch(`https://api.telegram.org/bot${token}/sendMessage`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({chat_id:chatId,text:lines})});
  if(!response.ok){
    const body=await response.text().catch(()=>"");
    throw new Error(`Telegram JARVIS update failed (${response.status}): ${body.slice(0,300)}`);
  }
}
