/**
 * SIGNAL ENGINE - THE ONLY PLACE SIGNAL EVALUATION HAPPENS
 * 
 * All paths must use this:
 * - /api/signals (live signals)
 * - /api/cron (event-driven alerts)
 * - UI (display)
 * - preview (testing)
 * 
 * NO DUPLICATE EVALUATION LOGIC ANYWHERE ELSE
 */

import type { TradeState } from "./strategy-core";
import { applyHoldRules, getHoldState } from "./persistent-store";

export type Symbol = "BTC" | "ETH" | "SOL";

export interface EngineSignal {
  symbol: string;
  price: number;
  state: TradeState;
  bias_4h: "Bullish" | "Bearish" | "Neutral";
  structure_4h: "HH/HL" | "LH/LL" | "Transitioning" | "Ranging";
  structure_15m: "Compressing" | "Shift Forming" | "Expanding" | "Ranging";
  trigger_5m: "Early Break Up" | "Early Break Down" | "Retest Bullish" | "Retest Bearish" | "Flat";
  direction?: "LONG" | "SHORT";
  entry?: number;
  stopLoss?: number;
  takeProfit?: number;
  riskReward?: number;
  confidence: number;
  hold_until: number;
  hold_remaining_ms: number;
  updated_at: string;
}

// In-memory price history
const priceHistory = new Map<string, number[]>();
const MAX_HISTORY = 100;

function recordPrice(symbol: string, price: number): void {
  if (!priceHistory.has(symbol)) {
    priceHistory.set(symbol, []);
  }
  const history = priceHistory.get(symbol)!;
  history.push(price);
  if (history.length > MAX_HISTORY) {
    history.shift();
  }
}

/**
 * LAYER 1: 4H BIAS DETECTION
 * Detects directional bias with trendline break detection
 */
function detect4HBias(history: number[]): { bias: "Bullish" | "Bearish" | "Neutral"; structure: "HH/HL" | "LH/LL" | "Ranging" | "Transitioning" } {
  if (history.length < 10) {
    return { bias: "Neutral", structure: "Ranging" };
  }

  const recent = history.slice(-20);
  
  // TRENDLINE BREAK DETECTION (HIGH PRIORITY)
  if (recent.length >= 5) {
    const veryRecent = recent.slice(-5);
    const previousSection = recent.slice(-10, -5);
    
    const veryRecentLow = Math.min(...veryRecent);
    const veryRecentHigh = Math.max(...veryRecent);
    const previousLow = Math.min(...previousSection);
    const previousHigh = Math.max(...previousSection);
    
    // Strong bearish: new lows below previous lows (breakdown confirmed)
    if (veryRecentLow < previousLow * 0.98) {
      return { bias: "Bearish", structure: "LH/LL" };
    }
    
    // Strong bullish: new highs above previous highs (breakout confirmed)
    if (veryRecentHigh > previousHigh * 1.02) {
      return { bias: "Bullish", structure: "HH/HL" };
    }
    
    // Trend direction
    let downCount = 0, upCount = 0;
    for (let i = 1; i < veryRecent.length; i++) {
      if (veryRecent[i] < veryRecent[i-1]) downCount++;
      if (veryRecent[i] > veryRecent[i-1]) upCount++;
    }
    
    if (downCount >= 4 && veryRecentLow <= previousLow) {
      return { bias: "Bearish", structure: "LH/LL" };
    }
    
    if (upCount >= 4 && veryRecentHigh >= previousHigh) {
      return { bias: "Bullish", structure: "HH/HL" };
    }
  }
  
  // Pattern counting
  let hhCount = 0, hlCount = 0, llCount = 0, lhCount = 0;
  
  for (let i = 2; i < recent.length; i++) {
    const isHH = recent[i] > recent[i-2] && recent[i-1] > recent[i-3];
    const isHL = recent[i-1] > recent[i-3] && recent[i] < recent[i-1];
    const isLL = recent[i] < recent[i-2] && recent[i-1] < recent[i-3];
    const isLH = recent[i-1] < recent[i-3] && recent[i] > recent[i-1];
    
    if (isHH) hhCount++;
    if (isHL) hlCount++;
    if (isLL) llCount++;
    if (isLH) lhCount++;
  }

  const hhhlActive = hhCount >= 2 || (hhCount > 0 && hlCount > 0);
  const llnlActive = llCount >= 2 || (llCount > 0 && lhCount > 0);

  if (hhhlActive && !llnlActive) {
    return { bias: "Bullish", structure: "HH/HL" };
  }
  if (llnlActive && !hhhlActive) {
    return { bias: "Bearish", structure: "LH/LL" };
  }
  if (hhhlActive && llnlActive) {
    return { bias: "Neutral", structure: "Transitioning" };
  }

  return { bias: "Neutral", structure: "Ranging" };
}

