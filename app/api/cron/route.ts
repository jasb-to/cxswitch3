import { evaluate } from "@/lib/engine";
import { sendTelegramMessage } from "@/app/api/telegram/route";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

function formatAlert(signal: any): string {
  if (signal.state !== "SNIPER") return "";
  
  const emoji = signal.direction === "LONG" ? "🟢" : "🔴";
  return `${emoji} ${signal.symbol} ${signal.direction} — $${signal.price?.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
24h: ${signal.change24h?.toFixed(2)}% | Bias: ${signal.bias}
Entry: $${signal.entry?.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} | SL: $${signal.stopLoss?.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} | TP: $${signal.takeProfit?.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
⏰ ${new Date().toLocaleTimeString()}`;
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const secret = searchParams.get("secret");
    
    if (secret !== process.env.CRON_SECRET) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const signals = await Promise.all([
      evaluate("BTC"),
      evaluate("ETH"),
      evaluate("SOL"),
    ]);

    const alerts = [];
    for (const signal of signals) {
      if (signal.state === "SNIPER") {
        const alert = formatAlert(signal);
        if (alert) {
          await sendTelegramMessage(alert);
          alerts.push({ symbol: signal.symbol, sent: true });
        }
      }
    }

    return NextResponse.json({ signals, alerts: alerts.length });
  } catch (err: any) {
    console.error("[CRON] Error:", err.message);
    return NextResponse.json({ error: err.message }, { status: 200 });
  }
}
