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
  
  // 4H STRUCTURE CONTEXT (directional bias layer)
  bias_4h: "Bullish" | "Bearish" | "Neutral";
  structure_4h: "HH/HL" | "LH/LL" | "Ranging" | "Transitioning";
  
  // 15M STRUCTURE (shift detection layer)
  structure_15m: "Shift Forming" | "Compressing" | "Expanding" | "Ranging";
  shift_type: "HH/HL to LH/LL" | "LH/LL to HH/HL" | "None";
  
  // 5M TRIGGER (execution layer)
  trigger_5m: "Early Break Up" | "Early Break Down" | "Retest" | "Compression" | "Neutral";
  
  // MARKET ACTIVITY DETECTION
  is_active: boolean;
  momentum_shift: boolean;
  
  // ENTRY POINT
  entry?: number;
  entry_description?: string;
  
  // Trade details
  direction?: "LONG" | "SHORT";
  stopLoss?: number;
  takeProfit?: number;
  riskReward?: number;
  confidence?: number;
  reason?: string;
  
  // Hold state
  hold_until?: number;
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

  const { bias: bias4h, structure: structure4h } = detect4HBias(history);
  const shift = detect15mShift(history, bias4h);

  const isActive = shift.structure !== "Ranging" || bias4h !== "Neutral";
  const momentumShift = history.length >= 3 && 
    (history[history.length - 1] - history[history.length - 2]) * 
    (history[history.length - 2] - history[history.length - 3]) < 0;
  
  const { trigger: trigger5m } = detect5mTrigger(history, isActive, momentumShift);

  let state: TradeState;
  let direction: "LONG" | "SHORT" | undefined;
  let confidence: number;
  let entry: number | undefined;

  // BUILDING: Early entry zone (any shift forming)
  if (shift.structure === "Shift Forming" || (shift.structure === "Compressing" && bias4h !== "Neutral")) {
    state = "BUILDING";
    entry = shift.entryLevel;
    
    if (bias4h === "Bullish" && shift.shiftType === "HH/HL to LH/LL") {
      direction = "LONG";
      confidence = 55;
    } else if (bias4h === "Bearish" && shift.shiftType === "LH/LL to HH/HL") {
      direction = "SHORT";
      confidence = 55;
    } else {
      confidence = 45;
    }
  }
  // SNIPER: Move already underway
  else if (
    (trigger5m === "Early Break Up" && bias4h === "Bullish") ||
    (trigger5m === "Early Break Down" && bias4h === "Bearish")
  ) {
    state = "SNIPER";
    entry = price;
    direction = trigger5m === "Early Break Up" ? "LONG" : "SHORT";
    confidence = 75;
  }
  // WATCHING_SHIFT: Default active state
  else {
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
    bias_4h: bias4h,
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
  const { applyHoldRules } = await import("./persistent-store");
  
  const price = await getKrakenTicker(symbol);
  const marketContext = evaluateMarket(symbol, price);

  const { finalState, holdRemaining } = await applyHoldRules(
    symbol,
    marketContext.state,
    marketContext.confidence || 0
  );

  const signal: Signal = {
    symbol,
    price,
    ...marketContext,
    state: finalState,
    hold_until: holdRemaining > 0 ? Date.now() + holdRemaining : 0,
    hold_remaining_ms: holdRemaining,
    updated_at: new Date().toISOString(),
  };

  return signal;
}
