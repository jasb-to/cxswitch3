/**
 * TRADING STRATEGY ENGINE - EARLY ENTRY MODE v2
 * 
 * Focus: Early structural shifts and trendline breaks, not confirmed setups.
 * Detect the shift early → prioritise transition states over completed structures
 */

export type TradeState = "SNIPER" | "BUILDING" | "WATCHING_SHIFT";

export const SYMBOLS = ["BTC", "ETH", "SOL"] as const;
export type Symbol = typeof SYMBOLS[number];

export interface Signal {
  symbol: string;
  price: number;
  state: TradeState;
  
  // 4H STRUCTURE CONTEXT (directional bias layer)
  bias_4h: "Bullish" | "Bearish" | "Neutral";
  structure_4h: "HH/HL" | "LH/HL" | "Ranging" | "Transitioning";
  
  // 15M STRUCTURE (shift detection layer)
  structure_15m: "Shift Forming" | "Compressing" | "Expanding" | "Ranging";
  shift_type: "HH/HL to LH/LL" | "LH/LL to HH/HL" | "None"; // Directional shift happening
  
  // 5M TRIGGER (execution layer - what is happening NOW)
  trigger_5m: "Early Break Up" | "Early Break Down" | "Retest" | "Compression" | "Neutral";
  
  // MARKET ACTIVITY DETECTION
  is_active: boolean; // Price is moving near key levels or changing momentum
  momentum_shift: boolean; // Momentum just changed direction (early signal)
  
  // ENTRY POINT (structure edge, not completion)
  entry?: number; // Entry at structure edge / compression boundary
  entry_description?: string; // "At compression edge" | "Structure shift forming" etc
  
  // Trade details (only for BUILDING / SNIPER)
  direction?: "LONG" | "SHORT";
  stopLoss?: number;
  takeProfit?: number;
  riskReward?: number;
  confidence?: number;
  reason?: string;
  
  // Hold state fields (UI display)
  hold_until?: number;
  hold_remaining_ms?: number;
  
  updated_at: string;
}

// In-memory price history for structure detection
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
    if (!tickerData) {
      console.warn(`[KRAKEN] No data for ${symbol} (${krakenSymbol})`);
      return 0;
    }

    const price = parseFloat(tickerData.c[0]); // Last trade close price
    if (price <= 0) {
      console.warn(`[KRAKEN] Invalid price for ${symbol}: ${price}`);
      return 0;
    }
    console.log(`[PRICE] ${symbol}: ${price}`);
    return price;
  } catch (err) {
    console.warn(`[KRAKEN] Failed to fetch ${symbol}:`, err);
    return 0;
  }
}

/**
 * LAYER 1: 4H BIAS - Directional context
 * Detects if bullish (HH/HL) or bearish (LH/LL) pattern is active
 */
function detect4HBias(history: number[]): { bias: "Bullish" | "Bearish" | "Neutral"; structure: "HH/HL" | "LH/LL" | "Ranging" | "Transitioning" } {
  if (history.length < 10) {
    return { bias: "Neutral", structure: "Ranging" };
  }

  const recent = history.slice(-20);
  
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
    return { bias: "Neutral", structure: "Ranging" };
  }

  return { bias: "Neutral", structure: "Ranging" };
}

/**
 * LAYER 2: 15M SHIFT DETECTION - Early structural changes
 * Detects compression, expansion, and early shift formations (yellow circles)
 */
