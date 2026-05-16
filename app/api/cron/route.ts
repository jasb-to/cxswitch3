import { NextRequest, NextResponse } from "next/server";
import { generateSetups, generateDisplayCards } from "@/lib/strategy-v6";
import { enqueueAlert } from "@/lib/telegram-worker";
import { refreshMarketData } from "@/lib/market-data-layer";
import { getSnapshot, setSnapshot } from "@/lib/runtime-snapshot";
import { calculatePatches, applySnapshotPatches } from "@/lib/snapshot-patcher";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// v8.0: CRON with hard pipeline segregation (execution vs display)
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

    console.log("[CRON] Start - v8.0 hard pipeline segregation");
    const cronStart = Date.now();

    // STEP 1: Refresh market data with segregation
    // Returns { execution: Record<string, PriceData>, display: Record<string, PriceData> }
    const segregatedMarkets = await refreshMarketData();
    console.log(`[TIER1] Market segregation: ${Date.now() - cronStart}ms`);

    // STEP 2a: Generate execution pipeline cards + setups
    // ONLY Kraken data, ONLY execution-grade signals
    const { cards: executionCards, setups } = await generateSetups(segregatedMarkets);
    
    // STEP 2b: Generate display pipeline cards
    // ONLY fallback data, display-only UI cards
    const displayCards = generateDisplayCards(segregatedMarkets.display);
    
    // STEP 2c: Merge cards for snapshot (execution first, then display)
    const newCards = [...executionCards, ...displayCards];
    console.log(`[TIER2/3] Card generation: ${Date.now() - cronStart}ms - ${executionCards.length} execution cards + ${displayCards.length} display cards, ${setups.length} setups`);

    // STEP 3: Apply delta patching (FIX #5)
    // Instead of replacing entire snapshot, patch only changed cards
    const existingSnapshot = getSnapshot();
    const existingCards = existingSnapshot?.cards || [];
    
    const patches = calculatePatches(existingCards, newCards);
    const patchedCards = applySnapshotPatches(existingCards, patches.map(p => ({
      symbol: p.symbol,
      fields: p.fields,
      timestamp: p.timestamp,
    })));
    
    console.log(`[DELTA] Patches applied: ${patches.length} changed cards out of ${newCards.length}`);

    // STEP 4: Update snapshot (only changed parts)
    setSnapshot({
      updatedAt: new Date().toISOString(),
      cards: patchedCards,
      setups,
    });

    // STEP 5: Enqueue alerts (FIX #6 - decoupled, non-blocking)
    // v7.3.1 FIX #1, #2, #3: Include all HTF data for execution gate and validation
    // Do NOT await - let alerts process independently
    for (const setup of setups) {
      // Find the corresponding card to get signalState, targetPrices, and HTF data
      const card = newCards.find(c => c.symbol === setup.symbol);
      
      enqueueAlert({
        symbol: setup.symbol,
        mode: setup.mode,
        direction: setup.direction,
        score: setup.score,
        price: setup.price,
        source: card?.source, // v7.3.1: validate price source
        signalState: card?.signalState, // v7.3.0 FIX #1: execution gate check
        targetPrices: card?.targetPrices, // v7.3.0 FIX #2: payload validation
        htf4hTrend: card?.htf4hTrend, // v7.3.1: HTF validation
        execution15mState: card?.execution15mState, // v7.3.1: 15M execution validation
        queued: Date.now(),
      });
    }

    const totalMs = Date.now() - cronStart;
    console.log(`[CRON] Complete in ${totalMs}ms - queued ${setups.length} alerts`);

    return NextResponse.json({ 
      ok: true, 
      perf: { totalMs, patchesApplied: patches.length, alertsQueued: setups.length }
    });
  } catch (error) {
    console.error('[CRON ERROR]', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unknown', ok: false },
      { status: 500 }
    );
  }
}
