import { supabase } from "@/lib/supabase-client";
import { fetchCandles, type Candle } from "./kraken";

export type SignalDirection = "LONG" | "SHORT";
export type SignalState = "EARLY" | "CONFIRMED" | "END";

export interface Signal {
  id?: number;
  symbol: string;
  direction: SignalDirection;
  state: SignalState;
  entry_price: number;
  stop_loss: number;
  take_profit: number;
  confidence: number;
  breakout_level: number;
  created_at?: string;
  updated_at?: string;
}

export interface MarketContext {
  symbol: string;
  price: number;
  swingHigh: number | null;
  swingLow: number | null;
  distanceToHigh: number | null;
  distanceToLow: number | null;
  setup: "LONG_SETUP" | "SHORT_SETUP" | "NO_SETUP" | "ERROR";
  setupText: string;
  error?: boolean;
  trendlines?: number;
}

// ─── Kraken candle helpers ───────────────────────────────────────────────────

function swingHighs(candles: Candle[]): number[] {
  const highs: number[] = [];
  for (let i = 1; i < candles.length - 1; i++) {
    if (candles[i].high > candles[i - 1].high && candles[i].high > candles[i + 1].high) {
      highs.push(candles[i].high);
    }
  }
  return highs;
}

function swingLows(candles: Candle[]): number[] {
  const lows: number[] = [];
  for (let i = 1; i < candles.length - 1; i++) {
    if (candles[i].low < candles[i - 1].low && candles[i].low < candles[i + 1].low) {
      lows.push(candles[i].low);
    }
  }
  return lows;
}

// ─── Signal generation from market data ──────────────────────────────────────

