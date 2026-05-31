import { Signal } from "./strategy";

function fmt(num: number | null | undefined, dp = 2) {
  if (num === null || num === undefined || Number.isNaN(num)) return "—";
  return num.toFixed(dp);
}

function getState(signal: Signal) {
  if (signal.isSniper) return "SNIPER";
  if (signal.isSetupValid) return "SETUP";
  if (signal.adx > 18 && signal.bias !== "Neutral") return "EARLY";
  return "WAIT";
}

export async function sendTelegramAlert(signal: Signal) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!botToken || !chatId) {
    console.log("[TELEGRAM] Missing credentials - alert not sent");
    return false;
  }

  const state = getState(signal);

  // Only send meaningful events (not noise)
  if (state === "WAIT") {
    console.log("[TELEGRAM] Skipping WAIT state");
    return false;
  }

  const emoji =
    state === "SNIPER"
      ? signal.bias === "Bullish"
        ? "🟢 SNIPER LONG"
        : "🔴 SNIPER SHORT"
      : state === "SETUP"
      ? "🟡 SETUP"
      : "🟣 EARLY SIGNAL";

  const message =
`${emoji}

${signal.symbol} — $${fmt(signal.price)}

State: ${state}
Bias: ${signal.bias}
Confidence: ${signal.confidence}%

Risk:
Stop Loss: $${fmt(signal.stopLoss)}
Take Profit: $${fmt(signal.takeProfit)}
R/R: ${fmt(signal.riskRewardRatio)}

Indicators:
ADX: ${fmt(signal.adx, 1)}
Stoch K: ${fmt(signal.stochK, 1)}
Stoch D: ${fmt(signal.stochD, 1)}

Time: ${new Date().toLocaleTimeString()}`;

  try {
    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
      }),
    });

    if (!response.ok) {
      console.error(`[TELEGRAM] Failed: HTTP ${response.status}`);
      return false;
    }

    console.log(`[TELEGRAM] Sent ${state} alert for ${signal.symbol}`);
    return true;
  } catch (err) {
    console.error("[TELEGRAM] Error:", err);
    return false;
  }
}

export async function sendTestAlert() {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!botToken || !chatId) {
    return { success: false, message: "Missing Telegram credentials" };
  }

  const message =
`✅ CX Switch Test

Telegram integration working
Time: ${new Date().toLocaleString()}`;

  try {
    const response = await fetch(
      `https://api.telegram.org/bot${botToken}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: message,
        }),
      }
    );

    if (!response.ok) {
      return {
        success: false,
        message: `Telegram error ${response.status}`,
      };
    }

    return { success: true, message: "Test alert sent" };
  } catch (err) {
    return { success: false, message: String(err) };
  }
}
