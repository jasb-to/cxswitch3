import { NextResponse } from "next/server";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";

export const dynamic = "force-dynamic";

export function formatAlert(signal: any): string {
  const emoji = signal.state === "LONG" ? "🟢" : signal.state === "SHORT" ? "🔴" : "⚪";
  const dir = signal.state === "LONG" ? "LONG" : signal.state === "SHORT" ? "SHORT" : "FLAT";

  let msg = `${emoji} **${signal.symbol} ${dir}**
`;
  msg += `Price: $${signal.price?.toLocaleString()}
`;
  msg += `Confidence: ${signal.confidence}%
`;
  msg += `4H Bias: ${signal.bias4h}

`;

  msg += `Layer Status:
`;
  msg += `1️⃣ ${signal.layer1?.status || "Waiting"}
`;
  msg += `2️⃣ ${signal.layer2?.status || "Waiting"}
`;
  msg += `3️⃣ ${signal.layer3?.status || "Waiting"}

`;

  if (signal.entry) {
    msg += `Entry: $${signal.entry?.toLocaleString()}
`;
    msg += `SL: $${signal.stopLoss?.toLocaleString()}
`;
    msg += `TP: $${signal.takeProfit?.toLocaleString()}
`;
    msg += `R:R ${signal.riskReward?.toFixed(2)}
`;
  }

  msg += `
⏰ ${new Date().toLocaleTimeString()}`;
  return msg;
}

export async function sendTelegramMessage(text: string): Promise<boolean> {
  if (!BOT_TOKEN || !CHAT_ID) {
    console.error("[TELEGRAM] Missing BOT_TOKEN or CHAT_ID");
    return false;
  }

  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: CHAT_ID,
        text,
        parse_mode: "Markdown",
      }),
    });

    const data = await res.json();
    if (!data.ok) {
      console.error("[TELEGRAM] API error:", data.description);
      return false;
    }

    return true;
  } catch (err: any) {
    console.error("[TELEGRAM] Send failed:", err.message);
    return false;
  }
}

// POST /api/telegram/alert - Send trade alert
export async function POST(req: Request) {
  try {
    const { signal } = await req.json();
    if (!signal) {
      return NextResponse.json({ error: "No signal provided" }, { status: 400 });
    }

    const text = formatAlert(signal);
    const success = await sendTelegramMessage(text);

    return NextResponse.json({ success, text: success ? "Alert sent" : "Failed to send" });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

// GET /api/telegram/test - Send test message
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);

  if (searchParams.get("action") === "test") {
    const text = `🧪 **CXSWITCH Test**

Telegram alerts are working correctly.

⏰ ${new Date().toLocaleTimeString()}`;
    const success = await sendTelegramMessage(text);
    return NextResponse.json({ success, message: success ? "Test sent" : "Failed" });
  }

  return NextResponse.json({ error: "Use ?action=test" }, { status: 400 });
}