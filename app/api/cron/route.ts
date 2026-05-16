import { NextRequest, NextResponse } from "next/server";
import { generateSetups } from "@/lib/strategy-v21";
import { enqueueAlert } from "@/lib/telegram-worker";
import { refreshMarketData } from "@/lib/market-data-layer";
import { getSnapshot, setSnapshot, type RuntimeSnapshot } from "@/lib/runtime-snapshot";
import { PERSISTENCE_CONFIG, validateConfig } from "@/lib/signal-config";
import { formatNumber, formatPrice, formatPercent } from "@/lib/format-utils";

// v22.1-final: Cache bust to force rebuild of server chunks (fix stale impulse references)
// Build timestamp: ${Date.now()}

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * v22.0 - QUALITY FILTER LAYER (MULTI-CYCLE STABILITY + CONFIDENCE GATING)
 * 
 * Every cron cycle:
 * 1. Fetch live market data
 * 2. Derive all signals from current market conditions only
 * 3. Apply enhanced multi-cycle quality filter
 * 4. Replace snapshot atomically
 * 5. Emit alerts ONLY on NEW EVENT CREATION (not state changes)
 * 
 * Pure event-driven execution with multi-cycle stability checks.
 * Confidence must be >= 70, direction consistent across cycles.
 */
export async function GET(req: NextRequest) {
  try {
    // v24.2: Validate config at runtime (INVARIANT 1: No missing constants)
    validateConfig();
    
    const secret = process.env.CRON_SECRET;
    if (secret) {
      const auth = req.headers.get("authorization");
      const query = new URL(req.url).searchParams.get("secret");
      if (auth !== `Bearer ${secret}` && query !== secret) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }
    }

    console.log("[CRON] v24.3 START - Permissive Pipeline + Defensive Formatting");
    const cronStart = Date.now();

    // STEP 1: Fetch live market data
    const market = await refreshMarketData();
    console.log(`[MARKET] Refreshed in ${Date.now() - cronStart}ms`);

    // STEP 2: Generate all signals from current market conditions
    const { cards: newCards, setups: newSetups } = await generateSetups(market);
    console.log(`[GENERATION] Generated ${newCards.length} cards, ${newSetups.length} setups in ${Date.now() - cronStart}ms`);

    // v24.3 FIX 3: PERMISSIVE SNAPSHOT (no rejection logic)
    // Never block write due to partial failures
    // If setups missing, attach fallback setups from impulse engine
    let finalSetups = newSetups;
    if (newCards.length > 0 && newSetups.length === 0) {
      console.log(
        `[SNAPSHOT_PERMISSIVE] Generated ${newCards.length} cards but 0 setups. ` +
        `Building fallback setups to ensure atomicity.`
      );
      // Create minimal fallback setups for cards that need them
      finalSetups = newCards
        .filter(c => c.signalState === "ACTIVE_SNIPER" && c.direction !== "NEUTRAL")
        .map((card) => ({
          symbol: card.symbol,
          mode: "SNIPER" as const,
          direction: card.direction as "LONG" | "SHORT",
          score: Math.ceil(card.confidence ?? 50),
          reason: `Fallback setup for ${card.signalState}`,
          price: card.price,
          entry: card.price,
          tp: card.targetPrices?.tp1 ?? card.price * 1.02,
          sl: card.targetPrices?.sl ?? card.price * 0.98,
          tp1: card.targetPrices?.tp1 ?? card.price * 1.02,
          tp2: card.targetPrices?.tp2 ?? card.price * 1.04,
          momentum: {},
          targetPrices: card.targetPrices,
          riskReward: card.riskReward,
        }));
      console.log(`[SNAPSHOT_PERMISSIVE] Created ${finalSetups.length} fallback setups`);
    }

    // STEP 3: Get previous snapshot for alert transition detection only
    const prevSnapshot = getSnapshot();
    const prevCards = prevSnapshot?.cards || [];
    const prevCardMap = new Map(prevCards.map(c => [c.symbol, c]));

    // STEP 4: Determine alerts based on NEW EVENT CREATION ONLY (v21.3.0)
    const alertCards: typeof newCards = [];
    for (const newCard of newCards) {
      // v21.3.0: Alert only if new event was just created
      const newEventMarker = (newCard as any)._newEventFired;
      if (newEventMarker) {
        alertCards.push(newCard);
        // FIX 2: Defensive formatting to prevent toFixed crashes
        const entryStr = formatPrice(newEventMarker.entry);
        const impulseStr = formatPercent(newEventMarker.impulse);
        console.log(`[EVENT_ALERT_TRIGGER] ${newCard.symbol}: NEW SNIPER_EVENT fired ` +
          `entry=${entryStr} impulse=${impulseStr}%`
        );
      }
    }

    // STEP 5: ATOMIC snapshot replacement (no merging, no patching)
    const newSnapshot: RuntimeSnapshot = {
      updatedAt: new Date().toISOString(),
      cards: newCards,
      setups: finalSetups,  // Use finalSetups (may have fallbacks)
    };
    setSnapshot(newSnapshot);
    console.log(`[SNAPSHOT_REPLACED] Atomic replacement: ${newCards.length} cards, ${finalSetups.length} setups`);

    // STEP 6: Enqueue alerts for NEW SNIPER_EVENTS ONLY (v21.3.0)
    for (const card of alertCards) {
      // v21.3.0: Event just fired - send alert immediately
      // FIX 2: Defensive formatting
      const priceStr = formatPrice(card.price);
      const tp1Str = formatPrice(card.targetPrices?.tp1);
      console.log(`[ALERT_ENQUEUE_START] ${card.symbol}: NEW EVENT entry=${priceStr} tp=${tp1Str}`);
      
      // Validate card has necessary fields before enqueuing
      const missingFields: string[] = [];
      if (!card.targetPrices) missingFields.push("targetPrices");
      if (!card.mode) missingFields.push("mode");
      if (!card.confidence) missingFields.push("confidence");
      if (!card.cycleId) missingFields.push("cycleId");
      
      if (missingFields.length > 0) {
        console.log(`[ALERT_ENQUEUE_ERROR] ${card.symbol}: Missing required fields: ${missingFields.join(", ")}`);
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
      
      console.log(`[ALERT_ENQUEUE_SUCCESS] ${card.symbol}: Telegram alert queued for NEW EVENT`);
    }

    const totalMs = Date.now() - cronStart;
    console.log(`[CRON] v24.3 COMPLETE in ${totalMs}ms - Permissive pipeline finished`);

    return NextResponse.json({
      ok: true,
      version: "v24.3",
      perf: {
        totalMs,
        cardsGenerated: newCards.length,
        setupsQueued: finalSetups.length,
        setupsFallback: finalSetups.length - newSetups.length,
        newEventsCreated: alertCards.length,
        alertsEmitted: alertCards.length,
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
