import { NextRequest, NextResponse } from "next/server";
import { generateSignals, getAllSignals } from "@/lib/strategy";
import { sendSignalAlert } from "@/lib/telegram";

export const dynamic = "force-dynamic";

// Track previous states to detect changes for Telegram alerts
const prevStates = new Map<string, string>();

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.get("authorization");
    const query = new URL(req.url).searchParams.get("secret");
    if (auth !== `Bearer ${secret}` && query !== secret) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const { signals, logs } = await generateSignals();

  // Print all logs to stdout so they appear in Vercel logs
  for (const line of logs) {
    console.log(line);
  }

  // Send Telegram alerts only on state change TO EARLY or TO CONFIRMED
  for (const signal of signals) {
    const key = signal.symbol;
    const prev = prevStates.get(key);
    if (
      (signal.state === "EARLY" && prev !== "EARLY") ||
      (signal.state === "CONFIRMED" && prev !== "CONFIRMED")
    ) {
      try {
        await sendSignalAlert(signal);
        console.log(`[TELEGRAM] Sent ${signal.state} alert for ${signal.symbol}`);
      } catch {
        console.log(`[TELEGRAM] Failed to send alert for ${signal.symbol}`);
      }
    }
    prevStates.set(key, signal.state);
  }

  return NextResponse.json({ ok: true, signals: getAllSignals(), logs });
}
