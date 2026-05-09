import { NextRequest, NextResponse } from "next/server";
import { generateSetups } from "@/lib/strategy-v6";
import { sendAlert, canSendAlert } from "@/lib/telegram-v6";
import { refreshMarketData } from "@/lib/market-data-layer";
import { setSnapshot } from "@/lib/runtime-snapshot";

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
      const status = priceData.source === "kraken_live" ? "LIVE" : "CACHED";
      console.log(`[MARKET] ${symbol} ${status}`);
    }

    // STEP 2: Generate symbol cards + setups
    const { cards, setups } = await generateSetups(market);
    console.log(`[SCAN] Generated ${cards.length} cards, ${setups.length} setups`);

    // STEP 3: Store snapshot as single source of truth
    setSnapshot({
      updatedAt: new Date().toISOString(),
      cards,
      setups,
    });

    // STEP 4: Check cooldown and send alerts
    console.log(`[ALERT DEBUG] ${setups.length} setups to process`);
    
    const sent = [];
    for (const setup of setups) {
      console.log(`[ALERT DEBUG] Checking ${setup.symbol} ${setup.mode}...`);
      
      if (await canSendAlert(setup.symbol, setup.mode, setup.direction)) {
        try {
          await sendAlert(setup);
          sent.push(setup);
          console.log(`[ALERT] ${setup.symbol} sent successfully`);
        } catch (err) {
          console.log(`[ALERT] ${setup.symbol} failed:`, err);
        }
      } else {
        console.log(`[ALERT DEBUG] ${setup.symbol} blocked by cooldown`);
      }
    }

    console.log(`[CRON] Complete - sent ${sent.length}/${setups.length} alerts`);

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('[CRON ERROR]', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unknown', ok: false },
      { status: 500 }
    );
  }
}
