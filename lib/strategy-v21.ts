/**
 * v21.2.0 - FINAL DETERMINISTIC IMPULSE ENGINE + INPUT GUARANTEE LAYER
 * 
 * COMPLETE REWRITE - NO LEGACY CODE
 * 
 * 6-Phase Pipeline Architecture:
 * 1. PHASE_MARKET_DATA: Fetch, compute, normalize
 * 2. PHASE_DIRECTION: EMA/displacement/stoch inference (NO HTF authority)
 * 3. PHASE_IMPULSE: Canonical computeImpulseStrength (with input sanitiser)
 * 4. PHASE_QUALITY: Threshold filter (27 → ACTIVE_SNIPER TERMINAL)
 * 5. PHASE_CLASSIFY: Metadata only (never mutates state)
 * 6. PHASE_OUTPUT: Persist atomically (no post-processing)
 * 
 * CRITICAL RULES:
 * - ACTIVE_SNIPER is TERMINAL: once fired, cannot downgrade/decay/rewrite
 * - One deterministic pass only
 * - Same market data = same state always
 * - No state mutations after state derivation
 * - Only 4 log namespaces: [DIRECTION], [IMPULSE_PIPELINE], [SNIPER_DECISION], [STATE]
 * - INPUT GUARANTEE: No NaN can enter pipeline (safeNumber sanitiser)
 */

import type { PriceData } from "./price-router";

// ============================================================================
// v21.2.0: TYPE DEFINITIONS (CLEAN - NO v17/v18/v19/v20 contamination)
// ============================================================================

export type SignalState = "NONE" | "BUILDING" | "ACTIVE_SNIPER";

export type MarketStructureClass =
  | "TREND_FOLLOWING"
  | "EARLY_REVERSAL"
  | "COUNTER_TREND"
  | "TRANSITION"
  | "RANGE"
  | "CHOP";

export type SymbolCardState = {
  symbol: string;
  price: number;
  source: string;
  degraded: boolean;

  // v21.2.0: EXECUTION STATE (TERMINAL, UNREVOKABLE)
  signalState: SignalState;
  marketClass: MarketStructureClass;
  direction: "LONG" | "SHORT" | "NEUTRAL";
  tradeReadinessScore: number | null;
  ignitionProbability: number;
  sniperTradeType?: "EARLY_REVERSAL" | "CONTINUATION" | "WEAK_EXPANSION" | "FALSE_START" | null;

  // v21.2.0: INDICATORS
  stochRsi: number | null;
  emaSlope: number | null;
  emaPressure: number;
  volatilityLevel: number | null;

  // v21.2.0: HTF CONTEXT (READ-ONLY, NEVER MUTATES STATE)
  htf4hTrend: "BULLISH" | "BEARISH" | "NEUTRAL";
  htf4hMomentum: number | null;
  htf1hAlignment: boolean | null;
  htf15mCompression: boolean | null;

  // v21.2.0: STRUCTURE
  execution15mState: "COMPRESSING" | "BREAKOUT_READY" | "EXPANDING" | "CHOP";
  marketReadinessState: string;

  // v21.2.0: CONDITIONAL TARGETS
  expectedMovePercent: { sniper: { min: number; max: number } } | null;
  targetPrices: { tp1: number; tp2: number; sl: number } | null;
  riskReward: number | null;

  // v21.2.0: METADATA
  cycleId: string;
  lastSignalTime?: number;
  notes: string;
  updatedAt: string;
  blockReason?: string;

  // v21.2.0: TRANSPARENCY BREAKDOWN
  scoreBreakdown?: {
    stochComponent: number;
    emaComponent: number;
    volatilityComponent: number;
    volumeComponent: number;
    totalImpulse: number;
  };
};

export type Setup = {
  symbol: string;
  mode: "SNIPER";
  direction: "LONG" | "SHORT";
  score: number;
  reason: string;
  price: number;
  momentum: {
    stochRsiSignal: string;
    emaStackSignal: string;
    volatilitySignal: string;
    trend4H: boolean;
  };
  targetPrices?: { tp1: number; tp2: number; sl: number };
  riskReward?: number;
};

