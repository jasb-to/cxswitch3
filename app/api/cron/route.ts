import { NextResponse } from "next/server";
import { getCandles, getCurrentPrice } from "@/lib/kraken";
import { generateSignal } from "@/lib/strategy";
import { setSignals } from "@/lib/state";
import { sendAlert } from "@/lib/telegram";

export const runtime = "nodejs";

// Throttle config — adaptive by signal quality
const PRIMARY_COOLDOWN_MS = 4 * 60 * 60 * 1000;  // 4 hours for primary
const CHEEKY_COOLDOWN_MS = 8 * 60 * 60 * 1000;   // 8 hours for cheeky
const SAME_HASH_COOLDOWN_MS = 60 * 60 * 1000;    // 1 hour if exact same setup repeats

const lastAlertTime: Record<string, number> = {};
const lastSignalHash: Record<string, string> = {};
const lastSignalState: Record<string, { state: string; setup: string; bias: string; timestamp: number }> = {};

function hashSignal(s: any): string {
  return `${s.setup}:${s.bias}:${s.entryTimeframe}:${s.reason?.includes("slope:") ? s.reason.match(/slope:([\d.-]+)/)?.[1] : "no-tl"}`;
}

function getCooldown(state: string, isSameHash: boolean): number {
  if (isSameHash) return SAME_HASH_COOLDOWN_MS;
  return state === "PRIMARY" ? PRIMARY_COOLDOWN_MS : CHEEKY_COOLDOWN_MS;
}

function shouldThrottle(symbol: string, signal: any): { throttled: boolean; reason: string } {
  const now = Date.now();
  const lastTime = lastAlertTime[symbol];
  const lastHash = lastSignalHash[symbol];
  const currentHash = hashSignal(signal);
  const isSameHash = lastHash === currentHash;

  // Always allow if genuinely new setup (different hash)
  if (!isSameHash) {
    return { throttled: false, reason: "NEW_SETUP" };
  }

  // Same hash — check cooldown
  const cooldown = getCooldown(signal.state, isSameHash);
  if (lastTime && (now - lastTime) < cooldown) {
    return { 
      throttled: true, 
      reason: `SAME_SETUP (${Math.round((now - lastTime) / 60000)}m ago, cooldown ${cooldown / 3600000}h)` 
    };
  }

  return { throttled: false, reason: "COOLDOWN_EXPIRED" };
}

function recordAlert(symbol: string, signal: any) {
  lastAlertTime[symbol] = Date.now();
  lastSignalHash[symbol] = hashSignal(signal);
  lastSignalState[symbol] = { 
    state: signal.state, 
    setup: signal.setup, 
    bias: signal.bias, 
    timestamp: Date.now() 
  };
}

export async function GET() {
  const symbols = ["BTC", "ETH", "SOL"] as const;

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
    generateSignal(s, prices[i], null, candles1h[i], candles4h[i])
  );

  setSignals(signals);

  console.log("[CRON] SIGNAL SNAPSHOT", new Date().toISOString());

  for (const s of signals) {
    const tier = s.reason?.includes("4H_PRIMARY") ? "PRIMARY" :
                 s.reason?.includes("1H_CHEEKY") ? "CHEEKY" : "OTHER";
    console.log(
      `[${s.symbol}] ${s.state} | ${s.setup} ${s.bias} | ${tier} | conf:${s.confidence} | rr:${s.rr}`
    );
  }

  for (const s of signals) {
    if (s.state === "WAIT") continue;

    // Hard confidence floors
    if (s.confidence < 50) {
      console.log("[SKIP LOW CONF]", s.symbol, s.confidence);
      continue;
    }

    const isCheeky = s.reason?.includes("1H_CHEEKY");
    if (isCheeky && s.confidence < 65) {
      console.log("[SKIP CHEEKY LOW CONF]", s.symbol, s.confidence);
      continue;
    }

    const throttle = shouldThrottle(s.symbol, s);
    if (throttle.throttled) {
      console.log("[THROTTLED]", s.symbol, throttle.reason);
      continue;
    }

    await sendAlert({
      ...s,
      timestamp: s.updatedAt,
    });

    recordAlert(s.symbol, s);

    console.log("[ALERT SENT]", {
      symbol: s.symbol,
      tier: isCheeky ? "CHEEKY" : "PRIMARY",
      confidence: s.confidence,
      rr: s.rr,
      throttleReason: throttle.reason,
    });
  }

  return NextResponse.json({ ok: true, signals });
}