/**
 * LAYER 2: 15M SHIFT DETECTION
 */
function detect15mShift(history: number[], bias: "Bullish" | "Bearish" | "Neutral"): {
  structure: "Shift Forming" | "Compressing" | "Expanding" | "Ranging";
  entryLevel?: number;
  momentumShift?: boolean;
} {
  if (history.length < 5) {
    return { structure: "Ranging" };
  }

  const recent = history.slice(-15);
  const high = Math.max(...recent);
  const low = Math.min(...recent);
  const range = high - low;
  const mid = (high + low) / 2;

  const isCompressing = range < (high + low) / 2 * 0.01;

  const recent5 = recent.slice(-5);
  const earlier10 = recent.slice(0, 10);
  const range5 = Math.max(...recent5) - Math.min(...recent5);
  const range10 = Math.max(...earlier10) - Math.min(...earlier10);
  const isExpanding = range5 > range10 * 1.2;

  let hasRejection = false;
  if (recent.length >= 3) {
    const lastThree = recent.slice(-3);
    const isReject = (lastThree[0] < mid && lastThree[1] > mid && lastThree[2] < mid) ||
                     (lastThree[0] > mid && lastThree[1] < mid && lastThree[2] > mid);
    hasRejection = isReject;
  }

  let structure: "Shift Forming" | "Compressing" | "Expanding" | "Ranging" = "Ranging";
  
  if (hasRejection || (isCompressing && bias !== "Neutral")) {
    structure = "Shift Forming";
  } else if (isCompressing) {
    structure = "Compressing";
  } else if (isExpanding) {
    structure = "Expanding";
  }

  const entryLevel = isCompressing ? high : undefined;
  const momentumShift = history.length >= 3 && 
    (history[history.length - 1] - history[history.length - 2]) * 
    (history[history.length - 2] - history[history.length - 3]) < 0;

  return { structure, entryLevel, momentumShift };
}

/**
 * LAYER 3: 5M TRIGGER DETECTION
 */
function detect5mTrigger(history: number[], isActive: boolean, momentumShift: boolean): "Early Break Up" | "Early Break Down" | "Retest Bullish" | "Retest Bearish" | "Flat" {
  if (history.length < 2 || !isActive) {
    return "Flat";
  }

  const current = history[history.length - 1];
  const prev = history[history.length - 2];

  // RELAXED TRIGGER: Only require 1 bar break (current > prev), not 3 consecutive
  const isBreakingUp = current > prev;
  const isBreakingDown = current < prev;

  // Retest patterns (still require 3-bar structure)
  let isRetestBullish = false;
  let isRetestBearish = false;
  if (history.length >= 3) {
    const prev2 = history[history.length - 3];
    isRetestBullish = (prev > current && prev > prev2) && current > prev2;
    isRetestBearish = (prev < current && prev < prev2) && current < prev2;
  }

  if (isBreakingUp && momentumShift) return "Early Break Up";
  if (isBreakingDown && momentumShift) return "Early Break Down";
  if (isBreakingUp) return "Early Break Up";
  if (isBreakingDown) return "Early Break Down";
  if (isRetestBullish) return "Retest Bullish";
  if (isRetestBearish) return "Retest Bearish";

  return "Flat";
}

/**
 * Fetch live price from Kraken
 */
async function getKrakenTicker(symbol: string): Promise<number> {
  const krakenMap: Record<string, string> = {
    BTC: "XXBTZUSD",
    ETH: "XETHZUSD",
    SOL: "SOLUSD",
  };

  const krakenSymbol = krakenMap[symbol];
  if (!krakenSymbol) return 0;

  try {
    const response = await fetch(`https://api.kraken.com/0/public/Ticker?pair=${krakenSymbol}`, {
      cache: "no-store",
    });

    const data = await response.json();
    const tickerData = data.result?.[krakenSymbol];
    if (!tickerData) return 0;

    const price = parseFloat(tickerData.c[0]);
    if (price <= 0) return 0;
    console.log(`[PRICE] ${symbol}: ${price}`);
    return price;
  } catch (err) {
    console.warn(`[KRAKEN] Failed to fetch ${symbol}:`, err);
    return 0;
  }
}

/**
 * THE ONLY FUNCTION THAT EVALUATES SIGNALS
 * 
 * This is called by:
 * - /api/signals -> signal[]
 * - cron -> read snapshot
 * - UI -> display
 * - preview -> test
 */
