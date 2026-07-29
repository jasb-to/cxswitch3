// app/api/cron/route.ts — v50.5 "First Wave" Cron
// ============================================================
// Daily Trend → 4H Location → 4H Trigger → Signal
// v50.5 FIX: Active trades now persist in UI until TP/SL hit.
// Exited signals remain visible with status until acknowledged.
// v50.5 REPAIR: State recovery — valid signals missing from activeTrades
// are re-hydrated from the signals list to prevent duplicate entries.

import { NextResponse } from "next/server";
import { getCandles, krakenPairFormat } from "@/lib/kraken";
import { generateSignal, isSignalStillValid, shouldHold, filterExpiredSignals, getMarketSnapshot, rebuildStateFromTrades, checkTradeStatus } from "@/lib/strategy";
import { getSignals, setSignals, getMarketData, setMarketData, getActiveTrades, setActiveTrades, getLastCronRun, setLastCronRun, addSignalToHistory } from "@/lib/state";
import { sendAlert } from "@/lib/telegram";

const PAIRS = ["BTC", "ETH", "SOL", "HYPE"] as const;
const MIN_CRON_INTERVAL_MS = 9 * 60 * 1000; // 9 minutes

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
  console.log("========================================");
  console.log(`[CRON v50.5] Started at ${new Date(runStart).toISOString()}`);

  const url = new URL(request.url);
  const querySecret = url.searchParams.get("secret");
  const authHeader = request.headers.get("authorization");
  const forceRun = url.searchParams.get("force") === "true";

  const isAuthorized = querySecret === process.env.CRON_SECRET || authHeader === `Bearer ${process.env.CRON_SECRET}`;
  if (!isAuthorized) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const lastRun = await getLastCronRun();
  if (!forceRun && (runStart - lastRun) < MIN_CRON_INTERVAL_MS) {
    return NextResponse.json({ success: true, skipped: true, reason: "rate_limited" });
  }
  await setLastCronRun(runStart);

  let activeTrades = await getActiveTrades();
  console.log(`[STATE] Active trades:`, Object.keys(activeTrades).join(", ") || "none");

  // v50.5: Rebuild in-memory state from persisted KV data
  rebuildStateFromTrades(activeTrades);
  console.log(`[STATE] In-memory state rebuilt from ${Object.keys(activeTrades).length} persisted trades`);

  const existingSignals = await getSignals();
  const currentPrices: Record<string, number> = {};

  for (const pair of PAIRS) {
    try {
      const candles = await getCandles(krakenPairFormat(pair + "/USD"), 60);
      if (candles?.length) currentPrices[pair] = candles[candles.length - 1].close;
    } catch (e) { console.log(`[PRICE] ${pair} — failed`); }
  }

  // v50.5 FIX: filterExpiredSignals now keeps TP_HIT/SL_HIT signals in active list
  // with exited=true so they remain visible in the UI
  const { active: validSignals, exited: preExited } = filterExpiredSignals(existingSignals, currentPrices, runStart);
  console.log(`[STATE] Valid: ${validSignals.length}, Exited: ${preExited.length}`);

  // v50.5 FIX: Only remove from activeTrades if signal was truly expired (not TP/SL)
  // TP/SL signals stay in the list for UI visibility
  for (const { signal, reason } of preExited) {
    console.log(`[EXIT] ${signal.pair} — ${reason}`);
    await addSignalToHistory(signal, reason as any, currentPrices[signal.pair] || signal.entry);
    // Only delete from activeTrades if it's NOT a TP/SL hit (those stay visible)
    if (reason !== "tp_hit" && reason !== "sl_hit") {
      if (activeTrades[signal.pair]) delete activeTrades[signal.pair];
    }
  }

  // v50.5 REPAIR: Recover activeTrades from valid signals that are missing.
  // This fixes the bug where serverless cold starts or KV write failures
  // cause activeTrades to lose entries, leading to duplicate signal generation.
  let recoveredCount = 0;
  for (const signal of validSignals) {
    if (signal.exited) continue; // Don't recover exited signals
    if (!activeTrades[signal.pair]) {
      const price = currentPrices[signal.pair];
      if (price !== undefined) {
        const validity = isSignalStillValid(signal, price, runStart);
        if (validity.valid) {
          activeTrades[signal.pair] = {
            direction: signal.direction,
            timestamp: signal.timestamp,
            entry: signal.entry,
            stop: signal.stop,
            target: signal.target,
            id: signal.id,
            type: signal.type,
          };
          console.log(`[STATE_RECOVER] ${signal.pair}: ${signal.type} ${signal.direction} @ ${signal.entry} — recovered from signals list`);
          recoveredCount++;
        }
      }
    }
  }
  if (recoveredCount > 0) {
    console.log(`[STATE_RECOVER] Recovered ${recoveredCount} trade(s) into activeTrades`);
    // Rebuild in-memory state again after recovery
    rebuildStateFromTrades(activeTrades);
  }

  const newSignals: any[] = [];
  const marketDataList: any[] = [];
  const alerts: any[] = [];

  for (const pair of PAIRS) {
    try {
      const [candles1h, candles4h, candles15m] = await Promise.all([
        getCandles(krakenPairFormat(pair + "/USD"), 60),
        getCandles(krakenPairFormat(pair + "/USD"), 240),
        getCandles(krakenPairFormat(pair + "/USD"), 15)
      ]);

      if (!candles1h || !candles4h || !candles15m || candles1h.length < 20 || candles4h.length < 30 || candles15m.length < 20) {
        alerts.push({ pair, status: "skip", reason: "insufficient_candles" });
        continue;
      }

      const currentPrice = candles1h[candles1h.length - 1].close;
      const existingIdx = validSignals.findIndex(s => s.pair === pair);
      const existingForPair = existingIdx >= 0 ? validSignals[existingIdx] : null;

      // ── Check existing signal ──
      if (existingForPair) {
        // v50.5 FIX: If signal already exited (TP/SL hit), skip processing but keep it in list
        if (existingForPair.exited) {
          console.log(`[PAIR] ${pair} — Already exited (${existingForPair.exitReason}), keeping in UI`);
          const snapshot = getMarketSnapshot(pair, candles1h, candles4h, candles15m);
          if (snapshot) marketDataList.push(snapshot);
          continue;
        }

        const validity = isSignalStillValid(existingForPair, currentPrice, runStart);
        if (!validity.valid) {
          console.log(`[PAIR] ${pair} — INVALID: ${validity.reason}`);
          await addSignalToHistory(existingForPair, validity.reason as any, currentPrice);
          if (activeTrades[pair]) delete activeTrades[pair];
          validSignals.splice(existingIdx, 1);
          alerts.push({ pair, status: "expired", reason: validity.reason });
        } else {
          const holdResult = shouldHold(existingForPair, candles4h, currentPrice, runStart);
          if (!holdResult.shouldHold) {
            console.log(`[PAIR] ${pair} — HOLD EXIT: ${holdResult.reason}`);
            await addSignalToHistory(existingForPair, "hold_exit", currentPrice);
            if (activeTrades[pair]) delete activeTrades[pair];
            validSignals.splice(existingIdx, 1);
            alerts.push({ pair, status: "hold_exit", reason: holdResult.reason });
          } else {
            console.log(`[PAIR] ${pair} — Still valid, skipping`);
            const snapshot = getMarketSnapshot(pair, candles1h, candles4h, candles15m);
            marketDataList.push(snapshot);
            continue;
          }
        }
      }

      // ── Generate new signal ──
      const result = generateSignal(pair, candles1h, candles4h, candles15m, validSignals, currentPrice);
      const snapshot = result.market || getMarketSnapshot(pair, candles1h, candles4h, candles15m);
      if (snapshot) marketDataList.push(snapshot);

      if (!result.signal) {
        console.log(`[PAIR] ${pair} — NO SIGNAL (${result.debug?.join(" | ")})`);
        alerts.push({ pair, status: "no_signal", debug: result.debug?.join(" | ") });
        continue;
      }

      const signal = result.signal;
      console.log(`[PAIR] ${pair} — SIGNAL: ${signal.type} ${signal.direction} ${signal.entry} TP${signal.target} SL${signal.stop} RR${signal.rr}`);
      newSignals.push(signal);

      // Determine alert state based on signal type
      const alertState = signal.type === "ADD" ? "ADD" : "ENTRY";
      const alertEmoji = signal.type === "ENTRY_1" ? "🟢" : signal.type === "ENTRY_2" ? "🟡" : "🔵";

      try {
        await sendAlert({
          symbol: signal.pair,
          state: alertState,
          price: roundPrice(signal.entry),
          bias: signal.direction,
          stopLoss: roundPrice(signal.stop),
          takeProfit: roundPrice(signal.target),
          rr: signal.rr,
          expectedMove: signal.expectedMove,
          adx: signal.adx,
          rsi: signal.rsi,
          stochK: signal.stochK,
          stochD: signal.stochD,
          reason: signal.reason,
          trend: signal.trend,
          location: signal.location,
          trigger: signal.trigger,
          updatedAt: new Date(signal.timestamp).toISOString(),
          signalType: signal.type,
          signalEmoji: alertEmoji,
        });
        console.log(`[ALERT] ${pair} — SENT (${signal.type})`);
        activeTrades[pair] = {
          direction: signal.direction,
          timestamp: Date.now(),
          entry: signal.entry,
          stop: signal.stop,
          target: signal.target,
          id: signal.id,
          type: signal.type,
        };
        alerts.push({ pair, status: "sent", type: signal.type });
      } catch (err) {
        console.error(`[ALERT] ${pair} — FAILED:`, err);
        alerts.push({ pair, status: "alert_failed", error: String(err) });
      }
    } catch (err) {
      console.error(`[PAIR] ${pair} — ERROR:`, err);
      alerts.push({ pair, status: "error", error: String(err) });
    }
  }

  // v50.5 FIX: Build merged signals with proper meta.status for UI
  const merged: any[] = [];
  for (const s of validSignals) {
    const ageMinutes = Math.round((runStart - s.timestamp) / 60000);

    // Determine status for UI
    let status = "ACTIVE";
    if (s.exited) {
      status = s.exitReason === "tp_hit" ? "TP_HIT" : s.exitReason === "sl_hit" ? "SL_HIT" : "EXPIRED";
    } else if (ageMinutes > 120 && (s.type === "ENTRY_1" || s.type === "ENTRY_2")) {
      status = "STALE";
    }

    // v50.5 FIX: Add meta object that the UI expects
    merged.push({
      ...s,
      meta: {
        status,
        ageMinutes,
        actionable: status === "ACTIVE" && !s.exited,
      }
    });
  }

  for (const s of newSignals) {
    const idx = merged.findIndex((x: any) => x.pair === s.pair);
    const ageMinutes = 0;
    const signalWithMeta = {
      ...s,
      meta: {
        status: "ACTIVE",
        ageMinutes,
        actionable: true,
      }
    };
    if (idx >= 0) merged[idx] = signalWithMeta; else merged.push(signalWithMeta);
  }

  await Promise.all([setSignals(merged), setMarketData(marketDataList), setActiveTrades(activeTrades)]);

  console.log(`[CRON] Done. signals=${merged.length}, marketData=${marketDataList.length}, exited=${preExited.length}, recovered=${recoveredCount}`);
  console.log("========================================");

  return NextResponse.json({ success: true, signals: merged.length, marketData: marketDataList.length, exited: preExited.length, recovered: recoveredCount, alerts });
}
