import { NextRequest, NextResponse } from "next/server";
import { Redis } from "@upstash/redis";
import {
  generateSignal,
  shouldHold,
  filterExpiredSignals,
  getMarketSnapshot,
  aggregateTo1D,
  Signal,
  SignalResult,
  setLastExitFunctions,
  setRedisHelpers,
} from "@/lib/strategy";
import {
  saveActiveSignals,
  loadActiveSignals,
  setLastCronRun,
  saveDashboardSnapshot,
  persistExit,
  loadLastExit,
  persistLastExit,
} from "@/lib/state";
import { getCandles, getCurrentPrice, krakenPairFormat } from "@/lib/kraken";
import { sendAlert, sendExitAlert, alertError } from "@/lib/telegram";

const redis = new Redis({
  url: process.env.KV_REST_API_URL!,
  token: process.env.KV_REST_API_TOKEN!,
});
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PAIRS = ["BTC/USD", "ETH/USD", "SOL/USD", "HYPE/USD"];
const CRON_SECRET = process.env.CRON_SECRET;
const EXITED_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const PENDING_EXIT_TIMEOUT_MS = 30 * 60 * 1000;

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  const secret = req.nextUrl.searchParams.get("secret");
  const token = authHeader?.replace("Bearer ", "") || secret;

  if (!CRON_SECRET) {
    console.error("[CRON] CRON_SECRET not set");
    return NextResponse.json({ error: "CRON_SECRET not set" }, { status: 500 });
  }
  if (!token || token !== CRON_SECRET) {
    return NextResponse.json({ error: "Invalid secret" }, { status: 401 });
  }

  console.log("[CRON] STARTED | " + new Date().toISOString());

  const now = Date.now();
  const results: Record<string, any> = {};
  const errors: string[] = [];

  // ─── Load & Clean State ───────────────────────────────────

  let activeSignals: Signal[] = [];
  try {
    activeSignals = await loadActiveSignals();
  } catch (e) {
    errors.push("loadActiveSignals: " + e);
  }
  if (!Array.isArray(activeSignals)) activeSignals = [];

  setLastExitFunctions(loadLastExit, persistLastExit);

  // Wire Redis for cross-instance hysteresis persistence (v38.7)
  setRedisHelpers(
    async (key) => {
      const val = await redis.get(key);
      return val ? JSON.parse(val as string) : null;
    },
    async (key, value) => {
      await redis.set(key, JSON.stringify(value), { ex: 86400 });
    }
  );

  const preCleanSignals = activeSignals.filter(
    (s) => !s.exited || now - s.timestamp < EXITED_TTL_MS
  );
  const prePruned = activeSignals.length - preCleanSignals.length;
  if (prePruned > 0) {
    console.log(`[CRON] Pre-cleaned ${prePruned} old exited signals`);
  }
  activeSignals = preCleanSignals;

  // v37.2: Deduplicate active signals per pair
  const pairCounts = new Map<string, number>();
  for (const s of activeSignals) {
    if (!s.exited && s.status !== "PENDING_EXIT") {
      pairCounts.set(s.pair, (pairCounts.get(s.pair) || 0) + 1);
    }
  }
  for (const [pair, count] of pairCounts) {
    if (count > 1) {
      console.error(`[CRON] STATE CORRUPTION: ${pair} has ${count} active signals. Keeping most recent.`);
      const pairSignals = activeSignals.filter(
        (s) => s.pair === pair && !s.exited && s.status !== "PENDING_EXIT"
      );
      pairSignals.sort((a, b) => b.timestamp - a.timestamp);
      for (let i = 1; i < pairSignals.length; i++) {
        pairSignals[i].exited = true;
        pairSignals[i].status = "EXITED";
        if (pairSignals[i].tradeState) {
          pairSignals[i].tradeState.phase = "EXIT";
          pairSignals[i].tradeState.phaseEnteredAt = now;
        }
      }
    }
  }

  const currentPrices: Record<string, number> = {};
  const signalResults: Record<string, SignalResult> = {};
  const marketSnapshots = [];

  // ─── Process Each Pair ────────────────────────────────────

  for (const pair of PAIRS) {
    const krakenPair = krakenPairFormat(pair);
    results[pair] = { status: "pending" };
    console.log(`[CRON] ─── ${pair} ───`);

    try {
      let candles1h: any[] = [],
        candles4h: any[] = [],
        candles15m: any[] = [],
        candles1d: any[] = [],
        price = 0;

      try {
        [candles1h, candles4h, candles15m, candles1d, price] = await Promise.all([
          getCandles(krakenPair, 60),
          getCandles(krakenPair, 240),
          getCandles(krakenPair, 15),
          getCandles(krakenPair, 1440),
          getCurrentPrice(krakenPair),
        ]);
      } catch (fetchErr) {
        console.warn(`[CRON] ${pair} | 1D fetch failed, aggregating from 4H`);
        [candles1h, candles4h, candles15m, price] = await Promise.all([
          getCandles(krakenPair, 60),
          getCandles(krakenPair, 240),
          getCandles(krakenPair, 15),
          getCurrentPrice(krakenPair),
        ]);
      }

      currentPrices[pair] = price;

      if (!Array.isArray(candles1h) || !Array.isArray(candles4h) || !Array.isArray(candles15m)) {
        throw new Error("Invalid candle data");
      }
      if (!Array.isArray(candles1d) || candles1d.length === 0) {
        candles1d = aggregateTo1D(candles4h);
      }

      console.log(
        `[CRON] ${pair} | $${price.toFixed(2)} | 1H:${candles1h.length} 4H:${candles4h.length} 15m:${candles15m.length} 1D:${candles1d.length}`
      );

      const activeForPair = activeSignals.filter(
        (s) => s.pair === pair && !s.exited && s.status !== "PENDING_EXIT"
      );
      const pendingForPair = activeSignals.filter(
        (s) => s.pair === pair && s.status === "PENDING_EXIT"
      );

      // ─── Handle Pending Exits ───────────────────────────────

      for (const signal of pendingForPair) {
        if (signal.exited) continue;

        if (
          signal.exitRecommendedAt &&
          now - signal.exitRecommendedAt > PENDING_EXIT_TIMEOUT_MS
        ) {
          console.log(
            `[CRON] ${pair} | AUTO-EXIT | Pending exit timed out (${Math.round(
              (now - signal.exitRecommendedAt) / 60000
            )}min)`
          );

          signal.exited = true;
          signal.status = "EXITED";
          signal.exitReason = "auto_exit_timeout";
          signal.exitTimestamp = now;
          signal.exitPrice = price;
          if (signal.tradeState) {
            signal.tradeState.phase = "EXIT";
            signal.tradeState.phaseEnteredAt = now;
          }

          const rawPnl =
            signal.direction === "LONG"
              ? ((price - signal.entry) / signal.entry) * 100
              : ((signal.entry - price) / signal.entry) * 100;
          const pnlStr = (isFinite(rawPnl) ? rawPnl.toFixed(2) : "0.00") + "%";

          try {
            await persistExit({
              id: signal.id,
              pair: signal.pair,
              direction: signal.direction,
              entry: signal.entry,
              exitPrice: price,
              pnl: parseFloat(pnlStr),
              reason: "auto_exit_timeout",
              timestamp: now,
            });
          } catch (e) {}

          try {
            await sendExitAlert(signal, price, "auto_exit_timeout");
          } catch (e) {}

          results[pair] = {
            status: "EXITED",
            reason: "auto_exit_timeout",
            price,
            signalId: signal.id,
            pnl: pnlStr,
            phase: "EXIT",
          };
        } else {
          console.log(
            `[CRON] ${pair} | PENDING_EXIT | waiting for user confirmation (${Math.round(
              (PENDING_EXIT_TIMEOUT_MS - (now - signal.exitRecommendedAt!)) / 60000
            )}min left)`
          );
          results[pair] = {
            status: "PENDING_EXIT",
            reason: signal.exitReason,
            price,
            signalId: signal.id,
          };
          continue;
        }
      }

      // ─── Manage Active Trades ───────────────────────────────

      if (activeForPair.length > 0) {
        for (const signal of activeForPair) {
          if (signal.exited) continue;

          const hoursInTrade = (now - signal.timestamp) / (60 * 60 * 1000);
          console.log(
            `[CRON] ${pair} | hoursInTrade: ${hoursInTrade.toFixed(2)} | timestamp: ${signal.timestamp} | now: ${now}`
          );

          const holdResult = shouldHold(signal, candles4h, candles1d, candles1h, price);
          const ts = holdResult.updatedTradeState || signal.tradeState;

          console.log(
            `[CRON] ${pair} | shouldHold: ${holdResult.shouldHold} | ${holdResult.reason} | phase: ${ts?.phase || "TREND"}`
          );

          // FIX v41: Persist updated tradeState back to signal
          if (holdResult.updatedTradeState) {
            signal.tradeState = holdResult.updatedTradeState;
          }

          if (!holdResult.shouldHold) {
            const rawPnl =
              signal.direction === "LONG"
                ? ((price - signal.entry) / signal.entry) * 100
                : ((signal.entry - price) / signal.entry) * 100;
            const pnlStr = (isFinite(rawPnl) ? rawPnl.toFixed(2) : "0.00") + "%";
            console.log(`[CRON] ${pair} | EXIT RECOMMENDED | ${holdResult.reason} | ${pnlStr}`);

            signal.exited = true;
            signal.status = "EXITED";
            signal.exitReason = holdResult.reason;
            signal.exitTimestamp = now;
            signal.exitPrice = price;

            try {
              await persistExit({
                id: signal.id,
                pair: signal.pair,
                direction: signal.direction,
                entry: signal.entry,
                exitPrice: price,
                pnl: parseFloat(pnlStr),
                reason: holdResult.reason,
                timestamp: now,
              });
            } catch (e) {}

            try {
              await sendExitAlert(signal, price, holdResult.reason);
            } catch (e) {}

            results[pair] = {
              status: "EXITED",
              reason: holdResult.reason,
              price,
              signalId: signal.id,
              pnl: pnlStr,
              phase: ts?.phase || "EXIT",
            };
          } else {
            const rawPnl =
              signal.direction === "LONG"
                ? ((price - signal.entry) / signal.entry) * 100
                : ((signal.entry - price) / signal.entry) * 100;
            const pnl = (isFinite(rawPnl) ? rawPnl.toFixed(2) : "0.00") + "%";

            console.log(`[CRON] ${pair} | HOLDING | ${ts?.phase || "TREND"} | ${pnl}`);

            results[pair] = {
              status: "HOLDING",
              phase: ts?.phase || "TREND",
              pnl,
              signalId: signal.id,
              entryMode: signal.entryMode || signal.entryType,
            };
          }
        }
      } else if (pendingForPair.length === 0) {
        // ─── Evaluate New Signals ─────────────────────────────
        console.log(`[CRON] ${pair} | No active trades — evaluating`);
        const result = generateSignal(
          pair,
          candles1h,
          candles4h,
          candles1d,
          candles15m,
          activeSignals,
          price
        );
        signalResults[pair] = result || { debug: [] };

        if (result?.debug?.length)
          console.log(`[CRON] ${pair} | Debug: ${result.debug.join(" | ")}`);

        if (result?.signal) {
          const signal = result.signal;
          activeSignals.push(signal);
          const rr = signal.rr || (signal.target - signal.entry) / (signal.entry - signal.stop);
          console.log(
            `[CRON] ${pair} | SIGNAL | ${signal.direction} ${signal.entryType || signal.entryMode} | Entry:$${signal.entry.toFixed(
              2
            )} | RR:${rr.toFixed(2)} | Conf:${signal.confidence}%`
          );

          if (signal.entryTier !== "NO_TRADE") {
            try {
              await sendAlert(signal);
            } catch (e) {}
          }

          results[pair] = {
            status: "SIGNAL",
            direction: signal.direction,
            confidence: signal.confidence,
            entry: signal.entry,
            stop: signal.stop,
            target: signal.target,
            rr: rr.toFixed(2),
            entryType: signal.entryType || signal.entryMode,
            volumeConfirmed: signal.volumeConfirmed,
          };
        } else {
          console.log(`[CRON] ${pair} | NO SIGNAL`);
          results[pair] = { status: "NO_SIGNAL" };
        }
      }

      // ─── Build Snapshot ─────────────────────────────────────

      const snapshot = getMarketSnapshot(
        pair,
        candles1h,
        candles4h,
        candles15m,
        candles1d,
        price,
        signalResults[pair]
      );

      if (results[pair]?.status === "HOLDING" && activeForPair.length > 0) {
        const activeSignal = activeForPair[0];
        const ts = activeSignal.tradeState || {
          phase: "TREND",
          profitLockLevel: 0,
          lockedStop: null,
          currentR: 0,
          highestPrice: activeSignal.entry,
          lowestPrice: activeSignal.entry,
          entryPrice: activeSignal.entry,
          entryTimestamp: activeSignal.timestamp,
          lastDecisionTimestamp: Date.now(),
          phaseEnteredAt: activeSignal.timestamp,
        };
        snapshot.activeTrade = {
          signalId: results[pair].signalId,
          direction: activeSignal.direction,
          phase: ts.phase,
          pnl: results[pair].pnl,
          lockedStop: ts.lockedStop,
          profitLockLevel: ts.profitLockLevel,
          entry: activeSignal.entry,
          stop: activeSignal.stop,
          target: activeSignal.target,
          entryTier: activeSignal.entryTier,
          entryMode: activeSignal.entryMode || activeSignal.entryType,
          positionSizePct: activeSignal.positionSizePct,
          maxProfit: "0%",
          maxDrawdown: "0%",
          currentR: ts.currentR?.toFixed(2) || "0.00",
          trendlinePrice: activeSignal.trendlinePrice,
          exitRecommended: false,
          exitReason: null,
          exitRecommendedAt: null,
        };
        // FIX v41: Use regimeDirection (original 1D trend) for regime, not activeSignal.direction
        // This prevents UI duplication where trade direction = regime direction
        const regimeDir = activeSignal.regimeDirection || activeSignal.direction;
        snapshot.regime.direction = regimeDir;
        snapshot.regime.strength = ts.phase === "TREND" ? "STRONG" : ts.phase === "BUILDING" ? "MEDIUM" : "WEAK";
        snapshot.regime.confidence = activeSignal.confidence;
        snapshot.recommendedAction = activeSignal.direction + " " + (ts.phase || "TREND");
        snapshot.entryTier = activeSignal.entryTier;
        snapshot.entryMode = activeSignal.entryMode || activeSignal.entryType;
        snapshot.positionSize = activeSignal.positionSizePct
          ? (activeSignal.positionSizePct * 100).toFixed(0) + "%"
          : null;
      }

      if (results[pair]?.status === "PENDING_EXIT" && pendingForPair.length > 0) {
        const pendingSignal = pendingForPair[0];
        const ts = pendingSignal.tradeState || {
          phase: "EXIT",
          profitLockLevel: 0,
          lockedStop: null,
          currentR: 0,
          highestPrice: pendingSignal.entry,
          lowestPrice: pendingSignal.entry,
          entryPrice: pendingSignal.entry,
          entryTimestamp: pendingSignal.timestamp,
          lastDecisionTimestamp: Date.now(),
          phaseEnteredAt: pendingSignal.timestamp,
        };
        snapshot.activeTrade = {
          signalId: results[pair].signalId,
          direction: pendingSignal.direction,
          phase: "EXIT_RECOMMENDED",
          pnl: results[pair].pnl,
          lockedStop: ts.lockedStop,
          profitLockLevel: ts.profitLockLevel,
          entry: pendingSignal.entry,
          stop: pendingSignal.stop,
          target: pendingSignal.target,
          entryTier: pendingSignal.entryTier,
          entryMode: pendingSignal.entryMode || pendingSignal.entryType,
          positionSizePct: pendingSignal.positionSizePct,
          maxProfit: "0%",
          maxDrawdown: "0%",
          currentR: ts.currentR?.toFixed(2) || "0.00",
          trendlinePrice: pendingSignal.trendlinePrice,
          exitRecommended: true,
          exitReason: pendingSignal.exitReason,
          exitRecommendedAt: pendingSignal.exitRecommendedAt,
        };
        // FIX v41: Use regimeDirection for regime, not pendingSignal.direction
        const regimeDir = pendingSignal.regimeDirection || pendingSignal.direction;
        snapshot.regime.direction = regimeDir;
        snapshot.regime.strength = "PENDING_EXIT";
        snapshot.regime.confidence = pendingSignal.confidence;
        snapshot.recommendedAction = "EXIT RECOMMENDED — Confirm or Override";
        snapshot.entryTier = pendingSignal.entryTier;
        snapshot.entryMode = pendingSignal.entryMode || pendingSignal.entryType;
        snapshot.positionSize = pendingSignal.positionSizePct
          ? (pendingSignal.positionSizePct * 100).toFixed(0) + "%"
          : null;
      }

      marketSnapshots.push(snapshot);
    } catch (err) {
      const msg = String(err);
      errors.push(pair + ": " + msg);
      results[pair] = { status: "ERROR", error: msg };
      console.error(`[CRON] ${pair} | ERROR: ${msg}`);
      try {
        await alertError("cron/" + pair, err);
      } catch (e) {}
    }
  }

  // ─── Filter Expired (SL/TP Hits) ──────────────────────────

  try {
    const { active, exited } = filterExpiredSignals(activeSignals, currentPrices);
    if (exited.length > 0) {
      for (const { signal, reason } of exited) {
        if (!signal.exited) {
          const price = currentPrices[signal.pair] || signal.entry;
          signal.exited = true;
          signal.status = "EXITED";
          signal.exitReason = reason;
          signal.exitTimestamp = now;
          signal.exitPrice = price;
          if (signal.tradeState) {
            signal.tradeState.phase = "EXIT";
            signal.tradeState.phaseEnteredAt = now;
          }

          const rawPnl =
            signal.direction === "LONG"
              ? ((price - signal.entry) / signal.entry) * 100
              : ((signal.entry - price) / signal.entry) * 100;
          const pnlStr = (isFinite(rawPnl) ? rawPnl.toFixed(2) : "0.00") + "%";

          try {
            await persistExit({
              id: signal.id,
              pair: signal.pair,
              direction: signal.direction,
              entry: signal.entry,
              exitPrice: price,
              pnl: parseFloat(pnlStr),
              reason,
              timestamp: now,
            });
          } catch (e) {}

          try {
            await sendExitAlert(signal, price, reason);
          } catch (e) {}
        }
      }
    }
    activeSignals = active;
  } catch (e) {
    errors.push("filterExpired: " + e);
  }

  // ─── Clean & Save State ───────────────────────────────────

  const cleaned = activeSignals.filter(
    (s) => !s.exited || now - s.timestamp < EXITED_TTL_MS
  );
  const pruned = activeSignals.length - cleaned.length;

  try {
    await saveActiveSignals(cleaned);
    await setLastCronRun(now);
  } catch (e) {
    errors.push("save state: " + e);
  }

  // ─── Save Dashboard Snapshot ──────────────────────────────

  const dashboardSnapshot = {
    timestamp: now,
    iso: new Date(now).toISOString(),
    markets: marketSnapshots,
    activeSignals: cleaned.filter((s) => !s.exited && s.status !== "PENDING_EXIT"),
    pendingExits: cleaned.filter((s) => s.status === "PENDING_EXIT"),
    errors: errors.length > 0 ? errors : undefined,
  };

  try {
    await saveDashboardSnapshot(dashboardSnapshot);
  } catch (e) {
    errors.push("save snapshot: " + e);
  }

  // ─── Summary ──────────────────────────────────────────────

  const activeTrades = cleaned.filter((s) => !s.exited && s.status !== "PENDING_EXIT");
  const pendingExits = cleaned.filter((s) => s.status === "PENDING_EXIT");
  console.log(
    "[CRON] FINISHED | Active trades: " + activeTrades.length + " | Pending exits: " + pendingExits.length
  );
  for (const pair of PAIRS) {
    const r = results[pair];
    if (r?.status === "HOLDING")
      console.log(`[CRON]   📊 ${pair} | HOLDING | ${r.phase} | ${r.pnl}`);
    else if (r?.status === "PENDING_EXIT")
      console.log(`[CRON]   ⏳ ${pair} | PENDING EXIT | ${r.reason} | ${r.pnl}`);
    else if (r?.status === "SIGNAL")
      console.log(
        `[CRON]   🔔 ${pair} | SIGNAL | ${r.direction} | Entry:$${r.entry.toFixed(2)} | ${r.entryType}`
      );
    else if (r?.status === "EXITED")
      console.log(`[CRON]   🚪 ${pair} | EXITED | ${r.reason} | ${r.pnl} | ${r.phase}`);
    else if (r?.status === "BLOCKED")
      console.log(`[CRON]   🛡️ ${pair} | BLOCKED | ${r.reason}`);
    else if (r?.status === "NO_SIGNAL") console.log(`[CRON]   ⏸️ ${pair} | NO SIGNAL`);
    else if (r?.status === "ERROR") console.log(`[CRON]   ❌ ${pair} | ERROR: ${r.error}`);
  }

  return NextResponse.json({
    ok: true,
    timestamp: now,
    iso: new Date(now).toISOString(),
    results,
    activeTrades: activeTrades.length,
    pendingExits: pendingExits.length,
    prunedExited: pruned || undefined,
    errors: errors.length > 0 ? errors : undefined,
  });
}

export async function POST(req: NextRequest) {
  return GET(req);
}
