import { NextRequest, NextResponse } from "next/server";
import { generateSetups, generateDisplayCards } from "@/lib/strategy-v6";
import { enqueueAlert } from "@/lib/telegram-worker";
import { refreshMarketData } from "@/lib/market-data-layer";
import { getSnapshot, setSnapshot } from "@/lib/runtime-snapshot";
import { calculatePatches, applySnapshotPatches } from "@/lib/snapshot-patcher";

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
    
    // STEP 1: Fetch markets (segregated at ingestion)
    const segregatedMarkets = await refreshMarketData();
    
    // STEP 2: ONLY scan execution pipeline (Kraken)
    const { cards: executionCards, setups } = await generateSetups(segregatedMarkets);
    
    console.log(`[EXEC_CYCLE] Generated ${executionCards.length} cards, ${setups.length} setups in ${Date.now() - cycleStart}ms`);
    
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
    
    // STEP 1: Fetch markets (already segregated)
    const segregatedMarkets = await refreshMarketData();
    
    // STEP 2: ONLY generate display cards (fallback)
    const displayCards = generateDisplayCards(segregatedMarkets.display);
    
    console.log(`[DISPLAY_CYCLE] Generated ${displayCards.length} cards in ${Date.now() - cycleStart}ms`);
    
    return { displayCards, timeMs: Date.now() - cycleStart };
  } finally {
    displayCycleRunning = false;
    lastDisplayCycleTime = Date.now();
  }
}

// v8.0 header: CRON optimized for delta updates, not full rebuilds
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

    console.log("[CRON] Start - v8.1 orchestration isolation");
    const cronStart = Date.now();

    // v8.1: RUN BOTH CYCLES INDEPENDENTLY (not sequentially)
    // Each cycle is completely isolated, no timing interference
    const [executionResult, displayResult] = await Promise.all([
      runExecutionCycle(),
      runDisplayCycle(),
    ]);

    const { executionCards, setups } = executionResult;
    const { displayCards } = displayResult;
    
    // Merge results: execution first, then display
    const newCards = [...executionCards, ...displayCards];
    console.log(`[CRON] Card generation: ${executionResult.timeMs + displayResult.timeMs}ms - ${executionCards.length} execution + ${displayCards.length} display`);

    // STEP 3: Apply delta patching
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
        patchesApplied: patches.length, 
        alertsQueued: setups.length 
      }
    });
  } catch (error) {
    console.error('[CRON ERROR]', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unknown', ok: false },
      { status: 500 }
    );
  }
}
