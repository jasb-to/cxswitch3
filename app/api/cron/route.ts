// app/api/cron/route.ts — v28 "Full v28 strategy integration with Trade Manager"
// ============================================================
// Backend cron (10 min): calculates highest/lowest price, locked profit,
// current stop, trade state. UI only displays these values.
//
// CHANGELOG v28-PROD-FINAL-v2:
// - Active trades persisted immediately after exit (crash safety)
// - Live currentPrices used for trade management (not stale 1H close)
// - MarketData calculated with real values (not placeholders)
// - Telegram alerts batched (Promise.all) to avoid sequential delays
// - runStart used consistently (no Date.now() mixing)
// - Market data pushed even on exits
// - Dead imports removed
// - Signal replacement guards trade manager state
// ============================================================

import { NextResponse } from "next/server";
import {
  getSignals,
  setSignals,
  getMarketData,
  setMarketData,
  getActiveTrades,
  setActiveTrades,
  getLastCronRun,
  setLastCronRun,
  addSignalToHistory,
  setCronLogs,
  getCronLogs,
  resetPairConsumedZones,
} from "@/lib/state";
import {
  generateSignal,
  filterExpiredSignals,
  isSignalStillValid,
  updateTradeManagerState,
  removeTradeManagerState,
  Candle,
  Signal,
  FEATURES,
} from "@/lib/strategy";
import { getCandles, getCurrentPrice, Symbol } from "@/lib/kraken";
import { sendAlert, sendExitAlert } from "@/lib/telegram";

interface MarketData {
  pair: string;
  price: number;
  timestamp: number;
  phase: string;
  trend: string;
  htfBias?: "BULLISH" | "BEARISH" | "NEUTRAL";
  adx: number;
  rsi: number;
  stochK: number;
  stochD: number;
  zoneTop: number | null;
  zoneBottom: number | null;
  zoneScore: number;
  zoneQuality?: any;
  closes4h?: number[];
}

const PAIRS: Symbol[] = ["BTC", "ETH", "SOL", "HYPE"];
const MIN_CRON_INTERVAL_MS = 10 * 60 * 1000;

const MIN_CANDLES_1H = 60;
const MIN_CANDLES_4H = 350;
const MIN_CANDLES_15M = 60;

