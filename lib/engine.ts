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

// In-memory signal cache
let signalCache: Signal[] = [];
const alertHistory = new Map<string, { direction: string; price: number; time: number }>();
const biasHistory = new Map<string, { bias: string; price: number; time: number }>();
const sentAlerts = new Map<string, { entry: number; direction: string; timestamp: number }>();

export function getCachedSignals(): Signal[] {
  return signalCache;
}

export function setCachedSignals(signals: Signal[]): void {
  signalCache = signals;
}

export function recordAlert(
  symbol: string,
  direction: string,
  price: number
): void {
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

  // If never sent for this symbol, allow it
  if (!lastAlert) {
    return true;
  }

  // If same direction AND entry within 5% AND sent within 5 minutes: SKIP (spam)
  const entryDiff = Math.abs(entry - lastAlert.entry) / lastAlert.entry;
  if (
    lastAlert.direction === direction &&
    entryDiff < 0.05 &&
    now - lastAlert.timestamp < fiveMinutes
  ) {
    console.log(
      `[ENGINE] ⏸️  Spam blocked for ${symbol}: same setup (entry diff: ${(entryDiff * 100).toFixed(2)}%)`
    );
    return false;
  }

  // If direction changed: allow (new setup)
  if (lastAlert.direction !== direction) {
    sentAlerts.set(symbol, { entry, direction, timestamp: now });
    return true;
  }

  // If entry moved significantly (>5%): allow
  if (entryDiff >= 0.05) {
    sentAlerts.set(symbol, { entry, direction, timestamp: now });
    return true;
  }

  // If more than 5 minutes have passed: allow
  if (now - lastAlert.timestamp > fiveMinutes) {
    sentAlerts.set(symbol, { entry, direction, timestamp: now });
    return true;
  }

  return false;
}

export function recordSentAlert(
  symbol: string,
  direction: string,
  entry: number
): void {
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
  BTC: "XBTUSD",
  ETH: "ETHUSD",
  SOL: "SOLUSD",
};

async function fetchOHLC(symbol: Symbol, interval: number) {
  const pair = KRAKEN[symbol];

  const url =
    "https://api.kraken.com/0/public/OHLC?pair=" +
    pair +
    "&interval=" +
    interval;

  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) {
      console.log(`[v0] Kraken API error for ${pair}: ${res.status}`);
      return [];
    }

    const data = await res.json();
    
    if (data.error && data.error.length > 0) {
      console.log(`[v0] Kraken error for ${pair}: ${data.error.join(", ")}`);
      return [];
    }

    const key = Object.keys(data.result || {}).find((k) => k !== "last");
    if (!key) {
      console.log(`[v0] No OHLC data for ${pair} (interval: ${interval})`);
      return [];
    }

    const candles = data.result[key].map((c: any[]) => ({
      close: Number(c[4]),
    }));
    
    console.log(`[v0] Fetched ${candles.length} candles for ${pair} (${interval}m)`);
    return candles;
  } catch (err) {
    console.log(`[v0] Fetch error for ${pair}: ${err}`);
    return [];
  }
}

function emaCross(closes: number[]) {
  if (closes.length < 20) return "None";

  const ema8 = closes.slice(-8).reduce((a, b) => a + b, 0) / 8;
  const ema21 = closes.slice(-21).reduce((a, b) => a + b, 0) / 21;

  if (ema8 > ema21) return "Bullish";
  if (ema8 < ema21) return "Bearish";
  return "None";
}

function bias(closes: number[]) {
  const r = closes.slice(-6);
  let up = 0,
    down = 0;

  for (let i = 1; i < r.length; i++) {
    if (r[i] > r[i - 1]) up++;
    if (r[i] < r[i - 1]) down++;
  }

  if (up >= 4) return "Bullish";
  if (down >= 4) return "Bearish";
  return "Neutral";
}

function stoch(closes: number[]) {
  if (closes.length < 14) return 50;
  
  const slice = closes.slice(-14);
  const low = Math.min(...slice);
  const high = Math.max(...slice);
  const current = slice.at(-1)!;

  const value = high === low ? 50 : ((current - low) / (high - low)) * 100;

  return Math.round(value);
}

function momentum(closes: number[]) {
  const a = Math.abs(closes.at(-3)! - closes.at(-4)!);
  const b = Math.abs(closes.at(-2)! - closes.at(-3)!);

  if (b > a) return "Accelerating";
  if (b < a) return "Decelerating";
  return "Flat";
}

export async function evaluateSignal(symbol: Symbol): Promise<Signal> {
  const [c4, c1, c15] = await Promise.all([
    fetchOHLC(symbol, 240),
    fetchOHLC(symbol, 60),
    fetchOHLC(symbol, 15),
  ]);

  const closes4 = c4.map((c) => c.close);
  const closes1 = c1.map((c) => c.close);
  const closes15 = c15.map((c) => c.close);

  console.log(`[v0] ${symbol}: closes4=${closes4.length}, closes1=${closes1.length}, closes15=${closes15.length}`);
  if (closes15.length > 0) {
    console.log(`[v0] ${symbol} latest 15m closes: ${closes15.slice(-3).join(", ")}`);
  }

  const price = closes15.at(-1) || 0;

  const bias4H = bias(closes4);
  const bias1H = bias(closes1);

  const ema = emaCross(closes15);
  const st = stoch(closes15);
  const mom = momentum(closes15);

  let setup: "LONG" | "SHORT" | null = null;
  let direction: string = "";

  if (
    bias4H === "Bullish" &&
    bias1H === "Bullish" &&
    ema === "Bullish" &&
    st >= 35
  ) {
    setup = "LONG";
    direction = "LONG";
  }

  if (
    bias4H === "Bearish" &&
    bias1H === "Bearish" &&
    ema === "Bearish" &&
    st <= 65
  ) {
    setup = "SHORT";
    direction = "SHORT";
  }

  const roundPrice = (p: number) => Math.round(p * 100) / 100;

  return {
    symbol,
    price: roundPrice(price),
    change24h: 0,
    bias4H,
    bias1H,
    setup,
    stochRSI: st,
    stochDirection: st < 20 ? "rising" : st > 80 ? "falling" : "neutral",
    emaCross: ema,
    momentum: mom,
    entry: setup ? roundPrice(price) : undefined,
    stopLoss: setup ? roundPrice(price * (setup === "LONG" ? 0.985 : 1.015)) : undefined,
    takeProfit: setup ? roundPrice(price * (setup === "LONG" ? 1.04 : 0.96)) : undefined,
    trigger: setup ? "EMA + Bias + Stoch" : "Waiting",
    updatedAt: new Date().toISOString(),
    state: setup ? "SNIPER" : "FLAT",
    confidence: setup ? 85 : 0,
    shouldAlert: setup ? true : false,
    tradeType: "With Trend",
    riskReward: setup ? 1.33 : undefined,
    bias: bias4H,
    dataQuality: "OHLC",
    stochRSIState: st < 20 ? "Oversold" : st > 80 ? "Overbought" : "Neutral",
    stochRSIPeak: null,
    stochRSITrough: null,
    stochRSIDirection: st < 20 ? "rising" : st > 80 ? "falling" : "neutral",
  };
}
