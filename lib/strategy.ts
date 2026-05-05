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
  pnl?: number | null;
  outcome?: "TP" | "SL" | null;
  alert_sent?: boolean;
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
    // Fetch all active (non-ended) signals once upfront
    const { data: activeRows, error: fetchError } = await supabase
      .from("signals")
      .select("*")
      .in("state", ["EARLY", "CONFIRMED"]);

    if (fetchError) {
      logs.push(`[SUPABASE] Query error: ${fetchError.message}`);
      return { signals, logs };
    }

    // Safe duplicate check: only block if symbol has an active (non-END) signal
    const activeBySymbol = new Map<string, Signal>(
      (activeRows ?? []).map((s: Signal) => [s.symbol, s])
    );

    for (const base of ["BTC", "ETH", "SOL"]) {
      try {
        const market = await getMarketContext(base);

        if (market.error) {
          logs.push(`[${base}] Market data error — skipping`);
          continue;
        }

        const { symbol, price, swingHigh, swingLow, setup } = market;
        logs.push(`[${base}] $${price.toFixed(2)} — ${setup} — ${market.setupText}`);

        // If there's already an active signal, carry it forward — unless it's a stale EARLY (>1h old)
        const existing = activeBySymbol.get(symbol);
        if (existing) {
          const ageMs = Date.now() - new Date(existing.created_at!).getTime();
          const isStaleEarly = existing.state === "EARLY" && ageMs > 60 * 60 * 1000;

          if (isStaleEarly) {
            // Expire the stale signal so a fresh breakout can create a new one
            await updateSignalState(existing.id!, "END");
            logs.push(`[${base}] Expired stale EARLY signal (${Math.round(ageMs / 60000)}m old) — allowing new signal`);
            // Fall through to signal creation below
          } else {
            logs.push(`[${base}] Active signal exists (${existing.state}) — skipping creation`);
            signals.push(existing);
            continue;
          }
        }

        // LONG: price broke above a 3-touch resistance level by 0.5%
        if (setup === "LONG_SETUP") {
          const breakoutLevel = swingHigh ?? price;
          const newSignal = {
            symbol,
            state: "EARLY" as SignalState,
            direction: "LONG" as SignalDirection,
            entry_price: price,
            stop_loss: swingLow ?? price * 0.97,
            take_profit: price * 1.03,
            confidence: 70,
            breakout_level: breakoutLevel,
          };

          const { data: inserted, error: insertErr } = await supabase
            .from("signals")
            .insert([newSignal])
            .select()
            .single();

          if (insertErr) {
            logs.push(`[${base}] Insert LONG failed: ${insertErr.message}`);
          } else {
            logs.push(`[${base}] Created LONG EARLY at $${price.toFixed(2)}`);
            signals.push(inserted);
          }

        // SHORT: price broke below a 3-touch support level by 0.5%
        } else if (setup === "SHORT_SETUP") {
          const breakoutLevel = swingLow ?? price;
          const newSignal = {
            symbol,
            state: "EARLY" as SignalState,
            direction: "SHORT" as SignalDirection,
            entry_price: price,
            stop_loss: swingHigh ?? price * 1.03,
            take_profit: price * 0.97,
            confidence: 70,
            breakout_level: breakoutLevel,
          };

          const { data: inserted, error: insertErr } = await supabase
            .from("signals")
            .insert([newSignal])
            .select()
            .single();

          if (insertErr) {
            logs.push(`[${base}] Insert SHORT failed: ${insertErr.message}`);
          } else {
            logs.push(`[${base}] Created SHORT EARLY at $${price.toFixed(2)}`);
            signals.push(inserted);
          }

        } else {
          logs.push(`[${base}] No setup — waiting`);
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

// ─── Update signal state in Supabase ────────────────────────────────────────

export async function updateSignalState(
  id: number,
  state: SignalState,
  extra?: Partial<Signal>
): Promise<boolean> {
  if (!supabase) return false;

  const { error } = await supabase
    .from("signals")
    .update({ state, updated_at: new Date().toISOString(), ...extra })
    .eq("id", id);

  if (error) {
    console.error(`[updateSignalState] Failed to update signal ${id}:`, error.message);
    return false;
  }
  return true;
}

// ─── Manage open positions: check TP/SL, promote EARLY → CONFIRMED, expire ──

export async function managePositions(): Promise<{ logs: string[]; confirmed: Signal[] }> {
  const logs: string[] = [];
  const confirmed: Signal[] = []; // newly CONFIRMED this run — for Telegram alerts

  if (!supabase) {
    logs.push("[POSITIONS] Supabase not connected");
    return { logs, confirmed };
  }

  try {
    const { data: openSignals, error } = await supabase
      .from("signals")
      .select("*")
      .in("state", ["EARLY", "CONFIRMED"]);

    if (error) {
      logs.push(`[POSITIONS] Query error: ${error.message}`);
      return { logs, confirmed };
    }

    if (!openSignals?.length) {
      logs.push("[POSITIONS] No open positions");
      return { logs, confirmed };
    }

    for (const signal of openSignals as Signal[]) {
      try {
        const base = signal.symbol.replace("/USD", "");
        // Use more candles so we catch TP/SL hits between cron intervals
        const candles = await fetchCandles(base, 15, 20);
        if (!candles.length) {
          logs.push(`[${base}] No 15m candles`);
          continue;
        }

        const latest = candles[candles.length - 1];
        const { entry_price, stop_loss, take_profit, direction, state, id } = signal;

        logs.push(`[${base}] ${state} ${direction} — close $${latest.close.toFixed(2)} H $${latest.high.toFixed(2)} L $${latest.low.toFixed(2)} | TP $${take_profit.toFixed(2)} SL $${stop_loss.toFixed(2)}`);

        // FIX 1: Use candle HIGH/LOW — not just close — so we never miss a fill
        const tpHitLong  = direction === "LONG"  && latest.high  >= take_profit;
        const tpHitShort = direction === "SHORT" && latest.low   <= take_profit;
        const slHitLong  = direction === "LONG"  && latest.low   <= stop_loss;
        const slHitShort = direction === "SHORT" && latest.high  >= stop_loss;

        if (tpHitLong || tpHitShort) {
          const exitPrice = direction === "LONG" ? take_profit : take_profit;
          const pnl = direction === "LONG"
            ? exitPrice - entry_price
            : entry_price - exitPrice;
          await updateSignalState(id!, "END", { outcome: "TP", pnl });
          logs.push(`[${base}] TP HIT — PNL $${pnl.toFixed(2)}`);
          continue;
        }

        if (slHitLong || slHitShort) {
          const exitPrice = stop_loss;
          const pnl = direction === "LONG"
            ? exitPrice - entry_price
            : entry_price - exitPrice;
          await updateSignalState(id!, "END", { outcome: "SL", pnl });
          logs.push(`[${base}] SL HIT — PNL $${pnl.toFixed(2)}`);
          continue;
        }

        // FIX 2: Smarter CONFIRMED — 2 closes holding + momentum (last close > prev close)
        if (state === "EARLY") {
          const recent = candles.slice(-3);
          const closes = recent.map((c) => c.close);
          const lastClose = closes[closes.length - 1];
          const prevClose = closes[closes.length - 2];

          const closesHolding =
            direction === "LONG"
              ? closes.slice(0, -1).filter((c) => c > entry_price * 0.999).length >= 2
              : closes.slice(0, -1).filter((c) => c < entry_price * 1.001).length >= 2;

          const hasMomentum =
            direction === "LONG" ? lastClose > prevClose : lastClose < prevClose;

          if (closesHolding && hasMomentum) {
            const newConfidence = Math.min(95, signal.confidence + 15);
            await updateSignalState(id!, "CONFIRMED", { confidence: newConfidence });
            logs.push(`[${base}] EARLY → CONFIRMED (confidence: ${newConfidence}%)`);
            confirmed.push({ ...signal, state: "CONFIRMED", confidence: newConfidence });
          } else {
            logs.push(`[${base}] EARLY — holding: ${closesHolding}, momentum: ${hasMomentum}`);
          }
        } else {
          logs.push(`[${base}] CONFIRMED — position active`);
        }
      } catch (err) {
        logs.push(`[POSITIONS] Error for ${signal.symbol}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } catch (err) {
    logs.push(`[POSITIONS] Outer error: ${err instanceof Error ? err.message : String(err)}`);
  }

  return { logs, confirmed };
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
