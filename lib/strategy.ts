import { supabase } from "@/lib/supabase-client";
import { fetchCandles, type Candle } from "./kraken";
import { calculateStopLoss, calculateTakeProfit, calculateRiskReward, calculateVolatility } from "./risk-utils";
import { sendTradeCloseAlert } from "./telegram";

export type SignalDirection = "LONG" | "SHORT";
export type SignalState = "EARLY" | "CONFIRMED" | "END";
export type SignalOutcome = "TP" | "SL" | "EXPIRED" | "MANUAL";

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
  outcome?: SignalOutcome | null;
  alert_sent?: boolean;
  last_checked_candle?: number | null;
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
  volatility?: number; // recent high-low / low over past candles
  volatilityThreshold?: number; // dynamic breakout threshold based on volatility
}

// ─── Cleanup expired signals ─────────────────────────────────────────────────

export async function cleanupExpiredSignals(): Promise<{ expired: number; logs: string[] }> {
  const logs: string[] = [];
  let expiredCount = 0;

  if (!supabase) {
    logs.push("[CLEANUP] Supabase not connected");
    return { expired: expiredCount, logs };
  }

  try {
    // Find EARLY signals that haven't been confirmed in 12 candles (~1 hour on 4H)
    const { data: earlySignals, error: fetchErr } = await supabase
      .from("signals")
      .select("*")
      .eq("state", "EARLY")
      .order("created_at", { ascending: false });

    if (fetchErr) {
      logs.push(`[CLEANUP] Query error: ${fetchErr.message}`);
      return { expired: expiredCount, logs };
    }

    for (const signal of earlySignals ?? []) {
      const ageMs = Date.now() - new Date(signal.created_at).getTime();
      const ageCandles = Math.floor(ageMs / (4 * 60 * 60 * 1000)); // 4H candles

      // Expire if >12 candles old without confirmation
      if (ageCandles > 12) {
        await updateSignalState(signal.id, "END", { outcome: "EXPIRED" });
        logs.push(`[CLEANUP] Expired ${signal.symbol} ${signal.direction} signal — ${ageCandles} candles old, never confirmed`);
        expiredCount++;
      }
    }

    if (expiredCount > 0) {
      logs.push(`[CLEANUP] Cleaned up ${expiredCount} expired signals`);
    }
  } catch (err) {
    logs.push(`[CLEANUP] Error: ${err}`);
  }

  return { expired: expiredCount, logs };
}

