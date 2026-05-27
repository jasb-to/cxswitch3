import { NextResponse } from "next/server";
import { getTelegramCooldown, setTelegramCooldown, healthCheck, getSignalEvents, clearSignalEvents } from "@/lib/persistent-store";
import { sendSignalAlert } from "@/lib/telegram";
import { executeKrakenOrder, checkPosition } from "@/lib/kraken";
import { evaluateSignal } from "@/lib/signal-engine";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const TELEGRAM_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes between alerts per symbol
const SYMBOLS = ["BTC", "ETH", "SOL"];

/**
 * CRON EXECUTOR - Minimal implementation
 * 
 * 1. Evaluate signals for all symbols
 * 2. When SNIPER + confidence >= 60, execute trade on Kraken
 * 3. Send Telegram alerts
 * 4. Log to Supabase
 */
export async function GET() {
  try {
    const isHealthy = await healthCheck();
    if (!isHealthy) {
      console.error("[CRON] Redis health check failed");
      return NextResponse.json(
        { ok: false, error: "Redis not available" },
        { status: 503 }
      );
    }

    console.log("[CRON] Starting execution cycle");
    const now = Date.now();

    // Step 1: Evaluate all signals
    const signals = await Promise.all(SYMBOLS.map(evaluateSignal));
    console.log(`[CRON] Evaluated ${signals.length} signals`);

    let tradeCount = 0;
    let alertCount = 0;

    // Step 2: Check each signal for trade execution
    for (const signal of signals) {
      console.log(`[CRON] ${signal.symbol}: state=${signal.state}, confidence=${signal.confidence}%, direction=${signal.direction || "N/A"}`);

      // Execute trade if SNIPER with confidence >= 60 and direction
      if (signal.state === "SNIPER" && signal.confidence >= 60 && signal.direction) {
        // Check if already have position
        const hasPosition = await checkPosition(signal.symbol);
        if (hasPosition) {
          console.log(`[CRON] ${signal.symbol} already has position, skipping`);
          continue;
        }

        // Map symbol to Kraken pair
        const krakenPairs: Record<string, string> = {
          BTC: "XXBTZUSD",
          ETH: "XETHZUSD",
          SOL: "SOLUSD",
        };

        const minVolumes: Record<string, string> = {
          BTC: "0.001",
          ETH: "0.01",
          SOL: "0.1",
        };

        // Execute market order
        const pair = krakenPairs[signal.symbol];
        const volume = minVolumes[signal.symbol];
        
        console.log(`[CRON] Executing: ${signal.type} ${volume} ${signal.symbol}`);
        const result = await executeKrakenOrder({
          pair,
          type: signal.direction === "LONG" ? "buy" : "sell",
          ordertype: "market",
          volume,
        });

        if (result.ok) {
          tradeCount++;
          console.log(`[CRON] Trade executed: ${result.orderId}`);
          
          // Log to Supabase
          try {
            await fetch("http://localhost:3000/api/log-trade", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                symbol: signal.symbol,
                direction: signal.direction,
                price: signal.entry,
                confidence: signal.confidence,
                orderId: result.orderId,
              }),
            });
          } catch (err) {
            console.warn("[CRON] Could not log trade:", err);
          }
        } else {
          console.error(`[CRON] Trade failed: ${result.error}`);
        }

        // Send Telegram alert
        const lastAlertTime = await getTelegramCooldown(signal.symbol);
        if (now - lastAlertTime >= TELEGRAM_COOLDOWN_MS) {
          await sendSignalAlert(signal);
          await setTelegramCooldown(signal.symbol, now);
          alertCount++;
        }
      }
    }

    // Consume and clear signal events (for historical tracking)
    const events = await getSignalEvents();
    if (events.length > 0) {
      await clearSignalEvents(events.length);
      console.log(`[CRON] Cleared ${events.length} signal events`);
    }

    console.log(`[CRON] Cycle complete: ${tradeCount} trades, ${alertCount} alerts`);

    return NextResponse.json({
      ok: true,
      signals_evaluated: signals.length,
      trades_executed: tradeCount,
      alerts_sent: alertCount,
    });
  } catch (error) {
    console.error("[CRON] Error:", error);
    return NextResponse.json(
      { ok: false, error: String(error) },
      { status: 500 }
    );
  }
}

export async function POST() {
  return NextResponse.json(
    { ok: false, error: "Cron endpoint should only be triggered by Vercel Cron" },
    { status: 403 }
  );
}


