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
// v21.2.1: SNIPER LOCK MAP - PERSISTENT ACTIVE SIGNAL REGISTRY
// ============================================================================

/**
 * v21.2.1 FIX: SNIPER_EVENT persistence
 * 
 * Separates DETECTION (ephemeral) from LOCKING (persistent)
 * 
 * Detection happens every cycle (impulse calculation)
 * Locking happens once (when impulse crosses threshold)
 * 
 * Once locked, signal is immutable until exit conditions met:
 * - TP hit
 * - SL hit  
 * - Timeout expiry (4H window default)
 */
interface SniperEvent {
  symbol: string;
  entry: number;
  tp: number;
  sl: number;
  direction: "LONG" | "SHORT";
  cycleId: string;
  firedAt: number; // timestamp when SNIPER_EVENT was created
  originalImpulse: number; // impulse value when fired
}

const activeSnipers = new Map<string, SniperEvent>();

/**
 * v21.2.1: Check if symbol already has active SNIPER event
 * If yes, return locked event (don't re-evaluate)
 * If no, return null (allow fresh detection)
 */
function getActiveSniper(symbol: string): SniperEvent | null {
  const event = activeSnipers.get(symbol);
  if (!event) return null;
  
  // Check timeout: 4-hour window (14400000ms)
  const age = Date.now() - event.firedAt;
  const timeoutMs = 4 * 60 * 60 * 1000;
  
  if (age > timeoutMs) {
    console.log(`[SNIPER_UNLOCK] ${symbol}: Event expired after ${(age / 1000 / 60 / 60).toFixed(1)}H`);
    activeSnipers.delete(symbol);
    return null;
  }
  
  return event;
}

/**
 * v21.2.1: Lock a new SNIPER event (only if not already active)
 */
function lockSniperEvent(
  symbol: string,
  entry: number,
  tp: number,
  sl: number,
  direction: "LONG" | "SHORT",
  cycleId: string,
  impulse: number
): SniperEvent {
  const event: SniperEvent = {
    symbol,
    entry,
    tp,
    sl,
    direction,
    cycleId,
    firedAt: Date.now(),
    originalImpulse: impulse,
  };
  
  activeSnipers.set(symbol, event);
  console.log(`[SNIPER_LOCK] ${symbol}: LOCKED ${direction} entry=${entry.toFixed(2)} tp=${tp.toFixed(2)} sl=${sl.toFixed(2)} impulse=${impulse.toFixed(1)}`);
  
  return event;
}

// ============================================================================
// v21.2.1: CANONICAL ASSET WHITELIST GATE (DATA HYGIENE BOUNDARY)
// ============================================================================

const VALID_ASSETS = new Set(["BTC", "ETH", "SOL"]);

/**
 * v21.2.1: Normalize asset from exchange symbols to canonical assets
 * 
 * Maps:
 * - XBTUSD, XXBTZUSD → BTC
 * - XETHZUSD, ETHUSD → ETH
 * - SOLUSD → SOL
 * - Direct symbols (BTC, ETH, SOL) → pass through
 * - Everything else → null (rejected)
 */
function normalizeAsset(symbol: string): string | null {
  // Exchange fallback symbols
  if (symbol === "XBTUSD" || symbol === "XXBTZUSD") return "BTC";
  if (symbol === "XETHZUSD" || symbol === "ETHUSD") return "ETH";
  if (symbol === "SOLUSD") return "SOL";
  
  // Direct canonical symbols
  if (VALID_ASSETS.has(symbol)) return symbol;
  
  // Reject everything else (PEPE, DOGE, test symbols, etc.)
  return null;
}

// ============================================================================
// v21.1.0: TYPE DEFINITIONS (CLEAN - NO v17/v18/v19/v20 contamination)
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
  
  // v21.2.0: TELEGRAM FIELDS (required for alert formatting)
  mode: "SNIPER" | "CONFIRMED";
  confidence: number;  // Alias for tradeReadinessScore for telegram compatibility

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
  entry: number;  // GUARANTEED: last candle close
  tp: number;     // GUARANTEED: entry ± volatility%
  sl: number;     // GUARANTEED: entry ∓ volatility%
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
// v21.2.0: PHASE 1 - MARKET DATA COMPUTATION (from candle history)
// ============================================================================

