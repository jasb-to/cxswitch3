import { NextRequest, NextResponse } from "next/server";
import { managePositions } from "@/lib/strategy";
import { reconcileAgainstMarketHealth } from "@/lib/state-orchestrator";
import { sendSignalAlert, shouldSendAlert } from "@/lib/telegram";
import { isMarketDataFresh } from "@/lib/market-data-layer";

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
    console.log(`[CRON] Run started at ${runAt}`);

    // ORCHESTRATOR: Reconcile signals against market health
    // This applies business rules and persists state changes
    const marketHealthCheck = (symbol: string) => isMarketDataFresh(symbol);
    await reconcileAgainstMarketHealth(marketHealthCheck);

    // SIGNAL ENGINE: Generate new positions (logic only)
    const { logs, confirmed } = await managePositions();

    for (const line of logs) {
      console.log(line);
    }

    // TELEGRAM: Alert on confirmed signals
    for (const signal of confirmed) {
      if (await shouldSendAlert(signal.id!, signal.symbol, "CONFIRMED")) {
        try {
          await sendSignalAlert(signal);
          console.log(`[TELEGRAM] ✓ Sent alert for ${signal.symbol}`);
        } catch (err) {
          console.log(`[TELEGRAM] ✗ Failed to send alert for ${signal.symbol}`);
        }
      }
    }

    return NextResponse.json({
      ok: true,
      runAt,
      logs,
    });
  } catch (error) {
    console.error("[CRON ERROR]", error);
    return NextResponse.json(
      {
        error: "Internal error",
        details: error instanceof Error ? error.message : "Unknown",
        ok: false,
      },
      { status: 500 }
    );
  }
}
