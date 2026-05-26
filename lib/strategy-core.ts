/**
 * TRADING STRATEGY ENGINE - TOP-DOWN MULTI-TIMEFRAME STRUCTURE MODEL
 * 
 * Entries at yellow circles: compression tops where breakouts occur
 */

export type TradeState = "SNIPER" | "BUILDING" | "DO_NOT_TRADE";

export const SYMBOLS = ["BTC", "ETH", "SOL"] as const;
export type Symbol = typeof SYMBOLS[number];

export interface Signal {
  symbol: string;
  price: number;
  state: TradeState;
  
  // 4H STRUCTURE CONTEXT (directional bias layer)
  bias_4h: "Bullish" | "Bearish" | "Neutral";
  structure_4h: "HH/HL" | "LH/LL" | "Ranging" | "Unclear";
  
  // 15M STRUCTURE (setup layer - what is forming)
  structure_15m: "Breakout" | "Setup" | "Ranging";
  hh_hl_active: boolean; // Bullish pattern forming
  lh_ll_active: boolean; // Bearish pattern forming
  
  // 5M TRIGGER (execution layer - what is happening now)
  trigger_5m: "Breaking Up" | "Breaking Down" | "Retest Bullish" | "Retest Bearish" | "Flat";
  
  // ENTRY POINT (at compression top / formation completion)
  entry?: number; // Entry price at compression level / formation completion
  entry_description?: string; // "At compression top" | "Breaking above resistance" etc
  
