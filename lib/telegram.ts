// lib/telegram.ts — v14 alerts
// ============================================================

export async function sendAlert(signal: any) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    console.log("[TELEGRAM DISABLED]", signal);
    return;
  }

  const isSweep = signal.state === "SWEEP";
  const isEarly = signal.state === "EARLY";
  
  const tierEmoji = isSweep ? "🎯" : isEarly ? "⚡" : "📊";
  const tierLabel = isSweep ? "SWEEP" : isEarly ? "EARLY" : "SETUP";

  const confEmoji = signal.confidence >= 85 ? "🟢" :
                    signal.confidence >= 70 ? "🟡" :
                    signal.confidence >= 55 ? "🟠" : "🔴";

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

ADX: ${signal.adx ?? "-"}
RSI: ${signal.rsi ?? "-"}
StochK: ${signal.stochK ?? "-"}
StochD: ${signal.stochD ?? "-"}

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
