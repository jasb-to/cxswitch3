// app/api/cron/route.ts — v29.2 CXSwitch cron job (ACTIVE TRADE FIX)
// ============================================================
// This is the ONLY place that evaluates markets, generates signals,
// manages exits, and computes dashboard snapshots.
//
// /api/signals is READ-ONLY. It never calls strategy functions.

import { NextRequest, NextResponse } from "next/server";
import {
  generateSignal,
  shouldHold,
  filterExpiredSignals,
  loadExits,
  setRegimePersistence,
  setExitPersistence,
  updateTradeManagerCompat,
  getMarketSnapshot,
  Signal,
  SignalResult,
} from "@/lib/strategy";
import { getCandles, getCurrentPrice, krakenPairFormat } from "@/lib/kraken";
import { sendAlert, sendExitAlert, alertStatus, alertError } from "@/lib/telegram";
import {
  saveActiveSignals,
  loadActiveSignals,
  persistRegime,
  loadRegime,
  persistExit,
  loadExits as loadExitsState,
  setLastCronRun,
  saveDashboardSnapshot,
} from "@/lib/state";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PAIRS = ["BTC/USD", "ETH/USD", "SOL/USD", "HYPE/USD"];
const CRON_SECRET = process.env.CRON_SECRET;
const DEBUG = process.env.DEBUG === "true";

// Max age of exited signals to keep in state (7 days)
const EXITED_SIGNAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;

