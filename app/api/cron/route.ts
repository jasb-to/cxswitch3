import { NextRequest, NextResponse } from "next/server";
import { generateSetups, deriveSignalLifecycle, checkSignalInvariants, type SignalLifecycle, type DerivedSignal, type MarketStructureClass } from "@/lib/strategy-v6";
import { enqueueAlert } from "@/lib/telegram-worker";
import { refreshMarketData } from "@/lib/market-data-layer";
import { getSnapshot, setSnapshot, type RuntimeSnapshot } from "@/lib/runtime-snapshot";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * v16.4.0 - CANONICAL SIGNAL LIFECYCLE ENGINE
 * 
 * Complete removal of stale persistence and ghost trades.
 * Every signal processed through deriveSignalLifecycle() canonical reducer.
 * Explicit expiration and invalidation enforcement.
 * Full invariant checking before snapshot publication.
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

    console.log("[CRON] v16.4.0 START - Canonical Signal Lifecycle Engine");
    const cronStart = Date.now();
    const nowMs = cronStart;

    // STEP 1: Refresh market data
    const market = await refreshMarketData();
    console.log(`[MARKET] Refreshed in ${Date.now() - cronStart}ms`);

    // STEP 2: Generate fresh derived signals (all cards from scratch)
    const { cards: newCards, setups: newSetups } = await generateSetups(market);
    console.log(`[GENERATION] Generated ${newCards.length} cards, ${newSetups.length} setups in ${Date.now() - cronStart}ms`);

    // STEP 3: Get previous snapshot and lifecycles
    const prevSnapshot = getSnapshot();
    const prevLifecycles = (prevSnapshot as any)?.lifecycles || [];
    const prevLifecycleMap = new Map(prevLifecycles.map((lc: SignalLifecycle) => [lc.symbol, lc]));

    // STEP 4: Derive lifecycles for ALL signals using canonical reducer
    const newLifecycles: SignalLifecycle[] = [];
    const lifecycleTransitions: string[] = [];
    
    for (const card of newCards) {
      const prevLifecycle = prevLifecycleMap.get(card.symbol);
      
      // Build market context for lifecycle derivation
      const lifecycleMarket = {
        ignition: card.ignitionProbability ?? 0,
        marketClass: card.marketClass,
        direction: card.direction,
        htfTrend: card.htf4hTrend ?? null,
        ltfBias: card.ltfBias ?? "NEUTRAL",
        price: card.price,
      };
      
      // Derive signal using canonical lifecycle reducer
      const newLifecycle = deriveSignalLifecycle(
        card.symbol,
        prevLifecycle,
        {
          state: card.signalState,
          direction: card.direction,
          confidence: card.tradeReadinessScore ?? 0,
          type: card.marketClass === "EARLY_REVERSAL" ? "REVERSAL" : "TREND",
          targets: card.targetPrices ? {
            entry: card.price,
            takeProfit: [card.targetPrices.tp1, card.targetPrices.tp2],
            stopLoss: card.targetPrices.sl,
            expectedMove: card.expectedMovePercent ?? 0,
            riskReward: card.riskReward ?? 0,
          } : undefined,
        } as DerivedSignal,
        lifecycleMarket,
        nowMs
      );
      
      newLifecycles.push(newLifecycle);
      
      // Track transitions for logging
      if (prevLifecycle && prevLifecycle.lifecycleState !== newLifecycle.lifecycleState) {
        lifecycleTransitions.push(`${card.symbol}: ${prevLifecycle.lifecycleState} → ${newLifecycle.lifecycleState}`);
      }
    }
    
    if (lifecycleTransitions.length > 0) {
      console.log(`[LIFECYCLE_TRANSITIONS] ${lifecycleTransitions.length} transitions detected:`);
      lifecycleTransitions.forEach(t => console.log(`  ${t}`));
    }

    // STEP 5: Check rendering invariants for all lifecycles
    const invariantViolations: string[] = [];
    for (const lifecycle of newLifecycles) {
      const violations = checkSignalInvariants(lifecycle);
      invariantViolations.push(...violations);
    }
    
    if (invariantViolations.length > 0) {
      console.error(`[INVARIANT_VIOLATIONS] ${invariantViolations.length} violations detected:`);
      invariantViolations.forEach(v => console.error(`  ${v}`));
    }

    // STEP 6: Filter renderable signals for UI
    const renderableLifecycles = newLifecycles.filter(lc => lc.renderable);
    console.log(`[RENDERING] ${renderableLifecycles.length}/${newLifecycles.length} signals are renderable`);

    // STEP 7: Determine which signals should emit alerts (only on transition)
    const alertsToEmit = determineAlerts(newLifecycles, prevLifecycleMap);
    console.log(`[ALERTS] ${alertsToEmit.length} signals should emit alerts (on transition)`);

    // STEP 8: ATOMIC snapshot replacement with lifecycles
    const newSnapshot: RuntimeSnapshot = {
      updatedAt: new Date().toISOString(),
      cards: newCards,
      setups: newSetups,
      lifecycles: newLifecycles,  // NEW: Include all lifecycle states
      renderableSymbols: renderableLifecycles.map(lc => lc.symbol),  // For UI efficiency
    };
    setSnapshot(newSnapshot);
    console.log(`[SNAPSHOT_REPLACED] Atomic replacement: ${newCards.length} cards, ${newSetups.length} setups, ${newLifecycles.length} lifecycles`);

    // STEP 9: Enqueue alerts ONLY for transition-based activations
    for (const alertSymbol of alertsToEmit) {
      const lifecycle = newLifecycles.find(lc => lc.symbol === alertSymbol);
      const card = newCards.find(c => c.symbol === alertSymbol);
      
      if (!lifecycle || !card) continue;
      if (!lifecycle.hasActiveTrade) continue;  // Only alert if has active trade

      console.log(`[ALERT_EMIT] ${alertSymbol}: ${lifecycle.previousState} → ${lifecycle.lifecycleState}`);
      
      enqueueAlert({
        card,
        symbol: card.symbol,
        mode: lifecycle.lifecycleState === "ACTIVE_CONFIRMED" ? "CONFIRMED" : "SNIPER",
        direction: lifecycle.derivedState.direction,
        score: lifecycle.derivedState.confidence,
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
    console.log(`[CRON] v16.4.0 COMPLETE in ${totalMs}ms`);

    return NextResponse.json({
      ok: true,
      version: "v16.4.0",
      perf: {
        totalMs,
        cardsGenerated: newCards.length,
        setupsQueued: newSetups.length,
        lifecyclesProcessed: newLifecycles.length,
        lifecycleTransitions: lifecycleTransitions.length,
        invariantViolations: invariantViolations.length,
        alertsEmitted: alertsToEmit.length,
        renderableSignals: renderableLifecycles.length,
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

/**
 * Determine which signals should emit alerts (only on state transitions)
 * Prevents repeated alerts for persistent states
 */
function determineAlerts(
  newLifecycles: SignalLifecycle[],
  prevLifecycleMap: Map<string, SignalLifecycle>
): string[] {
  const alertSymbols: string[] = [];
  
  for (const newLc of newLifecycles) {
    const prevLc = prevLifecycleMap.get(newLc.symbol);
    
    // Only alert on these transitions (not on persistent states)
    const alertTransitions = [
      "NONE→ACTIVE_SNIPER",
      "NONE→ACTIVE_CONFIRMED",
      "BUILDING→ACTIVE_SNIPER",
      "BUILDING→ACTIVE_CONFIRMED",
      "ACTIVE_SNIPER→ACTIVE_CONFIRMED",
    ];
    
    const transition = `${prevLc?.lifecycleState || "NONE"}→${newLc.lifecycleState}`;
    
    if (alertTransitions.includes(transition)) {
      alertSymbols.push(newLc.symbol);
    }
  }
  
  return alertSymbols;
}
