import { NextRequest, NextResponse } from "next/server";
import { generateSetups } from "@/lib/strategy-v6";
import { enqueueAlert } from "@/lib/telegram-worker";
import { refreshMarketData } from "@/lib/market-data-layer";
import { getSnapshot, setSnapshot } from "@/lib/runtime-snapshot";
import { calculatePatches, applySnapshotPatches } from "@/lib/snapshot-patcher";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// v7.2.7 FIX #3: CRON optimized for delta updates, not full rebuilds
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

    console.log("[CRON] Start - v7.2.7 tiered optimization");
    const cronStart = Date.now();

    // STEP 1: Refresh market data (TIER 1 - always fast)
    const market = await refreshMarketData();
    console.log(`[TIER1] Market refresh: ${Date.now() - cronStart}ms`);

    // STEP 2: Generate new cards (includes tiered caching internally)
    const { cards: newCards, setups } = await generateSetups(market);
    console.log(`[TIER2/3] Card generation: ${Date.now() - cronStart}ms - ${newCards.length} cards, ${setups.length} setups`);

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

    // STEP 5: Enqueue alerts (v7.5.6: Transition-based deduplication)
    // v7.5.5: Pass full card for complete formatting
    // v7.5.6: Call enqueueAlert for ALL setups - enqueueAlert handles deduplication
    // Only alerts with state transitions are actually queued (prevents spam while state persists)
    for (const setup of setups) {
      // Find the corresponding card to pass complete enriched object
      const card = newCards.find(c => c.symbol === setup.symbol);
      
      if (!card) continue; // Skip if card not found (shouldn't happen)
      
      enqueueAlert({
        // v7.5.5: Pass full enriched card object to Telegram formatter
        card,
        
        // Legacy minimal fields (for backward compat, derived from card)
        symbol: card.symbol,
        mode: setup.mode,
        direction: setup.direction,
        score: setup.score,
        price: card.price,
        source: card.source,
        signalState: card.signalState,
        targetPrices: card.targetPrices,
        htf4hTrend: card.htf4hTrend,
        execution15mState: card.execution15mState,
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
