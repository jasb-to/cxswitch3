import { NextResponse } from "next/server";
import { generateSignals, getAllSignals } from "@/lib/strategy";
import { sendSignalAlert, shouldSendAlert } from "@/lib/telegram";

export const dynamic = "force-dynamic";

// Server-side proxy: runs the cron logic directly without needing the secret
// to be exposed to the client. Called by the "Scan Now" button.
export async function POST() {
  const { signals, logs } = await generateSignals();

  for (const line of logs) {
    console.log(line);
  }

  for (const signal of signals) {
    if (await shouldSendAlert(signal.symbol, signal.state)) {
      try {
        await sendSignalAlert(signal);
        console.log(`[TELEGRAM] ✓ Sent ${signal.state} alert for ${signal.symbol} (manual scan)`);
      } catch {
        console.log(`[TELEGRAM] ✗ Failed to send alert for ${signal.symbol}`);
      }
    }
  }

  return NextResponse.json({ ok: true, signals: await getAllSignals(), logs });
}
