import { NextRequest, NextResponse } from "next/server";
import { managePositions, getAllSignals } from "@/lib/strategy";
import { sendSignalAlert, shouldSendAlert } from "@/lib/telegram";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  try {
    const secret = process.env.CRON_SECRET;
    if (!secret) {
      return NextResponse.json({ error: "CRON_SECRET not set" }, { status: 500 });
    }

    const auth = req.headers.get("authorization");
    const query = new URL(req.url).searchParams.get("secret");
    if (auth !== `Bearer ${secret}` && query !== secret) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const runAt = new Date().toISOString();
    console.log(`[POSITIONS CRON] Run started at ${runAt}`);

    const { logs } = await managePositions();

    for (const line of logs) {
      console.log(line);
    }

    // Fetch updated signals after position management
    const signals = await getAllSignals();

    // Send Telegram alerts for any newly CONFIRMED signals
    for (const signal of signals) {
      if (signal.state === "CONFIRMED") {
        if (await shouldSendAlert(signal.symbol, signal.state)) {
          try {
            await sendSignalAlert(signal);
            console.log(`[TELEGRAM] Sent CONFIRMED alert for ${signal.symbol}`);
          } catch {
            console.log(`[TELEGRAM] Failed to send alert for ${signal.symbol}`);
          }
        }
      }
    }

    console.log(`[POSITIONS CRON] Complete — ${signals.filter(s => s.state !== "END").length} open position(s)`);

    return NextResponse.json({
      ok: true,
      runAt,
      logs,
      openPositions: signals.filter((s) => s.state !== "END").length,
      signals,
    });
  } catch (error) {
    console.error("[GET /api/cron/positions ERROR]", error);
    return NextResponse.json(
      {
        error: "Internal error",
        details: error instanceof Error ? error.message : "Unknown",
        ok: false,
        logs: [],
      },
      { status: 500 }
    );
  }
}
