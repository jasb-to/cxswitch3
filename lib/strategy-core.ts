/**
 * TRADING STRATEGY ENGINE - TOP-DOWN MULTI-TIMEFRAME STRUCTURE MODEL
 * 
 * Architecture:
 * 4H Layer → Determines directional bias (Bullish/Bearish/Neutral)
 * 15M/5M Layer → Detects setup formation and breakout triggers
 * 
 * This is a STRUCTURE-BASED system, not a scoring system.
 * Decision logic: HH/HL/LH/LL sequencing, trendlines, retests
 */

export type TradeState = "SNIPER" | "BUILDING" | "DO_NOT_TRADE";

export const SYMBOLS = ["BTC", "ETH", "SOL"] as const;
export type Symbol = typeof SYMBOLS[number];

export interface Signal {
  symbol: string;
  price: number;
  state: TradeState;
  
  // 4H Market Context (bias layer)
  bias_4h: "Bullish" | "Bearish" | "Neutral";
  structure_4h: "HH/HL" | "LH/LL" | "Ranging" | "Unclear";
  
  // 15M/5M Execution Context (trigger layer)
  structure_15m: "Breakout" | "Setup" | "Ranging";
  hh_hl_active: boolean;
  lh_ll_active: boolean;
  trendline_interaction: "Break" | "Retest" | "None";
  
