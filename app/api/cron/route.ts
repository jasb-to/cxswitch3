import { NextRequest, NextResponse } from "next/server";
import {
  generateSignalCompat as generateSignal,
  shouldHoldCompat as shouldHold,
  filterExpiredSignals,
  getMarketSnapshot,
  aggregateTo1D,
  Signal,
  SignalResult,
} from "@/lib/strategy";
import {
  saveActiveSignals,
  loadActiveSignals,
  setLastCronRun,
  saveDashboardSnapshot,
  persistExit,
} from "@/lib/state";
import { getCandles, getCurrentPrice, krakenPairFormat } from "@/lib/kraken";
import { sendAlert, sendExitAlert, alertError } from "@/lib/telegram";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PAIRS = ["BTC/USD", "ETH/USD", "SOL/USD", "HYPE/USD"];
const CRON_SECRET = process.env.CRON_SECRET;
const EXITED_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export async function GET(req: NextRequest) {
  // ─── Health check / debug ───────────────────────────────
  const { searchParams } = new URL(req.url);
  if (searchParams.get("health") === "1") {
    return NextResponse.json({ ok: true, version: 46.1, ts: Date.now() });
  }

  try {
    const authHeader = req.headers.get("authorization");
    const secret = searchParams.get("secret");
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

    let activeSignals: Signal[] = [];
    try {
      activeSignals = await loadActiveSignals();
    } catch (e) {
      errors.push("loadActiveSignals: " + e);
    }
    if (!Array.isArray(activeSignals)) activeSignals = [];

    activeSignals = activeSignals.filter(
      s => !s.exited || now - (s.exitTimestamp || s.timestamp) < EXITED_TTL_MS
    );

    const currentPrices: Record<string, number> = {};
    const signalResults: Record<string, SignalResult> = {};
    const marketSnapshots: any[] = [];

    for (const pair of PAIRS) {
      const krakenPair = krakenPairFormat(pair);
      results[pair] = { status: "pending" };

      try {
        const [candles1h, candles4h, candles15m, candles1dRaw, price] = await Promise.all([
          getCandles(krakenPair, 60),
          getCandles(krakenPair, 240),
          getCandles(krakenPair, 15),
          getCandles(krakenPair, 1440),
          getCurrentPrice(krakenPair),
        ]);

        currentPrices[pair] = price;
        const candles1d = candles1dRaw?.length ? candles1dRaw : aggregateTo1D(candles4h);

        const activeForPair = activeSignals.filter(s => s.pair === pair && !s.exited);

        // ─── Manage Active Trades ─────────────────────────────
        if (activeForPair.length > 0) {
          for (const signal of activeForPair) {
            const rawPnl = signal.direction === "LONG"
              ? ((price - signal.entry) / signal.entry) * 100
              : ((signal.entry - price) / signal.entry) * 100;
            const pnlStr = (isFinite(rawPnl) ? rawPnl.toFixed(2) : "0.00") + "%";
            const risk = Math.abs(signal.entry - signal.stop);
            const currentR = risk > 0 ? (signal.direction === "LONG" ? (price - signal.entry) / risk : (signal.entry - price) / risk) : 0;
            const phase = currentR >= 2 ? "TRAILING" : currentR >= 1 ? "BUILDING" : "ENTRY";
            const nextMilestone = currentR < 1 ? "1R" : currentR < 2 ? "2R" : currentR < 3 ? "Target" : "Target reached";

            console.log(`[CRON] ${pair} | ACTIVE TRADE | ${signal.direction} | P&L ${pnlStr} | R ${currentR.toFixed(2)} | Phase ${phase} | Next ${nextMilestone}`);
            results[pair] = { status: "HOLDING", pnl: pnlStr, signalId: signal.id, currentR: currentR.toFixed(2), phase, nextMilestone };
          }
        } else {
          // ─── Evaluate New Signals ───────────────────────────
          const result = await generateSignal(pair, candles1h, candles4h, candles1d, candles15m, activeSignals, price);
          signalResults[pair] = result || { debug: [] };

          if (result?.debug?.length) {
            for (const line of result.debug) {
              console.log(`[CRON] ${pair} | ${line}`);
            }
          }

          if (result?.signal) {
            const signal = result.signal;
            activeSignals.push(signal);
            console.log(
              `[CRON] ${pair} | SIGNAL | ${signal.direction} | Entry:$${signal.entry.toFixed(2)} | SL:$${signal.stop.toFixed(2)} | TP:$${signal.target.toFixed(2)} | RR:${signal.rr.toFixed(2)} | ${signal.primaryTrigger}+${signal.confirmation}`
            );
            try { await sendAlert(signal); } catch (e) {}
            results[pair] = {
              status: "SIGNAL",
              direction: signal.direction,
              entry: signal.entry,
              stop: signal.stop,
              target: signal.target,
              rr: signal.rr.toFixed(2),
              primaryTrigger: signal.primaryTrigger,
              confirmation: signal.confirmation,
            };
          } else {
            console.log(`[CRON] ${pair} | NO SIGNAL`);
            results[pair] = { status: "NO_SIGNAL" };
          }
        }

        // ─── Snapshot ─────────────────────────────────────────
        const snapshot = getMarketSnapshot(pair, candles1h, candles4h, candles15m);
        snapshot.pair = pair;

        if (results[pair]?.status === "HOLDING" && activeForPair.length > 0) {
          const s = activeForPair[0];
          const rawPnl = s.direction === "LONG"
            ? ((price - s.entry) / s.entry) * 100
            : ((s.entry - price) / s.entry) * 100;
          const pnl = isFinite(rawPnl) ? rawPnl : 0;
          const risk = Math.abs(s.entry - s.stop);
          const currentR = risk > 0 ? (s.direction === "LONG" ? (price - s.entry) / risk : (s.entry - price) / risk) : 0;
          const phase = currentR >= 2 ? "TRAILING" : currentR >= 1 ? "BUILDING" : "ENTRY";
          const nextMilestone = currentR < 1 ? "1R" : currentR < 2 ? "2R" : currentR < 3 ? "Target" : "Target reached";

          snapshot.activeTrade = {
            signalId: s.id,
            direction: s.direction,
            pnl: (pnl >= 0 ? "+" : "") + pnl.toFixed(2) + "%",
            entry: s.entry,
            currentPrice: price,
            stop: s.stop,
            target: s.target,
            currentR: currentR.toFixed(2),
            phase,
            nextMilestone,
          };
        }

        marketSnapshots.push(snapshot);

      } catch (err) {
        const msg = String(err);
        errors.push(pair + ": " + msg);
        results[pair] = { status: "ERROR", error: msg };
        console.error(`[CRON] ${pair} | ERROR: ${msg}`);
        try { await alertError("cron/" + pair, err); } catch (e) {}
      }
    }

    // ─── Filter Expired ─────────────────────────────────────
    try {
      const { active } = filterExpiredSignals(activeSignals);
      activeSignals = active;
    } catch (e) { errors.push("filterExpired: " + e); }

    // ─── Save State ─────────────────────────────────────────
    try {
      await saveActiveSignals(activeSignals);
      await setLastCronRun(now);
    } catch (e) { errors.push("save state: " + e); }

    // ─── Dashboard Snapshot ─────────────────────────────────
    try {
      await saveDashboardSnapshot({
        timestamp: now,
        iso: new Date(now).toISOString(),
        markets: marketSnapshots,
        activeSignals: activeSignals.filter(s => !s.exited),
        errors: errors.length > 0 ? errors : undefined,
      });
    } catch (e) { errors.push("save snapshot: " + e); }

    // ─── Summary ────────────────────────────────────────────
    const activeTrades = activeSignals.filter(s => !s.exited);
    console.log(`[CRON] FINISHED | Active: ${activeTrades.length}`);
    for (const pair of PAIRS) {
      const r = results[pair];
      if (r?.status === "HOLDING") console.log(`[CRON]   📊 ${pair} | HOLDING | ${r.pnl} | R ${r.currentR} | ${r.phase} | Next: ${r.nextMilestone}`);
      else if (r?.status === "SIGNAL") console.log(`[CRON]   🔔 ${pair} | SIGNAL | ${r.direction} | Entry:$${r.entry.toFixed(2)} | RR:${r.rr}`);
      else if (r?.status === "NO_SIGNAL") console.log(`[CRON]   ⏸️ ${pair} | NO SIGNAL`);
      else if (r?.status === "ERROR") console.log(`[CRON]   ❌ ${pair} | ERROR: ${r.error}`);
    }

    return NextResponse.json({
      ok: true,
      timestamp: now,
      iso: new Date(now).toISOString(),
      results,
      activeTrades: activeTrades.length,
      errors: errors.length > 0 ? errors : undefined,
    });

  } catch (topLevelErr) {
    const msg = String(topLevelErr);
    console.error("[CRON] FATAL ERROR:", msg);
    return NextResponse.json({ error: "Cron failed", detail: msg }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  return GET(req);
}