function detect15mShift(history: number[], bias: "Bullish" | "Bearish" | "Neutral"): { 
  shiftForming: boolean; // Any transition starting
  isCompressing: boolean; // In compression zone
  isExpanding: boolean; // Breaking out of compression
  structure: "Shift Forming" | "Compressing" | "Expanding" | "Ranging";
  shiftType: "HH/HL to LH/LL" | "LH/LL to HH/HL" | "None";
  compressionEdge?: number; // Entry at edge, not completion
  rejectionPoint?: boolean; // Failed retest detected
} {
  if (history.length < 5) {
    return { shiftForming: false, isCompressing: false, isExpanding: false, structure: "Ranging", shiftType: "None" };
  }

  const recent = history.slice(-15);
  const current = recent[recent.length - 1];
  const prev = recent[recent.length - 2];
  const prev2 = recent[recent.length - 3];
  
  // Detect if bullish structure (HH/HL) is forming
  let hhhlCount = 0;
  for (let i = 2; i < recent.length; i++) {
    if (recent[i] > recent[i-2] && recent[i-1] > recent[i-3]) hhhlCount++;
  }
  
  // Detect if bearish structure (LH/LL) is forming
  let llnlCount = 0;
  for (let i = 2; i < recent.length; i++) {
    if (recent[i] < recent[i-2] && recent[i-1] < recent[i-3]) llnlCount++;
  }

  const hhhlForming = hhhlCount >= 1; // Early detection, not waiting for 2+ confirmations
  const llnlForming = llnlCount >= 1;

  // Compression detection: tight range
  const high5 = Math.max(...recent.slice(-5));
  const low5 = Math.min(...recent.slice(-5));
  const range5 = high5 - low5;
  const avgPrice = (high5 + low5) / 2;
  const isCompressing = range5 < avgPrice * 0.005; // < 0.5% = tight compression

  // Expansion detection: volatility increase
  const volatilityRecent = Math.abs(current - prev) + Math.abs(prev - prev2);
  const volatilityOld = recent.slice(-10).reduce((sum, p, i, arr) => 
    i > 0 ? sum + Math.abs(p - arr[i-1]) : 0, 0) / 10;
  const isExpanding = volatilityRecent > volatilityOld * 1.3;

  // Rejection detection: failed retest at level
  const support = Math.min(...recent.slice(-8));
  const resistance = Math.max(...recent.slice(-8));
  const rejectionAtSupport = prev > support && current < support && Math.abs(current - support) < range5;
  const rejectionAtResistance = prev < resistance && current > resistance && Math.abs(current - resistance) < range5;
  const rejectionPoint = rejectionAtSupport || rejectionAtResistance;

  // Shift detection: pattern reversing
  let shiftType: "HH/HL to LH/LL" | "LH/LL to HH/HL" | "None" = "None";
  if (bias === "Bullish" && llnlForming && !hhhlForming) {
    shiftType = "HH/HL to LH/LL";
  } else if (bias === "Bearish" && hhhlForming && !llnlForming) {
    shiftType = "LH/LL to HH/HL";
  }

  // Determine structure phase
  let structure: "Shift Forming" | "Compressing" | "Expanding" | "Ranging" = "Ranging";
  if (shiftType !== "None") {
    structure = "Shift Forming";
  } else if (isCompressing) {
    structure = "Compressing";
  } else if (isExpanding) {
    structure = "Expanding";
  }

  const shiftForming = shiftType !== "None" || rejectionPoint || (isCompressing && (hhhlForming || llnlForming));

  return {
    shiftForming,
    isCompressing,
    isExpanding,
    structure,
    shiftType,
    compressionEdge: isCompressing ? high5 : undefined,
    rejectionPoint,
  };
}

/**
 * LAYER 3: 5M TRIGGER - Real-time price action
 * Detects early breaks, retests, and momentum changes
 */
function detect5mTrigger(history: number[], bias: "Bullish" | "Bearish" | "Neutral", shift: ReturnType<typeof detect15mShift>): {
  trigger: "Early Break Up" | "Early Break Down" | "Retest" | "Compression" | "Neutral";
  momentumShift: boolean;
} {
  if (history.length < 3) {
    return { trigger: "Neutral", momentumShift: false };
  }

  const recent = history.slice(-5);
  const current = recent[recent.length - 1];
  const prev = recent[recent.length - 2];
  const prev2 = recent[recent.length - 3];

  const priceChange = current - prev;
  const direction = priceChange > 0 ? "Up" : priceChange < 0 ? "Down" : "Flat";

  // Early momentum shift detection
  const momentumChanging = 
    (prev2 > prev && current > prev) || // Starting to move up
    (prev2 < prev && current < prev);   // Starting to move down
  const momentumShift = Math.abs(priceChange) > 0.001 && momentumChanging;

  let trigger: "Early Break Up" | "Early Break Down" | "Retest" | "Compression" | "Neutral" = "Neutral";

  if (shift.isExpanding) {
    if (bias === "Bullish" && direction === "Up") {
      trigger = "Early Break Up";
    } else if (bias === "Bearish" && direction === "Down") {
      trigger = "Early Break Down";
    }
  }
  
  if (shift.isCompressing && momentumShift) {
    trigger = "Compression";
  }
  
  if (shift.rejectionPoint) {
    trigger = "Retest";
  }

  return { trigger, momentumShift };
}

/**
 * EARLY ENTRY MODE v2 EVALUATION
 * Prioritises early shifts and transition states, not confirmations
 */
