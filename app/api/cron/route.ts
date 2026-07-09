// app/api/cron/route.ts — v29.1 CXSwitch cron job
// ============================================================

import { NextRequest, NextResponse } from "next/server";
import {
  generateSignal,
  shouldHold,
  filterExpiredSignals,
  loadExits,
  setRegimePersistence,
  setExitPersistence,
  updateTradeManager,
  Signal,
} from "@/lib/strategy";
import { getCandles, getCurrentPrice, krakenPairFormat } from "@/lib/kraken";
import { sendAlert, sendExitAlert, alertStatus, alertNoSignal, alertError } from "@/lib/telegram";
import {
  saveActiveSignals,
  loadActiveSignals,
  persistRegime,
  loadRegime,
  persistExit,
  loadExits as loadExitsState,
  setLastCronRun,
} from "@/lib/state";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ─── Config ───

const PAIRS = ["BTC/USD", "ETH/USD", "SOL/USD", "HYPE/USD"];
const CRON_SECRET = process.env.CRON_SECRET;

// Initialize persistence hooks
setRegimePersistence(persistRegime, loadRegime);
setExitPersistence(persistExit, loadExitsState);

// ─── Main handler ───

export async function GET(req: NextRequest) {
  // Auth check
  const authHeader = req.headers.get("authorization");
  const secret = req.nextUrl.searchParams.get("secret");
  const token = authHeader?.replace("Bearer ", "") || secret;

  if (CRON_SECRET && token !== CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const now = Date.now();
  const results: Record<string, any> = {};
  const errors: string[] = [];

  try { await loadExits(); } catch (e) { errors.push(`loadExits: ${e}`); }

  let activeSignals: Signal[] = [];
  try { activeSignals = await loadActiveSignals(); } catch (e) { errors.push(`loadActiveSignals: ${e}`); }

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

      const activeForPair = activeSignals.find(s => s.pair === pair && !s.exited);

      if (activeForPair) {
        // ─── MANAGE EXISTING TRADE ───
        const holdResult = await shouldHold(activeForPair, candles4h, price, now);

        if (!holdResult.shouldHold) {
          await sendExitAlert(activeForPair, price, holdResult.reason);
          activeForPair.exited = true;
          results[pair] = { status: "EXITED", reason: holdResult.reason, price };
        } else {
          const tm = updateTradeManager(activeForPair, price);
          activeForPair.highestPrice = tm.highestPrice;
          activeForPair.lowestPrice = tm.lowestPrice;
          activeForPair.tradeState = tm.newState;
          activeForPair.lockedStop = tm.lockedStop;
          activeForPair.profitLockActive = tm.profitLockActive;

          const pnl = activeForPair.direction === "LONG"
            ? ((price - activeForPair.entry) / activeForPair.entry * 100).toFixed(2) + "%"
            : ((activeForPair.entry - price) / activeForPair.entry * 100).toFixed(2) + "%";

          results[pair] = { status: "HOLDING", state: tm.newState, lockedStop: tm.lockedStop, pnl };
        }
      } else {
        // ─── GENERATE NEW SIGNAL ───
        const activeTrades: Record<string, any> = {};
        for (const s of activeSignals) { if (!s.exited) activeTrades[s.pair] = s; }

        const result = await generateSignal(pair, candles1h, candles4h, candles15m, activeTrades, price);

        if (result.signal) {
          const signal = result.signal;
          activeSignals.push(signal);
          await sendAlert(signal);
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
          results[pair] = { status: "NO_SIGNAL", trend: result.market?.trend, debug: result.debug };

          const regime = result.market?.regime;
          if (regime && (regime.strength === "STRONG" || regime.strength === "MODERATE")) {
            await alertNoSignal(pair, result.market, result.debug || []);
          }
        }
      }
    } catch (err) {
      const msg = String(err);
      errors.push(`${pair}: ${msg}`);
      results[pair] = { status: "ERROR", error: msg };
      await alertError(`cron/${pair}`, err);
    }
  }

  // ─── Filter expired ───
  try {
    const { active, exited } = await filterExpiredSignals(activeSignals, currentPrices, now);
    for (const { signal, reason } of exited) {
      if (!signal.exited) {
        const price = currentPrices[signal.pair] || signal.entry;
        await sendExitAlert(signal, price, reason);
        signal.exited = true;
      }
    }
    activeSignals = active;
  } catch (e) {
    errors.push(`filterExpiredSignals: ${e}`);
  }

  // ─── Save state ───
  try {
    await saveActiveSignals(activeSignals);
    await setLastCronRun(now);
  } catch (e) {
    errors.push(`save state: ${e}`);
  }

  // Status every 6 hours
  const hour = new Date(now).getUTCHours();
  if (hour % 6 === 0) {
    await alertStatus(activeSignals, currentPrices);
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
