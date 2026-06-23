// lib/telegram.ts — v16 simplified alerts
// ============================================================

export async function sendAlert(signal: any) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    console.log("[TELEGRAM DISABLED]", signal);
    return;
  }

  // Skip low confidence (same threshold as before)
  if (signal.confidence < 60) {
    console.log("[TELEGRAM SKIP: LOW CONFIDENCE]", signal.symbol, signal.confidence);
    return;
  }

  const dirEmoji = signal.bias === "LONG" ? "🟢" : "🔴";
  const confColor = signal.confidence >= 85 ? "🟢" :
                    signal.confidence >= 70 ? "🟡" :
                    signal.confidence >= 55 ? "🟠" : "🔴";

  const text = `${dirEmoji} ${signal.symbol} ${signal.bias} ${signal.state} — ${confColor} ${signal.confidence}%
Entry: ${signal.price} | Stop: ${signal.stopLoss} | Target: ${signal.takeProfit}
RR ${signal.rr} | ${signal.reason}`;

  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "HTML",  // optional: enables bold/italic if you want later
    }),
  });
}
