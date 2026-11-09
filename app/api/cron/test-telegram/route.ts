import { NextResponse } from "next/server";
import { sendAlert } from "@/lib/telegram";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const ALERT_TYPES = ["ENTRY_1", "ENTRY_2", "ADD"] as const;

export async function GET(request: Request) {
  const url = new URL(request.url);
  const secret = url.searchParams.get("secret");
  const auth = request.headers.get("authorization");
  if (!process.env.CRON_SECRET ||
      (secret !== process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const requestedType = url.searchParams.get("type") ?? "all";
  const types = requestedType === "all"
    ? [...ALERT_TYPES]
    : ALERT_TYPES.includes(requestedType as typeof ALERT_TYPES[number])
      ? [requestedType as typeof ALERT_TYPES[number]]
      : null;
  if (!types) {
    return NextResponse.json({ error: "type must be ENTRY_1, ENTRY_2, ADD, or all" }, { status: 400 });
  }

  const results: Array<{ type: string; ok: boolean; messageId?: number; error?: string }> = [];
  for (const type of types) {
    try {
      const delivery = await sendAlert({
        symbol: "TEST-ONLY",
        state: "ENTRY",
        signalType: type,
        signalEmoji: "🧪",
        testOnly: true,
        bias: "LONG",
        price: 100,
        stopLoss: 95,
        takeProfit: 110,
        takeProfit1: 110,
        takeProfit2: 110,
        rr: 2,
        sizeMultiplier: 0.1,
        reason: "TEST ONLY — NOT A TRADING SIGNAL",
      });
      results.push({ type, ok: true, messageId: delivery.messageId });
    } catch (error) {
      results.push({ type, ok: false, error: String(error) });
    }
  }

  const ok = results.length === types.length && results.every(result => result.ok);
  return NextResponse.json({ ok, testOnly: true, results }, { status: ok ? 200 : 502 });
}
