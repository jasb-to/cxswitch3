import { NextRequest, NextResponse } from "next/server";
import { generateSignals, getAllSignals } from "@/lib/strategy";
import { sendSignalAlert, shouldSendAlert } from "@/lib/telegram";

export const dynamic = "force-dynamic";

// Cron runs every minute via vercel.json
const CRON_INTERVAL_MS = 60_000;
let lastCronRun = 0;

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.get("authorization");
    const query = new URL(req.url).searchParams.get("secret");
    if (auth !== `Bearer ${secret}` && query !== secret) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  lastCronRun = Date.now();
  const { signals, logs } = await generateSignals();

  // Print all logs to stdout
  for (const line of logs) {
    console.log(line);
  }

  // Telegram: send only if shouldSendAlert approves (no spam)
  for (const signal of signals) {
    if (shouldSendAlert(signal.symbol, signal.state)) {
      try {
        await sendSignalAlert(signal);
        console.log(`[TELEGRAM] ✓ Sent ${signal.state} alert for ${signal.symbol} (new state)`);
      } catch {
        console.log(`[TELEGRAM] ✗ Failed to send alert for ${signal.symbol}`);
      }
    } else {
      console.log(`[TELEGRAM] ✗ Skipped — already alerted ${signal.state} for ${signal.symbol}`);
    }
  }

  const nextInMs = CRON_INTERVAL_MS - (Date.now() - lastCronRun);
  const nextInSec = Math.max(0, Math.round(nextInMs / 1000));
  const nextMins = Math.floor(nextInSec / 60);
  const nextSecs = nextInSec % 60;
  console.log(`[NEXT CRON] In ${nextMins}m ${nextSecs}s`);

  return NextResponse.json({
    ok: true,
    signals: getAllSignals(),
    logs,
    lastCronRun,
  });
}
