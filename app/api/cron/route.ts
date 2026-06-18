// app/api/cron/route.ts — v22.0 "FIXED: Version Sync + History Tracking + Active Trade Levels"
// ============================================================
// Returns 200 OK instead of 429 when run too soon

import { NextResponse } from "next/server";
import { getCandles } from "@/lib/kraken";
import { generateSignal, isSignalStillValid, shouldHold, getMonitorState, clearMonitorState, setRedisClient } from "@/lib/strategy";
import { setSignals, setMarketData, getSignals, getActiveTrades, setActiveTrades, getLastCronRun, setLastCronRun, redis, addSignalToHistory } from "@/lib/state";
import { sendAlert } from "@/lib/telegram";

const PAIRS = ["BTC", "ETH", "SOL"] as const;
const MIN_CRON_INTERVAL_MS = 14 * 60 * 1000;

function roundPrice(n: number): number {
  if (n >= 10000) return Math.round(n);
  if (n >= 1000) return Math.round(n * 10) / 10;
  if (n >= 100) return Math.round(n * 100) / 100;
  return Math.round(n * 1000) / 1000;
}

function roundIndicator(n: number): number {
  return Math.round(n * 10) / 10;
}

function roundRR(n: number): number {
  return Math.round(n * 100) / 100;
}

function getSignalMaxAgeHours(signal: any): number {
  return signal.type === "REVERSAL" ? 4 : 8;
}

