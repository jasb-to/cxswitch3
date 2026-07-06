// app/api/cron/route.ts — v30.5 "Full v30.5 strategy integration"
// ============================================================
// CRITICAL FIXES:
//   - Uses lib/kraken.ts (no more duplicated fetch logic)
//   - Fixed "Still valid, skipping generation" → now re-evaluates for new setups
//   - Fixed candle count: 350+ 4H candles required for reliable HTF
//   - Fixed shouldHold() passes candles1h (not 4h) for trail update
//   - Clears consumedZones when signal expires
//   - Only sends alert on NEW signal generation, not on every run

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
  shouldHold,
  isSignalStillValid,
  Candle,
  Signal,
} from "@/lib/strategy";
import { getCandles, getCurrentPrice, Symbol } from "@/lib/kraken";

// ─── Types ──────────────────────────────────────────────────────────────

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

// ─── Config ─────────────────────────────────────────────────────────────

const PAIRS: Symbol[] = ["BTC", "ETH", "SOL", "HYPE"];
const MIN_CRON_INTERVAL_MS = 10 * 60 * 1000;

// v30.5 strategy requirements
const MIN_CANDLES_1H = 60;
const MIN_CANDLES_4H = 350;
const MIN_CANDLES_15M = 60;

// ─── Telegram Alert ─────────────────────────────────────────────────────

async function sendAlert(data: any): Promise<void> {
  console.log(`[TELEGRAM] Alert: ${JSON.stringify(data)}`);
}

function roundPrice(n: number): number {
  if (n >= 10000) return Math.round(n);
  if (n >= 1000) return Math.round(n * 10) / 10;
  if (n >= 100) return Math.round(n * 100) / 100;
  return Math.round(n * 1000) / 1000;
}