  // Trade details (only for SNIPER)
  direction?: "LONG" | "SHORT";
  entry?: number;
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
 * LAYER 1: 4H BIAS DETECTION (Not a gate, just context)
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
 * LAYER 2: 15M/5M SETUP DETECTION
 */
function detect15mSetup(history: number[], bias: "Bullish" | "Bearish" | "Neutral"): { 
  isSetup: boolean; 
  hhhlActive: boolean; 
  llnlActive: boolean; 
  structure: "Breakout" | "Setup" | "Ranging";
  trendlineInteraction: "Break" | "Retest" | "None";
} {
  if (history.length < 5) {
    return { isSetup: false, hhhlActive: false, llnlActive: false, structure: "Ranging", trendlineInteraction: "None" };
  }

  const recent = history.slice(-15);
  const current = recent[recent.length - 1];
  const prev = recent[recent.length - 2];
  
  let hhhlCount = 0;
  for (let i = 2; i < recent.length; i++) {
    if (recent[i] > recent[i-2] && recent[i-1] > recent[i-3]) hhhlCount++;
  }
  
  let llnlCount = 0;
  for (let i = 2; i < recent.length; i++) {
    if (recent[i] < recent[i-2] && recent[i-1] < recent[i-3]) llnlCount++;
  }

  const hhhlActive = hhhlCount >= 2;
  const llnlActive = llnlCount >= 2;

  const high = Math.max(...recent.slice(-5));
  const low = Math.min(...recent.slice(-5));
  const range = high - low;
  const isCompressing = range < (high + low) / 2 * 0.01;

  let trendlineInteraction: "Break" | "Retest" | "None" = "None";
  
  if (bias === "Bullish" && hhhlActive) {
    const support = Math.min(...recent.slice(-10));
    if (current > support * 1.002) {
      trendlineInteraction = current > prev ? "Break" : "Retest";
    }
  } else if (bias === "Bearish" && llnlActive) {
    const resistance = Math.max(...recent.slice(-10));
    if (current < resistance * 0.998) {
      trendlineInteraction = current < prev ? "Break" : "Retest";
    }
  }

  const isSetup = (
    (bias === "Bullish" && hhhlActive && isCompressing) ||
    (bias === "Bearish" && llnlActive && isCompressing) ||
    (bias !== "Neutral" && (hhhlActive || llnlActive))
  );

  let structure: "Breakout" | "Setup" | "Ranging" = "Ranging";
  if (hhhlActive || llnlActive) {
    structure = isCompressing ? "Setup" : "Breakout";
  }

  return {
    isSetup,
    hhhlActive,
    llnlActive,
    structure,
    trendlineInteraction,
  };
}

/**
 * TOP-DOWN DECISION ENGINE
 */
function evaluateMarket(symbol: string, price: number): { state: TradeState; bias_4h: "Bullish" | "Bearish" | "Neutral"; structure_4h: "HH/HL" | "LH/LL" | "Ranging" | "Unclear"; structure_15m: "Breakout" | "Setup" | "Ranging"; hh_hl_active: boolean; lh_ll_active: boolean; trendline_interaction: "Break" | "Retest" | "None"; direction?: "LONG" | "SHORT"; entry?: number; stopLoss?: number; takeProfit?: number; riskReward?: number; confidence?: number; reason?: string } {
  if (!price || price <= 0) {
    return {
      state: "DO_NOT_TRADE",
      bias_4h: "Neutral",
      structure_4h: "Unclear",
      structure_15m: "Ranging",
      hh_hl_active: false,
      lh_ll_active: false,
      trendline_interaction: "None",
      confidence: 0,
      reason: "Invalid price data",
    };
  }

  const history = priceHistory.get(symbol) || [];
  recordPrice(symbol, price);

  const { bias: bias4h, structure: structure4h } = detect4HBias(history);
  console.log(`[4H BIAS] ${symbol}: bias=${bias4h}, structure=${structure4h}`);

  const setup = detect15mSetup(history, bias4h);
  console.log(`[15M SETUP] ${symbol}: isSetup=${setup.isSetup}, structure=${setup.structure}, trendline=${setup.trendlineInteraction}`);

  let state: TradeState;
  let direction: "LONG" | "SHORT" | undefined;
  let reason: string;
  let confidence: number;

  if (bias4h === "Neutral" && !setup.isSetup) {
    state = "DO_NOT_TRADE";
    reason = "No structure, neutral bias";
    confidence = 0;
  }
  else if (setup.isSetup && bias4h !== "Neutral") {
    state = "BUILDING";
    if (bias4h === "Bullish") {
      reason = "Bullish setup forming (HH/HL pattern)";
      confidence = setup.hhhlActive ? 60 : 40;
    } else {
      reason = "Bearish setup forming (LH/LL pattern)";
      confidence = setup.llnlActive ? 60 : 40;
    }
  }
  else if (
    bias4h !== "Neutral" &&
    (setup.trendlineInteraction === "Break" || setup.structure === "Breakout")
  ) {
    state = "SNIPER";
    if (bias4h === "Bullish" && setup.hhhlActive) {
      direction = "LONG";
      reason = "Bullish breakout: HH/HL confirmed + trendline break";
      confidence = 75;
    } else if (bias4h === "Bearish" && setup.llnlActive) {
      direction = "SHORT";
      reason = "Bearish breakdown: LH/LL confirmed + trendline break";
      confidence = 75;
    } else {
      state = "BUILDING";
      reason = "Structure alignment unclear";
      confidence = 40;
    }
  }
  else if (bias4h !== "Neutral") {
    state = "BUILDING";
    reason = `Structure active, ${bias4h.toLowerCase()} bias`;
    confidence = 50;
  }
  else {
    state = "DO_NOT_TRADE";
    reason = "No actionable structure";
    confidence = 0;
  }

  let entry, stopLoss, takeProfit, riskReward;
  if (state === "SNIPER" && direction) {
    entry = price;
    
    const recent15 = history.slice(-15);
    const high = Math.max(...recent15);
    const low = Math.min(...recent15);
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
    structure_15m: setup.structure,
    hh_hl_active: setup.hhhlActive,
    lh_ll_active: setup.llnlActive,
    trendline_interaction: setup.trendlineInteraction,
    ...(direction ? { direction, entry, stopLoss, takeProfit, riskReward, confidence, reason } : { confidence, reason }),
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
 * Create a complete signal with live structure-based evaluation
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