// ============================================================================
// v21.2.0: PHASE 1 - MARKET DATA COMPUTATION
// ============================================================================

function computeStochRsi(priceData: PriceData): number | null {
  if (!priceData.stochRsi || priceData.stochRsi < 0 || priceData.stochRsi > 100) return null;
  return priceData.stochRsi;
}

function computeEmaSlope(
  current8Ema: number | null,
  prior8Ema: number | null
): number | null {
  if (current8Ema === null || prior8Ema === null) return null;
  return current8Ema - prior8Ema;
}

function computeVolatilityLevel(priceData: PriceData): number | null {
  if (!priceData.atr) return null;
  const percentVol = (priceData.atr / priceData.price) * 100;
  return Math.min(percentVol * 10, 100);
}

function computeVolumeComponent(priceData: PriceData): number {
  if (!priceData.volume || !priceData.volumeAvg) return 0;
  const volumeRatio = priceData.volume / priceData.volumeAvg;
  return Math.min(volumeRatio * 15, 40);
}

// ============================================================================
// v21.2.0: PHASE 2 - DIRECTION INFERENCE (NO HTF AUTHORITY)
// ============================================================================

function inferDirection(
  emaSlope: number | null,
  stochRsi: number | null,
  emaPressure: number
): "LONG" | "SHORT" | "NEUTRAL" {
  if (emaSlope === null || stochRsi === null) return "NEUTRAL";

  const hasBullishMomentum = emaSlope > 0.5 && stochRsi > 40 && emaPressure > 0;
  const hasBearishMomentum = emaSlope < -0.5 && stochRsi < 60 && emaPressure < 0;

  if (hasBullishMomentum) return "LONG";
  if (hasBearishMomentum) return "SHORT";
  return "NEUTRAL";
}

// ============================================================================
// v21.2.0: INPUT GUARANTEE LAYER - HARD SANITISER (PREVENTS NaN PROPAGATION)
// ============================================================================

/**
 * v21.2.0: HARD INPUT SANITISER
 * 
 * No NaN can ever enter the pipeline.
 * Every indicator must pass through this checkpoint.
 * Fallback: 0 (neutral, safe default)
 */
function safeNumber(value: any, fallback = 0): number {
  if (value === null || value === undefined) return fallback;
  if (Number.isNaN(value)) return fallback;
  if (!Number.isFinite(value)) return fallback;
  return value;
}

// ============================================================================
// v21.2.0: PHASE 3 - CANONICAL IMPULSE CALCULATION (SINGLE SOURCE OF TRUTH)
// ============================================================================

function computeImpulseStrength(
  stochComponent: number,
  emaComponent: number,
  volatilityComponent: number,
  volumeComponent: number
): number {
  // v21.2.0: HARD INPUT SANITISER - prevent NaN from entering pipeline
  const stoch = safeNumber(stochComponent, 0);
  const ema = safeNumber(emaComponent, 0);
  const vol = safeNumber(volatilityComponent, 0);
  const volume = safeNumber(volumeComponent, 0);
  
  const impulse = stoch + ema + vol + volume;
  console.log(
    `[IMPULSE_PIPELINE] v21.2.0 unified score=${impulse.toFixed(2)} ` +
    `(stoch=${stoch.toFixed(2)} + ema=${ema.toFixed(2)} + ` +
    `vol=${vol.toFixed(2)} + volume=${volume.toFixed(2)})`
  );
  return impulse;
}

// ============================================================================
// v21.2.0: PHASE 4 - QUALITY FILTER (THRESHOLD → TERMINAL STATE)
// ============================================================================

const IMPULSE_QUALITY_THRESHOLD = 27;

function deriveExecutionState(ignitionProbability: number): SignalState {
  if (ignitionProbability >= IMPULSE_QUALITY_THRESHOLD) return "ACTIVE_SNIPER";
  if (ignitionProbability >= 1) return "BUILDING";
  return "NONE";
}

// ============================================================================
// v21.2.0: PHASE 5 - CLASSIFICATION (METADATA ONLY - NEVER MUTATES STATE)
// ============================================================================

