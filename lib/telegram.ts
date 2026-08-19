// lib/telegram.ts — v57 CXSwitch alerts

export async function sendAlert(signal:any){
  const token=process.env.TELEGRAM_BOT_TOKEN,chatId=process.env.TELEGRAM_CHAT_ID;
  if(!token||!chatId){console.log("[TELEGRAM DISABLED]",signal.symbol,signal.state);return;}
  const type=signal.signalType||signal.state;
  const emoji=signal.signalEmoji||(type==="ENTRY_1"?"🟢":type==="ENTRY_2"?"🟠":type==="ADD"?"🔵":type==="EXIT"?"🔴":"📊");
  const labels:Record<string,string>={ENTRY_1:"ENTRY ①",ENTRY_2:"ENTRY ②",ADD:"ADD",ENTRY:"ENTRY",EXIT:"EXIT"};
  const label=labels[type]||signal.state;
  const dir=signal.bias==="LONG"?"📈":"📉";
  const text=`${emoji} CX SWITCH v57 — ${label}\n\n${dir} ${signal.symbol} — ${signal.bias}\nPrice: ${signal.price}\n\nTrend: ${signal.trend||signal.bias}\nLocation: ${signal.location||"—"}\nTrigger: ${signal.trigger||"—"}\n\nExpected Move: ${signal.expectedMove??"-"}%\nSL: ${signal.stopLoss??"-"}\nTP: ${signal.takeProfit??"-"}\nRR: ${signal.rr??"-"}\n\nADX: ${signal.adx??"-"}\nRSI: ${signal.rsi??"-"}\nStochK: ${signal.stochK??"-"}\nStochD: ${signal.stochD??"-"}\n\n${signal.reason}\n\nTime: ${signal.updatedAt}`;
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({chat_id:chatId,text})});
}
