import { fetchPrice, fetchOHLC1H, fetchOHLC4H, OHLC, PriceData } from "./coingecko";

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

type Symbol = "BTC" | "ETH" | "SOL";
type CGId = "bitcoin" | "ethereum" | "solana";
type Layer1State = "Bullish" | "Bearish" | "Neutral";
type Layer2State = "FLAT" | "BUILDING" | "SNIPER";

const CG_ID_MAP: Record<Symbol, CGId> = {
  BTC: "bitcoin",
  ETH: "ethereum",
  SOL: "solana",
};

export interface Signal {
  symbol: Symbol;
  price: number;
  state: "FLAT" | "BUILDING" | "SNIPER";
  confidence: number;
  layer1: {
    trend: Layer1State;
    sma20: number;
    smaDistance: number;
  };
  layer2: {
    state: Layer2State;
    sma12: number;
    smaDistance: number;
  };
  layer3: {
    trigger: "Pullback" | "Breakout" | "Waiting";
  };
  entry?: number;
  stopLoss?: number;
  takeProfit?: number;
  riskReward?: number;
  holdDuration?: string;
  timeStop?: number;
  updatedAt: string;
}

async function redis(command: string[]): Promise<any> {
  if (!REDIS_URL || !REDIS_TOKEN) return null;
  try {
    const response = await fetch(`${REDIS_URL}/exec`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${REDIS_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ commands: [command] }),
    });
    const data = await response.json();
    return data.result?.[0];
  } catch (err) {
    console.error("[REDIS] Error:", err);
    return null;
  }
}

async function getStateCache(symbol: Symbol): Promise<{ state: Layer2State; time: number } | null> {
  const key = `state:${symbol}`;
  const cached = await redis(["GET", key]);
  return cached ? JSON.parse(cached as string) : null;
}

async function setStateCache(symbol: Symbol, state: Layer2State): Promise<void> {
  const key = `state:${symbol}`;
  await redis(["SET", key, JSON.stringify({ state, time: Date.now() })]);
}

// Calculate SMA
function calculateSMA(candles: OHLC[], period: number): number {
  if (candles.length < period) return candles[candles.length - 1]?.close || 0;
  const closes = candles.slice(-period).map(c => c.close);
  return closes.reduce((a, b) => a + b, 0) / period;
}

// LAYER 1: 4H Trend Filter
function analyzeLayer1(candles4h: OHLC[], currentPrice: number): { trend: Layer1State; sma20: number; smaDistance: number } {
  if (candles4h.length < 2) return { trend: "Neutral", sma20: 0, smaDistance: 0 };

  const sma20 = calculateSMA(candles4h, 20);
  const smaDistance = ((currentPrice - sma20) / sma20) * 100;
  const last2Above = candles4h.slice(-2).every(c => c.close > sma20);
  const last2Below = candles4h.slice(-2).every(c => c.close < sma20);

  let trend: Layer1State = "Neutral";
  
  if (currentPrice > sma20 && last2Above && smaDistance > 1.5) {
    trend = "Bullish";
  } else if (currentPrice < sma20 && last2Below && smaDistance < -1.5) {
    trend = "Bearish";
  }

  return { trend, sma20, smaDistance };
}

// LAYER 2: 1H Primary Signal
function analyzeLayer2(candles1h: OHLC[], currentPrice: number, layer1Trend: Layer1State, previousState: Layer2State | null, lastStateTime: number | null): Layer2State {
  if (candles1h.length < 2) return "FLAT";

  const sma12 = calculateSMA(candles1h, 12);
  const smaDistance = ((currentPrice - sma12) / sma12) * 100;

  // FLAT: price within 0.5% of SMA (chop zone)
  if (Math.abs(smaDistance) <= 0.5) {
    return "FLAT";
  }

  if (layer1Trend === "Neutral") {
    return "FLAT";
  }

  const last2Candles = candles1h.slice(-2);
  const crossedSMA = (layer1Trend === "Bullish" && currentPrice > sma12) || (layer1Trend === "Bearish" && currentPrice < sma12);
  
  if (!crossedSMA) {
    return "FLAT";
  }

  const confirmedBreak = (layer1Trend === "Bullish" && last2Candles.every(c => c.close > sma12)) ||
                         (layer1Trend === "Bearish" && last2Candles.every(c => c.close < sma12));

  // Check minimum state duration (30 minutes = 2 candles)
  if (previousState && previousState !== "FLAT" && lastStateTime) {
    const elapsed = Date.now() - lastStateTime;
    if (elapsed < 30 * 60 * 1000) { // 30 minutes
      return previousState;
    }
  }

  // SNIPER: confirmed break (2 consecutive 1H candles)
  if (confirmedBreak) {
    return "SNIPER";
  }

  // BUILDING: crossed SMA but not confirmed yet
  return "BUILDING";
}

