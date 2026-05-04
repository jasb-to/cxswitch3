import type { Signal } from "./strategy";

function fmt(n: number): string {
  if (n >= 1000) return `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
  return `$${n.toFixed(2)}`;
}

export async function sendTelegramAlert(signal: Signal): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    console.log("[v0] Telegram not configured, skipping alert");
    return;
  }

  const text =
    `${signal.symbol}/USD ${signal.direction} ${signal.state} — ` +
    `Entry ${fmt(signal.entry)}, SL ${fmt(signal.sl)}, TP ${fmt(signal.tp)}, ` +
    `Confidence ${signal.confidence}%`;

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
    console.log("[v0] Telegram alert sent:", text);
  } catch (err) {
    console.error("[v0] Telegram send failed:", err);
  }
}
