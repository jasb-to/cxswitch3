import { NextRequest, NextResponse } from "next/server";
import { generateSignals, getAllSignals } from "@/lib/strategy";
import { sendSignalAlert, shouldSendAlert } from "@/lib/telegram";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const secret = searchParams.get("secret");

  const expected = process.env.CRON_SECRET;
  if (!expected) {
    return NextResponse.json({ error: "CRON_SECRET env var not set" }, { status: 500 });
  }
  if (secret !== expected) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const runAt = new Date().toISOString();
  console.log(`[EXTERNAL-CRON] Run started at ${runAt}`);

  const { signals, logs } = await generateSignals();

  for (const line of logs) {
    console.log(line);
  }

  for (const signal of signals) {
    if (shouldSendAlert(signal.symbol, signal.state)) {
      try {
        await sendSignalAlert(signal);
        console.log(`[TELEGRAM] Sent ${signal.state} alert for ${signal.symbol}`);
      } catch {
        console.log(`[TELEGRAM] Failed to send alert for ${signal.symbol}`);
      }
    } else {
      console.log(`[TELEGRAM] Skipped — already alerted ${signal.state} for ${signal.symbol}`);
    }
  }

  console.log(`[EXTERNAL-CRON] Run complete. ${signals.length} signal(s) evaluated.`);

  return NextResponse.json({
    ok: true,
    runAt,
    signals: getAllSignals(),
    logs,
  });
}
