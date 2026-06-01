const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN!;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID!;

export async function sendTelegram(message: string) {
  if (!BOT_TOKEN || !CHAT_ID) {
    console.error("[TELEGRAM] Missing env vars");
    return;
  }

  try {
    const res = await fetch(
      `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          chat_id: CHAT_ID,
          text: message,
          parse_mode: "HTML",
        }),
      }
    );

    const json = await res.json();

    if (!json.ok) {
      console.error("[TELEGRAM ERROR]", json);
    } else {
      console.log("[TELEGRAM SENT]", message);
    }
  } catch (err) {
    console.error("[TELEGRAM FAILED]", err);
  }
}
