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

  console.log(`[THROTTLE] ${key} | currentHash=${hash} | lastHash=${lastHash} | lastTime=${lastTime ? new Date(lastTime).toISOString() : "none"} | cooldown=${cooldown}ms`);

  if (lastHash === hash && lastTime && now - lastTime < cooldown) {
    console.log(`[THROTTLE] BLOCKED — same trendline within cooldown (${Math.round((now - lastTime) / 1000)}s ago)`);
    return true;
  }

  console.log(`[THROTTLE] ALLOWED — new trendline or cooldown expired`);
  lastSignalHash.set(key, hash);
  lastAlertTime.set(key, now);
  return false;
}

export async function GET(request: Request) {
  console.log("========================================");
  console.log(`[CRON] Started at ${new Date().toISOString()}`);
  console.log(`[CRON] Request URL: ${request.url}`);

  // Check auth: header OR query param
  const url = new URL(request.url);
  const querySecret = url.searchParams.get("secret");
  const authHeader = request.headers.get("authorization");

  console.log(`[AUTH] CRON_SECRET env set: ${!!process.env.CRON_SECRET}`);
  console.log(`[AUTH] Query secret present: ${!!querySecret}`);
  console.log(`[AUTH] Auth header present: ${!!authHeader}`);
  console.log(`[AUTH] Query secret matches: ${querySecret === process.env.CRON_SECRET}`);
  console.log(`[AUTH] Header matches: ${authHeader === `Bearer ${process.env.CRON_SECRET}`}`);

  const isAuthorized = 
    !process.env.CRON_SECRET || 
    querySecret === process.env.CRON_SECRET ||
    authHeader === `Bearer ${process.env.CRON_SECRET}`;

  if (!isAuthorized) {
    console.log(`[AUTH] FAILED — returning 401`);
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  console.log(`[AUTH] PASSED`);

  const signals: any[] = [];
  const alerts: any[] = [];

  for (const pair of PAIRS) {
    console.log(`----------------------------------------`);
    console.log(`[PAIR] Processing ${pair}...`);

    try {
      console.log(`[PAIR] Fetching 1H candles...`);
      const candles1h = await getCandles(pair, 60);
      console.log(`[PAIR] 1H candles received: ${candles1h?.length ?? 0} candles`);

      console.log(`[PAIR] Fetching 4H candles...`);
      const candles4h = await getCandles(pair, 240);
      console.log(`[PAIR] 4H candles received: ${candles4h?.length ?? 0} candles`);

      if (!candles1h || !candles4h) {
        console.log(`[PAIR] SKIP — null candles returned`);
        alerts.push({ pair, status: "skip", reason: "null candles" });
        continue;
      }

      if (candles1h.length < 50) {
        console.log(`[PAIR] SKIP — 1H candles insufficient (${candles1h.length} < 50)`);
        alerts.push({ pair, status: "skip", reason: `1H only ${candles1h.length} candles` });
        continue;
      }

      if (candles4h.length < 50) {
        console.log(`[PAIR] SKIP — 4H candles insufficient (${candles4h.length} < 50)`);
        alerts.push({ pair, status: "skip", reason: `4H only ${candles4h.length} candles` });
        continue;
      }

      console.log(`[PAIR] Generating signal...`);
      const signal = await generateSignal(pair, candles1h, candles4h);

      if (!signal) {
        console.log(`[PAIR] NO SIGNAL — no trendline break detected`);
        alerts.push({ pair, status: "no_signal", reason: "No trendline break detected" });
        continue;
      }

      console.log(`[PAIR] SIGNAL DETECTED:`);
      console.log(`  direction: ${signal.direction}`);
      console.log(`  type: ${signal.type}`);
      console.log(`  confidence: ${signal.confidence}%`);
      console.log(`  entry: ${signal.entry}`);
      console.log(`  stop: ${signal.stop}`);
      console.log(`  target: ${signal.target}`);
      console.log(`  rr: ${signal.rr}`);
      console.log(`  structure: ${signal.structure}`);
      console.log(`  adx: ${signal.adx}`);
      console.log(`  reason: ${signal.reason}`);

      signals.push(signal);

      if (!isThrottled(signal)) {
        console.log(`[ALERT] Sending Telegram alert...`);
        const alertText = formatAlert(signal);
        await sendAlert(alertText);
        console.log(`[ALERT] Telegram alert SENT`);
        alerts.push({ pair, type: signal.type, direction: signal.direction, status: "sent" });
      } else {
        console.log(`[ALERT] SKIPPED — throttled`);
        alerts.push({ 
          pair, type: signal.type, direction: signal.direction, status: "throttled",
          reason: "Same trendline within cooldown"
        });
      }
    } catch (err) {
      console.error(`[PAIR] ERROR processing ${pair}:`, err);
      alerts.push({ pair, status: "error", error: err instanceof Error ? err.message : "Unknown error" });
    }
  }

  console.log(`----------------------------------------`);
  console.log(`[STATE] Saving ${signals.length} signals to state...`);
  try {
    await setSignals(signals);
    console.log(`[STATE] Signals saved successfully`);
  } catch (err) {
    console.error(`[STATE] ERROR saving signals:`, err);
  }

  console.log(`[CRON] Finished. Signals: ${signals.length}, Alerts: ${alerts.length}`);
  console.log(`[CRON] Alerts breakdown:`, JSON.stringify(alerts, null, 2));
  console.log("========================================");

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
