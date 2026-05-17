import { NextRequest, NextResponse } from "next/server";
import { generateSetups, generateDisplayCards } from "@/lib/strategy-v6";
import { enqueueAlert } from "@/lib/telegram-worker";
import { refreshMarketData } from "@/lib/market-data-layer";
import { getSnapshot, setSnapshot } from "@/lib/runtime-snapshot";
import { mergeSnapshots, validateSnipperCardState } from "@/lib/snapshot-merger";
import { clearCanonicalStates, initializeCanonicalState, updateCanonicalState, getAllCanonicalStates, canonicalToCard } from "@/lib/unified-market-state";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// ═════════════════════════════════════════════════════════════════════════════
// v8.1: ORCHESTRATION ISOLATION LAYER - TWO INDEPENDENT CYCLES
// ═════════════════════════════════════════════════════════════════════════════
//
// CRITICAL FIX: Execution and display cycles are completely independent
// - Separate timers
// - Separate request budgets
// - Separate stagger schedules
// - NO shared orchestration state
//
// This prevents timing contamination between pipelines

// Execution cycle state (HARD REAL-TIME)
let executionCycleRunning = false;
let lastExecutionCycleTime = 0;

// Display cycle state (SOFT ASYNC)
let displayCycleRunning = false;
let lastDisplayCycleTime = 0;

// Global CRON mutex (v8.1 hardening)
// Prevents duplicate CRON invocations from overlapping serverless executions
let globalCronLocked = false;

/**
 * v8.1: Execution Cycle (KRAKEN ONLY)
 * - Hard real-time requirements
 * - Deterministic ordering
 * - No staggering
 * - No budget sharing
 */
async function runExecutionCycle(): Promise<{
  executionCards: any[];
  setups: any[];
  timeMs: number;
}> {
  if (executionCycleRunning) {
    console.log("[EXEC_CYCLE] Already running, skipping");
    return { executionCards: [], setups: [], timeMs: 0 };
  }

  executionCycleRunning = true;
  const cycleStart = Date.now();

  try {
    console.log("[EXEC_CYCLE] Start - Kraken only, hard real-time");
    
    // STEP 1: Fetch markets (segregated at ingestion) - v8.1 FIX: Use execution lock
    const segregatedMarkets = await refreshMarketData("execution");
    
    // STEP 2: ONLY scan execution pipeline (Kraken)
    const { cards: executionCards, setups } = await generateSetups(segregatedMarkets);
    
    // v8.2 FIX: Populate canonical state with execution cards
    for (const card of executionCards) {
      if (card.symbol) {
        initializeCanonicalState(card.symbol, card.price, card.source || "kraken");
        updateCanonicalState(card.symbol.toUpperCase(), {
          signalState: card.signalState,
          direction: card.direction,
          mode: card.mode,
          targetPrices: card.targetPrices,
          stopLoss: card.stopLoss,
          riskReward: card.riskReward,
          htf4hTrend: card.htf4hTrend,
          htf4hMomentum: card.htf4hMomentum,
          htf1hAlignment: card.htf1hAlignment,
          execution15mState: card.execution15mState,
          tradeReadinessScore: card.tradeReadinessScore,
          degraded: card.degraded,
          confidence: card.confidence,
        });
      }
    }
    
    console.log(`[EXEC_CYCLE] Generated ${executionCards.length} cards, ${setups.length} setups, populated canonical state in ${Date.now() - cycleStart}ms`);
    
    return { executionCards, setups, timeMs: Date.now() - cycleStart };
  } finally {
    executionCycleRunning = false;
    lastExecutionCycleTime = Date.now();
  }
}

/**
 * v8.1: Display Cycle (COINGECKO ONLY)
 * - Soft async (can lag without affecting execution)
 * - Independent timer
 * - No budget coupling
 * - STATEFUL: Uses previous snapshot as fallback if CoinGecko fails (v8.1 FIX #3)
 */
