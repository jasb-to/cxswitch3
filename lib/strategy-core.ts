/**
 * TRADING STRATEGY ENGINE - EARLY ENTRY MODE v2
 * 
 * Focus: Early structural shifts and trendline breaks, not confirmed setups.
 * Detect the shift early → prioritize transition states over completed structures
 */

export type TradeState = "SNIPER" | "BUILDING" | "WATCHING_SHIFT";

export const SYMBOLS = ["BTC", "ETH", "SOL"] as const;
export type Symbol = typeof SYMBOLS[number];

export interface Signal {
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
  hold_remaining_ms?: number;
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
  // If we see a clear trendline break, immediately flip bias regardless of pattern count
  if (recent.length >= 5) {
    const veryRecent = recent.slice(-5);
    const previousSection = recent.slice(-10, -5);
    
    // Check momentum: are we making lower lows/highs?
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
    
    // Trend direction: last 5 candles trending down or up?
    let downCount = 0, upCount = 0;
    for (let i = 1; i < veryRecent.length; i++) {
      if (veryRecent[i] < veryRecent[i-1]) downCount++;
      if (veryRecent[i] > veryRecent[i-1]) upCount++;
    }
    
    // Strong downtrend momentum (4+ down candles out of 5)
    if (downCount >= 4 && veryRecentLow <= previousLow) {
      return { bias: "Bearish", structure: "LH/LL" };
    }
    
    // Strong uptrend momentum (4+ up candles out of 5)
    if (upCount >= 4 && veryRecentHigh >= previousHigh) {
      return { bias: "Bullish", structure: "HH/HL" };
    }
  }
  
  // Pattern counting (secondary detection)
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
  shiftType: "HH/HL to LH/LL" | "LH/LL to HH/HL" | "None";
  entryLevel?: number;
} {
  if (history.length < 5) {
    return { structure: "Ranging", shiftType: "None" };
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

  let shiftType: "HH/HL to LH/LL" | "LH/LL to HH/HL" | "None" = "None";
  
  if (bias === "Bullish" && isCompressing) {
    shiftType = "HH/HL to LH/LL";
  } else if (bias === "Bearish" && isCompressing) {
    shiftType = "LH/LL to HH/HL";
  }

  let structure: "Shift Forming" | "Compressing" | "Expanding" | "Ranging" = "Ranging";
  
  if (hasRejection || (isCompressing && shiftType !== "None")) {
    structure = "Shift Forming";
  } else if (isCompressing) {
    structure = "Compressing";
  } else if (isExpanding) {
    structure = "Expanding";
  }

  const entryLevel = isCompressing ? high : undefined;

  return { structure, shiftType, entryLevel };
}

/**
 * LAYER 3: 5M TRIGGER DETECTION
 */
function detect5mTrigger(history: number[], isActive: boolean, momentumShift: boolean): {
  trigger: "Early Break Up" | "Early Break Down" | "Retest Bullish" | "Retest Bearish" | "Flat";
} {
  if (history.length < 3 || !isActive) {
    return { trigger: "Flat" };
  }

  const current = history[history.length - 1];
  const prev = history[history.length - 2];
  const prev2 = history[history.length - 3];

  const isBreakingUp = current > prev && prev > prev2;
  const isBreakingDown = current < prev && prev < prev2;
  const isRetestBullish = (prev > current && prev > prev2) && current > prev2;
  const isRetestBearish = (prev < current && prev < prev2) && current < prev2;

  if (isBreakingUp && momentumShift) return { trigger: "Early Break Up" };
  if (isBreakingDown && momentumShift) return { trigger: "Early Break Down" };
  if (isBreakingUp) return { trigger: "Early Break Up" };
  if (isBreakingDown) return { trigger: "Early Break Down" };
  if (isRetestBullish) return { trigger: "Retest Bullish" };
  if (isRetestBearish) return { trigger: "Retest Bearish" };

  return { trigger: "Flat" };
}

/**
 * EARLY ENTRY MODE v2 EVALUATION
 */
function evaluateMarket(symbol: string, price: number): Omit<Signal, "symbol" | "price" | "updated_at"> {
  if (!price || price <= 0) {
    return {
      state: "WATCHING_SHIFT",
      bias_4h: "Neutral",
      structure_4h: "Ranging",
      structure_15m: "Ranging",
      trigger_5m: "Flat",
      confidence: 0,
    };
  }

  const history = priceHistory.get(symbol) || [];
  recordPrice(symbol, price);

  // Layer 1: 4H bias
  const { bias: bias_4h, structure: structure_4h } = detect4HBias(history);
  const shift = detect15mShift(history, bias_4h);

  const isActive = shift.structure !== "Ranging" || bias_4h !== "Neutral";
  const momentumShift = history.length >= 3 && 
    (history[history.length - 1] - history[history.length - 2]) * 
    (history[history.length - 2] - history[history.length - 3]) < 0;
  
  const { trigger: trigger_5m } = detect5mTrigger(history, isActive, momentumShift);

  let state: TradeState;
  let direction: "LONG" | "SHORT" | undefined;
  let confidence: number;
  let entry: number | undefined;

  // BUILDING: Early entry zone - triggers on ANY structural activity
  if (bias_4h !== "Neutral" || shift.structure !== "Ranging") {
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
  } else if (
    (trigger_5m === "Early Break Up" && bias_4h === "Bullish") ||
    (trigger_5m === "Early Break Down" && bias_4h === "Bearish")
  ) {
    state = "SNIPER";
    entry = price;
    direction = trigger_5m === "Early Break Up" ? "LONG" : "SHORT";
    confidence = 75;
  } else {
    state = "WATCHING_SHIFT";
    confidence = Math.max(20, Math.floor(momentumShift ? 35 : 20));
  }

  let stopLoss, takeProfit, riskReward;
  if (state !== "WATCHING_SHIFT" && direction && entry) {
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

  return {
    state,
    bias_4h,
    structure_4h,
    structure_15m: shift.structure,
    trigger_5m,
    ...(entry ? { entry } : {}),
    ...(direction ? { direction, stopLoss, takeProfit, riskReward } : {}),
    confidence,
  };
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

    const price = parseFloat(tickerData.c[0]);
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
 * Create a complete signal with live prices and Early Entry Mode v2 evaluation
 */
export async function createSignal(symbol: string): Promise<Signal> {
  const { applyHoldRules, getHoldState } = await import("./persistent-store");
  
  const price = await getKrakenTicker(symbol);
  const marketContext = evaluateMarket(symbol, price);

  const { finalState, holdRemaining } = await applyHoldRules(
    symbol,
    marketContext.state,
    marketContext.confidence || 0
  );

  // Preserve confidence from hold state if HOLD is active
  let confidence = marketContext.confidence || 0;
  if (holdRemaining > 0) {
    const holdState = await getHoldState(symbol);
    if (holdState) {
      confidence = holdState.confidence;
    }
  }

  const signal: Signal = {
    symbol,
    price,
    ...marketContext,
    state: finalState,
    confidence,
    hold_until: holdRemaining > 0 ? Date.now() + holdRemaining : 0,
    hold_remaining_ms: holdRemaining,
    updated_at: new Date().toISOString(),
  };

  return signal;
}
