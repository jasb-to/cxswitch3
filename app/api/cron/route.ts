import { NextRequest, NextResponse } from "next/server";
import { generateSignals } from "@/lib/strategy";
import { reconcileAgainstMarketHealth } from "@/lib/state-orchestrator";
import { sendSignalAlert, shouldSendAlert } from "@/lib/telegram";
import { refreshMarketData, isMarketDataFresh } from "@/lib/market-data-layer";
import { getAllActiveSignals } from "@/lib/state-repository";
import { supabase } from "@/lib/supabase-client";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Main cron entry point — runs every minute via vercel.json
export async function GET(req: NextRequest) {
  try {
    const secret = process.env.CRON_SECRET;
    if (secret) {
      const auth = req.headers.get("authorization");
      const query = new URL(req.url).searchParams.get("secret");
      if (auth !== `Bearer ${secret}` && query !== secret) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }
    }

    const runAt = new Date().toISOString();
    console.log(`[CRON] Cycle started at ${runAt}`);

    // 1. MARKET: Refresh prices
    await refreshMarketData();

    // 2. ORCHESTRATOR: Reconcile signals against market health
    const marketHealthCheck = (symbol: string) => isMarketDataFresh(symbol);
    await reconcileAgainstMarketHealth(marketHealthCheck);

    // 3. SIGNAL ENGINE: Generate new signals
    const { signals, logs } = await generateSignals();

    for (const line of logs) {
      console.log(line);
    }

    // 4. TELEGRAM: Alert on new signals
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

    // Log cycle summary
    console.log(`[CRON CYCLE] Complete — ${allSignals.length} total signals | ${signals.length} new signals generated`);

    return NextResponse.json({
      ok: true,
      signals: allSignals,
      logs,
      runAt,
    });
  } catch (error) {
    console.error('[GET /api/cron ERROR]', error);
    return NextResponse.json(
      { error: 'Internal error', details: error instanceof Error ? error.message : 'Unknown', ok: false, logs: [] },
      { status: 500 }
    );
  }
}
