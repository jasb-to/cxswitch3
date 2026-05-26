import { NextResponse } from "next/server";
import { SYMBOLS, createSignal } from "@/lib/strategy-core";
import { readSignals, writeSignals, getTelegramCooldown, setTelegramCooldown, healthCheck } from "@/lib/persistent-store";
import { sendSignalAlert } from "@/lib/telegram";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const TELEGRAM_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes

/**
 * EXECUTOR - Fetch Kraken prices, evaluate, store persistently in Redis
 * Sends Telegram alerts when state changes INTO SNIPER
 * ONLY triggered by Vercel Cron (enforce single source in production)
 */
export async function GET() {
  try {
    // Check Redis health first
    const isHealthy = await healthCheck();
    if (!isHealthy) {
      console.error("[CRON] Redis health check failed - aborting execution");
      return NextResponse.json(
        { ok: false, error: "Redis not available" },
        { status: 503 }
      );
    }

    console.log("[CRON] Starting execution cycle");
    const results: any[] = [];
    
    // Read previous signals from persistent Redis store
    const previousSignals = await readSignals();
    const previousMap = new Map(previousSignals.map(s => [s.symbol, s]));

    const newSignals: any[] = [];

    for (const symbol of SYMBOLS) {
      const signal = await createSignal(symbol);
      const previousSignal = previousMap.get(symbol);
      const previousState = previousSignal?.state;
      
      newSignals.push(signal);
      
      // Log full signal details
      console.log(`[CRON]`);
      console.log(`${symbol}`);
      console.log(`STATE: ${signal.state}`);
      
      if (signal.state === "SNIPER" && signal.direction) {
        console.log(`DIRECTION: ${signal.direction}`);
        console.log(`PRICE: ${signal.price}`);
        console.log(`ENTRY: ${signal.entry}`);
        console.log(`SL: ${signal.stopLoss}`);
        console.log(`TP: ${signal.takeProfit}`);
        console.log(`RR: ${signal.riskReward}`);
        console.log(`CONFIDENCE: ${signal.confidence}%`);
        console.log(`REASON: ${signal.reason}`);
      } else {
        console.log(`PRICE: ${signal.price}`);
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

      // Send alert when state changes INTO SNIPER (with cooldown check)
      if (signal.state === "SNIPER" && previousState !== "SNIPER") {
        const lastAlertTime = await getTelegramCooldown(symbol);
        const now = Date.now();
        
        if (now - lastAlertTime >= TELEGRAM_COOLDOWN_MS) {
          console.log(`[ALERT] State changed from ${previousState} to SNIPER - Sending Telegram alert`);
          await sendSignalAlert(signal);
          await setTelegramCooldown(symbol, now);
        } else {
          const timeRemaining = Math.ceil((TELEGRAM_COOLDOWN_MS - (now - lastAlertTime)) / 1000 / 60);
          console.log(`[ALERT] SNIPER triggered but cooldown active (${timeRemaining}m remaining)`);
        }
      }
    }

    // Persist new signals to Redis
    await writeSignals(newSignals);

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
      message: "Signals evaluated and persisted to Redis",
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
  // In production, only Vercel Cron should POST
  // Return error to discourage manual triggers
  return NextResponse.json(
    { ok: false, error: "Cron endpoint should only be triggered by Vercel Cron" },
    { status: 403 }
  );
}


