import { evaluate } from "@/lib/engine";
import { sendTelegramMessage } from "@/app/api/telegram/route";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

function formatSignalAlert(signal: any): string {
  const emoji = signal.layer1.trend === "Bullish" ? "🟢" : "🔴";
  const direction = signal.layer1.trend;
  
  return `${emoji} ${signal.symbol} ${direction.toUpperCase()} — $${signal.price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
1H Signal Confirmed | 4H ${direction} Filter
Entry: $${signal.entry?.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} | SL: $${signal.stopLoss?.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} | TP: $${signal.takeProfit?.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} | R:R ${signal.riskReward?.toFixed(1)}
Hold: ${signal.holdDuration} | Time stop: 4h
⏰ ${new Date().toLocaleTimeString()}`;
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const secret = searchParams.get("secret");
    
    if (secret !== process.env.CRON_SECRET) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    console.log("[CRON] Starting 5min evaluation cycle...");

    const signals = await Promise.all([
      evaluate("BTC"),
      evaluate("ETH"),
      evaluate("SOL"),
    ]);

    const results = [];
    const alerts = [];

    for (const signal of signals) {
      console.log(`[CRON] ${signal.symbol}: state=${signal.state}, confidence=${signal.confidence}%`);

      // Send alert only for SNIPER signals
      if (signal.state === "SNIPER" && signal.confidence >= 85) {
        const alertText = formatSignalAlert(signal);
        await sendTelegramMessage(alertText);
        alerts.push({ symbol: signal.symbol, type: "sniper", sent: true });
        results.push({
          symbol: signal.symbol,
          action: "sniper_alert",
          state: signal.state,
          confidence: signal.confidence,
        });
      } else {
        results.push({
          symbol: signal.symbol,
          action: "monitoring",
          state: signal.state,
          confidence: signal.confidence,
        });
      }
    }

    console.log(`[CRON] Cycle complete: ${alerts.length} SNIPER alerts sent`);

    return NextResponse.json({ results, alerts, timestamp: Date.now() });

  } catch (err: any) {
    console.error("[CRON] Fatal error:", err);
    return NextResponse.json({ error: err.message }, { status: 200 });
  }
}
