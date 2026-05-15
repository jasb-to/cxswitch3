import { NextRequest, NextResponse } from "next/server";
import { generateSetups } from "@/lib/strategy-v6";
import { enqueueAlert } from "@/lib/telegram-worker";
import { refreshMarketData } from "@/lib/market-data-layer";
import { getSnapshot, setSnapshot, type RuntimeSnapshot } from "@/lib/runtime-snapshot";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * v20.4.0 - SNIPER IMPULSE DETECTION ENGINE
 * 
 * Every cron cycle:
 * 1. Fetch live market data
 * 2. Derive SNIPER impulse signals from current market conditions only
 * 3. Apply HTF expectancy scaler (±3% minimal influence)
 * 4. Replace snapshot atomically
 * 5. Emit alerts only on state transitions (NONE↔BUILDING↔SNIPER/CONFIRMED)
 * 
 * Pure impulse-driven with early-entry sensitivity (threshold 27).
 * SNIPER fires unconditionally on structural impulse emergence.
 * HTF provides context only, never suppression.
 */
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

    console.log("[CRON] v20.4.0 START - SNIPER Impulse Detection Engine");
    const cronStart = Date.now();

    // STEP 1: Fetch live market data
    const market = await refreshMarketData();
    console.log(`[MARKET] Refreshed in ${Date.now() - cronStart}ms`);

    // STEP 2: Generate all signals from current market conditions
    const { cards: newCards, setups: newSetups } = await generateSetups(market);
    console.log(`[GENERATION] Generated ${newCards.length} cards, ${newSetups.length} setups in ${Date.now() - cronStart}ms`);

    // STEP 3: Get previous snapshot for alert transition detection only
    const prevSnapshot = getSnapshot();
    const prevCards = prevSnapshot?.cards || [];
    const prevCardMap = new Map(prevCards.map(c => [c.symbol, c]));

    // STEP 4: Determine alerts based on state transitions only
    const alertSymbols: string[] = [];
    for (const newCard of newCards) {
      const prevCard = prevCardMap.get(newCard.symbol);
      const prevState = prevCard?.signalState || "NONE";
      const newState = newCard.signalState || "NONE";

      // Alert only if state changed
      if (prevState !== newState) {
        console.log(`[STATE_TRANSITION] ${newCard.symbol}: ${prevState} → ${newState}`);
        alertSymbols.push(newCard.symbol);
      }
    }

    // STEP 5: ATOMIC snapshot replacement (no merging, no patching)
    const newSnapshot: RuntimeSnapshot = {
      updatedAt: new Date().toISOString(),
      cards: newCards,
      setups: newSetups,
    };
    setSnapshot(newSnapshot);
    console.log(`[SNAPSHOT_REPLACED] Atomic replacement: ${newCards.length} cards, ${newSetups.length} setups`);

    // STEP 6: Enqueue alerts for symbols with state transitions
    for (const symbol of alertSymbols) {
      const card = newCards.find(c => c.symbol === symbol);
      if (!card) continue;

      // Only alert if now in ACTIVE_SNIPER or ACTIVE_CONFIRMED (not for NONE→BUILDING)
      if (card.signalState === "ACTIVE_SNIPER" || card.signalState === "ACTIVE_CONFIRMED") {
        console.log(`[ALERT_QUEUE] ${symbol}: ${card.signalState}`);
        
        enqueueAlert({
          card,
          symbol: card.symbol,
          mode: card.signalState === "ACTIVE_CONFIRMED" ? "CONFIRMED" : "SNIPER",
          direction: card.direction,
          score: card.tradeReadinessScore ?? 0,
          price: card.price,
          source: card.source,
          signalState: card.signalState,
          targetPrices: card.targetPrices,
          htf4hTrend: card.htf4hTrend,
          execution15mState: card.execution15mState,
          queued: Date.now(),
        });
      }
    }

    const totalMs = Date.now() - cronStart;
    console.log(`[CRON] v20.4.0 COMPLETE in ${totalMs}ms`);

    return NextResponse.json({
      ok: true,
      version: "v20.4.0",
      perf: {
        totalMs,
        cardsGenerated: newCards.length,
        setupsQueued: newSetups.length,
        stateTransitions: alertSymbols.length,
        alertsEmitted: alertSymbols.filter(s => newCards.find(c => c.symbol === s && (c.signalState === "ACTIVE_SNIPER" || c.signalState === "ACTIVE_CONFIRMED"))).length,
      },
    });
  } catch (error) {
    console.error('[CRON ERROR]', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unknown', ok: false },
      { status: 500 }
    );
  }
}
