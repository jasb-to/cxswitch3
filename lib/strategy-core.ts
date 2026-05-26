/**
 * EVENT-DRIVEN TRADING STRATEGY ENGINE
 * Detects real-time price action events and transitions between BUILDING → SNIPER
 * Every candle produces a directional read. Markets are always active.
 */

import type { Signal } from "./signal-store";

export const SYMBOLS = ["BTC", "ETH", "SOL"] as const;
export type Symbol = typeof SYMBOLS[number];

// In-memory price history for event detection
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
 * REAL-TIME EVENT DETECTION
 * Detects: breakout_attempt, rejection, retest, sweep, acceleration, exhaustion
 */
interface EventDetection {
  event: "breakout_attempt" | "rejection" | "retest" | "sweep" | "acceleration" | "exhaustion";
  direction: "LONG" | "SHORT";
  entryLevel: number;
  description: string;
  confidence: number; // 0-100
}

function detectEvent(symbol: string, history: number[]): EventDetection | null {
  if (history.length < 5) return null;

  const current = history[history.length - 1];
  const prev = history[history.length - 2];
  const prev2 = history[history.length - 3];
  const prev3 = history[history.length - 4];
  const prev4 = history[history.length - 5];

  // Get recent extremes
  const last10 = history.slice(-10);
  const recentHigh = Math.max(...last10);
  const recentLow = Math.min(...last10);
  const rangeSize = recentHigh - recentLow;

  // BREAKOUT ATTEMPT: Price pushes beyond recent high/low
  const breakoutUpAttempt = current > recentHigh && prev <= recentHigh;
  const breakoutDownAttempt = current < recentLow && prev >= recentLow;

  if (breakoutUpAttempt) {
    console.log(`[EVENT] ${symbol}: Breakout attempt UP at ${current}`);
    return {
      event: "breakout_attempt",
      direction: "LONG",
      entryLevel: current,
      description: `Breakout above ${recentHigh.toFixed(2)}`,
      confidence: 65,
    };
  }

  if (breakoutDownAttempt) {
    console.log(`[EVENT] ${symbol}: Breakout attempt DOWN at ${current}`);
    return {
      event: "breakout_attempt",
      direction: "SHORT",
      entryLevel: current,
      description: `Breakout below ${recentLow.toFixed(2)}`,
      confidence: 65,
    };
  }

  // REJECTION: Failed breakout with strong reversal wick
  const rejectionUp = prev > recentHigh && current < prev * 0.998; // Wick up, closed lower
  const rejectionDown = prev < recentLow && current > prev * 1.002; // Wick down, closed higher

  if (rejectionUp) {
    console.log(`[EVENT] ${symbol}: Rejection at resistance ${prev}`);
    return {
      event: "rejection",
      direction: "SHORT",
      entryLevel: prev, // Entry at rejection wick high
      description: `Rejection at resistance ${prev.toFixed(2)}`,
      confidence: 70,
    };
  }

  if (rejectionDown) {
    console.log(`[EVENT] ${symbol}: Rejection at support ${prev}`);
    return {
      event: "rejection",
      direction: "LONG",
      entryLevel: prev, // Entry at rejection wick low
      description: `Rejection at support ${prev.toFixed(2)}`,
      confidence: 70,
    };
  }

  // SWEEP: Liquidity grab above/below recent extreme
  const sweepHigh = current > recentHigh * 1.003; // 0.3% above recent high
  const sweepLow = current < recentLow * 0.997; // 0.3% below recent low

  if (sweepHigh) {
    console.log(`[EVENT] ${symbol}: Sweep HIGH at ${current}`);
    return {
      event: "sweep",
      direction: "LONG",
      entryLevel: current,
      description: `Liquidity grab above ${recentHigh.toFixed(2)}`,
      confidence: 72,
    };
  }

  if (sweepLow) {
    console.log(`[EVENT] ${symbol}: Sweep LOW at ${current}`);
    return {
      event: "sweep",
      direction: "SHORT",
      entryLevel: current,
      description: `Liquidity grab below ${recentLow.toFixed(2)}`,
      confidence: 72,
    };
  }

  // RETEST: Return to recently tested level
  const retestingHigh = Math.abs(current - recentHigh) < rangeSize * 0.02 && current > recentLow;
  const retestingLow = Math.abs(current - recentLow) < rangeSize * 0.02 && current < recentHigh;

  if (retestingHigh && (prev > current || prev2 > current)) {
    console.log(`[EVENT] ${symbol}: Retest of high at ${current}`);
    return {
      event: "retest",
      direction: "LONG",
      entryLevel: recentLow, // Entry at recent low (structure edge)
      description: `Retest of ${recentHigh.toFixed(2)} - entry at support ${recentLow.toFixed(2)}`,
      confidence: 60,
    };
  }

  if (retestingLow && (prev < current || prev2 < current)) {
    console.log(`[EVENT] ${symbol}: Retest of low at ${current}`);
    return {
      event: "retest",
      direction: "SHORT",
      entryLevel: recentHigh, // Entry at recent high (structure edge)
      description: `Retest of ${recentLow.toFixed(2)} - entry at resistance ${recentHigh.toFixed(2)}`,
      confidence: 60,
    };
  }

  // ACCELERATION: Strong directional momentum expansion
  const volatility = Math.abs(current - prev) + Math.abs(prev - prev2);
  const prevVolatility = Math.abs(prev2 - prev3) + Math.abs(prev3 - prev4);
  const isAccelerating = volatility > prevVolatility * 1.4;

  if (isAccelerating) {
    if (current > prev && prev > prev2) {
      console.log(`[EVENT] ${symbol}: Acceleration UP at ${current}`);
      return {
        event: "acceleration",
        direction: "LONG",
        entryLevel: current,
        description: `Momentum acceleration - strong move up`,
        confidence: 68,
      };
    } else if (current < prev && prev < prev2) {
      console.log(`[EVENT] ${symbol}: Acceleration DOWN at ${current}`);
      return {
        event: "acceleration",
        direction: "SHORT",
        entryLevel: current,
        description: `Momentum acceleration - strong move down`,
        confidence: 68,
      };
    }
  }

  // EXHAUSTION: Loss of momentum after strong impulse
  const recentMovement = Math.abs(current - prev4);
  const currentDeceleration = Math.abs(current - prev) < Math.abs(prev - prev2) * 0.6;

  if (recentMovement > rangeSize * 0.8 && currentDeceleration) {
    if (current > prev4) {
      console.log(`[EVENT] ${symbol}: Exhaustion after UP move at ${current}`);
      return {
        event: "exhaustion",
        direction: "SHORT",
        entryLevel: current,
        description: `Exhaustion after strong up move - reversal forming`,
        confidence: 55,
      };
    } else if (current < prev4) {
      console.log(`[EVENT] ${symbol}: Exhaustion after DOWN move at ${current}`);
      return {
        event: "exhaustion",
        direction: "LONG",
        entryLevel: current,
        description: `Exhaustion after strong down move - reversal forming`,
        confidence: 55,
      };
    }
  }

  return null;
}

