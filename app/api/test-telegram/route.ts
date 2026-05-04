import { NextResponse } from "next/server";

export async function POST() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    return NextResponse.json(
      { ok: false, error: "TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not configured" },
      { status: 400 }
    );
  }

  const text =
    "Signal Dashboard v1.0.0 — Test message. Your Telegram alerts are configured correctly.";

  try {
    const res = await fetch(
      `https://api.telegram.org/bot${token}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text }),
      }
    );
    const json = await res.json();
    if (!json.ok) {
      return NextResponse.json(
        { ok: false, error: json.description ?? "Telegram API error" },
        { status: 500 }
      );
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
