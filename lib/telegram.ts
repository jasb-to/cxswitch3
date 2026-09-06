// lib/telegram.ts — canonical CXSwitch alerts
import { CXSWITCH_VERSION } from "./version";

export async function sendAlert(signal:any){
  const token=process.env.TELEGRAM_BOT_TOKEN,chatId=process.env.TELEGRAM_CHAT_ID;
  if(!token||!chatId){console.log("[TELEGRAM DISABLED]",signal.symbol,signal.state);return;}
  const type=signal.signalType||signal.state;
  const emoji=signal.signalEmoji||(type==="ENTRY_1"?"🟢":type==="ENTRY_2"?"🟠":type==="ADD"?"🔵":type==="EXIT"?"🔴":"📊");
  const labels:Record<string,string>={ENTRY_1:"ENTRY ①",ENTRY_2:"ENTRY ②",ADD:"ADD",ENTRY:"ENTRY",EXIT:"EXIT"};
  const label=labels[type]||signal.state;
  const dir=signal.bias==="LONG"?"📈":"📉";
  const tp1=signal.takeProfit1??signal.context?.stages?.tp1??"-";
  const tp2=signal.takeProfit2??signal.context?.stages?.tp2??signal.takeProfit??"-";
  const tp3=signal.takeProfit3??signal.context?.stages?.tp3??"-";
  const fourH513=signal.fourH513Label||signal.context?.fourH513?.label||"NEUTRAL";
  const exitPlan=signal.context?.exitPlan;
  const exitText=exitPlan?`\nExit plan: TP1 ${exitPlan.tp1Pct}% | TP2 ${exitPlan.tp2Pct}% | TP3 ${exitPlan.tp3Pct}%\nAfter TP1: ${exitPlan.afterTp1} | After TP2: ${exitPlan.afterTp2}\nRunner: ${exitPlan.runner}\n`:"";
  const text=`${emoji} CX SWITCH v${CXSWITCH_VERSION} — ${label}\n\n${dir} ${signal.symbol} — ${signal.bias}\nPrice: ${signal.price}\n\n4H 5/13: ${fourH513}\n\nTrend: ${signal.trend||signal.bias}\nLocation: ${signal.location||"—"}\nTrigger: ${signal.trigger||"—"}\n\nExpected Move: ${signal.expectedMove??"-"}%\nSL: ${signal.stopLoss??"-"}\nTP1: ${tp1}\nTP2: ${tp2}\nTP3: ${tp3}\nRR: ${signal.rr??"-"}\n${exitText}\nADX: ${signal.adx??"-"}\nRSI: ${signal.rsi??"-"}\nStochK: ${signal.stochK??"-"}\nStochD: ${signal.stochD??"-"}\n\n${signal.reason}\n\nTime: ${signal.updatedAt}`;
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({chat_id:chatId,text})});
}