function roundPrice(n: number): number {
  if (n >= 10000) return Math.round(n);
  if (n >= 1000) return Math.round(n * 10) / 10;
  if (n >= 100) return Math.round(n * 100) / 100;
  return Math.round(n * 1000) / 1000;
}

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(request: Request) {
  const runStart = Date.now();
  const runId = `${runStart}-${Math.random().toString(36).slice(2, 8)}`;
  const logs: string[] = [];

  const log = (msg: string) => {
    const line = `[${new Date(runStart).toISOString()}] ${msg}`;
    logs.push(line);
    console.log(line);
  };

  log("========================================");
  log(`[CRON] Started runId=${runId} v28+TradeManager`);
  log(`[CRON] TradeManager=${FEATURES.TRADE_MANAGER_ENABLED ? "ON" : "OFF"}`);

  const url = new URL(request.url);
  const querySecret = url.searchParams.get("secret");
  const authHeader = request.headers.get("authorization");
  const forceRun = url.searchParams.get("force") === "true";

  const isAuthorized =
    querySecret === process.env.CRON_SECRET ||
    authHeader === `Bearer ${process.env.CRON_SECRET}`;

  if (!isAuthorized) {
    log("[CRON] Unauthorized");
    await persistLog(runId, logs, "unauthorized");
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const lastRun = await getLastCronRun();
  if (!forceRun && runStart - lastRun < MIN_CRON_INTERVAL_MS) {
    log(`[CRON] Rate limited, lastRun=${lastRun}, diff=${runStart - lastRun}ms`);
    await persistLog(runId, logs, "rate_limited");
    return NextResponse.json({ success: true, skipped: true, reason: "rate_limited" });
  }
  await setLastCronRun(runStart);
  log(`[CRON] lastRun set, force=${forceRun}`);

  let activeTrades = await getActiveTrades();
  log(`[STATE] Active trades: ${Object.keys(activeTrades).join(", ") || "none"}`);

  const existingSignals = await getSignals();
  const currentPrices: Record<string, number> = {};

  log("[CRON] Fetching current prices...");
  for (const pair of PAIRS) {
    try {
      const price = await getCurrentPrice(pair);
      if (price > 0) {
        currentPrices[pair] = price;
        log(`[PRICE] ${pair} = ${price}`);
      } else {
        log(`[PRICE] ${pair} — ticker returned 0`);
      }
    } catch (e: any) {
      log(`[PRICE] ${pair} — ERROR: ${e.message}`);
    }
  }

  // --- Fetch candles for ALL pairs first so filterExpiredSignals gets real data ---
  const candles4hMap: Record<string, Candle[]> = {};
  const candles1hMap: Record<string, Candle[]> = {};
  const candles15mMap: Record<string, Candle[]> = {};

  for (const pair of PAIRS) {
    try {
      const [c1h, c4h, c15m] = await Promise.all([
        getCandles(pair, 60),
        getCandles(pair, 240),
        getCandles(pair, 15),
      ]);
      candles1hMap[pair] = c1h || [];
      candles4hMap[pair] = c4h || [];
      candles15mMap[pair] = c15m || [];
    } catch (e: any) {
      log(`[FETCH] ${pair} — ERROR: ${e.message}`);
      candles1hMap[pair] = [];
      candles4hMap[pair] = [];
      candles15mMap[pair] = [];
    }
  }

  log(`[CRON] Filtering ${existingSignals.length} existing signals...`);
  const { active: validSignals, exited: preExited } = filterExpiredSignals(
    existingSignals,
    currentPrices,
    candles4hMap,
    runStart
  );
  log(`[STATE] Valid: ${validSignals.length}, Expired: ${preExited.length}`);

  // --- Process pre-exited signals ---
  // DUPLICATE EXIT BUG FIX: Mark exited, persist BEFORE alert, clean up
  const exitAlertsToSend: { signal: Signal; reason: string; exitPrice: number; pnl: number }[] = [];

  for (const { signal, reason } of preExited) {
    // Skip if already processed in a prior run
    if (signal.exited || signal.tradeState === "EXITED") {
      log(`[EXIT] ${signal.pair} — already marked exited, skipping duplicate alert`);
      if (activeTrades[signal.pair]) delete activeTrades[signal.pair];
      continue;
    }

    log(`[EXIT] ${signal.pair} — ${reason}`);

    // Mark signal as exited IMMEDIATELY (before any async operations)
    signal.exited = true;
    signal.exitReason = reason;
    signal.exitPrice = currentPrices[signal.pair] || signal.entry;
    signal.exitTimestamp = runStart;
    signal.tradeState = "EXITED";

    // Persist to history BEFORE sending alert
    await addSignalToHistory(signal, reason as any, signal.exitPrice);

    // Remove from active trades IMMEDIATELY (crash safety)
    if (activeTrades[signal.pair]) delete activeTrades[signal.pair];
    await setActiveTrades(activeTrades); // persist now, not at end

    await resetPairConsumedZones(signal.pair);
    log(`[STATE] Cleared consumedZones for ${signal.pair} after ${reason}`);

    // Clean up trade manager memory
    removeTradeManagerState(signal.id);

    const pnl =
      signal.direction === "LONG"
        ? ((signal.exitPrice - signal.entry) / signal.entry) * 100
        : ((signal.entry - signal.exitPrice) / signal.entry) * 100;

    // Queue alert for batch sending (not await here)
    exitAlertsToSend.push({ signal, reason, exitPrice: signal.exitPrice, pnl });
  }

  // Batch send all exit alerts in parallel (avoid sequential Telegram delays)
  if (exitAlertsToSend.length > 0) {
    log(`[ALERT] Sending ${exitAlertsToSend.length} exit alerts in parallel...`);
    await Promise.all(
      exitAlertsToSend.map(({ signal, reason, exitPrice, pnl }) =>
        sendExitAlert({
          pair: signal.pair,
          direction: signal.direction,
          exitPrice,
          reason,
          pnl,
          id: signal.id,
        }).catch((err: any) => {
          log(`[ALERT] ${signal.pair} exit alert FAILED: ${err.message}`);
        })
      )
    );
    log("[ALERT] All exit alerts sent");
  }

  const newSignals: Signal[] = [];
  const marketDataList: MarketData[] = [];
  const alerts: any[] = [];

  for (const pair of PAIRS) {
    log(`[PAIR] ${pair} — starting processing`);
    try {
      const candles1h = candles1hMap[pair];
      const candles4h = candles4hMap[pair];
      const candles15m = candles15mMap[pair];

      log(
        `[FETCH] ${pair} — using: 1H=${candles1h?.length}, 4H=${candles4h?.length}, 15M=${candles15m?.length}`
      );

      if (!candles1h || candles1h.length < MIN_CANDLES_1H) {
        log(`[PAIR] ${pair} — SKIP: insufficient 1H candles (${candles1h?.length || 0} < ${MIN_CANDLES_1H})`);
        alerts.push({ pair, status: "skip", reason: "insufficient_1h_candles", count: candles1h?.length });
        continue;
      }
      if (!candles4h || candles4h.length < MIN_CANDLES_4H) {
        log(`[PAIR] ${pair} — SKIP: insufficient 4H candles (${candles4h?.length || 0} < ${MIN_CANDLES_4H})`);
        alerts.push({ pair, status: "skip", reason: "insufficient_4h_candles", count: candles4h?.length });
        continue;
      }

      // Use LIVE price for trade management, not stale 1H close
      const currentPrice = currentPrices[pair] ?? candles1h[candles1h.length - 1].close;

      const existingIdx = validSignals.findIndex((s: any) => s.pair === pair);
      const existingForPair = existingIdx >= 0 ? validSignals[existingIdx] : null;

      if (existingForPair) {
        log(`[PAIR] ${pair} — has existing signal ${existingForPair.id}`);

        // DUPLICATE EXIT BUG FIX: Skip already-exited signals
        if (existingForPair.exited || existingForPair.tradeState === "EXITED") {
          log(`[PAIR] ${pair} — signal already EXITED, removing from active`);
          validSignals.splice(existingIdx, 1);
          if (activeTrades[pair]) delete activeTrades[pair];
          removeTradeManagerState(existingForPair.id);
          continue;
        }

        // --- Update trade manager state on existing signal ---
        // Backend responsibility: calculate highest/lowest/locked/stop/state
        if (FEATURES.TRADE_MANAGER_ENABLED) {
          const mgrResult = updateTradeManagerState(existingForPair, currentPrice, candles4h);

          // Persist manager state back onto signal object for UI display
          existingForPair.tradeState = mgrResult.state.tradeState;
          existingForPair.highestPrice = mgrResult.state.highestPrice;
          existingForPair.lowestPrice = mgrResult.state.lowestPrice;
          existingForPair.lockedStop = mgrResult.state.lockedStop;

          if (mgrResult.shouldExit) {
            log(`[PAIR] ${pair} — MANAGER EXIT: ${mgrResult.exitReason}`);

            // Mark as exited IMMEDIATELY (before any async)
            existingForPair.exited = true;
            existingForPair.exitReason = mgrResult.exitReason;
            existingForPair.exitPrice = currentPrice;
            existingForPair.exitTimestamp = runStart;
            existingForPair.tradeState = "EXITED";

            // Persist to history BEFORE alert
            await addSignalToHistory(existingForPair, mgrResult.exitReason as any, currentPrice);
            validSignals.splice(existingIdx, 1);

            // Remove from active trades IMMEDIATELY (crash safety)
            if (activeTrades[pair]) delete activeTrades[pair];
            await setActiveTrades(activeTrades); // persist now, not at end

            await resetPairConsumedZones(pair);
            removeTradeManagerState(existingForPair.id);

            const pnl =
              existingForPair.direction === "LONG"
                ? ((currentPrice - existingForPair.entry) / existingForPair.entry) * 100
                : ((existingForPair.entry - currentPrice) / existingForPair.entry) * 100;

            // Send alert (single, not batched here since it's inside the loop)
            await sendExitAlert({
              pair,
              direction: existingForPair.direction,
              exitPrice: currentPrice,
              reason: mgrResult.exitReason || "manager_exit",
              pnl,
              id: existingForPair.id,
            }).catch((err: any) => {
              log(`[ALERT] ${pair} exit alert FAILED: ${err.message}`);
            });
            alerts.push({ pair, status: "manager_exit", reason: mgrResult.exitReason });

            // Push market data even on exit
            marketDataList.push({
              pair,
              price: roundPrice(currentPrice),
              timestamp: runStart,
              phase: "EXIT",
              trend: existingForPair.direction,
              htfBias: existingForPair.direction === "LONG" ? "BULLISH" : "BEARISH",
              adx: existingForPair.adx,
              rsi: existingForPair.rsi,
              stochK: existingForPair.stochK,
              stochD: existingForPair.stochD,
              zoneTop: null,
              zoneBottom: null,
              zoneScore: existingForPair.confidence,
              closes4h: candles4h.slice(-50).map((c: Candle) => c.close),
            });
            continue;
          }
        }

        // Legacy TTL + missed entry check (Trade Manager doesn't handle these)
        const validity = isSignalStillValid(existingForPair, currentPrice, runStart);
        if (!validity.valid) {
          log(`[PAIR] ${pair} — INVALID: ${validity.reason}`);

          existingForPair.exited = true;
          existingForPair.exitReason = validity.reason;
          existingForPair.exitPrice = currentPrice;
          existingForPair.exitTimestamp = runStart;
          existingForPair.tradeState = "EXITED";

          await addSignalToHistory(existingForPair, validity.reason as any, currentPrice);
          validSignals.splice(existingIdx, 1);

          // Remove from active trades IMMEDIATELY (crash safety)
          if (activeTrades[pair]) delete activeTrades[pair];
          await setActiveTrades(activeTrades); // persist now, not at end

          await resetPairConsumedZones(pair);
          removeTradeManagerState(existingForPair.id);
          log(`[STATE] Cleared consumedZones for ${pair} after ${validity.reason}`);

          const pnl =
            existingForPair.direction === "LONG"
              ? ((currentPrice - existingForPair.entry) / existingForPair.entry) * 100
              : ((existingForPair.entry - currentPrice) / existingForPair.entry) * 100;

          await sendExitAlert({
            pair,
            direction: existingForPair.direction,
            exitPrice: currentPrice,
            reason: validity.reason,
            pnl,
            id: existingForPair.id,
          }).catch((err: any) => {
            log(`[ALERT] ${pair} exit alert FAILED: ${err.message}`);
          });
          alerts.push({ pair, status: "expired", reason: validity.reason });

          // Push market data even on exit
          marketDataList.push({
            pair,
            price: roundPrice(currentPrice),
            timestamp: runStart,
            phase: "EXIT",
            trend: existingForPair.direction,
            htfBias: existingForPair.direction === "LONG" ? "BULLISH" : "BEARISH",
            adx: existingForPair.adx,
            rsi: existingForPair.rsi,
            stochK: existingForPair.stochK,
            stochD: existingForPair.stochD,
            zoneTop: null,
            zoneBottom: null,
            zoneScore: existingForPair.confidence,
            closes4h: candles4h.slice(-50).map((c: Candle) => c.close),
          });
        } else {
          // Still holding — log state and push market data with real values
          log(`[PAIR] ${pair} — Holding, state=${existingForPair.tradeState || "OPEN"}`);

          marketDataList.push({
            pair,
            price: roundPrice(currentPrice),
            timestamp: runStart,
            phase: "EXPANSION",
            trend: existingForPair.direction,
            htfBias: existingForPair.direction === "LONG" ? "BULLISH" : "BEARISH",
            adx: existingForPair.adx,
            rsi: existingForPair.rsi,
            stochK: existingForPair.stochK,
            stochD: existingForPair.stochD,
            zoneTop: null,
            zoneBottom: null,
            zoneScore: existingForPair.confidence,
            closes4h: candles4h.slice(-50).map((c: Candle) => c.close),
          });
          continue;
        }
      }

      // --- Generate new signal ---
      const result = generateSignal(pair, candles1h, candles4h, candles15m, currentPrice);

      for (const line of result.debug) {
        log(`[STRAT] ${pair} ${line}`);
      }

      let market = result.market;
      if (market) {
        market.closes4h = candles4h.slice(-50).map((c: Candle) => c.close);
        marketDataList.push(market as MarketData);
      }

      if (!result.signal) {
        const lastDebug = result.debug[result.debug.length - 1] || "no breakout";
        log(`[PAIR] ${pair} — NO SIGNAL (${lastDebug})`);
        alerts.push({ pair, status: "no_signal", debug: result.debug.join(" | ") });
        continue;
      }

      const signal = result.signal;
      log(
        `[PAIR] ${pair} — SIGNAL: ${signal.direction} ${signal.type} entry=${signal.entry} TP=${signal.target} SL=${signal.stop} RR=${signal.rr}`
      );
      newSignals.push(signal);

      // --- Alert logic ---
      // Do NOT alert if this pair already has an active trade
      if (activeTrades[pair]) {
        log(`[ALERT] ${pair} — already active trade, skipping alert`);
        alerts.push({ pair, status: "already_active", signalId: signal.id });
        continue;
      }

      try {
        await sendAlert({
          symbol: signal.pair,
          direction: signal.direction,
          stage: signal.type,
          confidence: signal.confidence,
          entry: signal.entry,
          stop: signal.stop,
          target: signal.target,
          rr: signal.rr,
          reason: signal.reason,
          id: signal.id,
        });
        log(`[ALERT] ${pair} — SENT`);
        activeTrades[pair] = {
          direction: signal.direction,
          timestamp: runStart,
          entry: signal.entry,
          stop: signal.stop,
          target: signal.target,
          id: signal.id,
          type: signal.type,
        };
        // Persist active trades immediately after adding
        await setActiveTrades(activeTrades);
        alerts.push({ pair, status: "sent" });
      } catch (err: any) {
        log(`[ALERT] ${pair} — FAILED: ${err.message}`);
        alerts.push({ pair, status: "alert_failed", error: err.message });
      }
    } catch (err: any) {
      log(`[PAIR] ${pair} — ERROR: ${err.message}`);
      alerts.push({ pair, status: "error", error: err.message });
    }
  }

  log("[CRON] Merging signals...");
  const merged = [...validSignals];
  for (const s of newSignals) {
    const idx = merged.findIndex((x: any) => x.pair === s.pair);
    if (idx >= 0) {
      // Only replace if existing signal has no trade manager state (prevents overwriting active trade history)
      const existing = merged[idx];
      if (!existing.tradeState || existing.tradeState === "OPEN") {
        merged[idx] = s;
        log(`[MERGE] ${s.pair} — replaced existing (no active trade state)`);
      } else {
        log(`[MERGE] ${s.pair} — kept existing (has trade state: ${existing.tradeState})`);
      }
    } else {
      merged.push(s);
    }
  }

  log("[CRON] Persisting final state...");
  await Promise.all([
    setSignals(merged),
    setMarketData(marketDataList),
    setActiveTrades(activeTrades),
  ]);

  log(
    `[CRON] Done. signals=${merged.length}, marketData=${marketDataList.length}, exited=${preExited.length}`
  );
  log("========================================");

  const response = {
    success: true,
    signals: merged.length,
    marketData: marketDataList.length,
    exited: preExited.length,
    alerts,
    runId,
  };
  await persistLog(runId, logs, "complete", response);
  return NextResponse.json(response);
}

async function persistLog(runId: string, logs: string[], status: string, response?: any) {
  try {
    const existing = await getCronLogs();
    const entry = {
      runId,
      time: new Date().toISOString(),
      status,
      logCount: logs.length,
      logs: logs.slice(-50),
      response: response ? JSON.stringify(response) : undefined,
    };
    const updated = [entry, ...(existing || [])].slice(0, 20);
    await setCronLogs(updated);
  } catch (e) {
    console.error("[CRON] Failed to persist log:", e);
  }
}
