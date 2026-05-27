=== FILE 1: /lib/coingecko.ts ===
/**
 * CoinGecko API - SINGLE CALL ONLY
 * No OHLC. No Redis. No caching.
 * One call returns all 3 symbols with prices + 24h change.
 */

const COINGECKO_URL = "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,solana&vs_currencies=usd&include_24hr_change=true";

const FALLBACK = {
  bitcoin: { usd: 75000, usd_24h_change: 0 },
  ethereum: { usd: 2070, usd_24h_change: 0 },
  solana: { usd: 84, usd_24h_change: 0 },
};

export interface PriceData {
  price: number;
  change24h: number;
}

export async function fetchPrices(): Promise<Record<string, PriceData>> {
  try {
    const res = await fetch(COINGECKO_URL, { 
      cache: "no-store",
      headers: { "Accept": "application/json" }
    });

    if (!res.ok) {
      console.warn("[CG] API failed:", res.status, "using fallback");
      return {
        BTC: { price: FALLBACK.bitcoin.usd, change24h: FALLBACK.bitcoin.usd_24h_change },
        ETH: { price: FALLBACK.ethereum.usd, change24h: FALLBACK.ethereum.usd_24h_change },
        SOL: { price: FALLBACK.solana.usd, change24h: FALLBACK.solana.usd_24h_change },
      };
    }

    const data = await res.json();

    return {
      BTC: { 
        price: data.bitcoin?.usd || FALLBACK.bitcoin.usd, 
        change24h: data.bitcoin?.usd_24h_change || 0 
      },
      ETH: { 
        price: data.ethereum?.usd || FALLBACK.ethereum.usd, 
        change24h: data.ethereum?.usd_24h_change || 0 
      },
      SOL: { 
        price: data.solana?.usd || FALLBACK.solana.usd, 
        change24h: data.solana?.usd_24h_change || 0 
      },
    };
  } catch (err) {
    console.warn("[CG] Fetch crashed:", err.message, "using fallback");
    return {
      BTC: { price: FALLBACK.bitcoin.usd, change24h: FALLBACK.bitcoin.usd_24h_change },
      ETH: { price: FALLBACK.ethereum.usd, change24h: FALLBACK.ethereum.usd_24h_change },
      SOL: { price: FALLBACK.solana.usd, change24h: FALLBACK.solana.usd_24h_change },
    };
  }
}


=== FILE 2: /lib/engine.ts ===
/**
 * SIGNAL ENGINE - Stateless, simple, working
 * No Redis. No state memory. No sticky logic.
 * Evaluates from single price call + in-memory history.
 */

import { fetchPrices, PriceData } from "./coingecko";

export type Symbol = "BTC" | "ETH" | "SOL";

export interface Signal {
  symbol: Symbol;
  price: number;
  change24h: number;
  bias: "Bullish" | "Bearish" | "Neutral";
  state: "FLAT" | "BUILDING" | "SNIPER";
  direction?: "LONG" | "SHORT";
  entry?: number;
  stopLoss?: number;
  takeProfit?: number;
  riskReward?: number;
  confidence: number;
  trigger: "Waiting" | "Early Break Up" | "Early Break Down" | "Pullback";
  updatedAt: string;
}

// In-memory price history (survives one request, lost on cold start)
const lastPrices = new Map<Symbol, number>();

function getBias(change24h: number): "Bullish" | "Bearish" | "Neutral" {
  if (change24h > 1.0) return "Bullish";
  if (change24h < -1.0) return "Bearish";
  return "Neutral";
}

function getTrigger(symbol: Symbol, current: number): Signal["trigger"] {
  const last = lastPrices.get(symbol);
  if (!last || last === 0) {
    lastPrices.set(symbol, current);
    return "Waiting";
  }

  const change = (current - last) / last;
  lastPrices.set(symbol, current);

  if (change > 0.003) return "Early Break Up";
  if (change < -0.003) return "Early Break Down";
  if (change > 0.001) return "Pullback";
  if (change < -0.001) return "Pullback";
  return "Waiting";
}

