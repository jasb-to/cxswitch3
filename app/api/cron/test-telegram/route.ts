import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const secret = url.searchParams.get("secret");
  const auth = request.headers.get("authorization");
  if (secret !== process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    return NextResponse.json({ ok: false, error: "Telegram environment variables are missing" }, { status: 500 });
  }

  const text = `🧪 CX SWITCH — Telegram delivery test\n\nThis is a delivery/credential test only.\nNo trading signal or history entry was created.\nTime: ${new Date().toISOString()}`;
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
    cache: "no-store",
  });

  const body = await response.text().catch(() => "");
  if (!response.ok) {
    return NextResponse.json({ ok: false, telegramStatus: response.status, telegramResponse: body.slice(0, 500) }, { status: 502 });
  }

  return NextResponse.json({ ok: true, telegramStatus: response.status, telegramResponse: body.slice(0, 500) });
}
