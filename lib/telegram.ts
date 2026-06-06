export async function sendAlert(signal: any) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    console.log("[TELEGRAM DISABLED]", signal);
    return;
  }

  // Determine signal tier from the reason string or state
  const isPrimary = signal.reason?.includes("4H_PRIMARY") || 
                    (signal.state === "SNIPER" && signal.confidence >= 75);
  const isCheeky = signal.reason?.includes("1H_CHEEKY");
  
  const tierEmoji = isPrimary ? "🎯" : isCheeky ? "⚡" : "📊";
  const tierLabel = isPrimary ? "PRIMARY" : isCheeky ? "CHEEKY" : "SETUP";

  // Color-code confidence
  const confEmoji = signal.confidence >= 80 ? "🟢" :
                    signal.confidence >= 60 ? "🟡" :
                    signal.confidence >= 40 ? "🟠" : "🔴";

  // Only alert if confidence is worth acting on
  if (signal.confidence < 40) {
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

ADX: ${signal.adx}
RSI: ${signal.rsi}
StochK: ${signal.stochK}
StochD: ${signal.stochD}

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
