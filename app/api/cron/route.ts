/**
 * FILE: api/cron/route.ts
 * PURPOSE: Run every 5 minutes, evaluate signals, send Telegram alerts
 * WHY: Uses shouldAlert to prevent spam, recordAlert to track sent alerts
 * TEST MODE: ?test=true sends a test alert without evaluating real signals
 */

import { evaluateSignal, recordAlert } from "@/lib/engine";

const CRON_SECRET = process.env.CRON_SECRET || "abc123xyz789";
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

async function sendTelegramAlert(signal: any) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.warn("[CRON] Telegram not configured");
    return;
  }

  const emoji = signal.direction === "LONG" ? "🟢" : "🔴";
  const text = `${emoji} ${signal.symbol} ${signal.direction} — $${signal.price.toFixed(2)}
24h: ${signal.change24h > 0 ? "+" : ""}${signal.change24h.toFixed(2)}% | Bias: ${signal.bias} | Momentum: ${signal.momentum}
Entry: $${signal.entry?.toFixed(2)} | SL: $${signal.stopLoss?.toFixed(2)} | TP: $${signal.takeProfit?.toFixed(2)}
⏰ ${new Date().toLocaleTimeString()}`;

  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text,
        parse_mode: "HTML",
      }),
    });
    console.log("[CRON] ✅ Alert sent:", signal.symbol, signal.direction);
  } catch (err) {
    console.error("[CRON] ❌ Telegram failed:", err);
  }
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);

  if (searchParams.get("secret") !== CRON_SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }

  // TEST MODE: Send a test alert without evaluating real signals
  const isTest = searchParams.get("test") === "true";

  if (isTest) {
    console.log("[CRON] 🧪 Test mode activated");

    const testSignal = {
      symbol: "TEST",
      price: 100000,
      change24h: 5.0,
      bias: "Bullish",
      state: "SNIPER",
      direction: "LONG",
      confidence: 95,
      trigger: "Test",
      momentum: "Accelerating",
      shouldAlert: true,
      entry: 100000,
      stopLoss: 97500,
      takeProfit: 105000,
      riskReward: 2.0,
      updatedAt: new Date().toISOString()
    };

    await sendTelegramAlert(testSignal);

    return Response.json({ 
      test: true, 
      message: "Test alert sent to Telegram",
      signal: testSignal,
      timestamp: Date.now() 
    });
  }

  // NORMAL MODE: Evaluate real signals
  try {
    const signals = await Promise.all([
      evaluateSignal("BTC"),
      evaluateSignal("ETH"),
      evaluateSignal("SOL"),
    ]);

    let alertsSent = 0;

    for (const signal of signals) {
      console.log(`[CRON] ${signal.symbol}: ${signal.state}, momentum=${signal.momentum}, shouldAlert=${signal.shouldAlert}`);

      // ONLY send alert if shouldAlert is true (prevents spam)
      if (signal.state === "SNIPER" && signal.shouldAlert) {
        await sendTelegramAlert(signal);
        recordAlert(signal.symbol, signal.direction!, signal.price);
        alertsSent++;
      }
    }

    console.log(`[CRON] Cycle complete: ${alertsSent} alerts sent`);
    return Response.json({ signals, alertsSent, timestamp: Date.now() });

  } catch (err) {
    console.error("[CRON] Failed:", err);
    return Response.json({ error: err.message }, { status: 500 });
  }
}
