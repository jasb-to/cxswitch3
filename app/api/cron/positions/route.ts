import { NextRequest, NextResponse } from "next/server";
import { managePositions, getAllSignals, reconcileSignalsWithMarketData } from "@/lib/strategy";
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

    // FIRST: Reconcile active signals against market data
    // This validates all active positions and persists state changes immediately
    console.log("[POSITIONS CRON] Reconciling active signals with market data...");
    let activeSignals = await getAllSignals();
    console.log(`[POSITIONS CRON] Fetched ${activeSignals.length} active signals before reconciliation`);
    
    const reconciled = await reconcileSignalsWithMarketData(activeSignals);
    console.log(`[POSITIONS CRON] After reconciliation: ${reconciled.length} signals remain valid`);

    // THEN: Manage positions for reconciled signals
    const { logs, confirmed } = await managePositions();

    for (const line of logs) {
      console.log(line);
    }

    // FIX: Only alert on newly CONFIRMED signals — strict dedup by signal_id + CONFIRMED state
    for (const signal of confirmed) {
      // Check if we've already sent CONFIRMED alert for this exact signal
      if (await shouldSendAlert(signal.id!, signal.symbol, "CONFIRMED")) {
        try {
          await sendSignalAlert(signal);
          console.log(`[TELEGRAM] ✓ Sent CONFIRMED alert for ${signal.symbol} (signal ID ${signal.id})`);
        } catch (err) {
          console.log(`[TELEGRAM] ✗ Failed to send CONFIRMED alert for ${signal.symbol}`);
        }
      } else {
        console.log(`[TELEGRAM] ✗ Skipped CONFIRMED alert — already sent for signal ID ${signal.id}`);
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
