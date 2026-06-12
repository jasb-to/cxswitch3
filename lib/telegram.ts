// lib/telegram-v14.ts
// Clean alerts for v14 strategy
// ============================================================

export async function sendAlert(signal: any) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    console.log("[TELEGRAM DISABLED]", signal);
    return;
  }

  // Signal tier
  const isSweep = signal.state === "SWEEP";
  const isFVG = signal.state === "FVG";

  const tierEmoji = isSweep ? "🎯" : isFVG ? "⚡" : "📊";
  const tierLabel = isSweep ? "SWEEP" : isFVG ? "EARLY" : "SETUP";

  // Color-code confidence
  const confEmoji = signal.confidence >= 85 ? "🟢" :
                    signal.confidence >= 70 ? "🟡" :
                    signal.confidence >= 55 ? "🟠" : "🔴";

  // Hard floor — only alert on quality
  if (signal.confidence < 60) {
    console.log("[TELEGRAM SKIP: LOW CONFIDENCE]", signal.symbol, signal.confidence);
    return;
  }

  const text = `
${tierEmoji} CX SWITCH — ${tierLabel}

${signal.symbol} — ${signal.state}
Price: ${signal.price}

Bias: ${signal.bias}
${confEmoji} Confidence: ${signal.confidence}%

Expected Move: ${signal.expectedMove}%

SL: ${signal.stopLoss ?? "-"}
TP: ${signal.takeProfit ?? "-"}
RR: ${signal.rr ?? "-"}

${signal.reason}

Time: ${signal.updatedAt}
`;

  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
    }),
  });
}
