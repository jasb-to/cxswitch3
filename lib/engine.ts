export type Symbol = "BTC" | "ETH" | "SOL";

export interface Signal {
  symbol: Symbol;
  price: number;
  change24h: number;
  bias4H: "Bullish" | "Bearish" | "Neutral";
  bias1H: "Bullish" | "Bearish" | "Neutral";
  setup: "LONG" | "SHORT" | null;
  stochRSI: number;
  stochDirection: "rising" | "falling" | "neutral";
  emaCross: "Bullish" | "Bearish" | "None";
  momentum: "Accelerating" | "Decelerating" | "Flat";
  entry?: number;
  stopLoss?: number;
  takeProfit?: number;
  trigger: string;
  updatedAt: string;
  state?: "FLAT" | "BUILDING" | "SNIPER";
  confidence?: number;
  shouldAlert?: boolean;
  tradeType?: string;
  riskReward?: number;
  bias?: string;
  dataQuality?: string;
  stochRSIState?: string;
  stochRSIPeak?: any;
  stochRSITrough?: any;
  stochRSIDirection?: string;
  direction?: string;
}

// In-memory caches
let signalCache: Signal[] = [];
const alertHistory = new Map<string, { direction: string; price: number; time: number }>();
const biasHistory = new Map<string, { bias: string; price: number; time: number }>();
const sentAlerts = new Map<string, { entry: number; direction: string; timestamp: number }>();

// API response cache (5 minutes)
const ohlcCache = new Map<string, { data: any[]; timestamp: number }>();
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

export function getCachedSignals(): Signal[] {
  return signalCache;
}

export function setCachedSignals(signals: Signal[]): void {
  signalCache = signals;
}

export function recordAlert(symbol: string, direction: string, price: number): void {
  alertHistory.set(symbol, { direction, price, time: Date.now() });
}

export function shouldSendAlert(
  symbol: string,
  direction: string | undefined,
  entry: number | undefined
): boolean {
  if (!direction || !entry) return false;

  const lastAlert = sentAlerts.get(symbol);
  const now = Date.now();
  const fiveMinutes = 5 * 60 * 1000;

  if (!lastAlert) return true;

  const entryDiff = Math.abs(entry - lastAlert.entry) / lastAlert.entry;
  if (
    lastAlert.direction === direction &&
    entryDiff < 0.05 &&
    now - lastAlert.timestamp < fiveMinutes
  ) {
    return false;
  }

  if (lastAlert.direction !== direction) {
    sentAlerts.set(symbol, { entry, direction, timestamp: now });
    return true;
  }

  if (entryDiff >= 0.05) {
    sentAlerts.set(symbol, { entry, direction, timestamp: now });
    return true;
  }

  if (now - lastAlert.timestamp > fiveMinutes) {
    sentAlerts.set(symbol, { entry, direction, timestamp: now });
    return true;
  }

  return false;
}

export function recordSentAlert(symbol: string, direction: string, entry: number): void {
  sentAlerts.set(symbol, { entry, direction, timestamp: Date.now() });
}

export function detectBiasFlip(
  symbol: string,
  newBias: string,
  price: number
): { flipped: boolean; oldBias?: string; newBias: string } {
  const history = biasHistory.get(symbol);
  const oldBias = history?.bias;

  biasHistory.set(symbol, { bias: newBias, price, time: Date.now() });

  if (oldBias && oldBias !== newBias) {
    return { flipped: true, oldBias, newBias };
  }

  return { flipped: false, newBias };
}

const KRAKEN: Record<Symbol, string> = {
  BTC: "XXBTZUSD",
  ETH: "XETHZUSD",
  SOL: "SOLUSD",
};

async function fetchOHLC(symbol: Symbol, interval: number) {
  const pair = KRAKEN[symbol];
  const cacheKey = `${pair}_${interval}`;
  const now = Date.now();

  // Check cache first (5 minute TTL)
  const cached = ohlcCache.get(cacheKey);
  if (cached && now - cached.timestamp < CACHE_DURATION) {
    console.log(`[ENGINE] Cache hit for ${pair} (${interval}m) - ${Math.round((CACHE_DURATION - (now - cached.timestamp)) / 1000)}s remaining`);
    return cached.data;
  }

  const url = `https://api.kraken.com/0/public/OHLC?pair=${pair}&interval=${interval}`;

  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) {
      console.log(`[ENGINE] Kraken API error for ${pair}: ${res.status}`);
      return [];
    }

    const data = await res.json();

    if (data.error && data.error.length > 0) {
      console.log(`[ENGINE] Kraken error for ${pair}: ${data.error.join(", ")}`);
      return [];
    }

    const key = Object.keys(data.result || {}).find((k) => k !== "last");
    if (!key) {
      console.log(`[ENGINE] No OHLC data for ${pair} (interval: ${interval})`);
      return [];
    }

    const candles = data.result[key].map((c: any[]) => ({
      close: Number(c[4]),
    }));

    // Cache the result
    ohlcCache.set(cacheKey, { data: candles, timestamp: now });

    console.log(`[ENGINE] Fetched ${candles.length} candles for ${pair} (${interval}m)`);
    return candles;
  } catch (err) {
    console.log(`[ENGINE] Fetch error for ${pair}: ${err}`);
    return [];
  }
}