export async function generateSignals(): Promise<{ signals: Signal[]; logs: string[] }> {
  const logs: string[] = [];
  const signals: Signal[] = [];

  if (!supabase) {
    logs.push("[SUPABASE] Not connected — skipping signal generation");
    return { signals, logs };
  }

  try {
    const { data: existing, error } = await supabase
      .from("signals")
      .select("*")
      .in("state", ["EARLY", "CONFIRMED"]);

    if (error) {
      logs.push(`[SUPABASE] Query error: ${error.message}`);
      return { signals, logs };
    }

    const existingMap = new Map(existing?.map((s: any) => [s.symbol, s]) ?? []);

    for (const base of ["BTC", "ETH", "SOL"]) {
      try {
        const candles4h = await fetchCandles(base, 240, 100);
        if (!candles4h.length) continue;

        const price = candles4h[candles4h.length - 1].close;
        const highs = swingHighs(candles4h);
        const lows = swingLows(candles4h);
        const highestHigh = highs.length ? Math.max(...highs) : null;
        const lowestLow = lows.length ? Math.min(...lows) : null;

        if (highestHigh && price > highestHigh * 1.01) {
          logs.push(`[${base}] LONG breakout at $${price.toFixed(2)} above $${highestHigh.toFixed(2)}`);
        } else if (lowestLow && price < lowestLow * 0.99) {
          logs.push(`[${base}] SHORT breakout at $${price.toFixed(2)} below $${lowestLow.toFixed(2)}`);
        } else {
          logs.push(`[${base}] Price: $${price.toFixed(2)} — no breakout`);
        }

        const existing = existingMap.get(`${base}/USD`);
        if (existing) {
          signals.push(existing);
        }
      } catch (err) {
        logs.push(`[${base}] Error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } catch (err) {
    logs.push(`[GENERATE_SIGNALS] Error: ${err instanceof Error ? err.message : String(err)}`);
  }

  return { signals, logs };
}

// ─── Get all signals from Supabase ──────────────────────────────────────────

export async function getAllSignals(): Promise<Signal[]> {
  if (!supabase) {
    console.warn("[getAllSignals] Supabase not connected");
    return [];
  }

  try {
    const { data, error } = await supabase
      .from("signals")
      .select("*")
      .order("created_at", { ascending: false });

    if (error) {
      console.error("[getAllSignals] Query error:", error);
      return [];
    }

    return data ?? [];
  } catch (err) {
    console.error("[getAllSignals] Error:", err);
    return [];
  }
}

// ─── Find local pivots (highs and lows) ───────────────────────────────────────

function findPivots(candles: Candle[], lookback: number = 2): { highs: number[]; lows: number[] } {
  const highs: number[] = [];
  const lows: number[] = [];

  for (let i = lookback; i < candles.length - lookback; i++) {
    const c = candles[i];
    if (c.high > candles[i - 1].high && c.high > candles[i + 1].high) {
      highs.push(c.high);
    }
    if (c.low < candles[i - 1].low && c.low < candles[i + 1].low) {
      lows.push(c.low);
    }
  }
  return { highs, lows };
}

// ─── Group prices into trendlines by touch count ────────────────────────────────

function groupTouches(prices: number[], tolerance: number = 0.005): { level: number; touches: number }[] {
  const groups: { level: number; touches: number }[] = [];

  for (const price of prices) {
    let found = false;
    for (const group of groups) {
      if (Math.abs(price - group.level) / group.level < tolerance) {
        group.level = (group.level * group.touches + price) / (group.touches + 1);
        group.touches++;
        found = true;
        break;
      }
    }
    if (!found) groups.push({ level: price, touches: 1 });
  }

  return groups.filter((g) => g.touches >= 3).sort((a, b) => b.touches - a.touches);
}

// ─── Market context with trendlines ───────────────────────────────────────────

export async function getMarketContext(symbolBase: string): Promise<MarketContext> {
  try {
    const symbol = `${symbolBase}/USD`;
    const candles4h = await fetchCandles(symbolBase, 240, 100);

    if (!candles4h.length) {
      return {
        symbol,
        price: 0,
        swingHigh: null,
        swingLow: null,
        distanceToHigh: null,
        distanceToLow: null,
        setup: "ERROR",
        setupText: "No candle data available",
        error: true,
        trendlines: 0,
      };
    }

    const price = candles4h[candles4h.length - 1].close;

    // Find pivots and group into trendlines
    const { highs, lows } = findPivots(candles4h, 2);
    const resistances = groupTouches(highs, 0.005);
    const supports = groupTouches(lows, 0.005);

    const bestResistance = resistances[0];
    const bestSupport = supports[0];

    // Use best resistance/support as swingHigh/swingLow
    const swingHigh = bestResistance?.level ?? null;
    const swingLow = bestSupport?.level ?? null;

    let distanceToHigh: number | null = null;
    let distanceToLow: number | null = null;

    if (swingHigh) {
      distanceToHigh = ((swingHigh - price) / price) * 100;
    }
    if (swingLow) {
      distanceToLow = ((price - swingLow) / price) * 100;
    }

    let setup: "LONG_SETUP" | "SHORT_SETUP" | "NO_SETUP" | "ERROR" = "NO_SETUP";
    let setupText = "NO STRUCTURE — no 3-touch trendlines";

    // Check for breakouts (0.5% above resistance or below support)
    if (bestResistance && price > bestResistance.level * 1.005) {
      setup = "LONG_SETUP";
      setupText = `LONG — broke ${bestResistance.touches}-touch resistance at $${bestResistance.level.toFixed(0)}`;
    } else if (bestSupport && price < bestSupport.level * 0.995) {
      setup = "SHORT_SETUP";
      setupText = `SHORT — broke ${bestSupport.touches}-touch support at $${bestSupport.level.toFixed(0)}`;
    } else if (bestResistance) {
      const dist = ((bestResistance.level - price) / price) * 100;
      setupText = `${bestResistance.touches}-touch resistance at $${bestResistance.level.toFixed(0)} (${dist.toFixed(1)}% away)`;
    } else if (bestSupport) {
      const dist = ((price - bestSupport.level) / price) * 100;
      setupText = `${bestSupport.touches}-touch support at $${bestSupport.level.toFixed(0)} (${dist.toFixed(1)}% away)`;
    }

    const trendlineCount = (bestResistance ? 1 : 0) + (bestSupport ? 1 : 0);

    return {
      symbol,
      price,
      swingHigh,
      swingLow,
      distanceToHigh,
      distanceToLow,
      setup,
      setupText,
      trendlines: trendlineCount,
    };
  } catch (err) {
    console.error(`[getMarketContext] Error for ${symbolBase}:`, err);
    return {
      symbol: `${symbolBase}/USD`,
      price: 0,
      swingHigh: null,
      swingLow: null,
      distanceToHigh: null,
      distanceToLow: null,
      setup: "ERROR",
      setupText: `Data unavailable: ${err instanceof Error ? err.message : "Unknown error"}`,
      error: true,
      trendlines: 0,
    };
  }
}