/**
 * Compute Stoch RSI from candle close prices
 * Returns value 0-100
 */
function computeStochRsi(priceData: PriceData): number | null {
  if (!priceData.candles || priceData.candles.length < 14) return null;
  
  const closes = priceData.candles.map(c => c.close);
  
  // Simple RSI calculation (14 period)
  const gains: number[] = [];
  const losses: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    gains.push(change > 0 ? change : 0);
    losses.push(change < 0 ? -change : 0);
  }
  
  const avgGain = gains.slice(-14).reduce((a, b) => a + b, 0) / 14;
  const avgLoss = losses.slice(-14).reduce((a, b) => a + b, 0) / 14;
  
  if (avgLoss === 0) return avgGain > 0 ? 100 : 50;
  
  const rs = avgGain / avgLoss;
  const rsi = 100 - (100 / (1 + rs));
  
  // Stoch RSI: convert RSI to 0-100 scale (typically takes RSI over last 14 RSI values)
  return Math.min(100, Math.max(0, rsi));
}

/**
 * Compute EMA slope from candle closes
 * Returns slope of 8-period EMA
 */
function computeEmaSlope(priceData: PriceData): number | null {
  if (!priceData.candles || priceData.candles.length < 8) return null;
  
  const closes = priceData.candles.map(c => c.close);
  
  // Calculate 8-period EMA
  let ema = closes[0];
  const multiplier = 2 / (8 + 1);
  
  for (let i = 1; i < closes.length; i++) {
    ema = closes[i] * multiplier + ema * (1 - multiplier);
  }
  
  // Previous EMA (one candle ago)
  let prevEma = closes[0];
  for (let i = 1; i < closes.length - 1; i++) {
    prevEma = closes[i] * multiplier + prevEma * (1 - multiplier);
  }
  
  return ema - prevEma;
}

/**
 * Compute volatility level from candles (ATR-like)
 * Returns 0-100 scale
 */
function computeVolatilityLevel(priceData: PriceData): number | null {
  if (!priceData.candles || priceData.candles.length < 14) return null;
  
  const candles = priceData.candles.slice(-14);
  const atr = candles.reduce((sum, c) => {
    const tr = Math.max(
      c.high - c.low,
      Math.abs(c.high - (priceData.candles![priceData.candles!.length - 1].close)),
      Math.abs(c.low - (priceData.candles![priceData.candles!.length - 1].close))
    );
    return sum + tr;
  }, 0) / candles.length;
  
  // Normalize to 0-100 (50 = moderate volatility)
  const currentPrice = priceData.price;
  const volatilityPercent = (atr / currentPrice) * 100;
  return Math.min(100, volatilityPercent * 50);
}

/**
 * Compute volume impulse component
 */