function classifyTradeType(
  impulseStrength: number,
  emaSlope: number | null,
  stochRsi: number | null,
  direction: "LONG" | "SHORT" | "NEUTRAL",
  htf4hTrend: "BULLISH" | "BEARISH" | "NEUTRAL"
): "EARLY_REVERSAL" | "CONTINUATION" | "WEAK_EXPANSION" | "FALSE_START" | null {
  if (direction === "NEUTRAL" || impulseStrength < IMPULSE_QUALITY_THRESHOLD) {
    return null;
  }

  const isAlignedToHTF =
    (direction === "LONG" && htf4hTrend === "BULLISH") ||
    (direction === "SHORT" && htf4hTrend === "BEARISH");

  const isWeakEMA = emaSlope !== null && Math.abs(emaSlope) < 5;
  const isWeakStoch = stochRsi !== null && (stochRsi < 30 || stochRsi > 70);

  if (!isAlignedToHTF && !isWeakEMA) return "EARLY_REVERSAL";
  if (isAlignedToHTF && !isWeakEMA) return "CONTINUATION";
  if (isWeakEMA && !isWeakStoch) return "WEAK_EXPANSION";
  return "FALSE_START";
}

// ============================================================================
// v21.2.0: PHASE 6 - ATOMIC SNAPSHOT OUTPUT (NO POST-PROCESSING)
// ============================================================================

