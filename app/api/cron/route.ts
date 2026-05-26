import { NextResponse } from "next/server";
import { SYMBOLS, createSignal } from "@/lib/strategy-core";
import { getTelegramCooldown, setTelegramCooldown, healthCheck, getHoldState, getSignalEvents, clearSignalEvents } from "@/lib/persistent-store";
import { sendSignalAlert } from "@/lib/telegram";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const TELEGRAM_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes between alerts per symbol

/**
 * CRON EXECUTOR - Event-Driven Alert System
 * 
 * Architecture:
 * 1. Compute live strategy for all symbols (state machine with hold rules)
 * 2. Signal Event Layer emits events on state transitions
 * 3. This cron consumes SIGNAL_ENTERED_SNIPER events (not polling state)
 * 4. Alert fires ONCE per SNIPER entry, with cooldown protection
 * 
 * Key Benefits:
 * - No missed SNIPER alerts (event-driven, not polling-based)
 * - No duplicate alerts (one event per transition)
 * - No flickering SNIPER states affecting alerts
 * - Reliable across restarts and deploys
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

    console.log("[CRON] Starting execution cycle (live computation + event-driven alerts)");
    const results: any[] = [];
    const now = Date.now();

    // STEP 1: Compute live strategy for all symbols
    for (const symbol of SYMBOLS) {
      const signal = await createSignal(symbol);
      
      console.log(`[CRON] ${symbol}: state=${signal.state}, hold_remaining=${signal.hold_remaining_ms}ms`);
      
      if (signal.state === "SNIPER" && signal.direction) {
        console.log(`  SNIPER: ${signal.direction} @ ${signal.price}`);
        console.log(`  Entry: ${signal.entry} | SL: ${signal.stopLoss} | TP: ${signal.takeProfit}`);
        console.log(`  RR: ${signal.riskReward} | Confidence: ${signal.confidence}%`);
      }
      
      results.push({
        symbol,
        state: signal.state,
        price: signal.price,
        hold_remaining_ms: signal.hold_remaining_ms,
        ...(signal.state === "SNIPER" && signal.direction ? {
          direction: signal.direction,
          entry: signal.entry,
          stopLoss: signal.stopLoss,
          takeProfit: signal.takeProfit,
          riskReward: signal.riskReward,
          confidence: signal.confidence,
        } : {}),
      });
    }

    // STEP 2: Consume Signal Events (EVENT-DRIVEN ALERTS)
    const events = await getSignalEvents();
    console.log(`[EVENT_LOOP] Processing ${events.length} signal events...`);
    
    let alertsSent = 0;
    for (const event of events) {
      // CRITICAL: Only fire alert on SIGNAL_ENTERED_SNIPER event
      if (event.type === "SIGNAL_ENTERED_SNIPER") {
        console.log(`[EVENT] Processing SNIPER entry for ${event.symbol}`);
        
        // Get current signal to send alert with latest data
        const signal = await createSignal(event.symbol);
        
        if (signal.state === "SNIPER" && signal.direction) {
          // Check cooldown (prevent alert spam)
          const lastAlertTime = await getTelegramCooldown(event.symbol);
          
          if (now - lastAlertTime >= TELEGRAM_COOLDOWN_MS) {
            console.log(`[EVENT_ALERT] ✓ Sending Telegram alert for ${event.symbol} SNIPER entry`);
            await sendSignalAlert(signal);
            await setTelegramCooldown(event.symbol, now);
            alertsSent++;
          } else {
            const timeRemaining = Math.ceil((TELEGRAM_COOLDOWN_MS - (now - lastAlertTime)) / 1000 / 60);
            console.log(`[EVENT_ALERT] Cooldown active (${timeRemaining}m remaining)`);
          }
        }
      }
    }
    
    // Clear processed events from queue
    if (events.length > 0) {
      await clearSignalEvents(events.length);
      console.log(`[EVENT_LOOP] Cleared ${events.length} processed events`);
    }

    console.log("[CRON SUMMARY]");
    results.forEach((r) => {
      if (r.state === "SNIPER") {
        const holdMs = r.hold_remaining_ms || 0;
        console.log(`${r.symbol} → SNIPER (${r.direction}) $${r.price} [hold: ${holdMs}ms]`);
      } else {
        console.log(`${r.symbol} → ${r.state}`);
      }
    });
    console.log(`[EVENT_SUMMARY] ${alertsSent} Telegram alerts sent from ${events.length} events`);

    return NextResponse.json({
      ok: true,
      message: "Cron cycle complete (live computation + event-driven alerts)",
      results,
      events_processed: events.length,
      alerts_sent: alertsSent,
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


