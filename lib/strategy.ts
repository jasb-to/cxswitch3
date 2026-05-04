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

// ─── Market context with swing levels ────────────────────────────────────────

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
      };
    }

    const price = candles4h[candles4h.length - 1].close;
    const highs = swingHighs(candles4h);
    const lows = swingLows(candles4h);

    const swingHigh = highs.length ? Math.max(...highs) : null;
    const swingLow = lows.length ? Math.min(...lows) : null;

    let distanceToHigh: number | null = null;
    let distanceToLow: number | null = null;

    if (swingHigh) {
      distanceToHigh = ((swingHigh - price) / price) * 100;
    }
    if (swingLow) {
      distanceToLow = ((price - swingLow) / price) * 100;
    }

    let setup: "LONG_SETUP" | "SHORT_SETUP" | "NO_SETUP" | "ERROR" = "NO_SETUP";
    let setupText = "NO SETUP — ranging";

    if (distanceToHigh !== null && distanceToHigh >= -3 && distanceToHigh <= 0) {
      setup = "LONG_SETUP";
      setupText = `LONG SETUP — ${Math.abs(distanceToHigh).toFixed(1)}% below $${swingHigh.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
    } else if (distanceToLow !== null && distanceToLow >= 0 && distanceToLow <= 3) {
      setup = "SHORT_SETUP";
      setupText = `SHORT SETUP — ${distanceToLow.toFixed(1)}% above $${swingLow.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
    }

    return {
      symbol,
      price,
      swingHigh,
      swingLow,
      distanceToHigh,
      distanceToLow,
      setup,
      setupText,
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
    };
  }
}
