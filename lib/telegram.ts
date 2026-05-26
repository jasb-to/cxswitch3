import type { Signal } from "@/lib/strategy-core";
import { getTelegramCooldown, setTelegramCooldown } from "@/lib/persistent-store";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

/**
 * Send a test message to verify the bot is configured correctly.
 */
export async function sendTestMessage(): Promise<{ ok: boolean; error?: string }> {
  if (!BOT_TOKEN || !CHAT_ID) {
    return { ok: false, error: "TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set" };
  }

  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: CHAT_ID,
      text: "✅ Signal dashboard connected. Telegram alerts are working.",
    }),
  });

  const json = await res.json();
  if (!json.ok) return { ok: false, error: json.description ?? "Unknown error" };
  return { ok: true };
}

/**
 * Send a SNIPER signal alert with trade details
 * IMPORTANT: Cooldown is handled by cron route, not here
 * This function assumes cooldown has already been checked
 */
export async function sendSignalAlert(signal: Signal): Promise<{ ok: boolean; error?: string }> {
  if (!BOT_TOKEN || !CHAT_ID) {
    console.warn("[TELEGRAM] Bot not configured");
    return { ok: false, error: "TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set" };
  }

  if (signal.state !== "SNIPER" || !signal.direction) {
    return { ok: false, error: "Not a SNIPER signal" };
  }

  // Build alert message
  const confidenceEmoji = signal.confidence >= 75 ? "🔥" : signal.confidence >= 55 ? "⚠️" : "❄️";
  const message = `🚨 SNIPER SIGNAL

${signal.symbol}/USDT
${signal.direction === "LONG" ? "📈" : "📉"} ${signal.direction}

Price: $${signal.price?.toFixed(2)}
Entry: $${signal.entry?.toFixed(2)}
SL: $${signal.stopLoss?.toFixed(2)}
TP: $${signal.takeProfit?.toFixed(2)}
RR: ${signal.riskReward?.toFixed(2)}

${confidenceEmoji} Confidence: ${signal.confidence}%
📊 4H: ${signal.bias_4h}
⏱️ 15m: ${signal.structure_15m}`;

  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: CHAT_ID,
        text: message,
        parse_mode: "HTML",
      }),
    });

    const json = await res.json();
    if (!json.ok) {
      console.error(`[TELEGRAM] Alert failed: ${json.description}`);
      return { ok: false, error: json.description };
    }
    
    console.log(`[TELEGRAM] Alert sent for ${signal.symbol} ${signal.direction}`);
    return { ok: true };
  } catch (err) {
    console.error(`[TELEGRAM] Exception:`, err);
    return { ok: false, error: String(err) };
  }
}


