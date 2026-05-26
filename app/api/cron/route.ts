import { NextResponse } from "next/server";
import { SYMBOLS, createSignal } from "@/lib/strategy-core";
import { getTelegramCooldown, setTelegramCooldown, healthCheck, getHoldState } from "@/lib/persistent-store";
import { sendSignalAlert } from "@/lib/telegram";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const TELEGRAM_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes
const SNIPER_STABILITY_MS = 5 * 60 * 1000; // 5 minutes minimum before alert

/**
 * CRON EXECUTOR - Live Computation with Hold Rules
 * Runs every 5 minutes to:
 * 1. Compute live strategy for all symbols
 * 2. Apply hold rules (sticky states)
 * 3. Send Telegram alerts only for stable SNIPER states
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

    console.log("[CRON] Starting execution cycle (live computation + hold rules)");
    const results: any[] = [];
    const now = Date.now();

    for (const symbol of SYMBOLS) {
      // Compute live strategy with hold rules applied
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

      // ALERT LOGIC: Only send if SNIPER is stable (confirmed via hold)
      if (signal.state === "SNIPER" && signal.direction) {
        const holdState = await getHoldState(symbol);
        
        // Check if SNIPER has been confirmed (hold was initialized when SNIPER was entered)
        const sniperConfirmedAt = holdState?.sniper_confirmed_at || 0;
        const sniper_stability = now - sniperConfirmedAt;
        const is_stable = sniper_stability >= SNIPER_STABILITY_MS;
        
        console.log(`[ALERT] ${symbol} SNIPER: stability=${sniper_stability}ms, stable=${is_stable}`);
        
        if (is_stable) {
          const lastAlertTime = await getTelegramCooldown(symbol);
          
          if (now - lastAlertTime >= TELEGRAM_COOLDOWN_MS) {
            console.log(`[ALERT] ✓ Sending Telegram alert for ${symbol}`);
            await sendSignalAlert(signal);
            await setTelegramCooldown(symbol, now);
          } else {
            const timeRemaining = Math.ceil((TELEGRAM_COOLDOWN_MS - (now - lastAlertTime)) / 1000 / 60);
            console.log(`[ALERT] Cooldown active (${timeRemaining}m remaining)`);
          }
        } else {
          const remaining = Math.ceil((SNIPER_STABILITY_MS - sniper_stability) / 1000);
          console.log(`[ALERT] Waiting for confirmation (${remaining}s remaining)`);
        }
      }
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

    return NextResponse.json({
      ok: true,
      message: "Cron cycle complete (live computation + hold rules)",
      results,
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


