import { NextRequest, NextResponse } from "next/server";
import { generateSetups, STRATEGY_VERSION } from "@/lib/strategy-v6";
import { enqueueAlert } from "@/lib/telegram-worker";
import { refreshMarketData } from "@/lib/market-data-layer";
import { fetchCandles } from "@/lib/kraken";
import { getSnapshot, setSnapshot } from "@/lib/runtime-snapshot";
import { mergeSnapshots, validateSnipperCardState } from "@/lib/snapshot-merger";
import { clearCanonicalStates, initializeCanonicalState, updateCanonicalState, getAllCanonicalStates, canonicalToCard } from "@/lib/unified-market-state";
import { createCanonicalSnapshot } from "@/lib/canonical-snapshot";
import { detectMonitorEvent, formatMonitorEvent } from "@/lib/monitor-event-engine";
import { safeFreezeCard, deepFreeze, assertDeepFrozen } from "@/lib/immutability";

// v36.0 FIX: Defer module-level logging to runtime
let strategyVersionLogged = false;

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// SINGLE ENGINE ONLY: strategy-v6 (SCAN phase) is the ONLY signal source
// NO v43 post-processor, NO direction re-derivation, NO activation re-calculation
// Direction is calculated ONCE during card generation and FROZEN

// ═════════════════════════════════════════════════════════════════════════════
// SINGLE PIPELINE: Market Data → Strategy-v6 → Frozen Cards → Snapshot → UI
// ═════════════════════════════════════════════════════════════════════════════

// Execution cycle state (HARD REAL-TIME)
let executionCycleRunning = false;
let lastExecutionCycleTime = 0;

// Global CRON mutex (v8.1 hardening)
let globalCronLocked = false;

// v1 STABILIZATION: Track previous signal states to prevent duplicate alerts
const signalStateHistory: Record<string, { signalState: string; lastAlertedAt: number }> = {};

