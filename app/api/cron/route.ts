import { NextRequest, NextResponse } from "next/server";
import { generateSetups } from "@/lib/strategy-v6";
import { sendAlert, canSendAlert } from "@/lib/telegram-v6";
import { refreshMarketData } from "@/lib/market-data-layer";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// ONLY CRON ENTRY POINT - Scanner runs every minute
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

    console.log("[CRON] Start");

    // STEP 1: Refresh market cache and log status
    const market = await refreshMarketData();
    
    // Log market status
    for (const [symbol, priceData] of Object.entries(market)) {
      const status = priceData.source === "DEGRADED" ? "DEGRADED" : "LIVE";
      console.log(`[MARKET] ${symbol} ${status}`);
    }

    // STEP 2: Generate setups (PURE engine)
    const setups = await generateSetups(market);

    // STEP 3: Check cooldown and send alerts
    const sent = [];
    for (const setup of setups) {
      if (await canSendAlert(setup.symbol, setup.mode, setup.direction)) {
        try {
          await sendAlert(setup);
          sent.push(setup);
          console.log(`[ALERT] ${setup.symbol} sent`);
        } catch (err) {
          console.log(`[ALERT] ${setup.symbol} failed`);
        }
      }
    }

    console.log("[CRON] Complete");

    return NextResponse.json({ ok: true, setups, sent });
  } catch (error) {
    console.error('[CRON ERROR]', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unknown', ok: false },
      { status: 500 }
    );
  }
}
