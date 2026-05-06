import { supabase } from "@/lib/supabase-client";
import { fetchCandles, type Candle } from "./kraken";
import { calculateStopLoss, calculateTakeProfit, calculateRiskReward, calculateVolatility } from "./risk-utils";
import { sendTradeCloseAlert } from "./telegram";

export type SignalDirection = "LONG" | "SHORT";
export type SignalState = "EARLY" | "CONFIRMED" | "END";
export type SignalOutcome = "TP" | "SL" | "EXPIRED" | "MANUAL";

/**
 * Calculate ADX (Average Directional Index) for trend strength.
 * ADX > 25 = strong trend, ADX < 20 = weak trend/ranging
 * Returns value 0-100.
 */
function calculateADX(candles: Candle[]): number {
  if (candles.length < 14) return 0; // Need at least 14 candles for ADX

  // Calculate +DM, -DM, TR over last 14 periods
  let plusDM = 0, minusDM = 0, tr = 0;

  for (let i = 1; i < Math.min(candles.length, 14); i++) {
    const curr = candles[i];
    const prev = candles[i - 1];

    // True Range
    const hl = curr.high - curr.low;
    const hc = Math.abs(curr.high - prev.close);
    const lc = Math.abs(curr.low - prev.close);
    tr += Math.max(hl, hc, lc);

    // Directional Movement
    const upMove = curr.high - prev.high;
    const downMove = prev.low - curr.low;

    if (upMove > 0 && upMove > downMove) {
      plusDM += upMove;
    } else if (downMove > 0 && downMove > upMove) {
      minusDM += downMove;
    }
  }

  const atr = tr / 14;
  const plusDI = atr > 0 ? (plusDM / atr) * 100 : 0;
  const minusDI = atr > 0 ? (minusDM / atr) * 100 : 0;

  const di = Math.abs(plusDI - minusDI) / (plusDI + minusDI || 1);
  const adx = Math.min(100, di * 100); // Simplified ADX

  return Math.round(adx * 10) / 10;
}



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
  breakout_candle_time?: number; // Unix timestamp of candle when breakout occurred
  prev_candle_close?: number; // Close price of candle BEFORE breakout (for validation)
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
  dataSource?: "KRAKEN" | "COINGECKO" | "CACHE"; // Track which data source was used
  dataSourceTime?: number; // Unix timestamp of when data was fetched
  adx?: number; // Average Directional Index for trend strength (0-100)
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

    // Fetch recently ended signals (last 4 hours) to implement cooldown
    const fourHoursAgo = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();
    const { data: recentEnded, error: recentError } = await supabase
      .from("signals")
      .select("*")
      .eq("state", "END")
      .gte("updated_at", fourHoursAgo)
      .in("outcome", ["MANUAL", "EXPIRED"]);

    if (recentError) {
      logs.push(`[SUPABASE] Error fetching recently ended signals: ${recentError.message}`);
    }

    // Fetch recent telegram alerts to prevent spam (last 2 hours)
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const { data: recentAlerts, error: alertError } = await supabase
      .from("telegram_alerts")
      .select("signal_id, symbol, state, sent_at")
      .gte("sent_at", twoHoursAgo);

    if (alertError) {
      logs.push(`[SUPABASE] Error fetching recent alerts: ${alertError.message}`);
    }

    // Safe duplicate check: only block if symbol has an active (non-END) signal
    const activeBySymbol = new Map<string, Signal>(
      (activeRows ?? []).map((s: Signal) => [s.symbol, s])
    );

    // Map of symbol+direction+breakout_level combos on cooldown (fired in last 4h)
    const cooldownKey = (symbol: string, direction: string, level: number) => 
      `${symbol}:${direction}:${level.toFixed(2)}`;
    
    const cooldownSet = new Set<string>(
      (recentEnded ?? []).map((s: Signal) => cooldownKey(s.symbol, s.direction, s.breakout_level))
    );

    // Track breakout events to prevent duplicate signals from same breakout
    // Key: symbol + direction + breakout_level, Value: breakout_candle_time
    const breakoutEventMap = new Map<string, number>(
      (activeRows ?? [])
        .filter((s: Signal) => s.direction && s.breakout_level && s.breakout_candle_time)
        .map((s: Signal) => [
          `${s.symbol}:${s.direction}:${s.breakout_level.toFixed(2)}`,
          s.breakout_candle_time!
        ])
    );

    // Track symbols with recent alerts to prevent duplicate notifications
    const recentAlertSymbols = new Set<string>(
      (recentAlerts ?? [])
        .filter((a: any) => a.state === "EARLY")
        .map((a: any) => a.symbol)
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
        let existing = activeBySymbol.get(symbol);
        if (existing) {
          // For LONG: expire if price drops BELOW the breakout level
          // For SHORT: expire if price rises ABOVE the breakout level
          const shouldExpire = 
            existing.direction === "LONG" 
              ? price < existing.breakout_level
              : price > existing.breakout_level;

          if (shouldExpire) {
            await updateSignalState(existing.id!, "END", { outcome: "EXPIRED" });
            logs.push(`[${base}] Expired ${existing.direction} signal — price ${existing.direction === "LONG" ? "dropped below" : "rose above"} breakout level $${existing.breakout_level.toFixed(2)}`);
            // Clear the existing signal so we can create a new opposite-direction one
            existing = undefined;
          } else {
            // Signal still valid, check staleness
            const ageMs = Date.now() - new Date(existing.created_at!).getTime();
            const isStaleEarly = existing.state === "EARLY" && ageMs > 60 * 60 * 1000;

            if (isStaleEarly) {
              await updateSignalState(existing.id!, "END", { outcome: "EXPIRED" });
              logs.push(`[${base}] Expired stale EARLY signal (${Math.round(ageMs / 60000)}m old) — allowing new signal`);
              existing = undefined;
            } else {
              logs.push(`[${base}] Active signal exists (${existing.state}) — skipping creation`);
              signals.push(existing);
              continue; // IMPORTANT: Skip to next symbol
            }
          }
        }

        // FIX: Check for recent alert spam — don't fire if alert sent in last 2 hours
        if (recentAlertSymbols.has(symbol)) {
          logs.push(`[${base}] Alert already sent in last 2h — skipping to prevent spam`);
          continue;
        }

        // LONG: price broke above a 3-touch resistance level (EVENT-BASED)
        if (setup === "LONG_SETUP") {
          const breakoutLevel = swingHigh ?? price;
          const currentCandle = candles4h[candles4h.length - 1];
          const prevCandle = candles4h.length > 1 ? candles4h[candles4h.length - 2] : null;
          
          // EVENT DETECTION: Previous candle was at/below breakout level, current candle closed above
          const prevClosed = prevCandle?.close ?? 0;
          const currClosed = currentCandle.close;
          
          // Check if this is a fresh breakout event (not stale)
          const breakoutOccurred = prevClosed <= breakoutLevel && currClosed > breakoutLevel * (1 + volatilityThreshold);
          
          if (!breakoutOccurred) {
            logs.push(`[${base}] LONG skipped — not a fresh breakout event (prev: $${prevClosed.toFixed(2)}, curr: $${currClosed.toFixed(2)}, level: $${breakoutLevel.toFixed(2)})`);
            continue;
          }

          // FRESHNESS CHECK: Don't fire if breakout happened too long ago
          // If we're on candle 95 and breakout was on candle 85, it's 10 candles old = stale
          const breakoutCandleAge = candles4h.length - 1; // Current is last candle (0-indexed)
          if (breakoutCandleAge > 10) {
            logs.push(`[${base}] LONG skipped — breakout is stale (${breakoutCandleAge} candles old, max 10)`);
            continue;
          }

          // DUPLICATE PREVENTION: Check if same breakout event already created a signal
          const eventKey = `${symbol}:LONG:${breakoutLevel.toFixed(2)}`;
          const existingBreakoutTime = breakoutEventMap.get(eventKey);
          if (existingBreakoutTime && currentCandle.time === existingBreakoutTime) {
            logs.push(`[${base}] LONG skipped — signal already exists for this breakout event at candle time ${currentCandle.time}`);
            continue;
          }

          // DUPLICATE PREVENTION: Check if same breakout event already created a signal
          const eventKey = `${symbol}:SHORT:${breakoutLevel.toFixed(2)}`;
          const existingBreakoutTime = breakoutEventMap.get(eventKey);
          if (existingBreakoutTime && currentCandle.time === existingBreakoutTime) {
            logs.push(`[${base}] SHORT skipped — signal already exists for this breakout event at candle time ${currentCandle.time}`);
            continue;
          }
          
          // Check cooldown: don't fire same setup twice within 4 hours
          const key = cooldownKey(symbol, "SHORT", breakoutLevel);
          if (cooldownSet.has(key)) {
            logs.push(`[${base}] SHORT on cooldown — fired within last 4h at $${breakoutLevel.toFixed(2)}`);
            continue;
          }

          // If there's an active signal in the opposite direction, don't create another
          if (existing && existing.direction === "SHORT") {
            logs.push(`[${base}] LONG skipped — active SHORT signal exists`);
            continue;
          }

          const sl = calculateStopLoss(price, swingLow, "LONG");
          const tp = calculateTakeProfit(price, sl, "LONG");
          const rr = calculateRiskReward(price, tp, sl, "LONG");

          // Filter low-quality trades (RR < 1.5)
          if (rr < 1.5) {
            logs.push(`[${base}] LONG skipped — RR ${rr.toFixed(2)} < 1.5 threshold`);
            continue;
          }

          // Filter weak breakouts using ADX (trend strength)
          // ADX < 20 = ranging/consolidation, likely false breakout
          if (market.adx !== undefined && market.adx < 20) {
            logs.push(`[${base}] LONG skipped — ADX ${market.adx.toFixed(1)} < 20 (weak trend, likely false breakout)`);
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
            breakout_candle_time: currentCandle.time,
            prev_candle_close: prevClosed,
          };

          const { data: inserted, error: insertErr } = await supabase
            .from("signals")
            .insert([newSignal])
            .select()
            .single();

          if (insertErr) {
            logs.push(`[${base}] Insert LONG failed: ${insertErr.message}`);
          } else {
            logs.push(`[${base}] ✓ Created LONG EARLY (FRESH BREAKOUT) at $${price.toFixed(2)} | SL $${sl.toFixed(2)} | TP $${tp.toFixed(2)} | RR ${rr.toFixed(2)}`);
            signals.push(inserted);
            recentAlertSymbols.add(symbol); // Mark as just-alerted
          }

        // SHORT: price broke below a 3-touch support level (EVENT-BASED)
        } else if (setup === "SHORT_SETUP") {
          const breakoutLevel = swingLow ?? price;
          const currentCandle = candles4h[candles4h.length - 1];
          const prevCandle = candles4h.length > 1 ? candles4h[candles4h.length - 2] : null;
          
          // EVENT DETECTION: Previous candle was at/above breakout level, current candle closed below
          const prevClosed = prevCandle?.close ?? 0;
          const currClosed = currentCandle.close;
          
          // Check if this is a fresh breakout event (not stale)
          const breakoutOccurred = prevClosed >= breakoutLevel && currClosed < breakoutLevel * (1 - volatilityThreshold);
          
          if (!breakoutOccurred) {
            logs.push(`[${base}] SHORT skipped — not a fresh breakout event (prev: $${prevClosed.toFixed(2)}, curr: $${currClosed.toFixed(2)}, level: $${breakoutLevel.toFixed(2)})`);
            continue;
          }

          // FRESHNESS CHECK: Don't fire if breakout happened too long ago
          const breakoutCandleAge = candles4h.length - 1;
          if (breakoutCandleAge > 10) {
            logs.push(`[${base}] SHORT skipped — breakout is stale (${breakoutCandleAge} candles old, max 10)`);
            continue;
          }
          
          // Check cooldown: don't fire same setup twice within 4 hours
          const key = cooldownKey(symbol, "SHORT", breakoutLevel);
          if (cooldownSet.has(key)) {
            logs.push(`[${base}] SHORT on cooldown — fired within last 4h at $${breakoutLevel.toFixed(2)}`);
            continue;
          }

          // If there's an active signal in the opposite direction, don't create another
          if (existing && existing.direction === "LONG") {
            logs.push(`[${base}] SHORT skipped — active LONG signal exists`);
            continue;
          }

          const sl = calculateStopLoss(price, swingHigh, "SHORT");
          const tp = calculateTakeProfit(price, sl, "SHORT");
          const rr = calculateRiskReward(price, tp, sl, "SHORT");

          // Filter low-quality trades (RR < 1.5)
          if (rr < 1.5) {
            logs.push(`[${base}] SHORT skipped — RR ${rr.toFixed(2)} < 1.5 threshold`);
            continue;
          }

          // Filter weak breakouts using ADX (trend strength)
          if (market.adx !== undefined && market.adx < 20) {
            logs.push(`[${base}] SHORT skipped — ADX ${market.adx.toFixed(1)} < 20 (weak trend, likely false breakout)`);
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
            breakout_candle_time: currentCandle.time,
            prev_candle_close: prevClosed,
          };

          const { data: inserted, error: insertErr } = await supabase
            .from("signals")
            .insert([newSignal])
            .select()
            .single();

          if (insertErr) {
            logs.push(`[${base}] Insert SHORT failed: ${insertErr.message}`);
          } else {
            logs.push(`[${base}] ✓ Created SHORT EARLY (FRESH BREAKOUT) at $${price.toFixed(2)} | SL $${sl.toFixed(2)} | TP $${tp.toFixed(2)} | RR ${rr.toFixed(2)}`);
            signals.push(inserted);
            recentAlertSymbols.add(symbol); // Mark as just-alerted
          }

          // If there's an active signal in the opposite direction, don't create another
          if (existing && existing.direction === "SHORT") {
            logs.push(`[${base}] LONG skipped — active SHORT signal exists`);
            continue;
          }

          // Require close at least 0.5% above breakout level to avoid whipsaw
          const distAboveBreakout = ((price - breakoutLevel) / breakoutLevel) * 100;
          if (distAboveBreakout < 0.5) {
            logs.push(`[${base}] LONG skipped — only ${distAboveBreakout.toFixed(2)}% above breakout, need 0.5%`);
            continue;
          }

          const sl = calculateStopLoss(price, swingLow, "LONG");
          const tp = calculateTakeProfit(price, sl, "LONG");
          const rr = calculateRiskReward(price, tp, sl, "LONG");

          // Filter low-quality trades (RR < 1.5)
          if (rr < 1.5) {
            logs.push(`[${base}] LONG skipped — RR ${rr.toFixed(2)} < 1.5 threshold`);
            continue;
          }

          // NEW: Filter weak breakouts using ADX (trend strength)
          // ADX < 20 = ranging/consolidation, likely false breakout
          if (market.adx !== undefined && market.adx < 20) {
            logs.push(`[${base}] LONG skipped — ADX ${market.adx.toFixed(1)} < 20 (weak trend, likely false breakout)`);
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
            logs.push(`[${base}] ✓ Created LONG EARLY at $${price.toFixed(2)} | SL $${sl.toFixed(2)} | TP $${tp.toFixed(2)} | RR ${rr.toFixed(2)}`);
            signals.push(inserted);
            recentAlertSymbols.add(symbol); // Mark as just-alerted
          }

        // SHORT: price broke below a 3-touch support level
        } else if (setup === "SHORT_SETUP") {
          const breakoutLevel = swingLow ?? price;
          
          // Check cooldown: don't fire same setup twice within 4 hours
          const key = cooldownKey(symbol, "SHORT", breakoutLevel);
          if (cooldownSet.has(key)) {
            logs.push(`[${base}] SHORT on cooldown — fired within last 4h at $${breakoutLevel.toFixed(2)}`);
            continue;
          }

          // If there's an active signal in the opposite direction, don't create another
          if (existing && existing.direction === "LONG") {
            logs.push(`[${base}] SHORT skipped — active LONG signal exists`);
            continue;
          }

          // Require at least 1% below support level before SHORT fires
          const distBelowBreakout = ((breakoutLevel - price) / breakoutLevel) * 100;
          if (distBelowBreakout < 1) {
            logs.push(`[${base}] SHORT skipped — only ${distBelowBreakout.toFixed(2)}% below breakout, need 1%`);
            continue;
          }

          // Require close at least 0.5% below breakout level to avoid whipsaw
          if (distBelowBreakout < 0.5) {
            logs.push(`[${base}] SHORT skipped — only ${distBelowBreakout.toFixed(2)}% below breakout, need 0.5%`);
            continue;
          }

          const sl = calculateStopLoss(price, swingHigh, "SHORT");
          const tp = calculateTakeProfit(price, sl, "SHORT");
          const rr = calculateRiskReward(price, tp, sl, "SHORT");

          // Filter low-quality trades (RR < 1.5)
          if (rr < 1.5) {
            logs.push(`[${base}] SHORT skipped — RR ${rr.toFixed(2)} < 1.5 threshold`);
            continue;
          }

          // NEW: Filter weak breakouts using ADX (trend strength)
          // ADX < 20 = ranging/consolidation, likely false breakout
          if (market.adx !== undefined && market.adx < 20) {
            logs.push(`[${base}] SHORT skipped — ADX ${market.adx.toFixed(1)} < 20 (weak trend, likely false breakout)`);
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
            logs.push(`[${base}] ✓ Created SHORT EARLY at $${price.toFixed(2)} | SL $${sl.toFixed(2)} | TP $${tp.toFixed(2)} | RR ${rr.toFixed(2)}`);
            signals.push(inserted);
            recentAlertSymbols.add(symbol); // Mark as just-alerted
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
      const base = signal.symbol.replace("/USD", "");
      try {
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

        // Improvement 2: Strict CONFIRMED validation — structure + momentum only
        if (state === "EARLY") {
          const recent = candles.slice(-4);
          const closes = recent.map((c) => c.close);
          const lastClose = closes[closes.length - 1];
          const prevClose = closes[closes.length - 2];
          const prev2Close = closes[closes.length - 3];

          // Requirement 1: Must still be beyond breakout level
          const aboveBreakout = direction === "LONG" && lastClose > signal.breakout_level * 0.999;
          const belowBreakout = direction === "SHORT" && lastClose < signal.breakout_level * 1.001;
          const breakoutValid = aboveBreakout || belowBreakout;

          // Requirement 2: Two consecutive candles moving in same direction
          const twoConsecutiveUp = direction === "LONG" && lastClose > prevClose && prevClose > prev2Close;
          const twoConsecutiveDown = direction === "SHORT" && lastClose < prevClose && prevClose < prev2Close;
          const hasConsecutiveMomentum = twoConsecutiveUp || twoConsecutiveDown;

          // Requirement 3: Move strength between last two closes > 0.3%
          const moveStrength = Math.abs(lastClose - prevClose) / prevClose;
          const hasStrongMomentum = moveStrength > 0.003;

          logs.push(
            `[${base}] EARLY validation: ` +
            `breakoutValid=${breakoutValid} (${lastClose.toFixed(2)} ${direction === "LONG" ? ">" : "<"} ${signal.breakout_level.toFixed(2)}), ` +
            `consecutive=${hasConsecutiveMomentum} (${prev2Close.toFixed(2)}→${prevClose.toFixed(2)}→${lastClose.toFixed(2)}), ` +
            `moveStr=${(moveStrength * 100).toFixed(3)}% (need >0.3%)`
          );

          // ALL THREE conditions must be met for confirmation
          if (breakoutValid && hasConsecutiveMomentum && hasStrongMomentum) {
            const newConfidence = Math.min(95, signal.confidence + 15);
            await updateSignalState(id!, "CONFIRMED", {
              confidence: newConfidence,
              last_checked_candle: candleTs,
            });
            logs.push(`[${base}] EARLY → CONFIRMED (confidence: ${newConfidence}%, structure+momentum validated, move: ${(moveStrength * 100).toFixed(2)}%)`);
            confirmed.push({ ...signal, state: "CONFIRMED", confidence: newConfidence });
          } else {
            await updateSignalState(id!, "EARLY", { last_checked_candle: candleTs });
            logs.push(`[${base}] EARLY — awaiting: breakout=${breakoutValid}, consecutive=${hasConsecutiveMomentum}, move=${(moveStrength * 100).toFixed(3)}%`);
          }
        } else if (state === "CONFIRMED") {
          // FIX 4: Skip all confirmation logic for CONFIRMED signals — only check TP/SL
          await updateSignalState(id!, "CONFIRMED", { last_checked_candle: candleTs });
          logs.push(`[${base}] CONFIRMED — position active (no re-evaluation)`);
        }
      } catch (err) {
        logs.push(`[${base}] ✗ Error during position management: ${err instanceof Error ? err.message : String(err)} — skipping this signal`);
        // Continue to next signal instead of crashing
        continue;
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
    // Explicitly select only active states (EARLY, CONFIRMED) to exclude END signals
    const { data, error } = await supabase
      .from("signals")
      .select("*")
      .in("state", ["EARLY", "CONFIRMED"])
      .order("created_at", { ascending: false });

    if (error) {
      console.error("[getAllSignals] Query error:", error);
      return [];
    }

    console.log("[getAllSignals] Returned", data?.length ?? 0, "active signals:", data?.map(s => ({ id: s.id, symbol: s.symbol, direction: s.direction, state: s.state })));

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

// Price cache for fallback when API fails
const priceCache = new Map<string, { price: number; timestamp: number }>();

export async function getMarketContext(symbolBase: string): Promise<MarketContext> {
  const symbol = `${symbolBase}/USD`;
  let dataSource: "KRAKEN" | "COINGECKO" | "CACHE" = "KRAKEN";
  let dataSourceTime = Date.now();
  
  try {
    let candles4h: Candle[] = [];
    
    // Fetch candles with dedicated error handling
    try {
      const result = await fetchCandles(symbolBase, 240, 100);
      candles4h = result.candles;
      dataSource = result.source;
      dataSourceTime = result.timestamp;
    } catch (err) {
      console.error(`[${symbolBase}] ✗ Candle fetch failed:`, err instanceof Error ? err.message : String(err));
      
      // FALLBACK: Use cached price if available (within 1 hour)
      const cached = priceCache.get(symbol);
      const now = Date.now();
      if (cached && (now - cached.timestamp) < 3600000) {
        console.log(`[${symbolBase}] Using cached price: $${cached.price.toFixed(2)}`);
        return {
          symbol,
          price: cached.price,
          swingHigh: null,
          swingLow: null,
          distanceToHigh: null,
          distanceToLow: null,
          setup: "NO_SETUP",
          setupText: "API unavailable — using cached data",
          error: false,
          trendlines: 0,
          dataSource: "CACHE",
          dataSourceTime: cached.timestamp,
        };
      }
      
      // No cache available — return zero price but don't mark as error
      console.log(`[${symbolBase}] No cached data available`);
      return {
        symbol,
        price: 0,
        swingHigh: null,
        swingLow: null,
        distanceToHigh: null,
        distanceToLow: null,
        setup: "NO_SETUP",
        setupText: "Data loading...",
        error: false,
        trendlines: 0,
      };
    }

    if (!candles4h.length) {
      return {
        symbol,
        price: 0,
        swingHigh: null,
        swingLow: null,
        distanceToHigh: null,
        distanceToLow: null,
        setup: "NO_SETUP",
        setupText: "No candle data available",
        error: false,
        trendlines: 0,
      };
    }

    const price = candles4h[candles4h.length - 1].close;
    
    // Cache the price for fallback use
    priceCache.set(symbol, { price, timestamp: Date.now() });

    // Improvement 6: Calculate volatility for dynamic breakout threshold
    const volatility = calculateVolatility(candles4h);
    const volatilityThreshold = volatility > 0.02 ? 0.007 : 0.005; // 0.7% if high, 0.5% if low

    // Find pivots and group into trendlines
    const { highs, lows } = findPivots(candles4h, 2);
    const resistances = groupTouches(highs, 0.005);
    const supports = groupTouches(lows, 0.005);

    const bestResistance = resistances[0];
    const bestSupport = supports[0];

    // DEBUG: Log all detected trendlines for this symbol
    console.log(`[${symbolBase}] Price: $${price.toFixed(2)} | Resistances: ${resistances.map(r => `$${r.level.toFixed(2)}(${r.touches})`).join(", ")} | Supports: ${supports.map(s => `$${s.level.toFixed(2)}(${s.touches})`).join(", ")}`);
    console.log(`[${symbolBase}] Best R: ${bestResistance ? `$${bestResistance.level.toFixed(2)}(${bestResistance.touches})` : "NONE"} | Best S: ${bestSupport ? `$${bestSupport.level.toFixed(2)}(${bestSupport.touches})` : "NONE"}`);
    console.log(`[${symbolBase}] Volatility: ${(volatility * 100).toFixed(2)}% | Threshold: ${(volatilityThreshold * 100).toFixed(2)}%`);
    console.log(`[${symbolBase}] LONG check: price($${price.toFixed(2)}) > resistance($${bestResistance?.level.toFixed(2) ?? "N/A"}) * (1+${volatilityThreshold.toFixed(4)})? ${bestResistance ? (price > bestResistance.level * (1 + volatilityThreshold) ? "YES ✓" : "NO") : "NO RESISTANCE"}`);
    console.log(`[${symbolBase}] SHORT check: price($${price.toFixed(2)}) < support($${bestSupport?.level.toFixed(2) ?? "N/A"}) * (1-${volatilityThreshold.toFixed(4)})? ${bestSupport ? (price < bestSupport.level * (1 - volatilityThreshold) ? "YES ✓" : "NO") : "NO SUPPORT"}`);


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

    // Strict breakout detection: volatility-aware threshold ONLY
    if (bestResistance && price > bestResistance.level * (1 + volatilityThreshold)) {
      setup = "LONG_SETUP";
      setupText = `LONG — broke ${bestResistance.touches}-touch resistance at $${bestResistance.level.toFixed(0)} (+${(volatilityThreshold * 100).toFixed(1)}%)`;
    } else if (bestSupport && price < bestSupport.level * (1 - volatilityThreshold)) {
      setup = "SHORT_SETUP";
      setupText = `SHORT — broke ${bestSupport.touches}-touch support at $${bestSupport.level.toFixed(0)} (-${(volatilityThreshold * 100).toFixed(1)}%)`;
    } else if (bestResistance) {
      const dist = ((bestResistance.level - price) / price) * 100;
      setupText = `${bestResistance.touches}-touch resistance at $${bestResistance.level.toFixed(0)} (${dist.toFixed(1)}% away)`;
    } else if (bestSupport) {
      const dist = ((price - bestSupport.level) / price) * 100;
      setupText = `${bestSupport.touches}-touch support at $${bestSupport.level.toFixed(0)} (${dist.toFixed(1)}% away)`;
    }

    const trendlineCount = (bestResistance ? 1 : 0) + (bestSupport ? 1 : 0);
    
    // Calculate ADX to filter weak breakouts
    const adx = calculateADX(candles4h);

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
      dataSource,
      dataSourceTime,
      adx,
    };
  } catch (err) {
    console.error(`[${symbolBase}] ✗ Unexpected error in getMarketContext:`, err instanceof Error ? err.message : String(err));
    return {
      symbol,
      price: 0,
      swingHigh: null,
      swingLow: null,
      distanceToHigh: null,
      distanceToLow: null,
      setup: "NO_SETUP",
      setupText: "Unexpected error — retrying next cycle",
      error: false,
      trendlines: 0,
      dataSource: "KRAKEN",
      dataSourceTime: Date.now(),
    };
  }
}
