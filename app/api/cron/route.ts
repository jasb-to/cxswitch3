import { NextRequest, NextResponse } from "next/server";
import { generateSignals, getAllSignals, cleanupExpiredSignals } from "@/lib/strategy";
import { sendSignalAlert, shouldSendAlert } from "@/lib/telegram";
import { supabase } from "@/lib/supabase-client";
import { getTraceStats } from "@/lib/signal-trace";
import { initializeSupabaseConsumer } from "@/lib/supabase-consumer";
import { initializeTelegramConsumer } from "@/lib/telegram-consumer";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Cron runs every minute via vercel.json
const CRON_INTERVAL_MS = 60_000;
let lastCronRun = 0;
let consumersInitialized = false;

export async function GET(req: NextRequest) {
  try {
    const secret = process.env.CRON_SECRET;
    if (secret) {
      const auth = req.headers.get("authorization");
      const query = new URL(req.url).searchParams.get("secret");
      if (auth !== `Bearer ${secret}` && query !== secret) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }
    }

    lastCronRun = Date.now();

    // Initialize event consumers on first run
    if (!consumersInitialized) {
      initializeSupabaseConsumer();
      initializeTelegramConsumer();
      consumersInitialized = true;
      console.log("[EVENT CONSUMERS] Initialized Supabase and Telegram consumers");
    }
    
    // First: cleanup expired signals that haven't confirmed
    const { logs: cleanupLogs } = await cleanupExpiredSignals();
    for (const line of cleanupLogs) {
      console.log(line);
    }

    // Then: generate new signals
    const { signals, logs } = await generateSignals();

    // Print all logs to stdout
    for (const line of logs) {
      console.log(line);
    }

    // Telegram: send EARLY_OPEN alerts when signals are first created
    for (const signal of signals) {
      if (signal.state === "EARLY_OPEN" && await shouldSendAlert(signal.id!, signal.symbol, "EARLY_OPEN")) {
        try {
          await sendSignalAlert(signal);
          console.log(`[TELEGRAM] ✓ Sent EARLY_OPEN alert for ${signal.symbol} (signal ID ${signal.id})`);
        } catch (err) {
          console.log(`[TELEGRAM] ✗ Failed to send EARLY_OPEN alert for ${signal.symbol}`);
        }
      }
    }

    // Note: CONFIRMED alerts are sent by /api/cron/positions after managePositions() evaluates candidates

    // Clean up alerts for signals that have ended (prevents old alerts from blocking new ones)
    if (supabase) {
      try {
        const { data: endedSignals } = await supabase
          .from("signals")
          .select("id")
          .eq("state", "END")
          .gte("updated_at", new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString());

        if (endedSignals) {
          const endedIds = endedSignals.map(s => s.id);
          if (endedIds.length > 0) {
            await supabase
              .from("telegram_alerts")
              .delete()
              .in("signal_id", endedIds);
            console.log(`[TELEGRAM_ALERTS] Cleaned up ${endedIds.length} alerts for ended signals`);
          }
        }
      } catch (err) {
        console.warn(`[TELEGRAM_ALERTS] Failed to cleanup alerts:`, err);
      }
    }

    const nextInMs = CRON_INTERVAL_MS - (Date.now() - lastCronRun);
    const nextInSec = Math.max(0, Math.round(nextInMs / 1000));
    const nextMins = Math.floor(nextInSec / 60);
    const nextSecs = nextInSec % 60;
    console.log(`[NEXT CRON] In ${nextMins}m ${nextSecs}s`);

    const allSignals = await getAllSignals();

    // Log cycle summary with trace stats (v2.7.x observability)
    const traceStats = getTraceStats();
    console.log(
      `[CYCLE SUMMARY] Signals: ${signals.length} | Trace Stats: Triggered=${traceStats.triggered}, Blocked=${traceStats.blocked}, Failures=${traceStats.failures}, NoSignal=${traceStats.noSignal}`
    );

    // Log cron run to cron_runs table
    if (supabase) {
      const { error: logErr } = await supabase
        .from("cron_runs")
        .insert([
          {
            run_at: new Date().toISOString(),
            signals_count: signals.length,
            errors: logs.filter(l => l.includes("ERROR") || l.includes("error")).length,
          },
        ]);

      if (logErr) {
        console.error("[CRON_RUNS] Failed to log cron run:", logErr.message);
      } else {
        console.log("[CRON_RUNS] Logged execution");
      }
    }

    return NextResponse.json({
      ok: true,
      signals: allSignals,
      logs,
      lastCronRun,
    });
  } catch (error) {
    console.error('[GET /api/cron ERROR]', error);
    return NextResponse.json(
      { error: 'Internal error', details: error instanceof Error ? error.message : 'Unknown', ok: false, logs: [] },
      { status: 500 }
    );
  }
}