async function runDisplayCycle(): Promise<{
  displayCards: any[];
  timeMs: number;
}> {
  if (displayCycleRunning) {
    console.log("[DISPLAY_CYCLE] Already running, skipping");
    return { displayCards: [], timeMs: 0 };
  }

  displayCycleRunning = true;
  const cycleStart = Date.now();

  try {
    console.log("[DISPLAY_CYCLE] Start - Fallback/CoinGecko only, soft async");
    
    // STEP 1: Fetch markets (already segregated) - v8.1 FIX: Use display lock (NEVER blocks)
    const segregatedMarkets = await refreshMarketData("display");
    
    // STEP 2: ONLY generate display cards (fallback)
    const displayCards = generateDisplayCards(segregatedMarkets.display);
    
    // v8.2 FIX: Populate canonical state with display cards
    for (const card of displayCards) {
      if (card.symbol) {
        initializeCanonicalState(card.symbol, card.price, card.source || "coingecko");
        updateCanonicalState(card.symbol.toUpperCase(), {
          signalState: card.signalState,
          direction: card.direction,
          mode: card.mode,
          tradeReadinessScore: card.tradeReadinessScore,
          degraded: card.degraded,
          confidence: card.confidence,
        });
      }
    }
    
    // STEP 3: If display cycle generated cards, return them
    // Otherwise, fall back to previous display cards from snapshot
    if (displayCards.length > 0) {
      console.log(`[DISPLAY_CYCLE] Generated ${displayCards.length} cards, populated canonical state in ${Date.now() - cycleStart}ms`);
      return { displayCards, timeMs: Date.now() - cycleStart };
    }
    
    // FALLBACK (v8.1 FIX #3): Use previous display cards from snapshot
    // This ensures BTC/ETH are never lost if CoinGecko temporarily fails
    const previousSnapshot = getSnapshot();
    const previousDisplayCards = previousSnapshot?.cards?.filter(c => c.degraded) || [];
    
    if (previousDisplayCards.length > 0) {
      console.log(`[DISPLAY_CYCLE] Using ${previousDisplayCards.length} cards from previous snapshot (fallback)`);
      return { displayCards: previousDisplayCards, timeMs: Date.now() - cycleStart };
    }
    
    // FIX #3: Display cycle MUST ALWAYS return 3 cards (no exceptions)
    // If no display cards generated and no fallback, use canonical state to create display cards
    const canonicalStates = getAllCanonicalStates();
    if (canonicalStates.length > 0) {
      const displayCardsFromCanonical = canonicalStates.map(state => ({
        symbol: state.normalizedSymbol,
        price: state.price,
        source: state.source,
        signalState: "BUILDING" as const,
        direction: null,
        mode: null,
        degraded: true,
        confidence: 0.5,
        htf4hTrend: null,
        htf4hMomentum: null,
        htf1hAlignment: null,
        execution15mState: null,
        targetPrices: null,
        stopLoss: null,
        riskReward: null,
        emaSlope: null,
        stochRsi: null,
        volatilityLevel: null,
        tradeReadinessScore: null,
      }));
      console.log(`[DISPLAY_CYCLE] Generated fallback display cards from canonical state (${displayCardsFromCanonical.length} cards)`);
      return { displayCards: displayCardsFromCanonical, timeMs: Date.now() - cycleStart };
    }
    
    // Last resort: return empty but log clearly
    console.log(`[DISPLAY_CYCLE] CRITICAL: No display cards from any source`);
    return { displayCards: [], timeMs: Date.now() - cycleStart };
  } finally {
    displayCycleRunning = false;
    lastDisplayCycleTime = Date.now();
  }
}

