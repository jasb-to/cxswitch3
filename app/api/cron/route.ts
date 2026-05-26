import { NextResponse } from "next/server";
import { SYMBOLS, createSignal } from "@/lib/strategy-core";
import { getTelegramCooldown, setTelegramCooldown } from "@/lib/persistent-store";
import { sendSignalAlert } from "@/lib/telegram";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const TELEGRAM_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes

/**
 * CRON EXECUTOR - Side effects only
 * Evaluates strategy LIVE to trigger alerts
 * Does NOT write signal state to Redis (that kills BUILDING/SNIPER)
 * ONLY stores Telegram cooldowns
 */
export async function GET() {
  try {
    console.log("[CRON] Starting execution cycle (side effects only)");
    const results: any[] = [];

    for (const symbol of SYMBOLS) {
      // Compute strategy LIVE (no cached state)
      const signal = await createSignal(symbol);
      
      console.log(`[CRON] ${symbol}: state=${signal.state}`);
      
      // Log SNIPER opportunities
      if (signal.state === "SNIPER" && signal.direction) {
        console.log(`[CRON] 🎯 SNIPER FOUND: ${symbol} ${signal.direction} @ ${signal.price}`);
        console.log(`  ENTRY: ${signal.entry} | SL: ${signal.stopLoss} | TP: ${signal.takeProfit}`);
        console.log(`  RR: ${signal.riskReward} | CONFIDENCE: ${signal.confidence}%`);
      }
      
      results.push({
        symbol,
        state: signal.state,
        price: signal.price,
        ...(signal.state === "SNIPER" && signal.direction ? {
          direction: signal.direction,
          entry: signal.entry,
          stopLoss: signal.stopLoss,
          takeProfit: signal.takeProfit,
          riskReward: signal.riskReward,
          confidence: signal.confidence,
        } : {}),
      });

      // SIDE EFFECT: Send Telegram alert if SNIPER (with cooldown)
      if (signal.state === "SNIPER" && signal.direction) {
        const lastAlertTime = await getTelegramCooldown(symbol);
        const now = Date.now();
        
        if (now - lastAlertTime >= TELEGRAM_COOLDOWN_MS) {
          console.log(`[ALERT] Sending Telegram alert for ${symbol}`);
          await sendSignalAlert(signal);
          await setTelegramCooldown(symbol, now);
        } else {
          const timeRemaining = Math.ceil((TELEGRAM_COOLDOWN_MS - (now - lastAlertTime)) / 1000 / 60);
          console.log(`[ALERT] ${symbol} cooldown active (${timeRemaining}m remaining)`);
        }
      }
    }

    console.log("[CRON SUMMARY]");
    results.forEach((r) => {
      if (r.state === "SNIPER") {
        console.log(`${r.symbol} → SNIPER (${r.direction}) $${r.price}`);
      } else {
        console.log(`${r.symbol} → ${r.state}`);
      }
    });

    return NextResponse.json({
      ok: true,
      message: "Cron cycle complete (side effects only, no state writes)",
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