function isSignalExpired(signal: any): boolean {
  const ageHours = (Date.now() - signal.timestamp) / (1000 * 60 * 60);
  return ageHours >= getSignalMaxAgeHours(signal);
}

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const runStart = Date.now();
  console.log("========================================");
  console.log(`[CRON] Started at ${new Date(runStart).toISOString()}`);

  const url = new URL(request.url);
  const querySecret = url.searchParams.get("secret");
  const authHeader = request.headers.get("authorization");
  const resetCooldown = url.searchParams.get("reset") === "true";
  const forceRun = url.searchParams.get("force") === "true";

  const isAuthorized = 
    querySecret === process.env.CRON_SECRET ||
    authHeader === `Bearer ${process.env.CRON_SECRET}`;

  if (!isAuthorized) {
    console.log(`[AUTH] FAILED`);
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  console.log(`[AUTH] PASSED`);

  const lastRun = await getLastCronRun();
  const timeSinceLastRun = runStart - lastRun;

  if (!forceRun && timeSinceLastRun < MIN_CRON_INTERVAL_MS) {
    const waitSeconds = Math.ceil((MIN_CRON_INTERVAL_MS - timeSinceLastRun) / 1000);
    console.log(`[RATE LIMIT] Skipping — last run ${(timeSinceLastRun/1000).toFixed(0)}s ago. Next in ${waitSeconds}s.`);
    return NextResponse.json({ 
      success: true,
      skipped: true,
      reason: "rate_limited",
      retryAfter: waitSeconds,
      lastRun: new Date(lastRun).toISOString(),
      message: `Already ran ${(timeSinceLastRun/1000).toFixed(0)}s ago. Waiting ${waitSeconds}s.`
    });
  }

  await setLastCronRun(runStart);

  setRedisClient(redis);
  console.log(`[REDIS] Client wired`);

  let activeTrades = await getActiveTrades();

  if (resetCooldown) {
    console.log(`[STATE] Resetting all cooldowns`);
    activeTrades = {};
    await setActiveTrades({});
  }

  console.log(`[STATE] Active trades:`, Object.keys(activeTrades).join(", ") || "none");

  const existingSignals = await getSignals();

  let validSignals = existingSignals.filter((s: any) => !isSignalExpired(s));
  console.log(`[STATE] Existing valid signals: ${validSignals.length} (filtered ${existingSignals.length - validSignals.length} expired)`);

  const newSignals: any[] = [];
  const marketDataList: any[] = [];
  const alerts: any[] = [];
  const exitedSignals: any[] = [];

  for (const pair of PAIRS) {
    console.log(`[PAIR] ${pair} — fetching candles...`);

    try {
      const [candles1h, candles4h, candles15m] = await Promise.all([
        getCandles(pair, 60),
        getCandles(pair, 240),
        getCandles(pair, 15)
      ]);

      console.log(`[PAIR] ${pair} — 1H: ${candles1h?.length ?? 0}, 4H: ${candles4h?.length ?? 0}, 15m: ${candles15m?.length ?? 0}`);

      if (!candles1h || !candles4h || !candles15m || 
          candles1h.length < 30 || candles4h.length < 30 || candles15m.length < 50) {
        console.log(`[PAIR] ${pair} — SKIP: insufficient candles`);
        alerts.push({ pair, status: "skip", reason: "insufficient_candles" });
        continue;
      }

      const currentPrice = candles1h[candles1h.length - 1].close;

      const existingIdx = validSignals.findIndex(s => s.pair === pair);
      const existingForPair = existingIdx >= 0 ? validSignals[existingIdx] : null;

      // ─── FIX: Check existing signal validity FIRST ─────────
      if (existingForPair) {
        if (!isSignalStillValid(existingForPair, currentPrice)) {
          console.log(`[PAIR] ${pair} — Existing signal INVALID, removing`);

          // Determine exit reason for history
          const entry = Number(existingForPair.entry);
          const stop = Number(existingForPair.stop);
          const target = Number(existingForPair.target);
          let exitReason = "expired";

          if (existingForPair.direction === "LONG") {
            if (currentPrice <= stop * (1 - 0.002)) exitReason = "stop_hit";
            else if (currentPrice >= target * (1 + 0.002)) exitReason = "target_hit";
          } else {
            if (currentPrice >= stop * (1 + 0.002)) exitReason = "stop_hit";
            else if (currentPrice <= target * (1 - 0.002)) exitReason = "target_hit";
          }

          // Add to history so UI can show STOPPED OUT / TARGET HIT banner
          await addSignalToHistory(existingForPair, exitReason as any, currentPrice);

          // Clear from active trades so new signals can generate
          if (activeTrades[pair]) {
            delete activeTrades[pair];
          }

          validSignals.splice(existingIdx, 1);
          await clearMonitorState(pair);
          alerts.push({ pair, status: "existing_invalid", reason: exitReason });
        } else {
          const holdResult = shouldHold(existingForPair, candles4h, candles1h, currentPrice);
          if (!holdResult.shouldHold) {
            console.log(`[PAIR] ${pair} — HOLD EXIT: ${holdResult.reason}`);

            await addSignalToHistory(existingForPair, "hold_exit", currentPrice);

            if (activeTrades[pair]) {
              delete activeTrades[pair];
            }

            validSignals.splice(existingIdx, 1);
            await clearMonitorState(pair);
            exitedSignals.push({ pair, reason: holdResult.reason, signal: existingForPair });
            alerts.push({ pair, status: "hold_exit", reason: holdResult.reason });
          } else {
            console.log(`[PAIR] ${pair} — Existing signal still valid (${existingForPair.type}), skipping`);
            alerts.push({ pair, status: "existing_valid", type: existingForPair.type, holdReason: holdResult.reason });

            const result = await generateSignal(pair, candles1h, candles4h, candles15m, activeTrades);
            if (result.market) marketDataList.push(result.market);
            continue;
          }
        }
      }

      const result = await generateSignal(pair, candles1h, candles4h, candles15m, activeTrades);
      const market = result.market;
      const debug = result.debug || [];

      if (market) {
        marketDataList.push(market);
      }

      const monitorState = await getMonitorState(pair);
      if (monitorState) {
        const ageMin = (Date.now() - monitorState.startedAt) / 60000;
        console.log(`[MONITOR] ${pair}: ${monitorState.direction} | ${monitorState.reason} | K=${monitorState.stochK.toFixed(1)} D=${monitorState.stochD.toFixed(1)} | age=${ageMin.toFixed(1)}min`);
      } else {
        console.log(`[MONITOR] ${pair}: no state`);
      }

      if (!result.signal) {
        console.log(`[PAIR] ${pair} — NO SIGNAL (${debug.join(" | ")})`);
        alerts.push({ pair, status: "no_signal", debug: debug.join(" | ") });
        continue;
      }

      const signal = result.signal;
      console.log(`[PAIR] ${pair} — SIGNAL: ${signal.direction} ${signal.type} entry=${roundPrice(signal.entry)} conf=${signal.confidence}%`);

      await clearMonitorState(pair);

      newSignals.push(signal);

      const alertPayload = {
        symbol: signal.pair,
        state: signal.type,
        price: roundPrice(signal.entry),
        bias: signal.direction,
        confidence: signal.confidence,
        stopLoss: roundPrice(signal.stop),
        takeProfit: roundPrice(signal.target),
        rr: roundRR(signal.rr),
        adx: roundIndicator(signal.adx),
        rsi: roundIndicator(signal.rsi),
        stochK: roundIndicator(signal.stochK),
        stochD: roundIndicator(signal.stochD),
        expectedMove: roundIndicator(signal.expectedMove),
        reason: signal.reason,
        updatedAt: new Date(signal.timestamp).toISOString(),
      };

      try {
        await sendAlert(alertPayload);
        console.log(`[ALERT] ${pair} — SENT`);

        // FIX: Store FULL signal in activeTrades so isSignalStillValid works
        activeTrades[pair] = {
          direction: signal.direction,
          timestamp: Date.now(),
          entry: signal.entry,
          stop: signal.stop,
          target: signal.target,
          type: signal.type,
          id: signal.id,
        };

        alerts.push({ pair, status: "sent", type: signal.type });
      } catch (alertErr) {
        console.error(`[ALERT] ${pair} — FAILED:`, alertErr);
        alerts.push({ pair, status: "alert_failed", error: String(alertErr) });
      }

    } catch (err) {
      console.error(`[PAIR] ${pair} — ERROR:`, err);
      alerts.push({ pair, status: "error", error: err instanceof Error ? err.message : "Unknown" });
    }
  }

  const mergedSignals = [...validSignals];
  for (const s of newSignals) {
    const idx = mergedSignals.findIndex((x: any) => x.pair === s.pair);
    if (idx >= 0) mergedSignals[idx] = s;
    else mergedSignals.push(s);
  }

  const finalSignals = mergedSignals.filter((s: any) => !isSignalExpired(s));

  console.log(`[STATE] Saving ${finalSignals.length} signals, ${marketDataList.length} market data...`);
  console.log(`[STATE] Exited signals: ${exitedSignals.length}`);

  await Promise.all([
    setSignals(finalSignals),
    setMarketData(marketDataList),
    setActiveTrades(activeTrades),
  ]);

  const runDuration = Date.now() - runStart;
  console.log(`[CRON] Done in ${runDuration}ms. signals=${finalSignals.length}, marketData=${marketDataList.length}, exited=${exitedSignals.length}`);
  console.log("========================================");

  return NextResponse.json({
    success: true,
    skipped: false,
    timestamp: new Date().toISOString(),
    durationMs: runDuration,
    signals: finalSignals.length,
    marketData: marketDataList.length,
    exited: exitedSignals.length,
    alerts,
  });
}
