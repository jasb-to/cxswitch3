/**
 * TRADING STRATEGY ENGINE
 * Kraken prices → state generation → SNIPER details
 */

export type TradeState = "SNIPER" | "BUILDING" | "DO_NOT_TRADE";

export const SYMBOLS = ["BTC", "ETH", "SOL"] as const;
export type Symbol = typeof SYMBOLS[number];

export interface Signal {
  symbol: string;
  price: number;
  state: TradeState;
  
  // Market context (always present - used to render even DO_NOT_TRADE states)
  trend_4h: "Bullish" | "Bearish" | "Neutral";
  structure_15m: "Breakout" | "Compression" | "Expansion" | "Reversal" | "Range";
  macro_bias: "Bullish" | "Bearish" | "Neutral";
  momentum_percent: number; // Current momentum as percentage
  volatility_percent: number; // Current volatility as percentage
  readiness_score: number; // 0-100 readiness percentage
  
  // Trade details (optional, only for SNIPER)
  direction?: "LONG" | "SHORT";
  entry?: number;
  stopLoss?: number;
  takeProfit?: number;
  riskReward?: number;
  confidence?: number;
  reason?: string;
  
  // Internal: SNIPER confirmation state
  sniper_confirmation_count?: number;
  
  updated_at: string;
}

// Track SNIPER confirmation cycles per symbol
const sniperConfirmationTracker = new Map<string, { count: number; confluenceScore: number; structure: string }>();


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
 * REAL MARKET-REACTIVE STRATEGY ENGINE
 * Uses live Kraken price data, volatility, structure, and momentum
 * to dynamically transition between DO_NOT_TRADE → BUILDING → SNIPER
 */

// In-memory price history for structure detection (last 50 prices per symbol)
const priceHistory = new Map<string, number[]>();
const MAX_HISTORY = 50;

/**
 * Store price in history for structure detection
 */
function recordPrice(symbol: string, price: number): void {
  if (!priceHistory.has(symbol)) {
    priceHistory.set(symbol, []);
  }
  const history = priceHistory.get(symbol)!;
  history.push(price);
  if (history.length > MAX_HISTORY) {
    history.shift(); // Keep only last 50
  }
}

/**
 * Detect market structure from price history
 * breakout | compression | expansion | reversal | range
 */
function detectStructure(history: number[]): "Breakout" | "Compression" | "Expansion" | "Reversal" | "Range" {
  if (history.length < 3) return "Range";

  const current = history[history.length - 1];
  const prev = history[history.length - 2];
  const prev2 = history[history.length - 3];
  
  const changePercent = ((current - prev) / prev) * 100;
  const absChange = Math.abs(changePercent);
  
  // Calculate recent volatility (std dev of last 5 changes)
  const recentVolatility = Math.max(...history.slice(-5).map((p, i, arr) => 
    i > 0 ? Math.abs((p - arr[i-1]) / arr[i-1] * 100) : 0
  ));
  
  // Calculate baseline volatility (std dev of all history)
  const baselineVolatility = history.length > 10 
    ? Math.max(...history.slice(-10).map((p, i, arr) => 
        i > 0 ? Math.abs((p - arr[i-1]) / arr[i-1] * 100) : 0
      ))
    : recentVolatility;

  // Direction: higher high / lower low
  const isHigherHigh = current > prev && prev > prev2;
  const isLowerLow = current < prev && prev < prev2;
  
  // Volatility expansion / compression
  const volExpanding = recentVolatility > baselineVolatility * 1.2;
  const volCompressing = recentVolatility < baselineVolatility * 0.8;

  if (isHigherHigh && volExpanding) return "Breakout";
  if (isLowerLow && volExpanding) return "Breakout";
  if (volCompressing) return "Compression";
  if (volExpanding) return "Expansion";
  if (isHigherHigh || isLowerLow) return "Reversal";
  return "Range";
}

/**
 * Determine trend from price history
 * bullish | bearish | neutral
 */
function determineTrend(history: number[]): "Bullish" | "Bearish" | "Neutral" {
  if (history.length < 5) return "Neutral";

  // Simple MA comparison (last 5 vs last 10-20)
  const recent = history.slice(-5).reduce((a, b) => a + b, 0) / 5;
  const older = history.length >= 10 
    ? history.slice(-10, -5).reduce((a, b) => a + b, 0) / 5 
    : recent;

  const trendStrength = Math.abs((recent - older) / older) * 100;

  // Higher highs = bullish, lower lows = bearish
  const closes = history.slice(-10);
  let higherHighs = 0, lowerLows = 0;
  for (let i = 1; i < closes.length; i++) {
    if (closes[i] > closes[i - 1]) higherHighs++;
    else if (closes[i] < closes[i - 1]) lowerLows++;
  }

  if (higherHighs > lowerLows && trendStrength > 0.1) return "Bullish";
  if (lowerLows > higherHighs && trendStrength > 0.1) return "Bearish";
  return "Neutral";
}

