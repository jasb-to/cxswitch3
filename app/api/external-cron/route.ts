import { NextRequest, NextResponse } from "next/server";
import { generateSignals } from "@/lib/strategy";
import { reconcileAgainstMarketHealth } from "@/lib/state-orchestrator";
import { sendSignalAlert, shouldSendAlert } from "@/lib/telegram";
import { isMarketDataFresh, refreshMarketData } from "@/lib/market-data-layer";
import { getAllActiveSignals } from "@/lib/state-repository";

export const dynamic = "force-dynamic";

// External cron trigger for third-party schedulers (Vercel Cron, EasyCron, etc)
export async function GET(req: NextRequest) {
  try {
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

    // MARKET: Refresh prices from cache
    await refreshMarketData();

    // ORCHESTRATOR: Reconcile signals against market health
    const marketHealthCheck = (symbol: string) => isMarketDataFresh(symbol);
    await reconcileAgainstMarketHealth(marketHealthCheck);

    // SIGNAL ENGINE: Generate new signals
    const { signals, logs } = await generateSignals();

    for (const line of logs) {
      console.log(line);
    }

    // TELEGRAM: Alert on new signals
    for (const signal of signals) {
      if (await shouldSendAlert(signal.id!, signal.symbol, signal.state)) {
        try {
          await sendSignalAlert(signal);
          console.log(`[TELEGRAM] ✓ Sent ${signal.state} alert for ${signal.symbol}`);
        } catch (err) {
          console.log(`[TELEGRAM] ✗ Failed to send alert for ${signal.symbol}`);
        }
      }
    }

    const allSignals = await getAllActiveSignals();
    return NextResponse.json({
      ok: true,
      runAt,
      signals: allSignals,
      logs,
    });
  } catch (error) {
    console.error('[GET /api/external-cron ERROR]', error);
    return NextResponse.json(
      { error: 'Internal error', details: error instanceof Error ? error.message : 'Unknown', ok: false, logs: [] },
      { status: 500 }
    );
  }
}
