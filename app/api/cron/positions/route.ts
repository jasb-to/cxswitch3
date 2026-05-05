import { NextRequest, NextResponse } from "next/server";
import { managePositions, getAllSignals, updateSignalState } from "@/lib/strategy";
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

    const { logs, confirmed } = await managePositions();

    for (const line of logs) {
      console.log(line);
    }

    // FIX: Only alert on newly CONFIRMED signals this run, guarded by alert_sent flag
    for (const signal of confirmed) {
      if (!signal.alert_sent) {
        try {
          await sendSignalAlert(signal);
          // Mark alert_sent so subsequent cron runs don't re-alert
          if (signal.id) {
            await updateSignalState(signal.id, "CONFIRMED", { alert_sent: true } as any);
          }
          console.log(`[TELEGRAM] Sent CONFIRMED alert for ${signal.symbol}`);
        } catch {
          console.log(`[TELEGRAM] Failed to send alert for ${signal.symbol}`);
        }
      }
    }

    // Fetch updated signals after position management
    const signals = await getAllSignals();

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