export async function evaluateSignal(symbol: string): Promise<EngineSignal> {
  // Step 1: Get price
  const price = await getKrakenTicker(symbol);

  // Step 2: Get history and record price
  const history = priceHistory.get(symbol) || [];
  recordPrice(symbol, price);

  // Step 3: Detect market structure
  const { bias: bias_4h, structure: structure_4h } = detect4HBias(history);
  const shift = detect15mShift(history, bias_4h);
  
  const isActive = shift.structure !== "Ranging" || bias_4h !== "Neutral";
  const trigger_5m = detect5mTrigger(history, isActive, shift.momentumShift || false);

  // Step 4: Initial market context evaluation
  let state: TradeState = "WATCHING_SHIFT";
  let direction: "LONG" | "SHORT" | undefined;
  let confidence: number;
  let entry: number | undefined;

  // CRITICAL: Check strictest condition FIRST (SNIPER), then fallback to BUILDING, then WATCHING_SHIFT
  
  const isShiftActive = shift.structure === "Shift Forming" || shift.structure === "Expanding";
  const isBiasActive = bias_4h !== "Neutral";
  const isTriggerActive = trigger_5m !== "Flat";

  // CHECK SNIPER FIRST (strictest conditions)
  if (isShiftActive && isBiasActive && isTriggerActive) {
    state = "SNIPER";
    entry = price;
    
    // Direction from bias + trigger alignment
    if (bias_4h === "Bullish" && (trigger_5m === "Early Break Up" || trigger_5m === "Retest Bullish")) {
      direction = "LONG";
      confidence = 75;
    } else if (bias_4h === "Bearish" && (trigger_5m === "Early Break Down" || trigger_5m === "Retest Bearish")) {
      direction = "SHORT";
      confidence = 75;
    } else {
      // SNIPER without perfect alignment (trigger doesn't match bias)
      confidence = 60; // Reduced threshold for trade execution
    }
  } 
  // FALLBACK TO BUILDING (relaxed conditions)
  else if (bias_4h !== "Neutral" || shift.structure !== "Ranging") {
    state = "BUILDING";
    entry = shift.entryLevel;
    
    if (bias_4h === "Bullish") {
      direction = "LONG";
      confidence = 55;
    } else if (bias_4h === "Bearish") {
      direction = "SHORT";
      confidence = 55;
    } else {
      confidence = 45;
    }
  } 
  // ELSE: WATCHING_SHIFT (already initialized above)
  else {
    state = "WATCHING_SHIFT";
    confidence = Math.max(20, Math.floor(shift.momentumShift ? 35 : 20));
  }
  
  // SAFETY: Ensure state is always valid
  if (!state || !["WATCHING_SHIFT", "BUILDING", "SNIPER"].includes(state)) {
    state = "WATCHING_SHIFT";
    confidence = 0;
  }

  // Step 5: Apply hold rules
  const { finalState, holdRemaining } = await applyHoldRules(symbol, state, confidence);

  // SAFETY: Ensure finalState is valid
  let validatedState = finalState;
  if (!validatedState || !["WATCHING_SHIFT", "BUILDING", "SNIPER"].includes(validatedState)) {
    console.warn(
      `[ENGINE] SAFETY: Invalid finalState '${validatedState}' for ${symbol}, defaulting to WATCHING_SHIFT`
    );
    validatedState = "WATCHING_SHIFT";
  }

  // Preserve confidence from hold state
  let finalConfidence = confidence;
  if (holdRemaining > 0) {
    const holdState = await getHoldState(symbol);
    if (holdState) {
      finalConfidence = holdState.confidence;
    }
  }

  // Calculate SL/TP ONLY for SNIPER state
  let stopLoss: number | undefined;
  let takeProfit: number | undefined;
  let riskReward: number | undefined;

  if (validatedState === "SNIPER" && entry && direction) {
    const recent = history.slice(-10);
    const high = Math.max(...recent);
    const low = Math.min(...recent);
    const rangeSize = high - low;

    if (direction === "LONG") {
      stopLoss = Math.max(low, price * 0.97);
      takeProfit = price + (rangeSize * 1.5);
    } else {
      stopLoss = Math.min(high, price * 1.03);
      takeProfit = price - (rangeSize * 1.5);
    }

    riskReward = Math.abs((takeProfit - entry) / (entry - stopLoss));
    if (!isFinite(riskReward)) riskReward = 0;
  }

  const signal: EngineSignal = {
    symbol,
    price,
    state: validatedState,
    bias_4h,
    structure_4h,
    structure_15m: shift.structure,
    trigger_5m,
    direction,
    entry,
    stopLoss,
    takeProfit,
    riskReward,
    confidence: finalConfidence,
    hold_until: holdRemaining > 0 ? Date.now() + holdRemaining : 0,
    hold_remaining_ms: holdRemaining,
    updated_at: new Date().toISOString(),
  };

  return signal;
}
