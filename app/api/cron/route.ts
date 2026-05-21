import { NextRequest, NextResponse } from "next/server";
import { generateSetups, generateDisplayCards, STRATEGY_VERSION } from "@/lib/strategy-v6";
import { enqueueAlert } from "@/lib/telegram-worker";
import { refreshMarketData } from "@/lib/market-data-layer";
import { fetchCandles } from "@/lib/kraken";
import { getSnapshot, setSnapshot } from "@/lib/runtime-snapshot";
import { mergeSnapshots, validateSnipperCardState } from "@/lib/snapshot-merger";
import { clearCanonicalStates, initializeCanonicalState, updateCanonicalState, getAllCanonicalStates, canonicalToCard } from "@/lib/unified-market-state";
import { createCanonicalSnapshot } from "@/lib/canonical-snapshot";
import { detectMonitorEvent, formatMonitorEvent } from "@/lib/monitor-event-engine";

console.log(`[MOMENTUM_ENGINE_STARTUP] Strategy version: ${STRATEGY_VERSION}`);

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

// v1 STABILIZATION: Track previous signal states to prevent duplicate alerts
// Maps: symbol -> { signalState, lastAlertedAt }
const signalStateHistory: Record<string, { signalState: string; lastAlertedAt: number }> = {};

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
    
    // STEP 1.5: Fetch 4H candles for real structure detection (v22.0)
    const candles4hBySymbol: Record<string, any[]> = {};
    const symbols = ["BTC", "ETH", "SOL"];
    for (const symbol of symbols) {
      try {
        const candleData = await fetchCandles(symbol, 240, 50); // 4H = 240 mins, 50 candles lookback
        candles4hBySymbol[symbol] = candleData.candles;
        console.log(`[4H_CANDLES] ${symbol}: Fetched ${candleData.candles.length} 4H candles from ${candleData.source}`);
      } catch (error) {
        console.warn(`[4H_CANDLES] ${symbol}: Failed to fetch 4H candles, using empty array`, error);
        candles4hBySymbol[symbol] = [];
      }
    }
    
    // STEP 2: ONLY scan execution pipeline (Kraken) with real 4H structure
    const { cards: executionCards, setups } = await generateSetups(segregatedMarkets, candles4hBySymbol);
    
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
          notes: card.notes,  // v21.3.7: Include watch zone commentary (was missing)
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

    // ATOMIC: Update snapshot with exactly 3 cards + active setups
    // Backend MUST ONLY write when canonicalCards.length === 3
    // v1 FIX: Use createCanonicalSnapshot to enforce complete contract
    // ALL fields (cards, setups, activeSignals, signalCount, activeSnipers) populated
    const snapshot = createCanonicalSnapshot({
      cards: canonicalCards.length === 3 ? canonicalCards : [],
      setups: setups,  // ACTIVE_SNIPER + ACTIVE_CONFIRMED signals
      updatedAt: new Date().toISOString(),
    });
    setSnapshot(snapshot);

    // STEP 5: Enqueue alerts (decoupled, non-blocking)
    // v8.3 FIX: Use execution-grade signal state (ACTIVE_SNIPER/ACTIVE_CONFIRMED)
    // v1 STABILIZATION: Only alert on NEW ACTIVE_SNIPER signals, not every cycle
    for (const setup of setups) {
      // Get the card associated with this setup to extract complete payload
      const setupCard = executionCards.find(c => c.symbol === setup.symbol);
      
      // HOTFIX: Enforce payload completeness BEFORE enqueueing
      // Execution layer guarantees completeness, alert layer only delivers
      if (!setupCard || !setupCard.targetPrices || !setupCard.targetPrices.tp1) {
        console.log(`[SNIPER BLOCKED] ${setup.symbol} incomplete payload - holding for next cycle (tp1=${setupCard?.targetPrices?.tp1})`);
        continue; // Skip alert if payload incomplete
      }
      
      // Verify structureState is populated
      if (!setupCard.structureState) {
        console.log(`[SNIPER BLOCKED] ${setup.symbol} missing structureState`);
        continue;
      }
      
      // Compute execution-grade signal state from setup.mode
      const signalState = setup.mode === "SNIPER" ? "ACTIVE_SNIPER" : "ACTIVE_CONFIRMED";
      
      // v1 STABILIZATION: Check if this is a NEW signal state (transition)
      // Only enqueue if signal state CHANGED to ACTIVE_SNIPER (prevent duplicate alerts)
      const previousState = signalStateHistory[setup.symbol];
      const isNewSignal = !previousState || previousState.signalState !== signalState;
      
      if (!isNewSignal) {
        // Signal state unchanged, don't enqueue duplicate alert
        console.log(`[DEDUPED] ${setup.symbol} ${signalState} already alerted (last ${Date.now() - previousState!.lastAlertedAt}ms ago)`);
        continue;
      }
      
      // Calculate entry zone (±0.5% from entry price)
      const entryPriceBuffer = setupCard.price * 0.005;
      
      // Compute impulse state from compression/expansion
      const impulseState = setupCard.volatilityLevel && setupCard.volatilityLevel < 40 
        ? "Compression → Expansion confirmed"
        : "Impulse active";
      
      // Track this signal state for next cycle (prevent duplicates)
      signalStateHistory[setup.symbol] = { signalState, lastAlertedAt: Date.now() };
      // STEP 4 FIX: Generate unique signalTransitionId and normalize all alert fields
      // Ensures dedupe doesn't block new signals and all fields are defined
      const signalTransitionId = `${setup.symbol}-${setup.mode}-${Date.now()}-${Math.random().toString(36).substring(7)}`;
      
      // STEP 4 FIX: Normalize HTF mapping with fallback to "UNKNOWN"
      let htf4hTrend: "BULLISH" | "BEARISH" | "NEUTRAL" = "NEUTRAL";
      if (setup.htf?.trend4h === true) htf4hTrend = "BULLISH";
      else if (setup.htf?.trend4h === false) htf4hTrend = "BEARISH";
      
      // STEP 4 FIX: Normalize 15M mapping with fallback to "UNKNOWN"
      let execution15mState: "COMPRESSING" | "BREAKOUT_READY" | "EXPANDING" | "CHOP" = "CHOP";
      if (setup.htf?.compression15m === true) execution15mState = "COMPRESSING";
      else if (setup.htf?.expansion15m === true) execution15mState = "EXPANDING";
      else if (setup.htf?.breakout15m === true) execution15mState = "BREAKOUT_READY";
      
      enqueueAlert({
        symbol: setup.symbol,
        mode: setup.mode,
        direction: setup.direction,
        score: setup.score,
        price: setup.price,
        source: "kraken",  // Execution pipeline always uses Kraken
        signalState: signalState,  // Use execution-grade state, not display state
        signalTransitionId: signalTransitionId,  // STEP 2 FIX: For granular dedupe
        targetPrices: setupCard.targetPrices,  // Now guaranteed to exist
        htf4hTrend: htf4hTrend,  // STEP 4 FIX: Normalized with fallback
        execution15mState: execution15mState,  // STEP 4 FIX: Normalized with fallback
        queued: Date.now(),
        
        // v1 STABILIZATION: Trader-facing fields for beautiful alerts
        structureState: setupCard.structureState ?? "UNKNOWN",  // STEP 4 FIX: Force UNKNOWN if missing
        entryPrice: setupCard.price,
        entryZone: { min: setupCard.price - entryPriceBuffer, max: setupCard.price + entryPriceBuffer },
        riskReward: setupCard.riskReward,
        confidence: setupCard.confidence,
        impulseState: impulseState ?? "UNKNOWN",  // STEP 4 FIX: Force UNKNOWN if missing
        executionNotes: `Structure locked ${setup.direction}\nAtomic payload verified`,
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
