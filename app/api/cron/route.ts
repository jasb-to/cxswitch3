import { NextResponse } from "next/server";
import { getCandles, getCurrentPrice } from "@/lib/kraken";
import { generateSignal } from "@/lib/strategy";
import { setSignals } from "@/lib/state";
import { sendAlert } from "@/lib/telegram";

export const runtime = "nodejs";

// In-memory throttle tracking (resets on deploy/cold start)
const lastAlertTime: Record<string, number> = {};
const lastSignalState: Record<string, { state: string; setup: string; bias: string }> = {};

// Throttle config
const EARLY_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes between EARLY alerts
const SNIPER_COOLDOWN_MS = 60 * 60 * 1000; // 60 minutes between SNIPER alerts

function getCooldown(state: string): number {
  return state === "SNIPER" ? SNIPER_COOLDOWN_MS : EARLY_COOLDOWN_MS;
}

function shouldThrottle(symbol: string, state: string, setup: string, bias: string): boolean {
  const now = Date.now();
  const key = `${symbol}:${state}`;
  const lastTime = lastAlertTime[key];
  
  // Always allow SNIPER if different setup or bias than last signal
  const lastSignal = lastSignalState[symbol];
  if (state === "SNIPER" && lastSignal) {
    if (lastSignal.setup !== setup || lastSignal.bias !== bias) {
      // Different setup or bias = new trade idea, reset throttle
      return false;
    }
  }
  
  // Throttle same state/setup/bias combinations
  if (lastTime && (now - lastTime) < getCooldown(state)) {
    return true;
  }
  
  return false;
}

function recordAlert(symbol: string, state: string, setup: string, bias: string) {
  const key = `${symbol}:${state}`;
  lastAlertTime[key] = Date.now();
  lastSignalState[symbol] = { state, setup, bias };
}

export async function GET() {
  const symbols = ["BTC", "ETH", "SOL"] as const;

  const candles15 = await Promise.all(
    symbols.map(s => getCandles(s, 15))
  );

  const candles1h = await Promise.all(
    symbols.map(s => getCandles(s, 60))
  );

  const candles4h = await Promise.all(
    symbols.map(s => getCandles(s, 240))
  );

  const prices = await Promise.all(
    symbols.map(s => getCurrentPrice(s))
  );

  const signals = symbols.map((s, i) =>
    generateSignal(s, prices[i], candles15[i], candles1h[i], candles4h[i])
  );

  setSignals(signals);

  console.log("[CRON] FULL SIGNAL SNAPSHOT");

  for (const s of signals) {
    console.log(s);
  }

  for (const s of signals) {
    if (s.state === "WAIT") continue;

    // Check throttle
    if (shouldThrottle(s.symbol, s.state, s.setup, s.bias)) {
      console.log("[THROTTLED]", {
        symbol: s.symbol,
        state: s.state,
        setup: s.setup,
        bias: s.bias,
        reason: "Recent alert sent, skipping",
      });
      continue;
    }

    await sendAlert({
      ...s,
      timestamp: s.updatedAt,
    });

    // Record this alert
    recordAlert(s.symbol, s.state, s.setup, s.bias);

    console.log("[ALERT SENT]", {
      symbol: s.symbol,
      state: s.state,
      setup: s.setup,
      bias: s.bias,
      confidence: s.confidence,
      rr: s.rr,
    });
  }

  return NextResponse.json({ ok: true, signals });
}