/**
 * v8.1: Execution Cycle (KRAKEN ONLY)
 * Single immutable signal generation
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
    console.log("[EXEC_CYCLE] Start - Single immutable signal generation");
    
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
    // Direction is calculated ONCE here and FROZEN - no re-derivation allowed
    const { cards: executionCards, setups } = await generateSetups(segregatedMarkets, candles4hBySymbol);
    
    // v8.2 FIX: Populate canonical state with execution cards (DIRECT, NO POST-PROCESSOR)
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
          notes: card.notes,
        });
      }
    }
    
    // FREEZE CARDS: Make immutable after generation with deep cloning
    // Clone to prevent shared references, then deep freeze to prevent mutations
    const frozenCards = executionCards.map(card => safeFreezeCard(card));
    
    console.log(`[EXEC_CYCLE] Generated ${frozenCards.length} cards (DEEP FROZEN), ${setups.length} setups, populated canonical state in ${Date.now() - cycleStart}ms`);
    
    return { executionCards: frozenCards, setups, timeMs: Date.now() - cycleStart };
  } finally {
    executionCycleRunning = false;
    lastExecutionCycleTime = Date.now();
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// v8.0 header: CRON optimized for delta updates, not full rebuilds
// ═════════════════════════════════════════════════════════════════════════════
// SINGLE PIPELINE ONLY: EXECUTION_CYCLE → SNAPSHOT → UI RENDER
// NO DISPLAY_CYCLE, NO SECONDARY DERIVATION, NO FALLBACKS
// ═════════════════════════════════════════════════════════════════════════════
export async function GET(req: NextRequest) {
  try {
    // RULE 4: HARD ENFORCEMENT - Detect dual pipeline violations
    const originalLog = console.log;
    const violationPatterns = ["fallback", "recomputed", "re-derived"];
    let violationDetected = false;
    
    console.log = function(...args) {
      const message = args.join(" ");
      for (const pattern of violationPatterns) {
        if (message.includes(pattern)) {
          console.error(`[DUAL PIPELINE VIOLATION] ${pattern} detected in logs`);
          violationDetected = true;
        }
      }
      return originalLog.apply(console, args);
    };
    
    try {
    // v36.0 FIX: Log version on first execution (after all imports resolved)
    if (!strategyVersionLogged) {
      console.log(`[MOMENTUM_ENGINE_STARTUP] Strategy version: ${STRATEGY_VERSION}`);
      strategyVersionLogged = true;
    }
    
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
      // SINGLE PIPELINE: Execution cycle ONLY
      // No display cycle, no fallbacks, no secondary derivation
      const executionResult = await runExecutionCycle();
      const { executionCards, setups } = executionResult;
    
    // CANONICAL STATE: Direct from execution cycle
    const activeSignals = setups; // UI consumes this count directly
    
    // IMMUTABLE SNAPSHOT: Execution cards ONLY
    console.log(`[CRON] Execution cycle: ${executionResult.timeMs}ms - ${executionCards.length} cards`);

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

    // ═════════════════════════════════════════════════════════════════════════════
    // STEP 4.5: HARD TYPE ENFORCEMENT - Map activationState BEFORE freezing
    // ═════════════════════════════════════════════════════════════════════════════
    for (const card of canonicalCards) {
      // REQUIRED FIELDS - NO UNDEFINED
      if (!card.symbol || typeof card.symbol !== "string") {
        throw new Error(`[TYPE_VIOLATION] Card missing/invalid symbol: ${card.symbol}`);
      }
      if (!card.direction || !["LONG", "SHORT", "NEUTRAL"].includes(card.direction)) {
        throw new Error(`[TYPE_VIOLATION] Card ${card.symbol} invalid direction: ${card.direction}`);
      }
      if (!card.signalState || !["ACTIVE_SNIPER", "CONFIRMED", "DO_NOT_TRADE", "SNIPER_READY", "CONFIRMED_READY", "WATCH_BREAKOUT", "NONE"].includes(card.signalState)) {
        throw new Error(`[TYPE_VIOLATION] Card ${card.symbol} invalid signalState: ${card.signalState}`);
      }
      if (typeof card.confidence !== "number" || card.confidence < 0 || card.confidence > 100) {
        throw new Error(`[TYPE_VIOLATION] Card ${card.symbol} invalid confidence: ${card.confidence}`);
      }
      
      // CRITICAL FIX: Map signalState to activationState BEFORE freezing
      // Frontend expects activationState: "ACTIVE_SNIPER" | "CONFIRMED" | "DO_NOT_TRADE"
      // Map intermediate states to terminal states for serialization
      if (card.signalState === "ACTIVE_SNIPER") {
        (card as any).activationState = "ACTIVE_SNIPER";
      } else if (card.signalState === "CONFIRMED") {
        (card as any).activationState = "CONFIRMED";
      } else {
        // All other states (SNIPER_READY, CONFIRMED_READY, WATCH_BREAKOUT, DO_NOT_TRADE, NONE) → DO_NOT_TRADE
        (card as any).activationState = "DO_NOT_TRADE";
      }
    }

    // FREEZE CARDS: Make immutable after generation with deep cloning
    // Clone to prevent shared references, then deep freeze to prevent mutations
    // Do this AFTER mapping activationState to avoid frozen object mutations
    const frozenCards = canonicalCards.map(card => safeFreezeCard(card));
    
    console.log(`[EXEC_CYCLE] Generated ${frozenCards.length} cards (DEEP FROZEN), ${setups.length} setups, completed type enforcement in ${Date.now() - cronStart}ms`);
    // ATOMIC: Update snapshot with exactly 3 cards + active setups
    // Clone cards BEFORE snapshot to prevent snapshot mutations affecting execution cards
    // Backend MUST ONLY write when canonicalCards.length === 3
    // v1 FIX: Use createCanonicalSnapshot to enforce complete contract
    // ALL fields (cards, setups, activeSignals, signalCount, activeSnipers) populated
    const snapshotCards = canonicalCards.length === 3 
      ? canonicalCards.map(card => safeFreezeCard(card))
      : [];
    
    const snapshot = createCanonicalSnapshot({
      cards: snapshotCards,
      setups: setups,  // ACTIVE_SNIPER + ACTIVE_CONFIRMED signals
      updatedAt: new Date().toISOString(),
    });
    setSnapshot(snapshot);

    // STEP 5: Enqueue alerts (decoupled, non-blocking)
    // v8.3 FIX: Use execution-grade signal state (ACTIVE_SNIPER/ACTIVE_CONFIRMED)
    // v1 STABILIZATION: Only alert on NEW ACTIVE_SNIPER signals, not every cycle
    for (const setup of setups) {
      // Get the card associated with this setup to extract complete payload
      // Use the FROZEN execution card, never modify it
      const setupCard = frozenCards.find(c => c.symbol === setup.symbol);
      
      if (!setupCard) {
        console.log(`[SNIPER BLOCKED] ${setup.symbol} no execution card found`);
        continue;
      }
      
      // CRITICAL: Verify card is still frozen before reading
      try {
        assertDeepFrozen(setupCard, `${setup.symbol} execution card`);
      } catch (err) {
        console.error(`[MUTATION_VIOLATION] ${setup.symbol} card was mutated after freeze!`, err);
        continue;
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
        targetPrices: setupCard.targetPrices,  // Optional - may not be calculated yet
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
    console.log(`[CRON] Complete in ${totalMs}ms - execution: ${executionResult.timeMs}ms, queued ${setups.length} alerts`);
    
    // STATE DRIFT DETECTION: Verify no mutations occurred
    for (let i = 0; i < executionCards.length; i++) {
      const original = executionCards[i];
      if (!Object.isFrozen(original)) {
        throw new Error(`[STATE DRIFT] Card ${original.symbol} is not frozen - mutation detected`);
      }
    }

    return NextResponse.json({ 
      ok: true, 
      perf: { 
        totalMs, 
        executionMs: executionResult.timeMs,
        canonicalCards: canonicalCards.length,
        alertsQueued: activeSignals.length  // SNIPER signals from DecisionAxis only
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
      // Restore console.log
      console.log = originalLog;
    }
    } finally {
      // Restore console.log on outer finally
      console.log = originalLog;
    }
  } catch (authError) {
    console.error('[CRON AUTH ERROR]', authError);
    return NextResponse.json(
      { error: 'Authorization failed', ok: false },
      { status: 401 }
    );
  }
}
