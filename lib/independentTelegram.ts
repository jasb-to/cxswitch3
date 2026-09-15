import { Signal } from "./strategy";

export async function sendIndependentTelegram(signal:Signal){
 const token=process.env.TELEGRAM_BOT_TOKEN||process.env.TELEGRAM_TOKEN;
 const chatId=process.env.TELEGRAM_CHAT_ID||process.env.TELEGRAM_CHAT;
 if(!token||!chatId){console.warn("Independent Telegram skipped: TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID not configured");return false;}
 const source=signal.context?.strategySource||"UNKNOWN";
 const name=signal.context?.strategyName||signal.location||"Independent strategy";
 const text=[`🚨 CXSwitch INDEPENDENT STRATEGY`,`Strategy: ${name}`,`Source: ${source}`,`Asset: ${signal.pair}`,`Direction: ${signal.direction}`,`Entry: ${signal.entry}`,`Stop: ${signal.stop}`,`Target: ${signal.target}`,`R:R: 1:${signal.rr||2}`,`Reason: ${signal.reason}`,`Signal ID: ${signal.id}`].join("\n");
 const r=await fetch(`https://api.telegram.org/bot${token}/sendMessage`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({chat_id:chatId,text})});if(!r.ok)throw new Error(`Telegram HTTP ${r.status}`);return true;
}
