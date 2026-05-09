import { NextRequest, NextResponse } from "next/server";
import { generateSignals, persistSignals } from "@/lib/strategy";
import { sendSignalAlert } from "@/lib/telegram";
import { refreshMarketData } from "@/lib/market-data-layer";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// ONLY CRON ENTRY POINT - runs 4-step pipeline
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
    console.log(`[CRON] Started ${runAt}`);

    // STEP 1: Refresh market data
    await refreshMarketData();
    console.log("[CRON] Market data refreshed");

    // STEP 2: Generate signals
    const { signals, logs } = await generateSignals();
    for (const line of logs) {
      console.log(line);
    }

    // STEP 3: Persist signals
    const persisted = await persistSignals(signals);
    console.log(`[CRON] Persisted ${persisted.length} signals`);

    // STEP 4: Send Telegram alerts
    for (const signal of persisted) {
      try {
        await sendSignalAlert(signal);
        console.log(`[TELEGRAM] ✓ Sent alert for ${signal.symbol}`);
      } catch (err) {
        console.log(`[TELEGRAM] ✗ Failed for ${signal.symbol}`);
      }
    }

    console.log(`[CRON] Complete at ${new Date().toISOString()}`);

    return NextResponse.json({
      ok: true,
      signals: persisted,
      runAt,
    });
  } catch (error) {
    console.error('[CRON ERROR]', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unknown error', ok: false },
      { status: 500 }
    );
  }
}