export async function evaluateSignal(symbol: Symbol): Promise<Signal> {
  const prices = await fetchPrices();
  const data = prices[symbol];

  const price = data.price;
  const change24h = data.change24h;
  const bias = getBias(change24h);
  const trigger = getTrigger(symbol, price);

  let state: Signal["state"] = "FLAT";
  let direction: Signal["direction"] = undefined;
  let confidence = 0;

  // BUILDING: Bias exists but no strong trigger yet
  if (bias !== "Neutral") {
    state = "BUILDING";
    direction = bias === "Bullish" ? "LONG" : "SHORT";
    confidence = Math.min(60, 40 + Math.abs(change24h) * 5);
  }

  // SNIPER: Bias + trigger aligned
  if (bias === "Bullish" && trigger === "Early Break Up") {
    state = "SNIPER";
    direction = "LONG";
    confidence = Math.min(95, 70 + change24h * 3);
  } else if (bias === "Bearish" && trigger === "Early Break Down") {
    state = "SNIPER";
    direction = "SHORT";
    confidence = Math.min(95, 70 + Math.abs(change24h) * 3);
  }

  // SL/TP ONLY for SNIPER
  let stopLoss: number | undefined;
  let takeProfit: number | undefined;
  let riskReward: number | undefined;

  if (state === "SNIPER" && direction) {
    const slPct = 0.03; // 3%
    const tpPct = 0.05; // 5%

    if (direction === "LONG") {
      stopLoss = price * (1 - slPct);
      takeProfit = price * (1 + tpPct);
    } else {
      stopLoss = price * (1 + slPct);
      takeProfit = price * (1 - tpPct);
    }

    riskReward = Math.abs((takeProfit - price) / (price - stopLoss));
    if (!isFinite(riskReward)) riskReward = 1.67;
  }

  return {
    symbol,
    price,
    change24h,
    bias,
    state,
    direction,
    entry: state === "SNIPER" ? price : undefined,
    stopLoss,
    takeProfit,
    riskReward,
    confidence: Math.floor(confidence),
    trigger,
    updatedAt: new Date().toISOString(),
  };
}


=== FILE 3: /api/signals/route.ts ===
import { evaluateSignal } from "@/lib/engine";

export async function GET() {
  try {
    const [btc, eth, sol] = await Promise.all([
      evaluateSignal("BTC"),
      evaluateSignal("ETH"),
      evaluateSignal("SOL"),
    ]);

    return Response.json({ 
      signals: [btc, eth, sol], 
      timestamp: Date.now() 
    });
  } catch (err) {
    console.error("[SIGNALS] Failed:", err);
    return Response.json({ 
      error: "Failed to evaluate signals", 
      signals: [] 
    }, { status: 500 });
  }
}


=== FILE 4: /api/cron/route.ts ===
import { evaluateSignal } from "@/lib/engine";

const CRON_SECRET = process.env.CRON_SECRET || "abc123xyz789";
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

async function sendTelegramAlert(signal: any) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.warn("[CRON] Telegram not configured");
    return;
  }

  const emoji = signal.direction === "LONG" ? "🟢" : "🔴";
  const text = `${emoji} ${signal.symbol} ${signal.direction} — $${signal.price.toFixed(2)}
24h: ${signal.change24h > 0 ? "+" : ""}${signal.change24h.toFixed(2)}% | Bias: ${signal.bias}
Entry: $${signal.entry?.toFixed(2)} | SL: $${signal.stopLoss?.toFixed(2)} | TP: $${signal.takeProfit?.toFixed(2)}
⏰ ${new Date().toLocaleTimeString()}`;

  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text,
        parse_mode: "HTML",
      }),
    });
    console.log("[CRON] Alert sent:", signal.symbol, signal.direction);
  } catch (err) {
    console.error("[CRON] Telegram failed:", err);
  }
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);

  if (searchParams.get("secret") !== CRON_SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }

  try {
    const signals = await Promise.all([
      evaluateSignal("BTC"),
      evaluateSignal("ETH"),
      evaluateSignal("SOL"),
    ]);

    let alertsSent = 0;

    for (const signal of signals) {
      console.log(`[CRON] ${signal.symbol}: ${signal.state}, confidence=${signal.confidence}%`);

      if (signal.state === "SNIPER" && signal.confidence >= 60) {
        await sendTelegramAlert(signal);
        alertsSent++;
      }
    }

    console.log(`[CRON] Cycle complete: ${alertsSent} alerts sent`);
    return Response.json({ 
      signals, 
      alertsSent, 
      timestamp: Date.now() 
    });

  } catch (err) {
    console.error("[CRON] Failed:", err);
    return Response.json({ error: err.message }, { status: 500 });
  }
}