function evaluateMarket(symbol: string, price: number): Signal {
  const history = priceHistory.get(symbol) || [];
  recordPrice(symbol, price);

  // GUARD: Need minimum history
  if (history.length < 3) {
    return {
      symbol,
      price,
      state: "WATCHING_SHIFT",
      bias_4h: "Neutral",
      structure_4h: "Ranging",
      structure_15m: "Ranging",
      shift_type: "None",
      trigger_5m: "Neutral",
      is_active: false,
      momentum_shift: false,
      confidence: 0,
      reason: "Insufficient data",
      updated_at: new Date().toISOString(),
    };
  }

  // Layer 1: 4H Bias (directional context)
  const bias = detect4HBias(history);
  console.log(`[4H BIAS] ${symbol}: bias=${bias.bias}, structure=${bias.structure}`);

  // Layer 2: 15M Shift (early changes)
  const shift = detect15mShift(history, bias.bias);
  console.log(`[15M SHIFT] ${symbol}: forming=${shift.shiftForming}, structure=${shift.structure}, type=${shift.shiftType}`);

  // Layer 3: 5M Trigger (real-time action)
  const trigger = detect5mTrigger(history, bias.bias, shift);
  console.log(`[5M TRIGGER] ${symbol}: trigger=${trigger.trigger}, momentum=${trigger.momentumShift}`);

  // DECISION LOGIC: Early Entry Focus
  let state: TradeState = "WATCHING_SHIFT";
  let direction: "LONG" | "SHORT" | undefined;
  let entry: number | undefined;
  let entry_description: string | undefined;
  let confidence: number = 0;
  let reason: string = "";

  // BUILDING: Early entry zone when shift is forming
  if (shift.shiftForming || (shift.isCompressing && (trigger.momentumShift || shift.rejectionPoint))) {
    state = "BUILDING";
    entry = shift.compressionEdge;
    entry_description = "At compression edge - structure shift forming";
    confidence = 50;
    reason = "Early entry zone: " + shift.shiftType;

    // Determine direction based on shift
    if (shift.shiftType === "HH/HL to LH/LL") {
      direction = "SHORT";
      confidence = 55;
    } else if (shift.shiftType === "LH/LL to HH/HL") {
      direction = "LONG";
      confidence = 55;
    } else if (shift.rejectionPoint) {
      if (trigger.trigger === "Early Break Up") {
        direction = "LONG";
        confidence = 50;
      } else if (trigger.trigger === "Early Break Down") {
        direction = "SHORT";
        confidence = 50;
      }
    }
  }
  // SNIPER: Move already underway, structure break clear
  else if (
    (trigger.trigger === "Early Break Up" && bias.bias === "Bullish") ||
    (trigger.trigger === "Early Break Down" && bias.bias === "Bearish")
  ) {
    state = "SNIPER";
    entry = price;
    entry_description = "Breakout confirmed - move underway";
    confidence = 72;
    reason = trigger.trigger;

    if (trigger.trigger === "Early Break Up") {
      direction = "LONG";
    } else {
      direction = "SHORT";
    }
  }
  // WATCHING_SHIFT: Default active state, market is live
  else {
    state = "WATCHING_SHIFT";
    entry = shift.compressionEdge;
    entry_description = "Monitoring structure - ready for shift";
    confidence = 30;
    reason = shift.structure !== "Ranging" ? shift.structure : "Market activity detected";
  }

  // Generate trade details if direction exists
  let stopLoss, takeProfit, riskReward;
  if (direction) {
    const recent10 = history.slice(-10);
    const high = Math.max(...recent10);
    const low = Math.min(...recent10);
    const rangeSize = high - low;

    if (direction === "LONG") {
      stopLoss = Math.max(low, price * 0.97);
      takeProfit = price + (rangeSize * 1.5);
    } else {
      stopLoss = Math.min(high, price * 1.03);
      takeProfit = price - (rangeSize * 1.5);
    }

    riskReward = Math.abs((takeProfit - entry!) / (entry! - stopLoss));
    if (!isFinite(riskReward)) riskReward = 0;
  }

  return {
    symbol,
    price,
    state,
    bias_4h: bias.bias,
    structure_4h: bias.structure,
    structure_15m: shift.structure,
    shift_type: shift.shiftType,
    trigger_5m: trigger.trigger,
    is_active: shift.shiftForming || trigger.momentumShift || shift.isExpanding,
    momentum_shift: trigger.momentumShift,
    ...(entry !== undefined ? { entry, entry_description } : {}),
    ...(direction ? { direction, stopLoss, takeProfit, riskReward } : {}),
    confidence,
    reason,
    updated_at: new Date().toISOString(),
  };
}

/**
 * Create a complete signal with Kraken prices and early entry analysis
 * Applies hold rules for state inertia
 */
export async function createSignal(symbol: string): Promise<Signal> {
  const { applyHoldRules } = await import("./persistent-store");
  
  const price = await getKrakenTicker(symbol);
  
  if (!price || price <= 0) {
    return {
      symbol,
      price: 0,
      state: "WATCHING_SHIFT",
      bias_4h: "Neutral",
      structure_4h: "Ranging",
      structure_15m: "Ranging",
      shift_type: "None",
      trigger_5m: "Neutral",
      is_active: false,
      momentum_shift: false,
      confidence: 0,
      reason: "Invalid price data",
      updated_at: new Date().toISOString(),
    };
  }

  const marketContext = evaluateMarket(symbol, price);

  // Apply hold rules to the evaluated state
  const { finalState, holdRemaining } = await applyHoldRules(
    symbol,
    marketContext.state,
    marketContext.confidence || 0
  );

  const signal: Signal = {
    ...marketContext,
    state: finalState,
    hold_until: holdRemaining > 0 ? Date.now() + holdRemaining : 0,
    hold_remaining_ms: holdRemaining,
  };

  return signal;
}
