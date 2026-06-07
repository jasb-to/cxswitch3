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

  if (lastHash === hash && lastTime && now - lastTime < cooldown) {
    return true;
  }

  lastSignalHash.set(key, hash);
  lastAlertTime.set(key, now);
  return false;
}

export async function GET(request: Request) {
  // Check auth: header OR query param (Vercel cron uses query param)
  const url = new URL(request.url);
  const querySecret = url.searchParams.get("secret");
  const authHeader = request.headers.get("authorization");

  const isAuthorized = 
    !process.env.CRON_SECRET || 
    querySecret === process.env.CRON_SECRET ||
    authHeader === `Bearer ${process.env.CRON_SECRET}`;

  if (!isAuthorized) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const signals = [];
  const alerts = [];

  for (const pair of PAIRS) {
    try {
      const candles1h = await getCandles(pair, 60);
      const candles4h = await getCandles(pair, 240);

      if (!candles1h || !candles4h || candles1h.length < 50 || candles4h.length < 50) {
        console.warn(`Insufficient data for ${pair}`);
        continue;
      }

      const signal = await generateSignal(pair, candles1h, candles4h);

      if (signal) {
        signals.push(signal);

        if (!isThrottled(signal)) {
          const alertText = formatAlert(signal);
          await sendAlert(alertText);
          alerts.push({ pair, type: signal.type, direction: signal.direction, status: "sent" });
        } else {
          alerts.push({ 
            pair, type: signal.type, direction: signal.direction, status: "throttled",
            reason: "Same trendline within cooldown"
          });
        }
      }
    } catch (err) {
      console.error(`Error processing ${pair}:`, err);
      alerts.push({ pair, error: err instanceof Error ? err.message : "Unknown error" });
    }
  }

  await setSignals(signals);

  return NextResponse.json({
    success: true,
    timestamp: new Date().toISOString(),
    signals: signals.length,
    alerts,
  });
}

function formatAlert(signal: any): string {
  const emoji = signal.direction === "LONG" ? "🟢" : "🔴";
  const typeEmoji = signal.type === "PRIMARY" ? "⭐" : "👀";
  return `${emoji} ${typeEmoji} <b>${signal.pair} ${signal.direction} ${signal.type}</b>

📊 Confidence: <b>${signal.confidence}%</b>
📈 Entry: <b>${signal.entry.toFixed(2)}</b>
🛑 Stop: <b>${signal.stop.toFixed(2)}</b> (${((Math.abs(signal.stop - signal.entry) / signal.entry) * 100).toFixed(1)}%)
🎯 Target: <b>${signal.target.toFixed(2)}</b> (${((Math.abs(signal.target - signal.entry) / signal.entry) * 100).toFixed(1)}%)
⚖️ R:R: <b>${signal.rr.toFixed(2)}</b>
📐 Structure: <b>${signal.structure}</b> | ADX: <b>${signal.adx.toFixed(1)}</b>

📝 ${signal.reason}

⏰ ${new Date(signal.timestamp).toUTCString()}`.trim();
}