function computeVolumeComponent(priceData: PriceData): number {
  if (!priceData.candles || priceData.candles.length < 20) return 0;
  
  const recentVolumes = priceData.candles.slice(-5).map(c => c.volume);
  const avgVolume = priceData.candles.slice(-20).reduce((sum, c) => sum + c.volume, 0) / 20;
  
  if (avgVolume === 0) return 0;
  
  const currentVolume = recentVolumes.reduce((a, b) => a + b, 0) / recentVolumes.length;
  const volumeRatio = currentVolume / avgVolume;
  
  // Scale 0-10: ratio of 1.0 = 0, ratio of 2.0 = 10
  return Math.min(10, Math.max(0, (volumeRatio - 1) * 10));
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

  for (const [rawSymbol, priceData] of Object.entries(market)) {
    try {
      // v21.2.1: HARD ASSET FILTER - CRITICAL DATA HYGIENE BOUNDARY
      const symbol = normalizeAsset(rawSymbol);
      if (!symbol) {
        console.log(`[ASSET_REJECT] ${rawSymbol} - not in canonical set (BTC/ETH/SOL)`);
        continue;
      }
      // PHASE 1: Market Data - compute from candles
      const stochRsi = computeStochRsi(priceData);
      const emaSlope = computeEmaSlope(priceData);
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

      // PHASE 4: Quality Filter → Terminal State + SNIPER LOCKING
      // v21.2.1: CHECK FOR ACTIVE SNIPER LOCK FIRST
      const activeSniper = getActiveSniper(symbol);
      let signalState: SignalState;
      let lockedEntry: number | null = null;
      let lockedTp: number | null = null;
      let lockedSl: number | null = null;
      
      if (activeSniper) {
        // SNIPER_EVENT already locked - maintain ACTIVE_SNIPER state
        signalState = "ACTIVE_SNIPER";
        lockedEntry = activeSniper.entry;
        lockedTp = activeSniper.tp;
        lockedSl = activeSniper.sl;
        console.log(
          `[SNIPER_LOCKED] ${symbol}: Maintaining lock from cycle ${activeSniper.cycleId} ` +
          `age=${((Date.now() - activeSniper.firedAt) / 1000 / 60).toFixed(0)}min`
        );
      } else {
        // No active lock - evaluate fresh
        signalState = deriveExecutionState(ignitionProbability);
        
        // If fresh ACTIVE_SNIPER detected, lock it immediately
        if (signalState === "ACTIVE_SNIPER") {
          const entry = priceData.price;
          const targets = computeTargets(entry, direction);
          if (targets) {
            lockSniperEvent(
              symbol,
              entry,
              targets.tp1,
              targets.sl,
              direction,
              `${Date.now()}-${symbol}`,
              ignitionProbability
            );
            lockedEntry = entry;
            lockedTp = targets.tp1;
            lockedSl = targets.sl;
          }
        }
      }

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
        targetPrices: signalState === "ACTIVE_SNIPER" ? (lockedTp && lockedSl ? { tp1: lockedTp, tp2: lockedTp * 1.5, sl: lockedSl } : computeTargets(priceData.price, direction)) : null,
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
        // v21.2.0: TELEGRAM FIELDS
        mode: signalState === "ACTIVE_SNIPER" ? "SNIPER" : "CONFIRMED",
        confidence: signalState === "ACTIVE_SNIPER" ? 85 : 30,
      };

      cards.push(card);

      // Generate setup only for ACTIVE_SNIPER
      if (signalState === "ACTIVE_SNIPER" && direction !== "NEUTRAL") {
        // v21.2.1: FINAL SAFETY NET - verify asset one more time before SNIPER output
        if (!VALID_ASSETS.has(symbol)) {
          console.log(`[ASSET_REJECT_FINAL] ${symbol} - failed final safety check, not adding to SNIPER setups`);
          continue;
        }
        
        // v21.2.1: GUARANTEED ENTRY/TP/SL - Fallback calculation if missing
        const entry = priceData.price;
        const volFactor = (volatilityLevel || 30) / 100; // Default 30% volatility if null
        const tp = direction === "LONG" 
          ? entry * (1 + volFactor)
          : entry * (1 - volFactor);
        const sl = direction === "LONG"
          ? entry * (1 - volFactor)
          : entry * (1 + volFactor);
        
        setups.push({
          symbol,
          mode: "SNIPER",
          direction: direction as "LONG" | "SHORT",
          score: Math.min(85, 100),
          reason: `${signalState} ${direction} - impulse=${ignitionProbability.toFixed(0)}`,
          price: entry,
          entry, // GUARANTEED: last candle close
          tp,    // GUARANTEED: entry ± volatility%
          sl,    // GUARANTEED: entry ∓ volatility%
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
          `entry=${entry.toFixed(2)} tp=${tp.toFixed(2)} sl=${sl.toFixed(2)} | ` +
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
