// lib/telegram.ts — v16.1 simplified alerts
// ============================================================
// CHANGELOG:
// v16.1 — Lower confidence threshold for ACCUMULATE signals (50 vs 60)
//         ACCUMULATE = position-building, needs visibility even at lower confidence
//         BREAKOUT/ADD = high-conviction, keep 60 gate

export async function sendAlert(signal: any) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    console.log("[TELEGRAM DISABLED]", signal);
    return;
  }

  // v16.1: ACCUMULATE signals need visibility for position-building
  const isAccumulate = signal.type === "ACCUMULATE";
  const minConfidence = isAccumulate ? 50 : 60;

  if (signal.confidence < minConfidence) {
    console.log(`[TELEGRAM SKIP: LOW CONFIDENCE] ${signal.symbol || signal.pair} ${signal.confidence} (need ${minConfidence} for ${isAccumulate ? "ACCUMULATE" : "BREAKOUT"})`);
    return;
  }

  const dirEmoji = signal.bias === "LONG" ? "🟢" : "🔴";
  const confColor = signal.confidence >= 85 ? "🟢" :
                    signal.confidence >= 70 ? "🟡" :
                    signal.confidence >= 55 ? "🟠" : "🔴";

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