/**
 * Calculate momentum (rate of change)
 * Returns -100 to +100 (percentage change)
 */
function calculateMomentum(history: number[]): number {
  if (history.length < 2) return 0;
  const current = history[history.length - 1];
  const prev = history[history.length - 2];
  return ((current - prev) / prev) * 100;
}

/**
 * Calculate volatility as percentage of average price
 */
function calculateVolatility(history: number[]): number {
  if (history.length < 2) return 0;
  const avg = history.reduce((a, b) => a + b) / history.length;
  const variance = history.reduce((sum, p) => sum + Math.pow(p - avg, 2), 0) / history.length;
  return Math.sqrt(variance) / avg * 100;
}

/**
 * REAL MARKET-REACTIVE EVALUATION - REBALANCED THRESHOLDS
 * Returns dynamic state based on actual market conditions
 * 
 * State Distribution Goal:
 * - DO_NOT_TRADE: 60-70% (background noise only)
 * - BUILDING: 20-35% (active monitoring zone)
 * - SNIPER: 2-8% (rare, high-quality alerts)
 */
function evaluateMarket(symbol: string, price: number): { state: TradeState; details?: any } {
  // Guard: price must be positive
  if (!price || price <= 0) {
    return { 
      state: "DO_NOT_TRADE",
      trend_4h: "Neutral",
      structure_15m: "Range",
      macro_bias: "Neutral",
      momentum_percent: 0,
      volatility_percent: 0,
      readiness_score: 0,
      reason: "Invalid price data",
    };
  }

  // Record price in history
  const history = priceHistory.get(symbol) || [];
  recordPrice(symbol, price);

  // Market analysis
  const structure = detectStructure(history);
  const trend = determineTrend(history);
  const momentum = calculateMomentum(history);
  const volatility = calculateVolatility(history);

  // Derive macro bias (opposite of current trend for confirmation)
  const macro_bias: "Bullish" | "Bearish" | "Neutral" = 
    trend === "Bullish" ? "Bearish" : 
    trend === "Bearish" ? "Bullish" : 
    "Neutral";

  console.log(`[STRATEGY] ${symbol}: trend=${trend}, struct=${structure}, vol=${volatility.toFixed(2)}%, momentum=${momentum.toFixed(2)}%`);

  // Confluence scoring (0-100) - REBALANCED
  let confluenceScore = 0;
  let reasons: string[] = [];

  // Structure alignment (max +40) - INCREASED IMPORTANCE
  if (structure === "Breakout") confluenceScore += 40, reasons.push("Breakout structure");
  else if (structure === "Expansion") confluenceScore += 25, reasons.push("Volatility expansion");
  else if (structure === "Reversal") confluenceScore += 20, reasons.push("Reversal structure");
  else if (structure === "Compression") confluenceScore += 10, reasons.push("Setup compression");

  // Trend alignment (max +30)
  if (trend === "Bullish") confluenceScore += 15, reasons.push("Bullish trend");
  else if (trend === "Bearish") confluenceScore += 15, reasons.push("Bearish trend");

  // Momentum (max +20) - REBALANCED THRESHOLDS
  const absMomentum = Math.abs(momentum);
  if (absMomentum >= 0.50) confluenceScore += 10, reasons.push("Significant momentum");
  if (absMomentum >= 1.0) confluenceScore += 10, reasons.push("Strong momentum");

  // Volatility (max +20) - REBALANCED THRESHOLDS
  if (volatility >= 0.10 && volatility < 0.50) confluenceScore += 10, reasons.push("Healthy volatility");
  if (volatility >= 0.50 && volatility < 2.0) confluenceScore += 15, reasons.push("Elevated volatility");
  if (volatility >= 2.0) confluenceScore += 5, reasons.push("Extreme volatility");

  let state: TradeState;
  let readiness_score = 0; // 0-100
  let sniper_confirmation_count = 0;

  // ===== REBALANCED STATE LOGIC =====

  // 🟩 SNIPER DETECTION (confluence ≥ 65, must confirm for 2 cycles)
  if (
    confluenceScore >= 65 &&
    structure === "Breakout" &&
    trend !== "Neutral" &&
    absMomentum >= 0.20 &&
    volatility >= 0.15
  ) {
    // Check SNIPER confirmation tracker
    const confirmationState = sniperConfirmationTracker.get(symbol);
    
    if (
      confirmationState &&
      confirmationState.count >= 1 &&
      confirmationState.confluenceScore >= 65 &&
      confirmationState.structure === "Breakout"
    ) {
      // CONFIRMED SNIPER (2nd cycle)
      state = "SNIPER";
      sniper_confirmation_count = confirmationState.count + 1;
      readiness_score = Math.min(100, confluenceScore + (absMomentum * 5));
      console.log(`[STRATEGY] ${symbol} → SNIPER CONFIRMED (cycles=${sniper_confirmation_count}, confluence=${confluenceScore})`);
      
      // Reset tracker after confirmation
      sniperConfirmationTracker.delete(symbol);
    } else {
      // First cycle of potential SNIPER (PRE-SNIPER)
      state = "BUILDING";
      sniper_confirmation_count = 1;
      readiness_score = Math.min(100, confluenceScore + (absMomentum * 3));
      
      // Store confirmation state
      sniperConfirmationTracker.set(symbol, {
        count: 1,
        confluenceScore,
        structure,
      });
      
      console.log(`[STRATEGY] ${symbol} → BUILDING (PRE-SNIPER, cycle 1/2, confluence=${confluenceScore})`);
    }
  }
  // 🟧 BUILDING (confluence ≥ 35 OR structure != RANGE with momentum/volatility, must appear frequently)
  else if (
    (confluenceScore >= 35 && (structure !== "Range" || absMomentum >= 0.05 || volatility >= 0.10)) ||
    (structure !== "Range" && trend !== "Neutral" && (absMomentum >= 0.05 || volatility >= 0.10))
  ) {
    state = "BUILDING";
    readiness_score = Math.min(100, Math.max(25, confluenceScore + (absMomentum * 3)));
    console.log(`[STRATEGY] ${symbol} → BUILDING (confluence=${confluenceScore}, structure=${structure})`);
    
    // Reset SNIPER confirmation if structure reverted
    if (structure !== "Breakout") {
      sniperConfirmationTracker.delete(symbol);
    }
  }
  // 🟥 DO_NOT_TRADE (strict baseline - only true consolidation)
  else if (
    structure === "Range" &&
    absMomentum < 0.05 &&
    volatility < 0.10 &&
    trend === "Neutral"
  ) {
    state = "DO_NOT_TRADE";
    readiness_score = Math.max(0, confluenceScore / 3);
    console.log(`[STRATEGY] ${symbol} → DO_NOT_TRADE (strict consolidation, confluence=${confluenceScore})`);
    sniperConfirmationTracker.delete(symbol);
  }
  // Default to BUILDING for any other condition (not strict enough for DO_NOT_TRADE)
  else {
    state = "BUILDING";
    readiness_score = Math.min(100, Math.max(20, confluenceScore + (absMomentum * 2)));
    console.log(`[STRATEGY] ${symbol} → BUILDING (default fall-through, confluence=${confluenceScore})`);
    
    // Reset SNIPER confirmation if not breakout
    if (structure !== "Breakout") {
      sniperConfirmationTracker.delete(symbol);
    }
  }

  // Generate SNIPER details only when triggered
  if (state === "SNIPER" && trend !== "Neutral") {
    // Determine direction from trend and momentum
    const direction = (trend === "Bullish" && momentum > 0) || (trend === "Bearish" && momentum < 0) 
      ? (trend === "Bullish" ? "LONG" : "SHORT")
      : (momentum > 0.5 ? "LONG" : "SHORT");

    const entry = price;
    
    // Dynamic SL/TP based on volatility and structure
    const slPercent = 0.8 + (volatility / 10); // 0.8% - 1.2% depending on vol
    const tpPercent = 2.0 + (volatility / 5);  // 2% - 4% depending on vol
    
    const sl = direction === "LONG" 
      ? price * (1 - slPercent / 100)
      : price * (1 + slPercent / 100);
    
    const tp = direction === "LONG"
      ? price * (1 + tpPercent / 100)
      : price * (1 - tpPercent / 100);
    
    const risk = Math.abs(entry - sl);
    const reward = Math.abs(tp - entry);
    let rr = reward / risk;
    
    if (!isFinite(rr)) rr = 0;

    const confidence = Math.min(100, Math.floor(confluenceScore + (absMomentum * 5)));
    const reason = reasons[0] || "Market confluence trigger";

    return {
      state,
      sniper_confirmation_count,
      trend_4h: trend,
      structure_15m: structure,
      macro_bias,
      momentum_percent: momentum,
      volatility_percent: volatility,
      readiness_score,
      direction,
      entry,
      stopLoss: parseFloat(sl.toFixed(2)),
      takeProfit: parseFloat(tp.toFixed(2)),
      riskReward: parseFloat(rr.toFixed(2)),
      confidence,
      reason,
    };
  }

  return { 
    state,
    sniper_confirmation_count,
    trend_4h: trend,
    structure_15m: structure,
    macro_bias,
    momentum_percent: momentum,
    volatility_percent: volatility,
    readiness_score,
    reason: reasons[0] || "Market context",
  };
}

/**
 * Create a complete signal with Kraken prices and market context
 * Single source of truth - no simulation, no view-model transform
 */
export async function createSignal(symbol: string): Promise<Signal> {
  const price = await getKrakenTicker(symbol);
  const marketContext = evaluateMarket(symbol, price);

  const signal: Signal = {
    symbol,
    price,
    ...marketContext,
    updated_at: new Date().toISOString(),
  };

  return signal;
}