function calculateBias(closes: number[]) {
  if (closes.length < 6) return "Neutral";

  const recent = closes.slice(-6);
  let up = 0,
    down = 0;

  for (let i = 1; i < recent.length; i++) {
    if (recent[i] > recent[i - 1]) up++;
    if (recent[i] < recent[i - 1]) down++;
  }

  if (up >= 4) return "Bullish";
  if (down >= 4) return "Bearish";
  return "Neutral";
}

function calculateStoch(closes: number[]) {
  if (closes.length < 14) {
    console.log(`[ENGINE] Insufficient candles for stoch: ${closes.length} < 14`);
    return 50;
  }

  const slice = closes.slice(-14);
  const low = Math.min(...slice);
  const high = Math.max(...slice);
  const current = slice.at(-1)!;

  const value = high === low ? 50 : ((current - low) / (high - low)) * 100;
  return Math.round(value);
}

function calculateMomentum(closes: number[]) {
  if (closes.length < 4) return "Flat";

  const c1 = Math.abs(closes.at(-2)! - closes.at(-3)!);
  const c2 = Math.abs(closes.at(-1)! - closes.at(-2)!);

  if (c2 > c1 * 1.2) return "Accelerating";
  if (c2 < c1 * 0.8) return "Decelerating";
  return "Flat";
}

function calculateEMACross(closes: number[]) {
  if (closes.length < 30) return "None";

  const ema8 = closes.slice(-8).reduce((a, b) => a + b, 0) / 8;
  const ema21 = closes.slice(-21).reduce((a, b) => a + b, 0) / 21;

  if (ema8 > ema21) return "Bullish";
  if (ema8 < ema21) return "Bearish";
  return "None";
}

export async function evaluateSignal(symbol: Symbol): Promise<Signal> {
  // Single API call - fetch 1H candles with 2+ hours of data
  const closes1H = (await fetchOHLC(symbol, 60)).map((c) => c.close);

  console.log(`[ENGINE] ${symbol}: 1H candles=${closes1H.length}`);

  const price = closes1H.at(-1) || 0;

  // Calculate metrics from 1H data
  const bias1H = calculateBias(closes1H);
  const bias4H = bias1H; // Use 1H as proxy for 4H (single API call)
  const stoch = calculateStoch(closes1H);
  const momentum = calculateMomentum(closes1H);
  const emaCross = calculateEMACross(closes1H);

  let setup: "LONG" | "SHORT" | null = null;

  if (bias1H === "Bullish" && emaCross === "Bullish" && stoch >= 35) {
    setup = "LONG";
  }

  if (bias1H === "Bearish" && emaCross === "Bearish" && stoch <= 65) {
    setup = "SHORT";
  }

  const roundPrice = (p: number) => Math.round(p * 100) / 100;

  return {
    symbol,
    price: roundPrice(price),
    change24h: 0,
    bias4H,
    bias1H,
    setup,
    stochRSI: stoch,
    stochDirection: stoch < 20 ? "rising" : stoch > 80 ? "falling" : "neutral",
    emaCross,
    momentum,
    entry: setup ? roundPrice(price) : undefined,
    stopLoss: setup ? roundPrice(price * (setup === "LONG" ? 0.985 : 1.015)) : undefined,
    takeProfit: setup ? roundPrice(price * (setup === "LONG" ? 1.04 : 0.96)) : undefined,
    trigger: setup ? "1H Bias + EMA + Stoch" : "Waiting",
    updatedAt: new Date().toISOString(),
    state: setup ? "SNIPER" : "FLAT",
    confidence: setup ? 80 : 0,
    shouldAlert: setup ? true : false,
    tradeType: "With Trend",
    riskReward: setup ? 1.33 : undefined,
    bias: bias1H,
    dataQuality: "1H OHLC",
    stochRSIState: stoch < 20 ? "Oversold" : stoch > 80 ? "Overbought" : "Neutral",
    stochRSIDirection: stoch < 20 ? "rising" : stoch > 80 ? "falling" : "neutral",
    direction: setup,
  };
}
