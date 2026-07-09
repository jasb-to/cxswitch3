// app/api/cron/route.ts — v29.1 CXSwitch cron job (FIXED)
// ============================================================
// This is the ONLY place that evaluates markets, generates signals,
// manages exits, and computes dashboard snapshots.
//
// /api/signals is READ-ONLY. It never calls strategy Functions.

import { NextRequest, NextResponse } from "next/server";
import {
  generateSignal,
  shouldHold,
  filterExpiredSignals,
  loadExits,
  setRegimePersistence,
  setExitPersistence,
  updateTradeManager,
  getMarketSnapshot,
  Signal,
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

// Max age of exited signals to keep in state (7 days)
const EXITED_SIGNAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;

setRegimePersistence(persistRegime, loadRegime);
setExitPersistence(persistExit, loadExitsState);

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  const secret = req.nextUrl.searchParams.get("secret");
  const token = authHeader?.replace("Bearer ", "") || secret;

  // Verify CRON_SECRET is configured
  if (!CRON_SECRET) {
    console.error("[CRON] CRON_SECRET environment variable is not set");
    return NextResponse.json({ error: "Server misconfiguration: CRON_SECRET not set" }, { status: 500 });
  }

  // Verify token was provided
  if (!token) {
    console.warn("[CRON] Rejected — no secret provided (query param or Authorization header missing)");
    return NextResponse.json({ error: "Authentication required. Provide ?secret= or Authorization: Bearer header" }, { status: 401 });
  }

  // Verify token matches
  if (token !== CRON_SECRET) {
    console.warn("[CRON] Rejected — invalid secret provided");
    return NextResponse.json({ error: "Invalid secret" }, { status: 401 });
  }

  console.log("[CRON] Authenticated successfully");

  const now = Date.now();
  const results: Record<string, any> = {};
  const errors: string[] = [];

  try {
    await loadExits();
  } catch (e) {
    errors.push("loadExits: " + e);
    console.warn("[CRON] loadExits failed (non-fatal):", e);
  }

  let activeSignals: Signal[] = [];
  try {
    activeSignals = await loadActiveSignals();
  } catch (e) {
    errors.push("loadActiveSignals: " + e);
    console.error("[CRON] loadActiveSignals failed:", e);
  }

  const currentPrices: Record<string, number> = {};

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

      // Process ALL active signals for this pair, not just the first one
      const activeForPair = activeSignals.filter(s => s.pair === pair && !s.exited);

      if (activeForPair.length > 0) {
        for (const signal of activeForPair) {
          const holdResult = await shouldHold(signal, candles4h, price, now);

          if (!holdResult.shouldHold) {
            // Wrap sendExitAlert in try/catch — mark exited even if Telegram fails
            try {
              await sendExitAlert(signal, price, holdResult.reason);
            } catch (alertErr) {
              console.error("[CRON] sendExitAlert failed for", signal.id, ":", alertErr);
            }
            signal.exited = true;
            results[pair] = { status: "EXITED", reason: holdResult.reason, price, signalId: signal.id };
          } else {
            const tm = updateTradeManager(signal, price);
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
        const result = await generateSignal(pair, candles1h, candles4h, candles15m, price);

        if (result.signal) {
          const signal = result.signal;
          activeSignals.push(signal);
          try {
            await sendAlert(signal);
          } catch (alertErr) {
            console.error("[CRON] sendAlert failed for", signal.id, ":", alertErr);
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
          };
        } else {
          results[pair] = { status: "NO_SIGNAL", trend: result.market?.trend };
          // No NO_SIGNAL alerts — only actionable signals are sent to Telegram
        }
      }
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

  // Clean up old exited signals before saving to prevent unbounded growth
  const cleanedSignals = activeSignals.filter(s => {
    if (!s.exited) return true;
    const age = now - s.timestamp;
    return age < EXITED_SIGNAL_TTL_MS;
  });
  const prunedCount = activeSignals.length - cleanedSignals.length;
  if (prunedCount > 0) {
    console.log("[CRON] Pruned", prunedCount, "old exited signals");
  }

  try {
    await saveActiveSignals(cleanedSignals);
    await setLastCronRun(now);
  } catch (e) {
    errors.push("save state: " + e);
    console.error("[CRON] save state failed:", e);
  }

  // ─── BUILD DASHBOARD SNAPSHOT ───
  // This is the ONLY place that computes market snapshots.
  // /api/signals will read this pre-computed data.

  const marketSnapshots = [];
  for (const pair of PAIRS) {
    try {
      const krakenPair = krakenPairFormat(pair);
      const [candles1h, candles4h, candles15m, price] = await Promise.all([
        getCandles(krakenPair, 60),
        getCandles(krakenPair, 240),
        getCandles(krakenPair, 15),
        getCurrentPrice(krakenPair),
      ]);

      const snapshot = await getMarketSnapshot(pair, candles1h, candles4h, candles15m, price);
      marketSnapshots.push(snapshot);
    } catch (e) {
      console.error(`[CRON] Snapshot failed for ${pair}:`, e);
      // Don't fail the whole cron if one pair's snapshot fails
    }
  }

  const dashboardSnapshot = {
    timestamp: now,
    iso: new Date(now).toISOString(),
    markets: marketSnapshots,
    activeSignals: cleanedSignals.filter(s => !s.exited),
    diagnostics: results,
    errors: errors.length > 0 ? errors : undefined,
  };

  try {
    await saveDashboardSnapshot(dashboardSnapshot);
    console.log("[CRON] Dashboard snapshot saved");
  } catch (e) {
    console.error("[CRON] saveDashboardSnapshot failed:", e);
    errors.push("saveDashboardSnapshot: " + e);
  }

  // Status reports only if DAILY_STATUS_REPORT env var is set, once per day at 00:00 UTC
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
