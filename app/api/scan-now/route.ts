import { NextResponse } from "next/server";
import { generateSignals } from "@/lib/strategy";
import { reconcileAgainstMarketHealth } from "@/lib/state-orchestrator";
import { sendSignalAlert, shouldSendAlert } from "@/lib/telegram";
import { isMarketDataFresh, refreshMarketData } from "@/lib/market-data-layer";
import { getAllActiveSignals } from "@/lib/state-repository";

export const dynamic = "force-dynamic";

// Manual scan trigger — runs the full signal generation cycle without needing cron secret
export async function POST() {
  try {
    console.log("[SCAN-NOW] Manual signal scan triggered");

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
          console.log(`[TELEGRAM] ✓ Sent ${signal.state} alert for ${signal.symbol} (manual scan)`);
        } catch {
          console.log(`[TELEGRAM] ✗ Failed to send alert for ${signal.symbol}`);
        }
      }
    }

    const allSignals = await getAllActiveSignals();
    return NextResponse.json({ ok: true, signals: allSignals, logs });
  } catch (error) {
    console.error('[POST /api/scan-now ERROR]', error);
    return NextResponse.json(
      { error: 'Internal error', details: error instanceof Error ? error.message : 'Unknown', ok: false, logs: [] },
      { status: 500 }
    );
  }
}
