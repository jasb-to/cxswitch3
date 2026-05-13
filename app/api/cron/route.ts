import { NextRequest, NextResponse } from "next/server";
import { generateSetups } from "@/lib/strategy-v6";
import { enqueueAlert } from "@/lib/telegram-worker";
import { refreshMarketData } from "@/lib/market-data-layer";
import { getSnapshot, setSnapshot, type RuntimeSnapshot } from "@/lib/runtime-snapshot";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * v16.3.0 - ATOMIC SNAPSHOT RECONCILIATION
 * 
 * BREAKING CHANGE: Removes all delta patching.
 * Every cycle replaces entire snapshot atomically.
 * Tracks invalidations and state downgrades.
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

    console.log("[CRON] v16.3.0 START - Atomic snapshot replacement");
    const cronStart = Date.now();

    // STEP 1: Refresh market data
    const market = await refreshMarketData();
    console.log(`[MARKET] Refreshed market data in ${Date.now() - cronStart}ms`);

    // STEP 2: Generate fresh snapshot (EVERYTHING from scratch)
    const { cards: newCards, setups: newSetups } = await generateSetups(market);
    console.log(`[GENERATION] Generated ${newCards.length} cards, ${newSetups.length} setups in ${Date.now() - cronStart}ms`);

    // STEP 3: Get previous snapshot for reconciliation
    const prevSnapshot = getSnapshot();
    const prevCards = prevSnapshot?.cards || [];

    // STEP 4: Reconcile state transitions (detect invalidations, downgrades)
    const invalidations = reconcileStateTransitions(prevCards, newCards);
    if (invalidations.length > 0) {
      console.log(`[RECONCILIATION] ${invalidations.length} state transitions detected:`);
      invalidations.forEach(inv => console.log(`  ${inv}`));
    }

    // STEP 5: Enforce rendering invariants
    const invariantViolations = checkRenderingInvariants(newCards);
    if (invariantViolations.length > 0) {
      console.error(`[INVARIANT_VIOLATIONS] ${invariantViolations.length} violations detected:`);
      invariantViolations.forEach(v => console.error(`  ${v}`));
      // Don't throw - just warn and continue
    }

    // STEP 6: Validate trade plans (only SNIPER/CONFIRMED can have plans)
    validateTradePlans(newCards);

    // STEP 7: ATOMIC snapshot replacement (NO MERGING, NO PATCHING)
    const newSnapshot: RuntimeSnapshot = {
      updatedAt: new Date().toISOString(),
      cards: newCards,
      setups: newSetups,
    };
    setSnapshot(newSnapshot);
    console.log(`[SNAPSHOT_REPLACED] Atomic replacement: ${newCards.length} cards, ${newSetups.length} setups`);

    // STEP 8: Enqueue alerts for executable setups
    for (const setup of newSetups) {
      const card = newCards.find(c => c.symbol === setup.symbol);
      if (!card) continue;

      enqueueAlert({
        card,
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
    console.log(`[ALERTS] Queued ${newSetups.length} alerts for executable setups`);

    const totalMs = Date.now() - cronStart;
    console.log(`[CRON] v16.3.0 COMPLETE in ${totalMs}ms`);

    return NextResponse.json({
      ok: true,
      version: "v16.3.0",
      perf: { totalMs, cardsGenerated: newCards.length, setupsQueued: newSetups.length, invalidations: invalidations.length },
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
 * Reconcile state transitions between previous and new snapshot
 * Detect downgrades, invalidiations, and removed setups
 */
function reconcileStateTransitions(prevCards: any[], newCards: any[]): string[] {
  const transitions: string[] = [];
  const prevMap = new Map(prevCards.map(c => [c.symbol, c]));

  for (const newCard of newCards) {
    const prevCard = prevMap.get(newCard.symbol);
    if (!prevCard) continue;

    const prevState = prevCard.signalState || "NONE";
    const newState = newCard.signalState || "NONE";

    if (prevState !== newState) {
      transitions.push(`[STATE_TRANSITION] ${newCard.symbol}: ${prevState} → ${newState}`);

      // Downgrade detection
      if (isDowngrade(prevState, newState)) {
        transitions.push(`[SIGNAL_DOWNGRADE] ${newCard.symbol}: ${prevState} → ${newState}`);
        
        if ((prevState === "ACTIVE_SNIPER" || prevState === "ACTIVE_CONFIRMED") && newState === "BUILDING") {
          transitions.push(`[SETUP_REMOVED] ${newCard.symbol}: Was executable, now building`);
        }
      }

      // Invalidation detection
      if (isInvalidation(prevState, newState)) {
        transitions.push(`[SIGNAL_INVALIDATED] ${newCard.symbol}: ${prevState} → ${newState}`);
      }
    }
  }

  return transitions;
}

/**
 * Check for impossible state combinations
 */
function checkRenderingInvariants(cards: any[]): string[] {
  const violations: string[] = [];

  for (const card of cards) {
    const state = card.signalState || "NONE";
    const confidence = card.tradeReadinessScore ?? 0;

    // SNIPER + BUILDING is impossible
    if (state === "ACTIVE_SNIPER" && card.setupStatus === "BUILDING") {
      violations.push(`[STATE_MISMATCH] ${card.symbol}: ACTIVE_SNIPER but setupStatus=BUILDING`);
    }

    // CONFIRMED + LOW_QUALITY is suspicious
    if (state === "ACTIVE_CONFIRMED" && confidence < 50) {
      violations.push(`[STATE_MISMATCH] ${card.symbol}: ACTIVE_CONFIRMED but confidence=${confidence}%`);
    }

    // BUILDING + executable trade plan is impossible
    if (state === "BUILDING" && card.targetPrices) {
      violations.push(`[STATE_MISMATCH] ${card.symbol}: BUILDING state has trade plan (TP/SL present)`);
    }

    // ACTIVE_SNIPER/CONFIRMED must have direction
    if ((state === "ACTIVE_SNIPER" || state === "ACTIVE_CONFIRMED") && card.direction === "NEUTRAL") {
      violations.push(`[STATE_MISMATCH] ${card.symbol}: ${state} with NEUTRAL direction`);
    }
  }

  return violations;
}

/**
 * Validate trade plan lifecycle
 * Plans only exist if state >= SNIPER
 */
function validateTradePlans(cards: any[]): void {
  for (const card of cards) {
    const state = card.signalState || "NONE";
    const hasTargets = !!card.targetPrices;

    if ((state === "BUILDING" || state === "NONE") && hasTargets) {
      console.log(`[TRADE_PLAN_VIOLATION] ${card.symbol}: ${state} state has targetPrices, clearing`);
      card.targetPrices = null;
      card.riskReward = null;
    }

    if ((state === "ACTIVE_SNIPER" || state === "ACTIVE_CONFIRMED") && !hasTargets) {
      console.log(`[TRADE_PLAN_MISSING] ${card.symbol}: ${state} state missing targetPrices`);
    }
  }
}

/**
 * Detect downgrade transitions
 */
function isDowngrade(from: string, to: string): boolean {
  const stateRank = { "NONE": 0, "BUILDING": 1, "ACTIVE_SNIPER": 2, "ACTIVE_CONFIRMED": 3 };
  return (stateRank[from as keyof typeof stateRank] || 0) > (stateRank[to as keyof typeof stateRank] || 0);
}

/**
 * Detect invalidation transitions
 */
function isInvalidation(from: string, to: string): boolean {
  return (from === "ACTIVE_CONFIRMED" || from === "ACTIVE_SNIPER") && (to === "NONE" || to === "BUILDING");
}
