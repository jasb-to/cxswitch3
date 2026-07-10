// app/api/cron/route.ts — v32 CXSwitch cron job
// ============================================================

import { NextRequest, NextResponse } from "next/server";
import {
  generateSignalAsync,
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

setRegimePersistence(persistRegime, loadRegime);
setExitPersistence(persistExit, loadExitsState);

/** Migrate old signal format to v32 */
function migrateSignal(signal: any): Signal {
  if (!signal) return signal;
  return {
    ...signal,
    exited: signal.exited ?? false,
    highestPrice: signal.highestPrice ?? signal.entry,
    lowestPrice: signal.lowestPrice ?? signal.entry,
    tradeState: signal.tradeState ?? "OPEN",
    lockedStop: signal.lockedStop ?? undefined,
    profitLockActive: signal.profitLockActive ?? false,
    entryTier: signal.entryTier ?? (signal.scale === "ADD" ? "CONFIRMED_ENTRY" : signal.scale ? "EARLY_ENTRY" : null),
    entryMode: signal.entryMode ?? (signal.scale === "ADD" ? "BREAKOUT" : "PULLBACK"),
    positionSizePct: signal.positionSizePct ?? (signal.scale === "ADD" ? 0.05 : 0.03),
    regimeDirection: signal.regimeDirection ?? signal.direction,
  };
}

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

  console.log("[CRON] Started");
  const now = Date.now();
  const results: Record<string, any> = {};
  const errors: string[] = [];

  let activeSignals: Signal[] = [];
  try {
    const loaded = await loadActiveSignals();
    activeSignals = loaded.map(migrateSignal);
  } catch (e) {
    errors.push("loadActiveSignals: " + e);
  }

  const currentPrices: Record<string, number> = {};
  const signalResults: Record<string, SignalResult> = {};
  const marketSnapshots: any[] = [];

  for (const pair of PAIRS) {
    results[pair] = { status: "pending" };

    try {
      const krakenPair = krakenPairFormat(pair);
      if (!krakenPair) {
        throw new Error(`krakenPairFormat returned empty for ${pair}`);
      }

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
          const holdResult = shouldHold(signal, candles4h, price, now);

          if (!holdResult.shouldHold) {
            try {
              await sendExitAlert(signal, price, holdResult.reason);
            } catch (alertErr) {
              console.error("[CRON] sendExitAlert failed:", alertErr);
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
        // ─── STEP 2: Generate new signal ───
        const result = await generateSignalAsync(pair, candles1h, candles4h, candles15m, price);
        signalResults[pair] = result;

        if (result.signal) {
          const signal = migrateSignal(result.signal);
          activeSignals.push(signal);

          // Only send Telegram for ENTRY_1 and ADD (not ENTRY_2)
          if (signal.scale !== "ENTRY_2") {
            try {
              await sendAlert(signal);
            } catch (alertErr) {
              console.error("[CRON] sendAlert failed:", alertErr);
            }
          }
          console.log("[" + (signal.scale || "SIGNAL") + "] " + pair + " | " + signal.direction + " | conf=" + signal.confidence + "% | entry=" + signal.entry.toFixed(2));

          results[pair] = {
            status: "SIGNAL",
            direction: signal.direction,
            confidence: signal.confidence,
            entry: signal.entry,
            stop: signal.stop,
            target: signal.target,
            rr: signal.rr,
            scale: signal.scale,
          };
        } else {
          results[pair] = { status: "NO_SIGNAL", debug: result.debug };
        }
      }

      // ─── STEP 3: Build snapshot ───
      const snapshot = getMarketSnapshot(pair, candles1h, candles4h, [], price, signalResults[pair]);
      marketSnapshots.push(snapshot);

    } catch (err) {
      const msg = String(err);
      errors.push(pair + ": " + msg);
      results[pair] = { status: "ERROR", error: msg };
      try {
        await alertError("cron/" + pair, err);
      } catch {}
    }
  }

  // ─── STEP 4: Filter expired ───
  try {
    const { active, exited } = filterExpiredSignals(activeSignals, currentPrices, now);
    for (const { signal, reason } of exited) {
      if (!signal.exited) {
        const price = currentPrices[signal.pair] || signal.entry;
        try {
          await sendExitAlert(signal, price, reason);
        } catch {}
        signal.exited = true;
      }
    }
    activeSignals = active;
  } catch (e) {
    errors.push("filterExpiredSignals: " + e);
  }

  // ─── STEP 5: Save state ───
  try {
    await saveActiveSignals(activeSignals);
    await setLastCronRun(now);
  } catch (e) {
    errors.push("save state: " + e);
  }

  // ─── STEP 6: Dashboard snapshot ───
  const dashboardSnapshot = {
    timestamp: now,
    iso: new Date(now).toISOString(),
    markets: marketSnapshots,
    activeSignals: activeSignals.filter(s => !s.exited),
    errors: errors.length > 0 ? errors : undefined,
  };

  try {
    await saveDashboardSnapshot(dashboardSnapshot);
    console.log("[CRON] Finished | Active trades: " + activeSignals.filter(s => !s.exited).length);
  } catch (e) {
    errors.push("saveDashboardSnapshot: " + e);
  }

  return NextResponse.json({
    ok: true,
    timestamp: now,
    iso: new Date(now).toISOString(),
    results,
    activeTrades: activeSignals.filter(s => !s.exited).length,
    errors: errors.length > 0 ? errors : undefined,
  });
}

export async function POST(req: NextRequest) {
  return GET(req);
}
