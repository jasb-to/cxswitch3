import { NextResponse } from "next/server";
import { getCandles, getCurrentPrice } from "@/lib/kraken";
import { generateSignal } from "@/lib/strategy";
import { setSignals } from "@/lib/state";
import { sendAlert } from "@/lib/telegram";

const PAIRS = ["BTC", "ETH", "SOL"] as const;

const lastAlertTime = new Map<string, number>();
const lastSignalHash = new Map<string, string>();

function hashSignal(signal: any): string {
  const slopeMatch = signal.reason.match(/slope:([\d\.]+)/);
  const slope = slopeMatch ? slopeMatch[1] : "none";
  return `${signal.pair}:${signal.direction}:${signal.type}:slope${slope}`;
}

function isThrottled(signal: any): boolean {
  const hash = hashSignal(signal);
  const key = signal.pair;
  const now = Date.now();
  const cooldown = signal.type === "PRIMARY" ? 4 * 60 * 60 * 1000 : 8 * 60 * 60 * 1000;
  const lastHash = lastSignalHash.get(key);
  const lastTime = lastAlertTime.get(key);
  if (lastHash === hash && lastTime && now - lastTime < cooldown) return true;
  lastSignalHash.set(key, hash);
  lastAlertTime.set(key, now);
  return false;
}

export async function GET(request: Request) {
  console.log("========================================");
  console.log(`[CRON] Started at ${new Date().toISOString()}`);

  const url = new URL(request.url);
  const querySecret = url.searchParams.get("secret");
  const authHeader = request.headers.get("authorization");

  const isAuthorized = 
    !process.env.CRON_SECRET || 
    querySecret === process.env.CRON_SECRET ||
    authHeader === `Bearer ${process.env.CRON_SECRET}`;

  if (!isAuthorized) {
    console.log(`[AUTH] FAILED`);
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  console.log(`[AUTH] PASSED`);

  const signals = [];
  const alerts = [];

  for (const pair of PAIRS) {
    console.log(`[PAIR] ${pair} — fetching candles...`);
    try {
      const candles1h = await getCandles(pair, 60);
      const candles4h = await getCandles(pair, 240);

      console.log(`[PAIR] ${pair} — 1H: ${candles1h?.length ?? 0}, 4H: ${candles4h?.length ?? 0}`);

      if (!candles1h || !candles4h || candles1h.length < 50 || candles4h.length < 50) {
        console.log(`[PAIR] ${pair} — SKIP: insufficient candles`);
        alerts.push({ pair, status: "skip", reason: "insufficient candles" });
        continue;
      }

      const signal = await generateSignal(pair, candles1h, candles4h);

      if (!signal) {
        console.log(`[PAIR] ${pair} — NO SIGNAL`);
        alerts.push({ pair, status: "no_signal" });
        continue;
      }

      console.log(`[PAIR] ${pair} — SIGNAL: ${signal.direction} ${signal.type} conf=${signal.confidence}%`);
      signals.push(signal);

      if (!isThrottled(signal)) {
        console.log(`[ALERT] ${pair} — sending alert...`);

        // Map generateSignal fields -> sendAlert expected fields
        const alertPayload = {
          symbol: signal.pair,
          state: signal.type,
          price: signal.entry,
          bias: signal.direction,
          confidence: signal.confidence,
          stopLoss: signal.stop,
          takeProfit: signal.target,
          rr: signal.rr,
          adx: signal.adx,
          rsi: signal.rsi,
          stochK: signal.stochK,
          stochD: signal.stochD,
          expectedMove: signal.expectedMove,
          reason: signal.reason,
          updatedAt: new Date(signal.timestamp).toISOString(),
        };

        console.log(`[ALERT] Payload:`, JSON.stringify(alertPayload, null, 2));

        try {
          await sendAlert(alertPayload);
          console.log(`[ALERT] ${pair} — SENT`);
          alerts.push({ pair, status: "sent" });
        } catch (alertErr) {
          console.error(`[ALERT] ${pair} — FAILED:`, alertErr);
          alerts.push({ pair, status: "alert_failed", error: String(alertErr) });
        }
      } else {
        console.log(`[ALERT] ${pair} — THROTTLED`);
        alerts.push({ pair, status: "throttled" });
      }
    } catch (err) {
      console.error(`[PAIR] ${pair} — ERROR:`, err);
      alerts.push({ pair, status: "error", error: err instanceof Error ? err.message : "Unknown" });
    }
  }

  console.log(`[STATE] Saving ${signals.length} signals...`);
  await setSignals(signals);
  console.log(`[CRON] Done. signals=${signals.length}`);
  console.log("========================================");

  return NextResponse.json({
    success: true,
    timestamp: new Date().toISOString(),
    signals: signals.length,
    alerts,
  });
}
