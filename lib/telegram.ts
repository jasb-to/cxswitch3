// lib/telegram.ts — v16.2 simplified alerts
// ============================================================
// CHANGELOG:
// v16.2 — Hard 60 confidence floor for ALL signals. No exceptions.

export async function sendAlert(signal: any) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    console.log("[TELEGRAM DISABLED]", signal);
    return;
  }

  // v16.2: Hard 60 floor — no signal below this gets through
  const minConfidence = 60;

  if (signal.confidence < minConfidence) {
    console.log(`[TELEGRAM SKIP: LOW CONFIDENCE] ${signal.symbol || signal.pair} ${signal.confidence} (need ${minConfidence})`);
    return;
  }

  const dirEmoji = signal.bias === "LONG" ? "🟢" : "🔴";
  const confColor = signal.confidence >= 85 ? "🟢" :
                    signal.confidence >= 70 ? "🟡" : "🟠";

  const text = `${dirEmoji} ${signal.symbol || signal.pair} ${signal.bias || signal.direction} ${signal.state || signal.type} — ${confColor} ${signal.confidence}%
Entry: ${signal.price || signal.entry} | Stop: ${signal.stopLoss || signal.stop} | Target: ${signal.takeProfit || signal.target}
RR ${signal.rr} | ${signal.reason}`;

  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "HTML",
    }),
  });
}
