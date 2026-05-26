import { NextResponse } from "next/server";
import { getTelegramCooldown, setTelegramCooldown, healthCheck, getSignalEvents, clearSignalEvents } from "@/lib/persistent-store";
import { sendSignalAlert } from "@/lib/telegram";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const TELEGRAM_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes between alerts per symbol

/**
 * CRON EXECUTOR - Event-Driven Alert System ONLY
 * 
 * CRITICAL: This route MUST NOT compute state.
 * State is computed ONLY in /api/signals
 * 
 * This cron ONLY:
 * 1. Consume SIGNAL_ENTERED_SNIPER events from queue
 * 2. Get latest signal data from /api/signals (read-only snapshot)
 * 3. Send Telegram alerts
 * 4. Clear processed events
 * 
 * Why: Single source of truth prevents state corruption
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

    console.log("[CRON] Starting execution cycle (event-driven alerts only, NO state computation)");
    const now = Date.now();

    // Fetch signal state snapshot from signals API (read-only)
    let allSignals: any[] = [];
    try {
      const res = await fetch("http://localhost:3000/api/signals", {
        cache: "no-store",
        headers: { "x-internal-call": "cron" }
      });
      if (res.ok) {
        allSignals = await res.json();
      }
    } catch (err) {
      console.warn("[CRON] Could not fetch signals snapshot:", err);
    }

    // CRITICAL: Consume Signal Events (EVENT-DRIVEN ALERTS)
    const events = await getSignalEvents();
    console.log(`[EVENT_LOOP] Processing ${events.length} signal events...`);
    
    let alertsSent = 0;
    for (const event of events) {
      // CRITICAL: Only fire alert on SIGNAL_ENTERED_SNIPER event
      if (event.type === "SIGNAL_ENTERED_SNIPER") {
        console.log(`[EVENT] Processing SNIPER entry for ${event.symbol}`);
        
        // Get latest signal snapshot from API (DO NOT RECOMPUTE)
        const signal = allSignals.find(s => s.symbol === event.symbol);
        
        if (signal && signal.state === "SNIPER" && signal.direction) {
          // Check cooldown
          const lastAlertTime = await getTelegramCooldown(event.symbol);
          
          if (now - lastAlertTime >= TELEGRAM_COOLDOWN_MS) {
            console.log(`[EVENT_ALERT] Sending Telegram alert for ${event.symbol} SNIPER entry`);
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
    console.log(`[EVENT_SUMMARY] ${alertsSent} Telegram alerts sent from ${events.length} events`);

    return NextResponse.json({
      ok: true,
      message: "Cron cycle complete (event-driven alerts only, no state computation)",
      events_processed: events.length,
      alerts_sent: alertsSent,
      signals_count: allSignals.length,
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