// ─── Generate signals with risk-reward filtering ────────────────────────────


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

        // Check if an active signal exists and if it should be expired
        const existing = activeBySymbol.get(symbol);
        if (existing) {
          // Calculate retrace distance from breakout level
          const retracePercent = 
            existing.direction === "LONG"
              ? ((existing.breakout_level - price) / price) * 100
              : ((price - existing.breakout_level) / price) * 100;

          // Expire signal if price has retraced >1% through breakout level
          if (retracePercent > 1) {
            await updateSignalState(existing.id!, "END", { outcome: "EXPIRED" });
            logs.push(`[${base}] Expired ${existing.direction} signal — price retraced ${retracePercent.toFixed(2)}% through breakout level`);
            // Fall through to allow new signal in opposite direction
          } else {
            // Signal still valid, check staleness
            const ageMs = Date.now() - new Date(existing.created_at!).getTime();
            const isStaleEarly = existing.state === "EARLY" && ageMs > 60 * 60 * 1000;

            if (isStaleEarly) {
              await updateSignalState(existing.id!, "END", { outcome: "EXPIRED" });
              logs.push(`[${base}] Expired stale EARLY signal (${Math.round(ageMs / 60000)}m old) — allowing new signal`);
            } else {
              logs.push(`[${base}] Active signal exists (${existing.state}) — skipping creation`);
              signals.push(existing);
              continue;
            }
          }
        }

        // LONG: price broke above a 3-touch resistance level
        if (setup === "LONG_SETUP") {
          const breakoutLevel = swingHigh ?? price;
          const sl = calculateStopLoss(price, swingLow, "LONG");
          const tp = calculateTakeProfit(price, sl, "LONG");
          const rr = calculateRiskReward(price, tp, sl, "LONG");

          // Improvement 5: Filter low-quality trades (RR < 1.5)
          if (rr < 1.5) {
            logs.push(`[${base}] LONG skipped — RR ${rr.toFixed(2)} < 1.5 threshold`);
            continue;
          }

          const newSignal = {
            symbol,
            state: "EARLY" as SignalState,
            direction: "LONG" as SignalDirection,
            entry_price: price,
            stop_loss: sl,
            take_profit: tp,
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
            logs.push(`[${base}] Created LONG EARLY at $${price.toFixed(2)} | SL $${sl.toFixed(2)} | TP $${tp.toFixed(2)} | RR ${rr.toFixed(2)}`);
            signals.push(inserted);
          }

        // SHORT: price broke below a 3-touch support level
        } else if (setup === "SHORT_SETUP") {
          const breakoutLevel = swingLow ?? price;
          const sl = calculateStopLoss(price, swingHigh, "SHORT");
          const tp = calculateTakeProfit(price, sl, "SHORT");
          const rr = calculateRiskReward(price, tp, sl, "SHORT");

          // Improvement 5: Filter low-quality trades (RR < 1.5)
          if (rr < 1.5) {
            logs.push(`[${base}] SHORT skipped — RR ${rr.toFixed(2)} < 1.5 threshold`);
            continue;
          }

          const newSignal = {
            symbol,
            state: "EARLY" as SignalState,
            direction: "SHORT" as SignalDirection,
            entry_price: price,
            stop_loss: sl,
            take_profit: tp,
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
            logs.push(`[${base}] Created SHORT EARLY at $${price.toFixed(2)} | SL $${sl.toFixed(2)} | TP $${tp.toFixed(2)} | RR ${rr.toFixed(2)}`);
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

    const SLIPPAGE = 0.001; // 0.1% slippage on fills

    for (const signal of openSignals as Signal[]) {
      try {
        const base = signal.symbol.replace("/USD", "");
        const candles = await fetchCandles(base, 15, 20);
        if (!candles.length) {
          logs.push(`[${base}] No 15m candles`);
          continue;
        }

        const latest = candles[candles.length - 1];
        const candleTs = latest.time; // Unix seconds — unique per candle, used as dedup key

        // FIX 4: Skip if we already processed this exact candle
        if (signal.last_checked_candle === candleTs) {
          logs.push(`[${base}] Candle ${candleTs} already processed — skipping`);
          continue;
        }

        const { entry_price, stop_loss, take_profit, direction, state, id } = signal;

        logs.push(`[${base}] ${state} ${direction} — close $${latest.close.toFixed(2)} H $${latest.high.toFixed(2)} L $${latest.low.toFixed(2)} | TP $${take_profit.toFixed(2)} SL $${stop_loss.toFixed(2)}`);

        // Use candle HIGH/LOW so we never miss a fill between cron intervals
        const tpHitLong  = direction === "LONG"  && latest.high  >= take_profit;
        const tpHitShort = direction === "SHORT" && latest.low   <= take_profit;
        const slHitLong  = direction === "LONG"  && latest.low   <= stop_loss;
        const slHitShort = direction === "SHORT" && latest.high  >= stop_loss;

        if (tpHitLong || tpHitShort) {
          // Direction-aware exit with 0.1% slippage
          const exitPrice = direction === "LONG"
            ? take_profit * (1 - SLIPPAGE)
            : take_profit * (1 + SLIPPAGE);
          const pnl = direction === "LONG"
            ? exitPrice - entry_price
            : entry_price - exitPrice;
          const closeSignal = { ...signal, outcome: "TP" as SignalOutcome, pnl };
          await updateSignalState(id!, "END", { outcome: "TP", pnl });
          // Improvement 3: Send TP close alert
          await sendTradeCloseAlert(closeSignal, exitPrice);
          logs.push(`[${base}] TP HIT — exit $${exitPrice.toFixed(2)} PNL $${pnl.toFixed(2)}`);
          continue;
        }

        if (slHitLong || slHitShort) {
          // Direction-aware exit with 0.1% slippage
          const exitPrice = direction === "LONG"
            ? stop_loss * (1 - SLIPPAGE)
            : stop_loss * (1 + SLIPPAGE);
          const pnl = direction === "LONG"
            ? exitPrice - entry_price
            : entry_price - exitPrice;
          const closeSignal = { ...signal, outcome: "SL" as SignalOutcome, pnl };
          await updateSignalState(id!, "END", { outcome: "SL", pnl });
          // Improvement 3: Send SL close alert
          await sendTradeCloseAlert(closeSignal, exitPrice);
          logs.push(`[${base}] SL HIT — exit $${exitPrice.toFixed(2)} PNL $${pnl.toFixed(2)}`);
          continue;
        }

        // Improvement 2: CONFIRMED requires breakout-level validation + momentum
        if (state === "EARLY") {
          const recent = candles.slice(-3);
          const closes = recent.map((c) => c.close);
          const lastClose = closes[closes.length - 1];
          const prevClose = closes[closes.length - 2];

          // Must be above/below breakout level
          const aboveBreakout = direction === "LONG" && lastClose > signal.breakout_level * 0.999;
          const belowBreakout = direction === "SHORT" && lastClose < signal.breakout_level * 1.001;
          const breakoutValid = aboveBreakout || belowBreakout;

          const closesHolding =
            direction === "LONG"
              ? closes.slice(0, -1).filter((c) => c > entry_price * 0.999).length >= 2
              : closes.slice(0, -1).filter((c) => c < entry_price * 1.001).length >= 2;

          const moveStrength = Math.abs(lastClose - prevClose) / prevClose;
          const hasMomentum =
            direction === "LONG" ? lastClose > prevClose : lastClose < prevClose;

          if (breakoutValid && closesHolding && hasMomentum && moveStrength > 0.002) {
            const newConfidence = Math.min(95, signal.confidence + 15);
            await updateSignalState(id!, "CONFIRMED", {
              confidence: newConfidence,
              last_checked_candle: candleTs,
            });
            logs.push(`[${base}] EARLY → CONFIRMED (confidence: ${newConfidence}%, breakout valid, move: ${(moveStrength * 100).toFixed(2)}%)`);
            confirmed.push({ ...signal, state: "CONFIRMED", confidence: newConfidence });
          } else {
            await updateSignalState(id!, "EARLY", { last_checked_candle: candleTs });
            logs.push(`[${base}] EARLY — breakout: ${breakoutValid}, holding: ${closesHolding}, momentum: ${hasMomentum}, move: ${(moveStrength * 100).toFixed(2)}%`);
          }
        } else {
          // Update last_checked_candle so we don't reprocess
          await updateSignalState(id!, "CONFIRMED", { last_checked_candle: candleTs });
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

    // Improvement 6: Calculate volatility for dynamic breakout threshold
    const volatility = calculateVolatility(candles4h);
    const volatilityThreshold = volatility > 0.02 ? 0.007 : 0.005; // 0.7% if high, 0.5% if low

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

    // Check for breakouts with dynamic volatility-aware threshold
    if (bestResistance && price > bestResistance.level * (1 + volatilityThreshold)) {
      setup = "LONG_SETUP";
      setupText = `LONG — broke ${bestResistance.touches}-touch resistance at $${bestResistance.level.toFixed(0)} (threshold ${(volatilityThreshold * 100).toFixed(1)}%)`;
    } else if (bestSupport && price < bestSupport.level * (1 - volatilityThreshold)) {
      setup = "SHORT_SETUP";
      setupText = `SHORT — broke ${bestSupport.touches}-touch support at $${bestSupport.level.toFixed(0)} (threshold ${(volatilityThreshold * 100).toFixed(1)}%)`;
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
      volatility,
      volatilityThreshold,
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