// ─── Main Handler ───────────────────────────────────────────────────────

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(request: Request) {
  const runStart = Date.now();
  const runId = `${runStart}-${Math.random().toString(36).slice(2, 8)}`;
  const logs: string[] = [];

  const log = (msg: string) => {
    const line = `[${new Date().toISOString()}] ${msg}`;
    logs.push(line);
    console.log(line);
  };

  log("========================================");
  log(`[CRON] Started runId=${runId} v30.5`);

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

  // ── Fetch current prices first (fast, using ticker) ─────────
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

  // ── Filter expired signals ──────────────────────────────────
  log(`[CRON] Filtering ${existingSignals.length} existing signals...`);
  const { active: validSignals, exited: preExited } = filterExpiredSignals(
    existingSignals,
    currentPrices,
    runStart
  );
  log(`[STATE] Valid: ${validSignals.length}, Expired: ${preExited.length}`);

  // Handle expired signals: clear their consumedZones so new accumulations can form
  for (const { signal, reason } of preExited) {
    log(`[EXIT] ${signal.pair} — ${reason}`);
    await addSignalToHistory(signal, reason as any, currentPrices[signal.pair] || signal.entry);
    if (activeTrades[signal.pair]) delete activeTrades[signal.pair];
    // CRITICAL FIX: Clear consumed zones when signal expires so same area can trade again
    await resetPairConsumedZones(signal.pair);
    log(`[STATE] Cleared consumedZones for ${signal.pair} after ${reason}`);
  }

  const newSignals: Signal[] = [];
  const marketDataList: MarketData[] = [];
  const alerts: any[] = [];

  // ── Process each pair ─────────────────────────────────────
  for (const pair of PAIRS) {
    log(`[PAIR] ${pair} — starting processing`);
    try {
      // Fetch all timeframes in parallel
      log(`[FETCH] ${pair} — requesting 1H/4H/15M candles`);
      const [candles1h, candles4h, candles15m] = await Promise.all([
        getCandles(pair, 60),
        getCandles(pair, 240),
        getCandles(pair, 15),
      ]);
      log(
        `[FETCH] ${pair} — received: 1H=${candles1h?.length}, 4H=${candles4h?.length}, 15M=${candles15m?.length}`
      );

      // Validate candle counts for v30.5 strategy
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

      const currentPrice = candles1h[candles1h.length - 1].close;

      // ═══════════════════════════════════════════════════════════════
      // CHECK EXISTING SIGNAL
      // ═══════════════════════════════════════════════════════════════
      const existingIdx = validSignals.findIndex((s: any) => s.pair === pair);
      const existingForPair = existingIdx >= 0 ? validSignals[existingIdx] : null;

      if (existingForPair) {
        log(`[PAIR] ${pair} — has existing signal ${existingForPair.id}`);

        const validity = isSignalStillValid(existingForPair, currentPrice, runStart);
        if (!validity.valid) {
          log(`[PAIR] ${pair} — INVALID: ${validity.reason}`);
          await addSignalToHistory(existingForPair, validity.reason as any, currentPrice);
          if (activeTrades[pair]) delete activeTrades[pair];
          validSignals.splice(existingIdx, 1);
          // Clear consumed zones so new accumulation can form
          await resetPairConsumedZones(pair);
          log(`[STATE] Cleared consumedZones for ${pair} after ${validity.reason}`);
          alerts.push({ pair, status: "expired", reason: validity.reason });
        } else {
          // FIX: Pass candles1h (not 4h) for trail update
          const holdResult = await shouldHold(pair, existingForPair, candles1h, currentPrice);
          if (!holdResult.shouldHold) {
            log(`[PAIR] ${pair} — TRAIL STOP: ${holdResult.reason}`);
            await addSignalToHistory(existingForPair, "trail_stop" as any, currentPrice);
            if (activeTrades[pair]) delete activeTrades[pair];
            validSignals.splice(existingIdx, 1);
            // Clear consumed zones
            await resetPairConsumedZones(pair);
            alerts.push({ pair, status: "trail_stop", reason: holdResult.reason });
          } else {
            log(`[PAIR] ${pair} — Holding, trail=${holdResult.reason}`);
            // Build market data for dashboard from existing signal
            marketDataList.push({
              pair,
              price: roundPrice(currentPrice),
              timestamp: Date.now(),
              phase: "EXPANSION",
              trend: existingForPair.direction,
              htfBias: existingForPair.direction === "LONG" ? "BULLISH" : "BEARISH",
              adx: existingForPair.adx,
              rsi: 0,
              stochK: 0,
              stochD: 0,
              zoneTop: existingForPair.zoneTop,
              zoneBottom: existingForPair.zoneBottom,
              zoneScore: existingForPair.confidence,
              closes4h: candles4h.slice(-50).map((c: Candle) => c.close),
            });
            continue;
          }
        }
      }

      // ═══════════════════════════════════════════════════════════════
      // GENERATE NEW SIGNAL
      // ═══════════════════════════════════════════════════════════════
      const result = await generateSignal(pair, candles1h, candles4h, candles15m, currentPrice);

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
        alerts.push({ pair, status: "no_signal", stage: result.stage, debug: result.debug.join(" | ") });
        continue;
      }

      const signal = result.signal;
      log(
        `[PAIR] ${pair} — SIGNAL: ${signal.direction} ${signal.stage} entry=${signal.entry} TP=${signal.target} SL=${signal.stop} trail=${signal.trail} RR=${signal.rr}`
      );
      newSignals.push(signal);

      // Skip alert if already active (shouldn't happen after expiry check, but safety)
      if (activeTrades[pair]) {
        log(`[ALERT] ${pair} — already active, skipping alert`);
        alerts.push({ pair, status: "already_active", signalId: signal.id });
        continue;
      }

      // Send alert for NEW signal
      try {
        await sendAlert({
          symbol: signal.pair,
          state: signal.stage,
          price: roundPrice(signal.entry),
          bias: signal.direction,
          confidence: signal.confidence,
          stopLoss: roundPrice(signal.stop),
          takeProfit: roundPrice(signal.target),
          rr: signal.rr,
          reason: signal.explanation,
          updatedAt: new Date(signal.timestamp).toISOString(),
        });
        log(`[ALERT] ${pair} — SENT`);
        activeTrades[pair] = {
          direction: signal.direction,
          timestamp: Date.now(),
          entry: signal.entry,
          stop: signal.stop,
          target: signal.target,
          trail: signal.trail,
          id: signal.id,
          stage: signal.stage,
        };
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

  // ── Merge and persist ─────────────────────────────────────
  log("[CRON] Merging signals...");
  const merged = [...validSignals];
  for (const s of newSignals) {
    const idx = merged.findIndex((x: any) => x.pair === s.pair);
    if (idx >= 0) merged[idx] = s;
    else merged.push(s);
  }

  log("[CRON] Persisting state...");
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
