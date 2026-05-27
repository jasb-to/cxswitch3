import { evaluate } from "@/lib/engine";
import { sendTelegramMessage } from "@/app/api/telegram/route";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

function formatSignalAlert(signal: any): string {
  const emoji = signal.state === "LONG" ? "🟢" : "🔴";
  return `${emoji} ${signal.symbol} ${signal.state}

Price: $${signal.price?.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
Confidence: ${signal.confidence}%
4H Bias: ${signal.bias4h || "Unknown"}

Layer Status:
1️⃣ Bullish Break
2️⃣ Confirmed
3️⃣ Fired

Entry: $${signal.entry?.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
SL: $${signal.stopLoss?.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
TP: $${signal.takeProfit?.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
R:R ${signal.riskReward?.toFixed(2)}

⏰ ${new Date().toLocaleTimeString()}`;
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const secret = searchParams.get("secret");
    
    if (secret !== process.env.CRON_SECRET) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    console.log("[CRON] Starting signal evaluation cycle...");

    const signals = await Promise.all([
      evaluate("BTC"),
      evaluate("ETH"),
      evaluate("SOL"),
    ]);

    const results = [];
    const alerts = [];

    for (const signal of signals) {
      console.log(`[CRON] ${signal.symbol}: state=${signal.state}, confidence=${signal.confidence}%`);

      if (signal.state !== "FLAT" && signal.confidence >= 60) {
        const alertText = formatSignalAlert(signal);
        await sendTelegramMessage(alertText);
        alerts.push({ symbol: signal.symbol, type: "signal", sent: true });
        results.push({
          symbol: signal.symbol,
          action: "alert_sent",
          state: signal.state,
          confidence: signal.confidence,
        });
      } else {
        results.push({
          symbol: signal.symbol,
          action: "skipped",
          reason: signal.state === "FLAT" ? "no_signal" : "low_confidence",
        });
      }
    }

    console.log(`[CRON] Cycle complete: ${alerts.length} alerts sent`);

    return NextResponse.json({ results, alerts, timestamp: Date.now() });

  } catch (err: any) {
    console.error("[CRON] Fatal error:", err);
    return NextResponse.json({ error: err.message }, { status: 200 });
  }
}