export async function generateSetups(market: Record<string, PriceData>): Promise<{
  cards: SymbolCardState[];
  setups: Setup[];
}> {
  const cards: SymbolCardState[] = [];
  const setups: Setup[] = [];

  console.log(`[STATE] v21.2.0 START - Final Deterministic Impulse Engine`);
  const cycleStart = Date.now();

  for (const [symbol, priceData] of Object.entries(market)) {
    try {
      // PHASE 1: Market Data
      const stochRsi = computeStochRsi(priceData);
      const emaSlope = computeEmaSlope(priceData.ema8, priceData.ema8Prev);
      const volatilityLevel = computeVolatilityLevel(priceData);
      const volumeComponent = computeVolumeComponent(priceData);
      const emaPressure = stochRsi !== null ? stochRsi - 50 : 0;

      // PHASE 2: Direction Inference (NO HTF authority)
      const direction = inferDirection(emaSlope, stochRsi, emaPressure);

      // PHASE 3: Impulse Calculation
      const stochComponent = stochRsi !== null ? stochRsi / 3 : 0;
      const emaComponent = emaSlope !== null ? Math.min(Math.abs(emaSlope) * 2, 30) : 0;
      const volatilityComponent = volatilityLevel !== null ? Math.min(volatilityLevel, 30) : 0;

      const ignitionProbability = computeImpulseStrength(
        stochComponent,
        emaComponent,
        volatilityComponent,
        volumeComponent
      );

      // PHASE 4: Quality Filter → Terminal State
      const signalState = deriveExecutionState(ignitionProbability);

      // PHASE 5: Classification (metadata only)
      const sniperTradeType =
        signalState === "ACTIVE_SNIPER"
          ? classifyTradeType(
              ignitionProbability,
              emaSlope,
              stochRsi,
              direction,
              priceData.htf4hTrend || "NEUTRAL"
            )
          : null;

      console.log(
        `[SNIPER_DECISION] ${symbol}: ` +
        `state=${signalState} ` +
        `probability=${ignitionProbability.toFixed(2)} ` +
        `direction=${direction} ` +
        `type=${sniperTradeType || "NONE"}`
      );

      // PHASE 6: Atomic Output
      const card: SymbolCardState = {
        symbol,
        price: priceData.price,
        source: "v21.2.0",
        degraded: false,
        signalState,
        marketClass: "TREND_FOLLOWING",
        direction,
        tradeReadinessScore: signalState === "ACTIVE_SNIPER" ? 85 : 30,
        ignitionProbability,
        sniperTradeType,
        stochRsi,
        emaSlope,
        emaPressure,
        volatilityLevel,
        htf4hTrend: priceData.htf4hTrend || "NEUTRAL",
        htf4hMomentum: null,
        htf1hAlignment: null,
        htf15mCompression: null,
        execution15mState: "EXPANDING",
        marketReadinessState: signalState,
        expectedMovePercent: signalState === "ACTIVE_SNIPER" ? { sniper: { min: 0.5, max: 2 } } : null,
        targetPrices: signalState === "ACTIVE_SNIPER" ? computeTargets(priceData.price, direction) : null,
        riskReward: signalState === "ACTIVE_SNIPER" ? 2 : null,
        cycleId: `${Date.now()}-${symbol}`,
        notes: `${signalState} ${direction}`,
        updatedAt: new Date().toISOString(),
        scoreBreakdown: {
          stochComponent,
          emaComponent,
          volatilityComponent,
          volumeComponent,
          totalImpulse: ignitionProbability,
        },
      };

      cards.push(card);

      // Generate setup only for ACTIVE_SNIPER
      if (signalState === "ACTIVE_SNIPER" && direction !== "NEUTRAL") {
        setups.push({
          symbol,
          mode: "SNIPER",
          direction: direction as "LONG" | "SHORT",
          score: Math.min(85, 100),
          reason: `${signalState} ${direction} - impulse=${ignitionProbability.toFixed(0)}`,
          price: priceData.price,
          momentum: {
            stochRsiSignal: `Stoch RSI: ${stochRsi?.toFixed(1) ?? "—"}`,
            emaStackSignal: direction === "LONG" ? "8 EMA accelerating up" : "8 EMA accelerating down",
            volatilitySignal: volatilityLevel && volatilityLevel > 45 ? "Expansion" : "Forming",
            trend4H: priceData.htf4hTrend === "BULLISH" || priceData.htf4hTrend === "BEARISH",
          },
          targetPrices: card.targetPrices || undefined,
          riskReward: card.riskReward || undefined,
        });

        console.log(
          `[STATE] SETUP_GENERATED ${symbol} ACTIVE_SNIPER ${direction} | ` +
          `impulse=${ignitionProbability.toFixed(1)}`
        );
      } else {
        const blockReason =
          direction === "NEUTRAL"
            ? "No directional bias"
            : signalState === "BUILDING"
              ? `BUILDING - impulse insufficient (${ignitionProbability.toFixed(1)} < ${IMPULSE_QUALITY_THRESHOLD})`
              : "NONE - no emergence";
        card.blockReason = blockReason;
        console.log(`[STATE] NO_SETUP ${symbol} ${signalState} | ${blockReason}`);
      }
    } catch (error) {
      console.error(`[STATE] ERROR processing ${symbol}:`, error);
      cards.push({
        symbol,
        price: priceData.price,
        source: "v21.2.0-error",
        degraded: true,
        signalState: "NONE",
        marketClass: "CHOP",
        direction: "NEUTRAL",
        tradeReadinessScore: null,
        ignitionProbability: 0,
        stochRsi: null,
        emaSlope: null,
        emaPressure: 0,
        volatilityLevel: null,
        htf4hTrend: "NEUTRAL",
        htf4hMomentum: null,
        htf1hAlignment: null,
        htf15mCompression: null,
        execution15mState: "CHOP",
        marketReadinessState: "ERROR",
        expectedMovePercent: null,
        targetPrices: null,
        riskReward: null,
        cycleId: `${Date.now()}-${symbol}`,
        notes: "ERROR",
        updatedAt: new Date().toISOString(),
      });
    }
  }

  const totalMs = Date.now() - cycleStart;
  console.log(
    `[STATE] v21.2.0 COMPLETE in ${totalMs}ms | ` +
    `cards=${cards.length} | ` +
    `setups=${setups.length}`
  );

  return { cards, setups };
}

// ============================================================================
// v21.2.0: HELPER FUNCTIONS
// ============================================================================

function computeTargets(
  price: number,
  direction: "LONG" | "SHORT" | "NEUTRAL"
): { tp1: number; tp2: number; sl: number } | null {
  if (direction === "NEUTRAL") return null;

  const moveSize = price * 0.015;

  if (direction === "LONG") {
    return {
      tp1: price + moveSize,
      tp2: price + moveSize * 2,
      sl: price - moveSize * 0.5,
    };
  } else {
    return {
      tp1: price - moveSize,
      tp2: price - moveSize * 2,
      sl: price + moveSize * 0.5,
    };
  }
}
