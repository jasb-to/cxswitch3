import { NextResponse } from "next/server";
import { getCandles, getCurrentPrice } from "@/lib/kraken";
import { generateSignal } from "@/lib/strategy";
import { setSignals } from "@/lib/state";
import { sendAlert } from "@/lib/telegram";

export const runtime = "nodejs";

// Throttle config — aligned with 1H candle closes
const ALERT_COOLDOWN_MS = 60 * 60 * 1000; // 60 min minimum between alerts per symbol

const lastAlertTime: Record<string, number> = {};
const lastSignalHash: Record<string, string> = {};

function hashSignal(s: any): string {
  return `${s.setup}:${s.bias}:${s.entryTimeframe}`;
}

function shouldThrottle(symbol: string, signal: any): boolean {
  const now = Date.now();
  const lastTime = lastAlertTime[symbol];
  const lastHash = lastSignalHash[symbol];
  const currentHash = hashSignal(signal);

  // Always alert if it's a genuinely new setup (different hash)
  if (lastHash !== currentHash) return false;

  // Same setup repeating — throttle
  if (lastTime && (now - lastTime) < ALERT_COOLDOWN_MS) return true;

  return false;
}

function recordAlert(symbol: string, signal: any) {
  lastAlertTime[symbol] = Date.now();
  lastSignalHash[symbol] = hashSignal(signal);
}

export async function GET() {
  const symbols = ["BTC", "ETH", "SOL"] as const;

  // Drop 15M — not used anymore
  const candles1h = await Promise.all(
    symbols.map(s => getCandles(s, 60))
  );

  const candles4h = await Promise.all(
    symbols.map(s => getCandles(s, 240))
  );

  const prices = await Promise.all(
    symbols.map(s => getCurrentPrice(s))
  );

  // Pass null for 15M since it's no longer used
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

    // Confidence floor — don't even consider low-confidence signals
    if (s.confidence < 50) {
      console.log("[SKIP LOW CONF]", s.symbol, s.confidence);
      continue;
    }

    // Cheeky trades need higher bar
    const isCheeky = s.reason?.includes("1H_CHEEKY");
    if (isCheeky && s.confidence < 65) {
      console.log("[SKIP CHEEKY LOW CONF]", s.symbol, s.confidence);
      continue;
    }

    if (shouldThrottle(s.symbol, s)) {
      console.log("[THROTTLED]", s.symbol, hashSignal(s));
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
    });
  }

  return NextResponse.json({ ok: true, signals });
}