/**
 * Check if SNIPER condition is met (momentum confirmation after BUILDING event)
 */
function isSniperConfirmed(history: number[], previousEvent: "breakout_attempt" | "rejection" | "retest" | "sweep" | "acceleration" | "exhaustion" | null, direction: "LONG" | "SHORT"): boolean {
  if (!previousEvent || history.length < 3) return false;

  const current = history[history.length - 1];
  const prev = history[history.length - 2];
  const prev2 = history[history.length - 3];

  // SNIPER triggered when price continues in the direction of the event
  // AND momentum is confirming over next 1-3 candles
  if (direction === "LONG") {
    // Price making higher high after breakout/retest/sweep
    return current > prev && prev > prev2;
  } else {
    // Price making lower low after breakout/retest/sweep
    return current < prev && prev < prev2;
  }
}

/**
 * EVENT-DRIVEN MARKET EVALUATION
 * Always produces BUILDING or SNIPER with a directional bias
 */
function evaluateMarket(symbol: string, price: number, previousSignal: Signal | null): Omit<Signal, "updated_at"> {
  const history = priceHistory.get(symbol) || [];
  recordPrice(symbol, price);

  // Detect current event
  const currentEvent = detectEvent(symbol, history);

  // If new event detected → BUILDING state
  if (currentEvent) {
    console.log(`[STRATEGY] ${symbol} → BUILDING (${currentEvent.event})`);
    return {
      symbol,
      price,
      state: "BUILDING",
      direction: currentEvent.direction,
      event: currentEvent.event,
      entry_level: currentEvent.entryLevel,
      entry_description: currentEvent.description,
      confidence: currentEvent.confidence,
    };
  }

  // If previous signal exists, check for SNIPER confirmation
  if (previousSignal && previousSignal.state === "BUILDING") {
    const isSniped = isSniperConfirmed(history, previousSignal.event, previousSignal.direction);

    if (isSniped) {
      console.log(`[STRATEGY] ${symbol} → SNIPER (momentum confirmed)`);
      
      // Calculate trade details
      const entryLevel = previousSignal.entry_level;
      const last10 = history.slice(-10);
      const high = Math.max(...last10);
      const low = Math.min(...last10);
      const rangeSize = high - low;

      let stopLoss: number;
      let takeProfit: number;

      if (previousSignal.direction === "LONG") {
        stopLoss = Math.max(low, entryLevel * 0.975); // 2.5% below entry
        takeProfit = entryLevel + rangeSize * 1.5;
      } else {
        stopLoss = Math.min(high, entryLevel * 1.025); // 2.5% above entry
        takeProfit = entryLevel - rangeSize * 1.5;
      }

      const riskReward = Math.abs((takeProfit - entryLevel) / (entryLevel - stopLoss));

      return {
        symbol,
        price,
        state: "SNIPER",
        direction: previousSignal.direction,
        event: previousSignal.event,
        entry_level: entryLevel,
        entry_description: `${previousSignal.direction} entry at ${entryLevel.toFixed(2)}`,
        stopLoss: parseFloat(stopLoss.toFixed(2)),
        takeProfit: parseFloat(takeProfit.toFixed(2)),
        riskReward: parseFloat(riskReward.toFixed(2)),
        confidence: Math.min(100, previousSignal.confidence + 15),
      };
    }

    // BUILDING continues - no new event, no confirmation yet
    console.log(`[STRATEGY] ${symbol} → BUILDING (awaiting confirmation)`);
    return {
      symbol,
      price,
      state: "BUILDING",
      direction: previousSignal.direction,
      event: previousSignal.event,
      entry_level: previousSignal.entry_level,
      entry_description: previousSignal.entry_description,
      confidence: previousSignal.confidence,
    };
  }

  // Default: No previous signal and no event detected
  // This should NOT happen per the requirement - markets are always active
  // But as fallback, create a micro-event based on direction
  const currentClose = history[history.length - 1];
  const prevClose = history.length > 1 ? history[history.length - 2] : currentClose;
  
  const direction = currentClose > prevClose ? "LONG" : "SHORT";
  const event = currentClose > prevClose ? "acceleration" : "exhaustion";

  console.log(`[STRATEGY] ${symbol} → BUILDING (default active state: ${event})`);
  return {
    symbol,
    price,
    state: "BUILDING",
    direction,
    event,
    entry_level: currentClose,
    entry_description: `Market active: ${direction} bias`,
    confidence: 45,
  };
}

/**
 * Create a complete signal with Kraken prices and event-driven analysis
 */
export async function createSignal(symbol: string): Promise<Signal> {
  const { getSignal } = await import("./signal-store");

  const price = await getKrakenTicker(symbol);

  if (!price || price <= 0) {
    // Fallback: Create minimal signal (still BUILDING, not neutral)
    const direction = Math.random() > 0.5 ? "LONG" : "SHORT";
    return {
      symbol,
      price: 0,
      state: "BUILDING",
      direction,
      event: "acceleration",
      entry_level: 0,
      entry_description: "Awaiting price data",
      confidence: 0,
      updated_at: new Date().toISOString(),
    };
  }

  const previousSignal = getSignal(symbol);
  const evaluated = evaluateMarket(symbol, price, previousSignal || null);

  const signal: Signal = {
    ...evaluated,
    updated_at: new Date().toISOString(),
  };

  return signal;
}
