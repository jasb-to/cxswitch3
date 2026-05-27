import { evaluate } from "@/lib/engine";
import { placeOrder } from "@/lib/kraken";
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

function formatTradeExecutedAlert(signal: any, txid: string): string {
  const emoji = signal.state === "LONG" ? "🟢" : "🔴";
  return `${emoji} TRADE EXECUTED: ${signal.symbol} ${signal.state}

Entry: $${signal.entry?.toLocaleString()}
SL: $${signal.stopLoss?.toLocaleString()}
TP: $${signal.takeProfit?.toLocaleString()}
R:R ${signal.riskReward?.toFixed(2)}
Confidence: ${signal.confidence}%

TxID: ${txid}
⏰ ${new Date().toLocaleTimeString()}`;
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    if (searchParams.get("secret") !== CRON_SECRET) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    console.log("[CRON] Starting execution cycle...");

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
      }

      if (signal.state === "FLAT" || signal.confidence < MIN_CONFIDENCE) {
        results.push({
          symbol: signal.symbol,
          action: "skipped",
          reason: signal.state === "FLAT" ? "no signal" : `confidence ${signal.confidence}% < ${MIN_CONFIDENCE}%`,
        });
        continue;
      }

      try {
        const pair = signal.symbol === "BTC" ? "XXBTZUSD" : signal.symbol === "ETH" ? "XETHZUSD" : "SOLUSD";
        const volume = signal.symbol === "BTC" ? "0.001" : signal.symbol === "ETH" ? "0.01" : "0.1";

        console.log(`[CRON] Executing ${signal.state} on ${signal.symbol} at ${signal.entry}`);

        const order = await placeOrder({
          pair,
          type: signal.state === "LONG" ? "buy" : "sell",
          ordertype: "market",
          volume,
        });

        // Send trade execution alert
        const tradeAlert = formatTradeExecutedAlert(signal, order.txid);
        const tradeAlertSent = await sendTelegramMessage(tradeAlert);

        results.push({
          symbol: signal.symbol,
          action: "executed",
          direction: signal.state,
          entry: signal.entry,
          txid: order.txid,
          alertSent: tradeAlertSent,
        });

      } catch (err: any) {
        console.error(`[CRON] Trade failed for ${signal.symbol}:`, err.message);
        results.push({
          symbol: signal.symbol,
          action: "failed",
          error: err.message,
        });
      }
    }

    console.log(`[CRON] Cycle complete: ${results.filter(r => r.action === "executed").length} trades, ${alerts.length} alerts`);

    return NextResponse.json({ results, alerts, timestamp: Date.now() });

  } catch (err: any) {
    console.error("[CRON] Fatal error:", err);
    return NextResponse.json({ error: err.message }, { status: 200 });
  }
}
