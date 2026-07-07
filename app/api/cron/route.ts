// app/api/cron/route.ts — v28 "Full v28 strategy integration"
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
  shouldHold,
  hasExited,
  Candle,
  Signal,
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
  log(`[CRON] Started runId=${runId} v28`);

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

  log(`[CRON] Checking ${existingSignals.length} existing signals...`);

  const signalsToCheck = existingSignals.filter((s: any) => !s.exited && !hasExited(s.id));
  const alreadyExitedSignals = existingSignals.filter((s: any) => s.exited || hasExited(s.id));

  if (alreadyExitedSignals.length > 0) {
    log(`[STATE] Skipping ${alreadyExitedSignals.length} already-exited signals`);
  }

  const validSignals: Signal[] = [];
  const preExited: { signal: Signal; reason: string }[] = [];

  for (const signal of signalsToCheck) {
    const price = currentPrices[signal.pair];
    const candles4h = candles4hMap[signal.pair] || [];

    if (price === undefined || candles4h.length < 30) {
      validSignals.push(signal);
      continue;
    }

    const holdResult = shouldHold(signal, candles4h, price, runStart);
    const validity = isSignalStillValid(signal, price, runStart);

    if (!holdResult.shouldHold) {
      log(`[EXIT] ${signal.pair} — ${holdResult.reason}`);
      preExited.push({ signal, reason: holdResult.reason });
    } else if (!validity.valid) {
      log(`[EXIT] ${signal.pair} — ${validity.reason}`);
      preExited.push({ signal, reason: validity.reason });
    } else {
      validSignals.push(signal);
    }
  }

  log(`[STATE] Valid: ${validSignals.length}, Exited: ${preExited.length}`);

  const exitAlertsToSend: { signal: Signal; reason: string; exitPrice: number; pnl: number }[] = [];

  for (const { signal, reason } of preExited) {
    if (signal.exited || hasExited(signal.id)) {
      log(`[EXIT] ${signal.pair} — already marked exited, skipping alert`);
      if (activeTrades[signal.pair]) delete activeTrades[signal.pair];
      continue;
    }

    log(`[EXIT] ${signal.pair} — ${reason}`);

    signal.exited = true;
    signal.exitReason = reason;
    signal.exitPrice = currentPrices[signal.pair] || signal.entry;
    signal.exitTimestamp = runStart;

    await addSignalToHistory(signal, reason as any, signal.exitPrice);

    if (activeTrades[signal.pair]) delete activeTrades[signal.pair];
    await setActiveTrades(activeTrades);

    await resetPairConsumedZones(signal.pair);
    log(`[STATE] Cleared consumedZones for ${signal.pair} after ${reason}`);

    const pnl =
      signal.direction === "LONG"
        ? ((signal.exitPrice - signal.entry) / signal.entry) * 100
        : ((signal.entry - signal.exitPrice) / signal.entry) * 100;

    exitAlertsToSend.push({ signal, reason, exitPrice: signal.exitPrice, pnl });
  }

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
        if (candles4h && candles4h.length >= 30) {
          const currentPrice = currentPrices[pair] ?? candles1h?.[candles1h.length - 1]?.close ?? 0;
          const result = generateSignal(pair, candles1h || [], candles4h, candles15m || [], currentPrice);
          if (result.market) {
            marketDataList.push(result.market as MarketData);
          }
        }
        continue;
      }
      if (!candles4h || candles4h.length < MIN_CANDLES_4H) {
        log(`[PAIR] ${pair} — SKIP: insufficient 4H candles (${candles4h?.length || 0} < ${MIN_CANDLES_4H})`);
        alerts.push({ pair, status: "skip", reason: "insufficient_4h_candles", count: candles4h?.length });
        continue;
      }

      const currentPrice = currentPrices[pair] ?? candles1h[candles1h.length - 1].close;

      const existingIdx = validSignals.findIndex((s: any) => s.pair === pair);
      const existingForPair = existingIdx >= 0 ? validSignals[existingIdx] : null;

      if (existingForPair) {
        log(`[PAIR] ${pair} — has existing signal ${existingForPair.id}`);

        if (existingForPair.exited || hasExited(existingForPair.id)) {
          log(`[PAIR] ${pair} — signal already EXITED, removing from active`);
          validSignals.splice(existingIdx, 1);
          if (activeTrades[pair]) delete activeTrades[pair];
          continue;
        }

        log(`[PAIR] ${pair} — Holding`);
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

      const result = generateSignal(pair, candles1h, candles4h, candles15m, currentPrice);

      for (const line of result.debug) {
        log(`[STRAT] ${pair} ${line}`);
      }

      if (result.market) {
        marketDataList.push(result.market as MarketData);
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
  const merged = [...validSignals, ...newSignals].filter((s: any) => !s.exited && !hasExited(s.id));
  
  const deduped: Signal[] = [];
  for (const s of merged) {
    const idx = deduped.findIndex((x: any) => x.pair === s.pair);
    if (idx >= 0) {
      if (s.timestamp > deduped[idx].timestamp) deduped[idx] = s;
    } else {
      deduped.push(s);
    }
  }

  log("[CRON] Persisting final state...");
  await Promise.all([
    setSignals(deduped),
    setMarketData(marketDataList),
    setActiveTrades(activeTrades),
  ]);

  log(
    `[CRON] Done. signals=${deduped.length}, marketData=${marketDataList.length}, exited=${preExited.length}`
  );
  log("========================================");

  const response
