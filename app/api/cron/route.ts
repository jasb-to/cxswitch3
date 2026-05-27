import { evaluate } from "@/lib/engine";
import { sendTelegramMessage } from "@/app/api/telegram/route";
import { NextResponse } from "next/server";

const CRON_SECRET = process.env.CRON_SECRET;
const MIN_CONFIDENCE = 60;

export const dynamic = "force-dynamic";

function formatAllConditionAlert(signal: any): string {
  const emoji = signal.state === "LONG" ? "🟢" : "🔴";
  return `${emoji} ${signal.symbol} ${signal.state}

Price: $${signal.price?.toLocaleString()}
Confidence: ${signal.confidence}%
4H Bias: ${signal.bias4h}

Layer Status:
1️⃣ ${signal.layer1?.status}
2️⃣ ${signal.layer2?.status}
3️⃣ ${signal.layer3?.status}

Entry: $${signal.entry?.toLocaleString()}
SL: $${signal.stopLoss?.toLocaleString()}
TP: $${signal.takeProfit?.toLocaleString()}
R:R ${signal.riskReward?.toFixed(2)}

⏰ ${new Date().toLocaleTimeString()}`;
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    if (searchParams.get("secret") !== CRON_SECRET) {
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

      // Send Telegram alert ONLY when all 3 layers are met (Layer 3 fired = all conditions aligned)
      if (signal.state !== "FLAT" && signal.layer3?.met && signal.confidence >= 60) {
        const alertText = formatAllConditionAlert(signal);
        const alertSent = await sendTelegramMessage(alertText);
        alerts.push({ symbol: signal.symbol, type: "all_conditions_met", sent: alertSent });
        
        results.push({
          symbol: signal.symbol,
          action: "alert_sent",
          state: signal.state,
          confidence: signal.confidence,
          alertSent,
        });
      } else {
        results.push({
          symbol: signal.symbol,
          action: "skipped",
          reason: signal.state === "FLAT" ? "no signal" : signal.layer3?.met ? "low confidence" : "layers not complete",
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