setRegimePersistence(persistRegime, loadRegime);
setExitPersistence(persistExit, loadExitsState);

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  const secret = req.nextUrl.searchParams.get("secret");
  const token = authHeader?.replace("Bearer ", "") || secret;

  if (!CRON_SECRET) {
    console.error("[CRON] CRON_SECRET environment variable is not set");
    return NextResponse.json({ error: "Server misconfiguration: CRON_SECRET not set" }, { status: 500 });
  }

  if (!token) {
    console.warn("[CRON] Rejected — no secret provided");
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  if (token !== CRON_SECRET) {
    console.warn("[CRON] Rejected — invalid secret provided");
    return NextResponse.json({ error: "Invalid secret" }, { status: 401 });
  }

  console.log("[CRON] Started");

  const now = Date.now();
  const results: Record<string, any> = {};
  const errors: string[] = [];

  try {
    await loadExits();
  } catch (e) {
    errors.push("loadExits: " + e);
    if (DEBUG) console.warn("[CRON] loadExits failed (non-fatal):", e);
  }

  let activeSignals: Signal[] = [];
  try {
    activeSignals = await loadActiveSignals();
  } catch (e) {
    errors.push("loadActiveSignals: " + e);
    console.error("[CRON] loadActiveSignals failed:", e);
  }

  const currentPrices: Record<string, number> = {};
  const signalResults: Record<string, SignalResult> = {};
  const marketSnapshots = [];

  for (const pair of PAIRS) {
    const krakenPair = krakenPairFormat(pair);
    results[pair] = { status: "pending" };

    try {
      const [candles1h, candles4h, candles15m, price] = await Promise.all([
        getCandles(krakenPair, 60),
        getCandles(krakenPair, 240),
        getCandles(krakenPair, 15),
        getCurrentPrice(krakenPair),
      ]);

      currentPrices[pair] = price;

      // ─── STEP 1: Manage existing positions ───
      const activeForPair = activeSignals.filter(s => s.pair === pair && !s.exited);

      if (activeForPair.length > 0) {
        for (const signal of activeForPair) {
          const holdResult = await shouldHold(signal, candles4h, price);

          if (!holdResult.shouldHold) {
            try {
              await sendExitAlert(signal, price, holdResult.reason);
            } catch (alertErr) {
              console.error("[CRON] sendExitAlert failed for", signal.id, ":", alertErr);
            }
            signal.exited = true;
            results[pair] = { status: "EXITED", reason: holdResult.reason, price, signalId: signal.id };
            console.log("[EXIT] " + pair + " | " + signal.direction + " | " + holdResult.reason + " | $" + price.toFixed(2));
          } else {
            const tm = updateTradeManagerCompat(signal, price);
            signal.highestPrice = tm.highestPrice;
            signal.lowestPrice = tm.lowestPrice;
            signal.tradeState = tm.newState;
            signal.lockedStop = tm.lockedStop;
            signal.profitLockActive = tm.profitLockActive;

            const rawPnl = signal.direction === "LONG"
              ? ((price - signal.entry) / signal.entry * 100)
              : ((signal.entry - price) / signal.entry * 100);
            const pnl = (isFinite(rawPnl) ? rawPnl.toFixed(2) : "0.00") + "%";

            results[pair] = { status: "HOLDING", state: tm.newState, lockedStop: tm.lockedStop, pnl, signalId: signal.id };
          }
        }
      } else {
        // ─── STEP 2: Generate new signal (ONCE) ───
        const result = await generateSignal(pair, candles1h, candles4h, candles15m, price);
        signalResults[pair] = result;

        if (result.signal) {
          const signal = result.signal;
          activeSignals.push(signal);

          // Only send Telegram for actionable tiers
          if (signal.entryTier !== "NO_TRADE") {
            try {
              await sendAlert(signal);
            } catch (alertErr) {
              console.error("[CRON] sendAlert failed for", signal.id, ":", alertErr);
            }
            console.log("[" + signal.entryTier.replace("_", " ") + "] " + pair + " | " + signal.direction + " | conf=" + signal.confidence.toFixed(1) + "% | entry=" + signal.entry.toFixed(2) + " | size=" + (signal.positionSizePct * 100).toFixed(0) + "%");
          }

          results[pair] = {
            status: "SIGNAL",
            direction: signal.direction,
            confidence: signal.confidence,
            entry: signal.entry,
            stop: signal.stop,
            target: signal.target,
            rr: signal.rr,
            mode: signal.entryMode,
            entryTier: signal.entryTier,
            positionSizePct: signal.positionSizePct,
          };
        } else {
          results[pair] = { status: "NO_SIGNAL" };
        }
      }

      // ─── STEP 3: Build snapshot ───
      // For active trades, signalResults[pair] is undefined. getMarketSnapshot still
      // computes regime from candles. We then overlay active-trade data so the
      // dashboard card knows a position is open.
      const snapshot = await getMarketSnapshot(
        pair,
        candles1h,
        candles4h,
        candles15m,
        price,
        signalResults[pair] // undefined when trade is active
      );

      // FIX v29.2: Overlay active-trade state onto the snapshot
      if (results[pair]?.status === "HOLDING" && activeForPair.length > 0) {
        const activeSignal = activeForPair[0];
        snapshot.activeTrade = {
          signalId: results[pair].signalId,
          direction: activeSignal.direction,
          state: results[pair].state,
          pnl: results[pair].pnl,
          lockedStop: results[pair].lockedStop,
          entry: activeSignal.entry,
          stop: activeSignal.stop,
          target: activeSignal.target,
          entryTier: activeSignal.entryTier,
          positionSizePct: activeSignal.positionSizePct,
        };
        // Force regime to match trade direction so card doesn't show NEUTRAL
        snapshot.regime.direction = activeSignal.direction;
        snapshot.regime.strength = "ACTIVE";
        snapshot.regime.confidence = activeSignal.confidence;
        snapshot.recommendedAction = activeSignal.direction + " HOLDING";
        snapshot.entryTier = activeSignal.entryTier;
        snapshot.positionSize = activeSignal.positionSizePct
          ? (activeSignal.positionSizePct * 100).toFixed(0) + "%"
          : null;
      }

      marketSnapshots.push(snapshot);

    } catch (err) {
      const msg = String(err);
      errors.push(pair + ": " + msg);
      results[pair] = { status: "ERROR", error: msg };
      try {
        await alertError("cron/" + pair, err);
      } catch (alertErr) {
        console.error("[CRON] alertError failed:", alertErr);
      }
    }
  }

  // Filter expired signals
  try {
    const { active, exited } = await filterExpiredSignals(activeSignals, currentPrices, now);
    for (const { signal, reason } of exited) {
      if (!signal.exited) {
        const price = currentPrices[signal.pair] || signal.entry;
        try {
          await sendExitAlert(signal, price, reason);
        } catch (alertErr) {
          console.error("[CRON] sendExitAlert (filterExpired) failed for", signal.id, ":", alertErr);
        }
        signal.exited = true;
      }
    }
    activeSignals = active;
  } catch (e) {
    errors.push("filterExpiredSignals: " + e);
  }

  // Clean up old exited signals
  const cleanedSignals = activeSignals.filter(s => {
    if (!s.exited) return true;
    const age = now - s.timestamp;
    return age < EXITED_SIGNAL_TTL_MS;
  });
  const prunedCount = activeSignals.length - cleanedSignals.length;

  try {
    await saveActiveSignals(cleanedSignals);
    await setLastCronRun(now);
  } catch (e) {
    errors.push("save state: " + e);
    console.error("[CRON] save state failed:", e);
  }

  // Build and save dashboard snapshot
  const dashboardSnapshot = {
    timestamp: now,
    iso: new Date(now).toISOString(),
    markets: marketSnapshots,
    activeSignals: cleanedSignals.filter(s => !s.exited),
    errors: errors.length > 0 ? errors : undefined,
  };

  try {
    await saveDashboardSnapshot(dashboardSnapshot);
    console.log("[CRON] Finished | Markets: " + PAIRS.length + " | Active trades: " + cleanedSignals.filter(s => !s.exited).length);
  } catch (e) {
    console.error("[CRON] saveDashboardSnapshot failed:", e);
    errors.push("saveDashboardSnapshot: " + e);
  }

  // Daily report only if enabled
  const hour = new Date(now).getUTCHours();
  const sendDailyStatus = process.env.DAILY_STATUS_REPORT === "true";
  if (sendDailyStatus && hour === 0) {
    try {
      await alertStatus(activeSignals, currentPrices);
    } catch (alertErr) {
      console.error("[CRON] alertStatus failed:", alertErr);
    }
  }

  return NextResponse.json({
    ok: true,
    timestamp: now,
    iso: new Date(now).toISOString(),
    results,
    activeTrades: cleanedSignals.filter(s => !s.exited).length,
    prunedExited: prunedCount || undefined,
    errors: errors.length > 0 ? errors : undefined,
  });
}

export async function POST(req: NextRequest) {
  return GET(req);
}
