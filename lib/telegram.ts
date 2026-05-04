import type { Signal } from "./strategy";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

function fmt(n: number): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * Send a signal alert. Only called on state change TO EARLY or TO CONFIRMED.
 */
export async function sendSignalAlert(signal: Signal): Promise<void> {
  if (!BOT_TOKEN || !CHAT_ID) return;

  const emoji = signal.state === "CONFIRMED" ? "🟢" : "🟡";
  const text =
    `${emoji} ${signal.symbol} ${signal.direction} ${signal.state}\n` +
    `Entry: $${fmt(signal.entry)}\n` +
    `SL: $${fmt(signal.sl)}\n` +
    `TP: $${fmt(signal.tp)}\n` +
    `Confidence: ${signal.confidence}%`;

  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: CHAT_ID, text }),
  });
}

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
