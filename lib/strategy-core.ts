/**
 * PRICE ACTION EVENT TRACKER
 * Real-time swing structure detection and event-driven signal generation
 * 
 * 4H = directional context (never gates trades)
 * 15M = structure formation (HH, HL, LH, LL, compression, squeeze)
 * 5M = trigger execution (break candle, retest rejection, sweep reversal)
 * 
 * Only BUILDING and SNIPER states. Markets always active.
 */

import type { Signal } from "./signal-store";

export const SYMBOLS = ["BTC", "ETH", "SOL"] as const;
export type Symbol = typeof SYMBOLS[number];

// In-memory price history (OHLC data simulation - using closes for simplicity)
const priceHistory = new Map<string, number[]>();
const MAX_HISTORY = 200;

interface SwingStructure {
  highLow: "HH" | "HL" | "LH" | "LL" | "compression" | "squeeze" | "breakout";
  description: string;
  swingHigh?: number;
  swingLow?: number;
}

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
 * Detect raw swing structure: HH, HL, LH, LL
 */
function detectSwingStructure(history: number[]): SwingStructure | null {
  if (history.length < 20) return null;

  // Find local swing highs and lows (using simple peak/valley detection)
  const swings: Array<{ type: "high" | "low"; price: number; index: number }> = [];
  
  for (let i = 5; i < history.length - 5; i++) {
    const price = history[i];
    const isHigh = price > history[i - 1] && price > history[i + 1] && 
                   price > history[i - 2] && price > history[i + 2];
    const isLow = price < history[i - 1] && price < history[i + 1] && 
                  price < history[i - 2] && price < history[i + 2];
    
    if (isHigh) swings.push({ type: "high", price, index: i });
    if (isLow) swings.push({ type: "low", price, index: i });
  }

  if (swings.length < 4) return null;

  // Get last 4 swings for structure
  const lastSwings = swings.slice(-4);
  const [s1, s2, s3, s4] = lastSwings;

  // Current price context
  const currentPrice = history[history.length - 1];
  const recent20 = history.slice(-20);
  const recentHigh = Math.max(...recent20);
  const recentLow = Math.min(...recent20);

  // Determine structure
  if (s3.type === "high" && s4.type === "high") {
    if (s4.price > s3.price) {
      return {
        highLow: "HH",
        description: `Higher High forming - ${s4.price.toFixed(2)} > ${s3.price.toFixed(2)}`,
        swingHigh: s4.price,
      };
    } else {
      return {
        highLow: "HL",
        description: `Lower High forming - ${s4.price.toFixed(2)} < ${s3.price.toFixed(2)}`,
        swingHigh: s4.price,
      };
    }
  }

  if (s3.type === "low" && s4.type === "low") {
    if (s4.price < s3.price) {
      return {
        highLow: "LL",
        description: `Lower Low forming - ${s4.price.toFixed(2)} < ${s3.price.toFixed(2)}`,
        swingLow: s4.price,
      };
    } else {
      return {
        highLow: "LH",
        description: `Higher Low forming - ${s4.price.toFixed(2)} > ${s3.price.toFixed(2)}`,
        swingLow: s4.price,
      };
    }
  }

  // Compression detection
  const rangeSize = recentHigh - recentLow;
  const avgPrice = recent20.reduce((a, b) => a + b) / recent20.length;
  const volatilityPercent = (rangeSize / avgPrice) * 100;

  if (volatilityPercent < 0.3) {
    return {
      highLow: "compression",
      description: `Compression tightening - ${volatilityPercent.toFixed(2)}% range`,
      swingHigh: recentHigh,
      swingLow: recentLow,
    };
  }

  // Squeeze detection (contracting range)
  if (recent20.length >= 2) {
    const oldRange = Math.max(...recent20.slice(0, 10)) - Math.min(...recent20.slice(0, 10));
    const newRange = Math.max(...recent20.slice(-10)) - Math.min(...recent20.slice(-10));
    if (newRange < oldRange * 0.6) {
      return {
        highLow: "squeeze",
        description: `Trendline squeeze forming`,
        swingHigh: recentHigh,
        swingLow: recentLow,
      };
    }
  }

  return null;
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
 * DETECT LIVE PRICE ACTION EVENTS
 * Returns BUILDING or SNIPER based on structure and momentum
 */
function evaluateMarket(symbol: string, price: number, history: number[], previousSignal: Signal | null): Omit<Signal, "updated_at"> {
  const recent = history.slice(-50);
  if (recent.length < 5) {
    // Not enough data - default to BUILDING
    return {
      symbol,
      price,
      state: "BUILDING",
      direction: "LONG",
      event: "acceleration",
      entry_level: price,
      entry_description: "Accumulating price data",
      confidence: 30,
    };
  }

  const recentHigh = Math.max(...recent);
  const recentLow = Math.min(...recent);
  const rangeSize = recentHigh - recentLow;
  const current = recent[recent.length - 1];
  const prev = recent[recent.length - 2];
  const prev2 = recent.length > 2 ? recent[recent.length - 3] : prev;

  // Get swing structure context
  const structure = detectSwingStructure(history);
  
  // 4H context (directional bias, never gates)
  const is4hBullish = structure?.highLow === "HH" || structure?.highLow === "LH";
  const is4hBearish = structure?.highLow === "LL" || structure?.highLow === "HL";

  console.log(`[EVENT] ${symbol}: structure=${structure?.highLow}, 4h=${is4hBullish ? "bullish" : is4hBearish ? "bearish" : "neutral"}`);

  // DETECT 5M TRIGGER EVENTS

  // 1. BREAKOUT ATTEMPT: Price breaks recent high/low
  const breakoutUp = current > recentHigh && prev <= recentHigh;
  const breakoutDown = current < recentLow && prev >= recentLow;

  if (breakoutUp) {
    console.log(`[EVENT] ${symbol}: BREAKOUT UP attempt at ${current}`);
    return {
      symbol,
      price,
      state: "BUILDING",
      direction: "LONG",
      event: "breakout_attempt",
      entry_level: current,
      entry_description: `Breakout above ${recentHigh.toFixed(2)}`,
      confidence: is4hBullish ? 75 : 60,
    };
  }

  if (breakoutDown) {
    console.log(`[EVENT] ${symbol}: BREAKOUT DOWN attempt at ${current}`);
    return {
      symbol,
      price,
      state: "BUILDING",
      direction: "SHORT",
      event: "breakout_attempt",
      entry_level: current,
      entry_description: `Breakout below ${recentLow.toFixed(2)}`,
      confidence: is4hBearish ? 75 : 60,
    };
  }

  // 2. REJECTION: Failed breakout with wick reversal
  const rejectionUp = prev > recentHigh * 1.002 && current < prev * 0.998;
  const rejectionDown = prev < recentLow * 0.998 && current > prev * 1.002;

  if (rejectionUp) {
    console.log(`[EVENT] ${symbol}: REJECTION at resistance ${prev}`);
    return {
      symbol,
      price,
      state: "BUILDING",
      direction: "SHORT",
      event: "rejection",
      entry_level: prev,
      entry_description: `Rejection at resistance ${prev.toFixed(2)}`,
      confidence: is4hBearish ? 78 : 65,
    };
  }

  if (rejectionDown) {
    console.log(`[EVENT] ${symbol}: REJECTION at support ${prev}`);
    return {
      symbol,
      price,
      state: "BUILDING",
      direction: "LONG",
      event: "rejection",
      entry_level: prev,
      entry_description: `Rejection at support ${prev.toFixed(2)}`,
      confidence: is4hBullish ? 78 : 65,
    };
  }

  // 3. SWEEP: Liquidity grab beyond recent extreme
  const sweepHigh = current > recentHigh * 1.005;
  const sweepLow = current < recentLow * 0.995;

  if (sweepHigh) {
    console.log(`[EVENT] ${symbol}: SWEEP above ${recentHigh}`);
    return {
      symbol,
      price,
      state: "BUILDING",
      direction: "LONG",
      event: "sweep",
      entry_level: current,
      entry_description: `Liquidity grab above ${recentHigh.toFixed(2)}`,
      confidence: 72,
    };
  }

  if (sweepLow) {
    console.log(`[EVENT] ${symbol}: SWEEP below ${recentLow}`);
    return {
      symbol,
      price,
      state: "BUILDING",
      direction: "SHORT",
      event: "sweep",
      entry_level: current,
      entry_description: `Liquidity grab below ${recentLow.toFixed(2)}`,
      confidence: 72,
    };
  }

  // 4. RETEST: Return to recently tested level
  const onResistance = Math.abs(current - recentHigh) < rangeSize * 0.015;
  const onSupport = Math.abs(current - recentLow) < rangeSize * 0.015;

  if (onResistance && prev < current) {
    console.log(`[EVENT] ${symbol}: RETEST of resistance ${recentHigh}`);
    return {
      symbol,
      price,
      state: "BUILDING",
      direction: "LONG",
      event: "retest",
      entry_level: recentLow,
      entry_description: `Retest of ${recentHigh.toFixed(2)} - enter at support ${recentLow.toFixed(2)}`,
      confidence: 60,
    };
  }

  if (onSupport && prev > current) {
    console.log(`[EVENT] ${symbol}: RETEST of support ${recentLow}`);
    return {
      symbol,
      price,
      state: "BUILDING",
      direction: "SHORT",
      event: "retest",
      entry_level: recentHigh,
      entry_description: `Retest of ${recentLow.toFixed(2)} - enter at resistance ${recentHigh.toFixed(2)}`,
      confidence: 60,
    };
  }

  // 5. ACCELERATION: Strong impulse momentum
  const impulseSize = Math.abs(current - prev2);
  const avgRecentMove = (Math.abs(prev - prev2) + Math.abs(recent[recent.length - 4] - recent[recent.length - 3])) / 2;

  if (impulseSize > avgRecentMove * 2) {
    if (current > prev2) {
      console.log(`[EVENT] ${symbol}: ACCELERATION UP`);
      return {
        symbol,
        price,
        state: "BUILDING",
        direction: "LONG",
        event: "acceleration",
        entry_level: current,
        entry_description: `Strong upside acceleration`,
        confidence: 68,
      };
    } else {
      console.log(`[EVENT] ${symbol}: ACCELERATION DOWN`);
      return {
        symbol,
        price,
        state: "BUILDING",
        direction: "SHORT",
        event: "acceleration",
        entry_level: current,
        entry_description: `Strong downside acceleration`,
        confidence: 68,
      };
    }
  }

  // 6. EXHAUSTION: Loss of momentum after move
  if (impulseSize < avgRecentMove * 0.5 && avgRecentMove > rangeSize * 0.1) {
    if (current > prev2) {
      console.log(`[EVENT] ${symbol}: EXHAUSTION after up move`);
      return {
        symbol,
        price,
        state: "BUILDING",
        direction: "SHORT",
        event: "exhaustion",
        entry_level: current,
        entry_description: `Momentum loss after up move`,
        confidence: 55,
      };
    } else {
      console.log(`[EVENT] ${symbol}: EXHAUSTION after down move`);
      return {
        symbol,
        price,
        state: "BUILDING",
        direction: "LONG",
        event: "exhaustion",
        entry_level: current,
        entry_description: `Momentum loss after down move`,
        confidence: 55,
      };
    }
  }

  // 7. SNIPER CONFIRMATION: Previous BUILDING event continues with momentum
  if (previousSignal && previousSignal.state === "BUILDING") {
    const isConfirming = 
      (previousSignal.direction === "LONG" && current > prev && prev > prev2) ||
      (previousSignal.direction === "SHORT" && current < prev && prev < prev2);

    if (isConfirming) {
      console.log(`[EVENT] ${symbol}: SNIPER TRIGGERED - momentum confirmed`);
      
      const entryLevel = previousSignal.entry_level;
      const stopLoss = previousSignal.direction === "LONG" 
        ? entryLevel * 0.975
        : entryLevel * 1.025;
      const takeProfit = previousSignal.direction === "LONG"
        ? entryLevel + rangeSize * 1.5
        : entryLevel - rangeSize * 1.5;

      const riskReward = Math.abs((takeProfit - entryLevel) / (entryLevel - stopLoss));

      return {
        symbol,
        price,
        state: "SNIPER",
        direction: previousSignal.direction,
        event: previousSignal.event,
        entry_level: entryLevel,
        entry_description: previousSignal.entry_description,
        stopLoss: parseFloat(stopLoss.toFixed(2)),
        takeProfit: parseFloat(takeProfit.toFixed(2)),
        riskReward: parseFloat(riskReward.toFixed(2)),
        confidence: Math.min(100, previousSignal.confidence + 20),
      };
    }

    // Maintain BUILDING state
    return previousSignal;
  }

  // DEFAULT: Continue previous signal or default to BUILDING with directional bias
  if (previousSignal) {
    return previousSignal;
  }

  // Fallback: Markets always active
  const direction = current > prev ? "LONG" : "SHORT";
  return {
    symbol,
    price,
    state: "BUILDING",
    direction,
    event: "acceleration",
    entry_level: current,
    entry_description: `Market active: ${direction} bias`,
    confidence: 45,
  };
}

/**
 * Create complete signal with Kraken prices and price action analysis
 */
export async function createSignal(symbol: string): Promise<Signal> {
  const { getSignal } = await import("./signal-store");

  const price = await getKrakenTicker(symbol);

  if (!price || price <= 0) {
    return {
      symbol,
      price: 0,
      state: "BUILDING",
      direction: "LONG",
      event: "acceleration",
      entry_level: 0,
      entry_description: "Awaiting price data",
      confidence: 0,
      updated_at: new Date().toISOString(),
    };
  }

  const history = priceHistory.get(symbol) || [];
  recordPrice(symbol, price);

  const previousSignal = getSignal(symbol);
  const evaluated = evaluateMarket(symbol, price, history, previousSignal || null);

  const signal: Signal = {
    ...evaluated,
    updated_at: new Date().toISOString(),
  };

  return signal;
}

