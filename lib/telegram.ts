// lib/telegram.ts — canonical CXSwitch alerts
import { CXSWITCH_VERSION } from "./version";

const formatPrice=(value:any)=>{
  if(value===undefined||value===null||value==="-")return "-";
  const n=Number(value);
  return Number.isFinite(n)?n.toFixed(2):String(value);
};

export async function sendAlert(signal:any){
  const token=process.env.TELEGRAM_BOT_TOKEN,chatId=process.env.TELEGRAM_CHAT_ID;
  if(!token||!chatId){console.log("[TELEGRAM DISABLED]",signal.symbol,signal.state);return;}
  const type=signal.signalType||signal.state;
  const emoji=signal.signalEmoji||(type==="ENTRY_1"?"🟢":type==="ENTRY_2"?"🟠":type==="ENTRY_0"?"🟡":type==="ADD"?"🔵":type==="EXIT_0"?"🔴":type==="EXIT"?"🔴":"📊");
  const labels:Record<string,string>={ENTRY_0:"ENTRY ⓪",ENTRY_1:"ENTRY ①",ENTRY_2:"ENTRY ②",ADD:"ADD",ENTRY:"ENTRY",EXIT_0:"EXIT ⓪",EXIT:"EXIT"};
  const label=labels[type]||signal.state;
  const dir=signal.bias==="LONG"?"📈":"📉";
  const tp1=signal.takeProfit1??signal.context?.stages?.tp1??"-";
  const tp2=signal.takeProfit2??signal.context?.stages?.tp2??signal.takeProfit??"-";
  const tp3=signal.takeProfit3??signal.context?.stages?.tp3??"-";
  const guard=signal.context?.entryGuard;
  const fourH513=signal.fourH513Label||signal.context?.fourH513?.label||"NEUTRAL";
  const exitPlan=signal.context?.exitPlan;
  const trendAlignment=signal.context?.trendAlignment||signal.context?.risk?.trendAlignment;
  const sizeMultiplier=signal.context?.sizeMultiplier??signal.context?.risk?.sizeMultiplier;
  const addText=type==="ADD"?`\n🔵 ADD DETAILS\nSize: ${sizeMultiplier?`x${sizeMultiplier}`:"reduced"}${trendAlignment?` · ${trendAlignment}`:""}\nReason: ${signal.reason||"next wave after pullback/retest with thesis intact"}\n`:"";
  const exitText=exitPlan?`\nExit plan: TP1 ${exitPlan.tp1Pct}% | TP2 ${exitPlan.tp2Pct}% | TP3 ${exitPlan.tp3Pct}%\nAfter TP1: ${exitPlan.afterTp1} | After TP2: ${exitPlan.afterTp2}\nRunner: ${exitPlan.runner}\n`:"";
  const entry0Text=type==="ENTRY_0"?`\nENTRY_0 confirmation: ${signal.confirmation||"1D 5/13 aligned with 4H 5/13 cross"}\nLongevity exit: 4H 8/21 opposite cross\n`:type==="EXIT_0"?`\nENTRY_0 exit: ${signal.reason||"4H 8/21 opposite cross"}\n`:"";
  const text=`${emoji} CX SWITCH v${CXSWITCH_VERSION} — ${label}\n\n${dir} ${signal.symbol} — ${signal.bias}\nPrice: ${formatPrice(signal.price??signal.entry)}\n${type==="ENTRY_1"&&guard?`Entry zone: ${signal.bias==="LONG"?`≤ ${formatPrice(guard.maxEntry)}`:`≥ ${formatPrice(guard.maxEntry)}`} · TL ${formatPrice(guard.referenceTrendline)} · distance ${guard.executionDistancePct}%`:""}\n\n4H 5/13: ${fourH513}\n${addText}${entry0Text}\nTrend: ${signal.trend||signal.bias}\nLocation: ${signal.location||"—"}\nTrigger: ${signal.trigger||"—"}\n\nExpected Move: ${signal.expectedMove??"-"}%\nSL: ${formatPrice(signal.stopLoss)}\nTP1: ${formatPrice(tp1)}\nTP2: ${formatPrice(tp2)}\nTP3: ${formatPrice(tp3)}\nRR: ${signal.rr??"-"}\n${exitText}\nADX: ${signal.adx??"-"}\nRSI: ${signal.rsi??"-"}\nStochK: ${signal.stochK??"-"}\nStochD: ${signal.stochD??"-"}\n\n${signal.reason||""}\n\nTime: ${signal.updatedAt||new Date().toISOString()}`;
  const response=await fetch(`https://api.telegram.org/bot${token}/sendMessage`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({chat_id:chatId,text})});
  if(!response.ok){
    const body=await response.text().catch(()=>"");
    throw new Error(`Telegram sendMessage failed (${response.status}): ${body.slice(0,300)}`);
  }
}