  // Trade details (only for SNIPER / BUILDING)
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
 * LAYER 1: 4H BIAS DETECTION
 * Determines market direction via HH/HL vs LH/LL patterns
 */
function detect4HBias(history: number[]): { bias: "Bullish" | "Bearish" | "Neutral"; structure: "HH/HL" | "LH/LL" | "Ranging" | "Unclear" } {
  if (history.length < 10) {
    return { bias: "Neutral", structure: "Unclear" };
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

  return { bias: "Neutral", structure: "Unclear" };
}

/**
 * LAYER 2: 15M SETUP DETECTION
 * Finds compression tops where entries should be placed (yellow circles)
 */
function detect15mSetup(history: number[], bias: "Bullish" | "Bearish" | "Neutral"): { 
  isSetup: boolean; 
  hhhlActive: boolean; 
  llnlActive: boolean; 
  structure: "Breakout" | "Setup" | "Ranging";
  compressionTop?: number; // Entry price at compression top
  trendlineInteraction: "Breaking Up" | "Breaking Down" | "Retest Bullish" | "Retest Bearish" | "Flat";
} {
  if (history.length < 5) {
    return { isSetup: false, hhhlActive: false, llnlActive: false, structure: "Ranging", trendlineInteraction: "Flat" };
  }

  const recent = history.slice(-15);
  const current = recent[recent.length - 1];
  const prev = recent[recent.length - 2];
  
  // Detect HH/HL (bullish setup)
  let hhhlCount = 0;
  for (let i = 2; i < recent.length; i++) {
    if (recent[i] > recent[i-2] && recent[i-1] > recent[i-3]) hhhlCount++;
  }
  
  // Detect LH/LL (bearish setup)
  let llnlCount = 0;
  for (let i = 2; i < recent.length; i++) {
    if (recent[i] < recent[i-2] && recent[i-1] < recent[i-3]) llnlCount++;
  }

  const hhhlActive = hhhlCount >= 2;
  const llnlActive = llnlCount >= 2;

  // Find compression zone (narrow range = entry zone / yellow circle)
  const high = Math.max(...recent.slice(-5));
  const low = Math.min(...recent.slice(-5));
  const range = high - low;
  const avgPrice = (high + low) / 2;
  const isCompressing = range < avgPrice * 0.01; // < 1% compression zone

  // Compression top = high of compression zone (entry for bullish)
  // Compression bottom = low of compression zone (entry for bearish)
  const compressionTop = high;

  // Trendline interaction detection
  let trendlineInteraction: "Breaking Up" | "Breaking Down" | "Retest Bullish" | "Retest Bearish" | "Flat" = "Flat";
  
  if (bias === "Bullish" && hhhlActive) {
    const support = Math.min(...recent.slice(-10));
    if (current > support * 1.002) {
      trendlineInteraction = current > prev ? "Breaking Up" : "Retest Bullish";
    }
  } else if (bias === "Bearish" && llnlActive) {
    const resistance = Math.max(...recent.slice(-10));
    if (current < resistance * 0.998) {
      trendlineInteraction = current < prev ? "Breaking Down" : "Retest Bearish";
    }
  }

  // Setup is active when: structure + bias alignment + compression
  const isSetup = (
    (bias === "Bullish" && hhhlActive && isCompressing) ||
    (bias === "Bearish" && llnlActive && isCompressing) ||
    (bias !== "Neutral" && (hhhlActive || llnlActive))
  );

  // Determine structure
  let structure: "Breakout" | "Setup" | "Ranging" = "Ranging";
  if (hhhlActive || llnlActive) {
    structure = isCompressing ? "Setup" : "Breakout";
  }

  return {
    isSetup,
    hhhlActive,
    llnlActive,
    structure,
    compressionTop,
    trendlineInteraction,
  };
}

/**
 * TOP-DOWN DECISION ENGINE WITH ENTRY POINTS
 * Returns state based on structure analysis + calculates entry at compression tops
 */
function evaluateMarket(symbol: string, price: number): Signal {
  if (!price || price <= 0) {
    return {
      symbol,
      price,
      state: "DO_NOT_TRADE",
      bias_4h: "Neutral",
      structure_4h: "Unclear",
      structure_15m: "Ranging",
      hh_hl_active: false,
      lh_ll_active: false,
      trigger_5m: "Flat",
      confidence: 0,
      reason: "Invalid price data",
      updated_at: new Date().toISOString(),
    };
  }

  const history = priceHistory.get(symbol) || [];
  recordPrice(symbol, price);

  // STEP 1: Determine 4H bias
  const { bias: bias4h, structure: structure4h } = detect4HBias(history);
  console.log(`[4H BIAS] ${symbol}: bias=${bias4h}, structure=${structure4h}`);

  // STEP 2: Detect 15M setup + find compression top entry point
  const setup = detect15mSetup(history, bias4h);
  console.log(`[15M SETUP] ${symbol}: structure=${setup.structure}, trigger=${setup.trendlineInteraction}, compressionTop=${setup.compressionTop}`);

  let state: TradeState;
  let direction: "LONG" | "SHORT" | undefined;
  let reason: string;
  let confidence: number;
  let entry: number | undefined;
  let entryDescription: string | undefined;

  // STEP 3: Apply decision logic

  // DO_NOT_TRADE: No structure alignment
  if (bias4h === "Neutral" && !setup.isSetup) {
    state = "DO_NOT_TRADE";
    reason = "No structure, neutral bias";
    confidence = 0;
  }
  // BUILDING: Setup forming (compression zone with bias alignment)
  // This is where traders enter at yellow circle (compression top)
  else if (setup.isSetup && bias4h !== "Neutral") {
    state = "BUILDING";
    entry = setup.compressionTop; // Entry at compression top (yellow circle)
    entryDescription = "At compression top";
    
    if (bias4h === "Bullish") {
      reason = "Bullish setup forming (HH/HL pattern)";
      confidence = setup.hhhlActive ? 65 : 45;
      direction = "LONG";
    } else {
      reason = "Bearish setup forming (LH/LL pattern)";
      confidence = setup.llnlActive ? 65 : 45;
      direction = "SHORT";
    }
  }
  // SNIPER: Breakout/breakdown confirmed with trendline break
  else if (
    bias4h !== "Neutral" &&
    (setup.trendlineInteraction === "Breaking Up" || setup.trendlineInteraction === "Breaking Down")
  ) {
    state = "SNIPER";
    entry = price; // Entry at current breakout price
    entryDescription = "Breakout confirmed";
    
    if (bias4h === "Bullish" && setup.hhhlActive) {
      direction = "LONG";
      reason = "Bullish breakout: HH/HL confirmed + trendline break";
      confidence = 78;
    } else if (bias4h === "Bearish" && setup.llnlActive) {
      direction = "SHORT";
      reason = "Bearish breakdown: LH/LL confirmed + trendline break";
      confidence = 78;
    } else {
      state = "BUILDING";
      entry = setup.compressionTop;
      entryDescription = "At compression top";
      reason = "Structure alignment unclear";
      confidence = 50;
    }
  }
  // Default: BUILDING if bias exists but no clear break
  else if (bias4h !== "Neutral") {
    state = "BUILDING";
    entry = setup.compressionTop;
    entryDescription = "At compression top";
    reason = `Structure active, ${bias4h.toLowerCase()} bias`;
    confidence = 50;
  }
  // Absolute default
  else {
    state = "DO_NOT_TRADE";
    reason = "No actionable structure";
    confidence = 0;
  }

  // Calculate SL/TP for trade setups
  let stopLoss: number | undefined;
  let takeProfit: number | undefined;
  let riskReward: number | undefined;

  if (direction && entry) {
    const recent15 = history.slice(-15);
    const high = Math.max(...recent15);
    const low = Math.min(...recent15);
    const rangeSize = high - low;

    if (direction === "LONG") {
      stopLoss = Math.max(low, entry * 0.97);
      takeProfit = entry + (rangeSize * 1.5);
    } else {
      stopLoss = Math.min(high, entry * 1.03);
      takeProfit = entry - (rangeSize * 1.5);
    }

    riskReward = Math.abs((takeProfit - entry) / (entry - stopLoss));
    if (!isFinite(riskReward)) riskReward = 0;
  }

  const signal: Signal = {
    symbol,
    price,
    state,
    bias_4h: bias4h,
    structure_4h: structure4h,
    structure_15m: setup.structure,
    hh_hl_active: setup.hhhlActive,
    lh_ll_active: setup.llnlActive,
    trigger_5m: setup.trendlineInteraction,
    ...(entry !== undefined ? { entry, entry_description: entryDescription } : {}),
    ...(direction ? { direction, stopLoss, takeProfit, riskReward } : {}),
    confidence,
    reason,
    updated_at: new Date().toISOString(),
  };

  return signal;
}

/**
 * Create a complete signal with Kraken prices and structure-based evaluation
 * Applies hold rules for state inertia
 */
export async function createSignal(symbol: string): Promise<Signal> {
  const { applyHoldRules } = await import("./persistent-store");
  
  const price = await getKrakenTicker(symbol);
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
    updated_at: new Date().toISOString(),
  };

  return signal;
}
