/**
 * FILE: api/cron/route.ts
 * PURPOSE: Run every 5 minutes, evaluate signals, cache them, send alerts
 */

import {
  evaluateSignal,
  recordAlert,
  recordSentAlert,
  shouldSendAlert,
  detectBiasFlip,
  setCachedSignals,
} from "@/lib/engine";

const CRON_SECRET = process.env.CRON_SECRET || "abc123xyz789";
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

async function sendTelegramAlert(signal: any, isExit = false) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.warn("[CRON] Telegram not configured");
    return;
  }

  let text: string;

  if (isExit) {
    const emoji = signal.newBias === "Bullish" ? "🟢" : "🔴";
    const action = signal.oldBias === "Bullish" ? "LONG" : "SHORT";
    text = `🚨 ${emoji} ${signal.symbol} FLIPPED ${signal.newBias.toUpperCase()}

📉 Exit your ${action} position NOW
Price: $${signal.price.toLocaleString(undefined, { minimumFractionDigits: 2 })}
Old bias: ${signal.oldBias} → New bias: ${signal.newBias}
⏰ ${new Date().toLocaleTimeString()}`;
  } else {
    const emoji = signal.direction === "LONG" ? "🟢" : "🔴";
    const quality =
      signal.dataQuality && signal.dataQuality !== "OHLC"
        ? ` [${signal.dataQuality}]`
        : "";
    const typeTag = signal.tradeType === "Counter Trend" ? " ⚡COUNTER" : "";
    const stochInfo =
      signal.stochRSI != null ? ` | Stoch: ${signal.stochRSI.toFixed(0)}` : "";
    const peakInfo = signal.stochRSIPeak
      ? ` ↘ Peak: ${signal.stochRSIPeak.peakValue} (‑${signal.stochRSIPeak.dropFromPeak})`
      : signal.stochRSITrough
        ? ` ↗ Trough: ${signal.stochRSITrough.troughValue} (+${signal.stochRSITrough.riseFromTrough})`
        : "";
    const dirInfo = ` | ${signal.stochRSIDirection}`;

    text = `${emoji}${typeTag} ${signal.symbol} ${signal.direction}${quality} — $${signal.price.toFixed(2)}
${signal.tradeType} | 24h: ${signal.change24h > 0 ? "+" : ""}${signal.change24h.toFixed(2)}% | Bias: ${signal.bias}${stochInfo}${peakInfo}${dirInfo}
Entry: $${signal.entry?.toFixed(2)} | SL: $${signal.stopLoss?.toFixed(2)} | TP: $${signal.takeProfit?.toFixed(2)}
⏰ ${new Date().toLocaleTimeString()}`;
  }

  try {
    await fetch(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: TELEGRAM_CHAT_ID,
          text,
          parse_mode: "HTML",
        }),
      }
    );
    console.log(
      isExit ? `[CRON] 🚨 Exit alert sent:` : `[CRON] ✅ Entry alert sent:`,
      signal.symbol
    );
  } catch (err) {
    console.error("[CRON] ❌ Telegram failed:", err);
  }
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);

  if (searchParams.get("secret") !== CRON_SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }

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
      stochRSI: 15,
      stochRSIState: "Oversold",
      stochRSIPeak: null,
      stochRSITrough: { troughValue: 12, riseFromTrough: 3 },
      stochRSIDirection: "rising",
      tradeType: "With Trend",
      updatedAt: new Date().toISOString(),
    };
    await sendTelegramAlert(testSignal);
    return Response.json({
      test: true,
      message: "Test alert sent",
      signal: testSignal,
      timestamp: Date.now(),
    });
  }

  console.log("[CRON] ═══════════════════════════════════════════");
  console.log("[CRON] Starting evaluation cycle —", new Date().toISOString());
  console.log("[CRON] ═══════════════════════════════════════════");

  try {
    const signals = await Promise.all([
      evaluateSignal("BTC"),
      evaluateSignal("ETH"),
      evaluateSignal("SOL"),
    ]);

    setCachedSignals(signals);

    let alertsSent = 0;
    let exitAlertsSent = 0;

    for (const signal of signals) {
      const flip = detectBiasFlip(signal.symbol, signal.bias, signal.price);
      if (flip.flipped) {
        console.log(
          `[CRON] 🔄 ${signal.symbol} BIAS FLIP: ${flip.oldBias} → ${flip.newBias}`
        );
        await sendTelegramAlert(
          {
            symbol: signal.symbol,
            price: signal.price,
            oldBias: flip.oldBias,
            newBias: flip.newBias,
          },
          true
        );
        exitAlertsSent++;
      }

      console.log("");
      console.log(
        `[CRON] ┌── ${signal.symbol} ───────────────────────────────`
      );
      console.log(
        `[CRON] │ Price:        $${signal.price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
      );
      console.log(
        `[CRON] │ 24h Change:   ${signal.change24h > 0 ? "+" : ""}${signal.change24h.toFixed(3)}%`
      );
      console.log(`[CRON] │ 4H Bias:      ${signal.bias}`);
      console.log(`[CRON] │ State:        ${signal.state}`);
      console.log(
        `[CRON] │ Direction:    ${signal.direction || "—"}`
      );
      console.log(`[CRON] │ Trade Type:   ${signal.tradeType}`);
      console.log(`[CRON] │ Trigger:      ${signal.trigger}`);
      console.log(`[CRON] │ Momentum:     ${signal.momentum}`);
      console.log(
        `[CRON] │ StochRSI:     ${signal.stochRSI?.toFixed(0)} (${signal.stochRSIState})`
      );
      if (signal.stochRSIPeak) {
        console.log(
          `[CRON] │ Stoch Peak:   ${signal.stochRSIPeak.peakValue} ↘ ‑${signal.stochRSIPeak.dropFromPeak}`
        );
      }
      if (signal.stochRSITrough) {
        console.log(
          `[CRON] │ Stoch Trough: ${signal.stochRSITrough.troughValue} ↗ +${signal.stochRSITrough.riseFromTrough}`
        );
      }
      console.log(
        `[CRON] │ Stoch Dir:    ${signal.stochRSIDirection}`
      );
      console.log(`[CRON] │ Confidence:   ${signal.confidence}%`);
      console.log(
        `[CRON] │ Data Quality: ${signal.dataQuality || "OHLC"}`
      );
      console.log(`[CRON] │ Should Alert: ${signal.shouldAlert}`);

      if (signal.state === "SNIPER") {
        console.log(`[CRON] │ Entry:        $${signal.entry?.toFixed(2)}`);
        console.log(`[CRON] │ SL:           $${signal.stopLoss?.toFixed(2)}`);
        console.log(`[CRON] │ TP:           $${signal.takeProfit?.toFixed(2)}`);
        console.log(`[CRON] │ R:R:          ${signal.riskReward?.toFixed(2)}:1`);
      }
      console.log(
        `[CRON] └── Decision:   ${signal.state === "SNIPER" && signal.shouldAlert ? "🚨 SEND ALERT" : signal.state === "SNIPER" ? "⏳ SUPPRESSED" : "👁️ WATCHING"}`
      );

      if (signal.state === "SNIPER" && signal.shouldAlert) {
        // Check if this is a new/unique alert (prevent spam)
        if (shouldSendAlert(signal.symbol, signal.direction, signal.entry)) {
          await sendTelegramAlert(signal);
          recordSentAlert(signal.symbol, signal.direction!, signal.entry!);
          alertsSent++;
        } else {
          console.log(
            `[CRON] ⏸️  Alert suppressed (spam prevention): ${signal.symbol} ${signal.direction}`
          );
        }
      }
    }

    console.log("");
    console.log("[CRON] ═══════════════════════════════════════════");
    console.log(
      `[CRON] Cycle complete: ${alertsSent} entry, ${exitAlertsSent} exit alerts sent`
    );
    console.log("[CRON] ═══════════════════════════════════════════");

    return Response.json({
      signals,
      alertsSent,
      exitAlertsSent,
      timestamp: Date.now(),
    });
  } catch (err: any) {
    console.error("[CRON] ❌ Failed:", err);
    return Response.json({ error: err.message }, { status: 500 });
  }
}
