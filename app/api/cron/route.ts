// app/api/cron/route.ts — v29.3 CXSwitch cron job (VERBOSE LOGGING)
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

  console.log("[CRON] ═══════════════════════════════════════════════════");
  console.log("[CRON] STARTED | " + new Date().toISOString());
  console.log("[CRON] Pairs: " + PAIRS.join(", "));
  console.log("[CRON] ═══════════════════════════════════════════════════");

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

    console.log(`[CRON] ─── ${pair} ───`);

    try {
      const [candles1h, candles4h, candles15m, price] = await Promise.all([
        getCandles(krakenPair, 60),
        getCandles(krakenPair, 240),
        getCandles(krakenPair, 15),
        getCurrentPrice(krakenPair),
      ]);

      currentPrices[pair] = price;
      console.log(`[CRON] ${pair} | Price: $${price.toFixed(2)} | 1H: ${candles1h.length} | 4H: ${candles4h.length} | 15m: ${candles15m.length}`);

      // ─── STEP 1: Manage existing positions ───
      const activeForPair = activeSignals.filter(s => s.pair === pair && !s.exited);

      if (activeForPair.length > 0) {
        console.log(`[CRON] ${pair} | Found ${activeForPair.length} active trade(s)`);

        for (const signal of activeForPair) {
          console.log(`[CRON] ${pair} | Trade ID: ${signal.id} | Dir: ${signal.direction} | Entry: $${signal.entry.toFixed(2)} | Stop: $${signal.stop.toFixed(2)} | Target: $${signal.target.toFixed(2)}`);

          const holdResult = await shouldHold(signal, candles4h, price);
          console.log(`[CRON] ${pair} | shouldHold: ${holdResult.shouldHold} | reason: ${holdResult.reason}`);

          if (!holdResult.shouldHold) {
            // ─── EXIT ───
            const rawPnl = signal.direction === "LONG"
              ? ((price - signal.entry) / signal.entry * 100)
              : ((signal.entry - price) / signal.entry * 100);
            const pnlStr = (isFinite(rawPnl) ? rawPnl.toFixed(2) : "0.00") + "%";

            console.log(`[CRON] ${pair} | ⚠️ EXITING | Reason: ${holdResult.reason} | Exit: $${price.toFixed(2)} | PnL: ${pnlStr}`);

            try {
              await sendExitAlert(signal, price, holdResult.reason);
            } catch (alertErr) {
              console.error("[CRON] sendExitAlert failed for", signal.id, ":", alertErr);
            }
            signal.exited = true;
            results[pair] = { status: "EXITED", reason: holdResult.reason, price, signalId: signal.id, pnl: pnlStr };
          } else {
            // ─── HOLDING ───
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

            console.log(`[CRON] ${pair} | ✅ HOLDING | State: ${tm.newState} | PnL: ${pnl} | High: $${tm.highestPrice.toFixed(2)} | Low: $${tm.lowestPrice.toFixed(2)} | ProfitLock: ${tm.profitLockActive} | LockedStop: ${tm.lockedStop ? "$" + tm.lockedStop.toFixed(2) : "none"}`);

            results[pair] = { status: "HOLDING", state: tm.newState, lockedStop: tm.lockedStop, pnl, signalId: signal.id };
          }
        }
      } else {
        // ─── STEP 2: Generate new signal (ONCE) ───
        console.log(`[CRON] ${pair} | No active trades — evaluating for new signal`);

        const result = await generateSignal(pair, candles1h, candles4h, candles15m, price);
        signalResults[pair] = result;

        if (result.debug && result.debug.length > 0) {
          console.log(`[CRON] ${pair} | Debug: ${result.debug.join(" | ")}`);
        }

        if (result.signal) {
          const signal = result.signal;
          activeSignals.push(signal);

          console.log(`[CRON] ${pair} | 🔔 SIGNAL | ${signal.direction} ${signal.type} ${signal.scale} | Entry: $${signal.entry.toFixed(2)} | Stop: $${signal.stop.toFixed(2)} | Target: $${signal.target.toFixed(2)} | RR: ${signal.rr.toFixed(2)} | Conf: ${signal.confidence}% | Tier: ${signal.entryTier}`);

          // Only send Telegram for actionable tiers
          if (signal.entryTier !== "NO_TRADE") {
            try {
              await sendAlert(signal);
            } catch (alertErr) {
              console.error("[CRON] sendAlert failed for", signal.id, ":", alertErr);
            }
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
          console.log(`[CRON] ${pair} | ⏸️ NO SIGNAL`);
          results[pair] = { status: "NO_SIGNAL" };
        }
      }

      // ─── STEP 3: Build snapshot ───
      const snapshot = await getMarketSnapshot(
        pair,
        candles1h,
        candles4h,
        candles15m,
        price,
        signalResults[pair]
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
        snapshot.regime.direction = activeSignal.direction;
        snapshot.regime.strength = "ACTIVE";
        snapshot.regime.confidence = activeSignal.confidence;
        snapshot.recommendedAction = activeSignal.direction + " HOLDING";
        snapshot.entryTier = activeSignal.entryTier;
        snapshot.positionSize = activeSignal.positionSizePct
          ? (activeSignal.positionSizePct * 100).toFixed(0) + "%"
          : null;
      }

      // Log snapshot summary for this pair
      const snap = snapshot;
      console.log(`[CRON] ${pair} | Snapshot → Trend: ${snap.trend} | ADX: ${snap.adx} | RSI: ${snap.rsi} | Stoch4H: ${snap.stochK}/${snap.stochD} | Stoch1H: ${snap.stoch1hK}/${snap.stoch1hD} | Phase1H: ${snap.phase1h} | Phase4H: ${snap.phase4h}`);

      marketSnapshots.push(snapshot);

    } catch (err) {
      const msg = String(err);
      errors.push(pair + ": " + msg);
      results[pair] = { status: "ERROR", error: msg };
      console.error(`[CRON] ${pair} | ❌ ERROR: ${msg}`);
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
    if (exited.length > 0) {
      console.log(`[CRON] Filtered ${exited.length} expired signal(s)`);
      for (const { signal, reason } of exited) {
        if (!signal.exited) {
          const price = currentPrices[signal.pair] || signal.entry;
          console.log(`[CRON] ${signal.pair} | Auto-exit: ${reason} | Signal: ${signal.id}`);
          try {
            await sendExitAlert(signal, price, reason);
          } catch (alertErr) {
            console.error("[CRON] sendExitAlert (filterExpired) failed for", signal.id, ":", alertErr);
          }
          signal.exited = true;
        }
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
  if (prunedCount > 0) {
    console.log(`[CRON] Pruned ${prunedCount} old exited signal(s)`);
  }

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
  } catch (e) {
    console.error("[CRON] saveDashboardSnapshot failed:", e);
    errors.push("saveDashboardSnapshot: " + e);
  }

  // ─── FINAL SUMMARY ───
  const activeTrades = cleanedSignals.filter(s => !s.exited);
  console.log("[CRON] ═══════════════════════════════════════════════════");
  console.log("[CRON] FINISHED | " + new Date().toISOString());
  console.log("[CRON] Markets evaluated: " + PAIRS.length);
  console.log("[CRON] Active trades: " + activeTrades.length);

  for (const pair of PAIRS) {
    const r = results[pair];
    if (r?.status === "HOLDING") {
      console.log(`[CRON]   📊 ${pair} | HOLDING | PnL: ${r.pnl} | State: ${r.state}`);
    } else if (r?.status === "SIGNAL") {
      console.log(`[CRON]   🔔 ${pair} | SIGNAL | ${r.direction} | Entry: $${r.entry.toFixed(2)} | RR: ${r.rr.toFixed(2)}`);
    } else if (r?.status === "EXITED") {
      console.log(`[CRON]   🚪 ${pair} | EXITED | Reason: ${r.reason} | PnL: ${r.pnl}`);
    } else if (r?.status === "NO_SIGNAL") {
      console.log(`[CRON]   ⏸️ ${pair} | NO SIGNAL`);
    } else if (r?.status === "ERROR") {
      console.log(`[CRON]   ❌ ${pair} | ERROR: ${r.error}`);
    }
  }

  if (errors.length > 0) {
    console.log("[CRON] Errors: " + errors.length);
    for (const err of errors) {
      console.log("[CRON]   ⚠️ " + err);
    }
  }
  console.log("[CRON] ═══════════════════════════════════════════════════");

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
    activeTrades: activeTrades.length,
    prunedExited: prunedCount || undefined,
    errors: errors.length > 0 ? errors : undefined,
  });
}

export async function POST(req: NextRequest) {
  return GET(req);
}
 
