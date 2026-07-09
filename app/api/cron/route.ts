// app/api/cron/route.ts — v29.1 CXSwitch cron job
// ============================================================
// Triggers: Vercel cron (vercel.json) or external scheduler (e.g. cron-job.org)
// Scans all pairs, generates signals, manages exits, sends Telegram alerts.

import { NextRequest, NextResponse } from "next/server";
import {
  generateSignal,
  shouldHold,
  filterExpiredSignals,
  loadExits,
  setRegimePersistence,
  setExitPersistence,
  getCurrentRegime,
  getPairConfig,
  Signal,
  MarketData,
} from "@/lib/strategy-consolidated";
import { getOHLC, getTicker, krakenPairFormat } from "@/lib/kraken";
import {
  alertSignal,
  alertExit,
  alertStatus,
  alertNoSignal,
  alertError,
  alertWarning,
} from "@/lib/telegram";
import {
  saveActiveSignals,
  loadActiveSignals,
  persistRegime,
  loadRegime,
  persistExit,
  loadExits as loadExitsState,
  setLastCronRun,
} from "@/lib/state";

// ─── Config ───

const PAIRS = ["BTC/USD", "ETH/USD", "SOL/USD", "HYPE/USD"];
const CRON_SECRET = process.env.CRON_SECRET;

// Initialize persistence hooks
setRegimePersistence(persistRegime, loadRegime);
setExitPersistence(persistExit, loadExitsState);

// ─── Candle helpers ───

function krakenCandlesToStrategy(candles: any[]): any[] {
  return candles.map(c => ({
    timestamp: c.time * 1000,
    open: parseFloat(c.open),
    high: parseFloat(c.high),
    low: parseFloat(c.low),
    close: parseFloat(c.close),
    volume: parseFloat(c.volume),
  }));
}

// ─── Main handler ───

export async function GET(req: NextRequest) {
  // Auth check for external cron triggers
  const authHeader = req.headers.get("authorization");
  const secret = req.nextUrl.searchParams.get("secret");
  const token = authHeader?.replace("Bearer ", "") || secret;

  if (CRON_SECRET && token !== CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const now = Date.now();
  const results: Record<string, any> = {};
  const errors: string[] = [];

  try {
    await loadExits();
  } catch (e) {
    errors.push(`loadExits failed: ${e}`);
  }

  // Load active trades
  let activeSignals: Signal[] = [];
  try {
    activeSignals = await loadActiveSignals();
  } catch (e) {
    errors.push(`loadActiveSignals failed: ${e}`);
  }

  const currentPrices: Record<string, number> = {};

  for (const pair of PAIRS) {
    const krakenPair = krakenPairFormat(pair);
    results[pair] = { status: "pending", debug: [] as string[] };

    try {
      // Fetch candles
      const [candles1hRaw, candles4hRaw, candles15mRaw, ticker] = await Promise.all([
        getOHLC(krakenPair, 60),
        getOHLC(krakenPair, 240),
        getOHLC(krakenPair, 15),
        getTicker(krakenPair),
      ]);

      currentPrices[pair] = ticker.price;

      const candles1h = krakenCandlesToStrategy(candles1hRaw);
      const candles4h = krakenCandlesToStrategy(candles4hRaw);
      const candles15m = krakenCandlesToStrategy(candles15mRaw);

      // Check if we have an active trade for this pair
      const activeForPair = activeSignals.find(s => s.pair === pair && !s.exited);

      if (activeForPair) {
        // ─── MANAGE EXISTING TRADE ───
        const holdResult = await shouldHold(activeForPair, candles4h, ticker.price, now);

        if (!holdResult.shouldHold) {
          // EXIT triggered
          await alertExit(activeForPair, ticker.price, holdResult.reason);
          activeForPair.exited = true;
          results[pair] = { status: "EXITED", reason: holdResult.reason, price: ticker.price };
        } else {
          // Update trade manager state
          const { updateTradeManager } = await import("@/lib/strategy-consolidated");
          const tm = updateTradeManager(activeForPair, ticker.price);

          // Update highest/lowest tracking
          activeForPair.highestPrice = tm.highestPrice;
          activeForPair.lowestPrice = tm.lowestPrice;
          activeForPair.tradeState = tm.newState;
          activeForPair.lockedStop = tm.lockedStop;
          activeForPair.profitLockActive = tm.profitLockActive;

          results[pair] = {
            status: "HOLDING",
            state: tm.newState,
            lockedStop: tm.lockedStop,
            pnl: activeForPair.direction === "LONG"
              ? ((ticker.price - activeForPair.entry) / activeForPair.entry * 100).toFixed(2) + "%"
              : ((activeForPair.entry - ticker.price) / activeForPair.entry * 100).toFixed(2) + "%",
          };
        }
      } else {
        // ─── GENERATE NEW SIGNAL ───
        const result = await generateSignal(pair, candles1h, candles4h, candles15m, {}, ticker.price);

        if (result.signal) {
          const signal = result.signal;
          activeSignals.push(signal);
          await alertSignal(signal);
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
          results[pair] = {
            status: "NO_SIGNAL",
            trend: result.market?.trend,
            debug: result.debug,
          };

          // Only send "no signal" alert if regime is strong (reduce noise)
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

  // ─── Filter expired / exited signals ───
  try {
    const { active, exited } = await filterExpiredSignals(activeSignals, currentPrices, now);

    for (const { signal, reason } of exited) {
      if (!signal.exited) {
        const price = currentPrices[signal.pair] || signal.entry;
        await alertExit(signal, price, reason);
        signal.exited = true;
      }
    }

    activeSignals = active;
  } catch (e) {
    errors.push(`filterExpiredSignals failed: ${e}`);
  }

  // ─── Save state ───
  try {
    await saveActiveSignals(activeSignals);
    await setLastCronRun(now);
  } catch (e) {
    errors.push(`save state failed: ${e}`);
  }

  // ─── Send daily status (every 6th run ≈ every 6 hours if hourly) ───
  const hour = new Date(now).getUTCHours();
  if (hour % 6 === 0) {
    await alertStatus(activeSignals, currentPrices);
  }

  return NextResponse.json({
    ok: true,
    timestamp: now,
    iso: new Date(now).toISOString(),
    results,
    activeTrades: activeSignals.length,
    errors: errors.length > 0 ? errors : undefined,
  });
}

// POST handler for webhook-style cron triggers (e.g. cron-job.org)
export async function POST(req: NextRequest) {
  return GET(req);
}