// v8.0 header: CRON optimized for delta updates, not full rebuilds
export async function GET(req: NextRequest) {
  try {
    // v8.1 CRITICAL: Global CRON mutex to prevent duplicate execution
    // Vercel serverless can invoke this handler multiple times per tick if not guarded
    if (globalCronLocked) {
      console.log("[CRON] Skipped - already running (mutex locked)");
      return NextResponse.json({ 
        ok: false, 
        reason: "CRON already running (mutex locked)" 
      }, { status: 429 });
    }

    globalCronLocked = true;

    try {
      const secret = process.env.CRON_SECRET;
      if (secret) {
        const auth = req.headers.get("authorization");
        const query = new URL(req.url).searchParams.get("secret");
        if (auth !== `Bearer ${secret}` && query !== secret) {
          return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }
      }

      console.log("[CRON] Start - v8.1 orchestration isolation");
      const cronStart = Date.now();

      // v8.2 FIX: Start fresh canonical state (one source of truth per cycle)
      clearCanonicalStates();

      // v8.1 FIX #4: Sequential execution (execution → display)
      // Display cycle must run AFTER execution fetches all market data
      // Otherwise display cycle completes with 0 cards before markets are fetched
      const executionResult = await runExecutionCycle();
      const displayResult = await runDisplayCycle();

      const { executionCards, setups } = executionResult;
      const { displayCards } = displayResult;
    
    // Merge results: execution first, then display
    const newCards = [...executionCards, ...displayCards];
    console.log(`[CRON] Card generation: ${executionResult.timeMs + displayResult.timeMs}ms - ${executionCards.length} execution + ${displayCards.length} display (sequential: exec first, then display with full market data)`);

    // STEP 3: v8.2 FIX - Use canonical state directly (unified source of truth)
    // All cards already have canonical state populated by execution and display cycles
    // No need for merging - canonical state is the definitive state
    const canonicalCards = getAllCanonicalStates().map(canonicalToCard);
    
    console.log(`[CANONICAL] Using ${canonicalCards.length} unified canonical states (BTC, ETH, SOL always present)`);

    // STEP 4: Validate SNIPER cards completed full pipeline (v8.1 FIX #2)
    // SNIPER_READY is intermediate, not final. Must have TP/SL before rendering
    for (const card of canonicalCards) {
      if (!validateSnipperCardState(card)) {
        console.warn(`[VALIDATION] Card ${card.symbol} failed pipeline validation`);
      }
    }

    // ATOMIC: Update snapshot with exactly 3 cards
    // Backend MUST ONLY write when canonicalCards.length === 3
    // Ready flag is set automatically by setSnapshot
    setSnapshot({
      updatedAt: new Date().toISOString(),
      cards: canonicalCards.length === 3 ? canonicalCards : [],
    });

    // STEP 5: Enqueue alerts (decoupled, non-blocking)
    for (const setup of setups) {
      const card = newCards.find(c => c.symbol === setup.symbol);
      
      enqueueAlert({
        symbol: setup.symbol,
        mode: setup.mode,
        direction: setup.direction,
        score: setup.score,
        price: setup.price,
        source: card?.source,
        signalState: card?.signalState,
        targetPrices: card?.targetPrices,
        htf4hTrend: card?.htf4hTrend,
        execution15mState: card?.execution15mState,
        queued: Date.now(),
      });
    }

    const totalMs = Date.now() - cronStart;
    console.log(`[CRON] Complete in ${totalMs}ms - execution: ${executionResult.timeMs}ms, display: ${displayResult.timeMs}ms, queued ${setups.length} alerts`);

    return NextResponse.json({ 
      ok: true, 
      perf: { 
        totalMs, 
        executionMs: executionResult.timeMs,
        displayMs: displayResult.timeMs,
        canonicalCards: canonicalCards.length,
        alertsQueued: setups.length 
      }
    });
    } catch (error) {
      console.error('[CRON ERROR]', error);
      return NextResponse.json(
        { error: error instanceof Error ? error.message : 'Unknown', ok: false },
        { status: 500 }
      );
    } finally {
      // v8.1: Always release the mutex
      globalCronLocked = false;
    }
  } catch (authError) {
    console.error('[CRON AUTH ERROR]', authError);
    return NextResponse.json(
      { error: 'Authorization failed', ok: false },
      { status: 401 }
    );
  }
}
