// lib/telegram.ts — v16.4
export async function sendAlert(signal: any) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.log("[TELEGRAM DISABLED]", signal);
    return;
  }
  const scale = signal.scale || signal.state?.split(" ")[1] || null;
  const minConfidence = scale === "ENTRY_1" ? 50 : 55;
  if (signal.confidence < minConfidence) {
    console.log(`[TELEGRAM SKIP: LOW CONFIDENCE] ${signal.symbol || signal.pair} ${signal.confidence} (need ${minConfidence})`);
    return;
  }
  const dirEmoji = signal.bias === "LONG" ? "🟢" : "🔴";
  const confColor = signal.confidence >= 85 ? "🟢" : signal.confidence >= 70 ? "🟡" : "🟠";
  const text = `${dirEmoji} ${signal.symbol || signal.pair} ${signal.bias || signal.direction} ${signal.state || signal.type} — ${confColor} ${signal.confidence}%
Entry: ${signal.price || signal.entry} | Stop: ${signal.stopLoss || signal.stop} | Target: ${signal.takeProfit || signal.target}
RR ${signal.rr} | ${signal.reason}`;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
    });
    const data = await res.json();
    if (!data.ok) console.error("[TELEGRAM ERROR]", data);
    else console.log(`[TELEGRAM SENT] ${signal.symbol || signal.pair} ${signal.confidence}%`);
  } catch (err) {
    console.error("[TELEGRAM SEND FAILED]", err);
  }
}

export async function sendUIAlert(alert: any) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) { console.log("[TELEGRAM UI DISABLED]", alert); return; }
  const isShort = alert.type === "SHORT_ALERT_OVERSOLD_CROSS";
  const text = `${isShort ? "↗️" : "↘️"} ${alert.pair} — ${isShort ? "Potential Bounce" : "Potential Pullback"}
${alert.message}
Stoch K=${alert.stochK.toFixed(1)} D=${alert.stochD.toFixed(1)}
<i>UI warning only — not a trading signal</i>`;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
    });
  } catch (err) {
    console.error("[TELEGRAM UI SEND FAILED]", err);
  }
}
