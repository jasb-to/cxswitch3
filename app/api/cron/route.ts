import { NextRequest, NextResponse } from "next/server";
import { generateSetups } from "@/lib/strategy-v21";
import { enqueueAlert } from "@/lib/telegram-worker";
import { refreshMarketData } from "@/lib/market-data-layer";
import { getSnapshot, setSnapshot, type RuntimeSnapshot } from "@/lib/runtime-snapshot";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * v21.2.0 - FINAL DETERMINISTIC IMPULSE ENGINE + INPUT GUARANTEE LAYER
 * 
 * Every cron cycle:
 * 1. Fetch live market data
 * 2. Derive all signals from current market conditions only
 * 3. Replace snapshot atomically
 * 4. Emit alerts only on state transitions (NONE↔BUILDING↔ACTIVE_SNIPER)
 * 
 * Pure impulse-driven execution with hard input sanitiser.
 * No NaN can enter pipeline. No state decay, no upgrades/downgrades.
 * BUILDING persists as long as directional emergence exists.
 * ACTIVE_SNIPER fires and never revokes once impulse >= 27.
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

    console.log("[CRON] v21.2.0 START - Final Deterministic Impulse Engine + Input Guarantee Layer");
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
      if (!card) {
        console.log(`[ALERT_ENQUEUE_ERROR] ${symbol}: Card not found in newCards array`);
        continue;
      }

      // Only alert if now in ACTIVE_SNIPER (CONFIRMED state removed in v21.0.0)
      if (card.signalState === "ACTIVE_SNIPER") {
        console.log(`[ALERT_ENQUEUE_START] ${symbol}: state=${card.signalState} price=${card.price} targetPrices=${JSON.stringify(card.targetPrices)}`);
        
        // Validate card has necessary fields before enqueuing
        const missingFields: string[] = [];
        if (!card.targetPrices) missingFields.push("targetPrices");
        if (!card.mode) missingFields.push("mode");
        if (!card.confidence) missingFields.push("confidence");
        if (!card.cycleId) missingFields.push("cycleId");
        
        if (missingFields.length > 0) {
          console.log(`[ALERT_ENQUEUE_ERROR] ${symbol}: Missing required fields: ${missingFields.join(", ")}`);
          continue;
        }
        
        enqueueAlert({
          card,
          symbol: card.symbol,
          mode: card.mode,
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
        
        console.log(`[ALERT_ENQUEUE_SUCCESS] ${symbol}: Queued for telegram`);
      } else {
        console.log(`[ALERT_ENQUEUE_SKIP] ${symbol}: state=${card.signalState} is not ACTIVE_SNIPER`);
      }
    }

    const totalMs = Date.now() - cronStart;
    console.log(`[CRON] v21.2.0 COMPLETE in ${totalMs}ms`);

    return NextResponse.json({
      ok: true,
      version: "v21.0.0",
      perf: {
        totalMs,
        cardsGenerated: newCards.length,
        setupsQueued: newSetups.length,
        stateTransitions: alertSymbols.length,
        alertsEmitted: alertSymbols.filter(s => newCards.find(c => c.symbol === s && c.signalState === "ACTIVE_SNIPER")).length,
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