// LAYER 3: 15M Execution Trigger
function analyzeLayer3(currentPrice: number, layer2SMA: number, layer1Trend: Layer1State): "Pullback" | "Breakout" | "Waiting" {
  if (layer1Trend === "Neutral") return "Waiting";

  const pullbackDistance = Math.abs(currentPrice - layer2SMA);
  const smaPercent = (pullbackDistance / layer2SMA) * 100;

  if (smaPercent <= 0.3) {
    return "Pullback";
  }

  return "Waiting";
}

export async function evaluate(symbol: Symbol): Promise<Signal> {
  try {
    const cgId = CG_ID_MAP[symbol];
    
    // Fetch all data in parallel
    const [priceData, candles1h, candles4h] = await Promise.all([
      fetchPrice(cgId),
      fetchOHLC1H(cgId),
      fetchOHLC4H(cgId),
    ]);

    if (!priceData) throw new Error(`Failed to fetch price for ${symbol}`);

    const price = priceData.price;

    // Layer 1: 4H Trend Filter
    const layer1 = analyzeLayer1(candles4h, price);

    // Layer 2: 1H Primary Signal with state memory
    const stateMemory = await getStateCache(symbol);
    const layer2 = analyzeLayer2(candles1h, price, layer1.trend, stateMemory?.state || null, stateMemory?.time || null);

    // Update state cache if state changed
    if (layer2 !== stateMemory?.state) {
      await setStateCache(symbol, layer2);
    }

    // Layer 3: 15M Execution Trigger
    const sma12 = calculateSMA(candles1h, 12);
    const layer3 = analyzeLayer3(price, sma12, layer1.trend);

    // Determine final signal state
    let finalState: "FLAT" | "BUILDING" | "SNIPER" = "FLAT";
    let confidence = 0;

    if (layer1.trend !== "Neutral" && layer2 === "SNIPER" && layer3 === "Pullback") {
      finalState = "SNIPER";
      confidence = 95;
    } else if (layer1.trend !== "Neutral" && layer2 === "SNIPER") {
      finalState = "SNIPER";
      confidence = 85;
    } else if (layer1.trend !== "Neutral" && layer2 === "BUILDING") {
      finalState = "BUILDING";
      confidence = 60;
    }

    // Calculate SL/TP
    let entry = price;
    let stopLoss = 0;
    let takeProfit = 0;

    if (finalState === "SNIPER") {
      stopLoss = layer1.trend === "Bullish" ? entry * 0.985 : entry * 1.015;
      takeProfit = layer1.trend === "Bullish" ? entry * 1.045 : entry * 0.955;
    }

    const riskReward = finalState === "SNIPER" ? 3.0 : 0;
    const timeStop = finalState === "SNIPER" ? 4 * 60 * 60 * 1000 : 0;

    return {
      symbol,
      price,
      state: finalState,
      confidence,
      layer1: {
        trend: layer1.trend,
        sma20: layer1.sma20,
        smaDistance: layer1.smaDistance,
      },
      layer2: {
        state: layer2,
        sma12,
        smaDistance: ((price - sma12) / sma12) * 100,
      },
      layer3: {
        trigger: layer3,
      },
      entry: finalState === "SNIPER" ? entry : undefined,
      stopLoss: finalState === "SNIPER" ? stopLoss : undefined,
      takeProfit: finalState === "SNIPER" ? takeProfit : undefined,
      riskReward: finalState === "SNIPER" ? riskReward : undefined,
      holdDuration: finalState === "SNIPER" ? "6-8h" : undefined,
      timeStop: finalState === "SNIPER" ? timeStop : undefined,
      updatedAt: new Date().toISOString(),
    };
  } catch (err: any) {
    console.error(`[ENGINE] ${symbol} evaluation failed:`, err.message);
    return {
      symbol,
      price: 0,
      state: "FLAT",
      confidence: 0,
      layer1: { trend: "Neutral", sma20: 0, smaDistance: 0 },
      layer2: { state: "FLAT", sma12: 0, smaDistance: 0 },
      layer3: { trigger: "Waiting" },
      updatedAt: new Date().toISOString(),
    };
  }
}
