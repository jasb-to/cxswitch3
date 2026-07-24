import { NextRequest, NextResponse } from "next/server";
import {
  generateSignal,
  shouldHold,
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
    console.log(`[CRON] ─── ${pair} ───`);

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

      console.log(
        `[CRON] ${pair} | $${price.toFixed(2)} | 1H:${candles1h.length} 4H:${candles4h.length} 15m:${candles15m.length} 1D:${candles1d.length}`
      );

      const activeForPair = activeSignals.filter(s => s.pair === pair && s.exited === false);

      // ─── Manage Active Trades ─────────────────────────────
      if (activeForPair.length > 0) {
        for (const signal of activeForPair) {
          if (signal.exited) continue;

          // FIX: Pass candles4h as 2nd param, candles15m as 3rd (correct order for shouldHold)
          const holdResult = shouldHold(signal, candles1h, candles4h, candles15m, price);

          const rawPnl = signal.direction === "LONG"
            ? ((price - signal.entry) / signal.entry) * 100
            : ((signal.entry - price) / signal.entry) * 100;
          const pnlStr = (isFinite(rawPnl) ? rawPnl.toFixed(2) : "0.00") + "%";

          if (!holdResult.shouldHold) {
            console.log(`[CRON] ${pair} | EXIT | ${holdResult.reason} | ${pnlStr}`);

            signal.exited = true;
            signal.status = "EXITED";
            signal.exitReason = holdResult.reason;
            signal.exitTimestamp = now;
            signal.exitPrice = price;

            try { await persistExit({
              id: signal.id, pair: signal.pair, direction: signal.direction,
              entry: signal.entry, exitPrice: price, pnl: parseFloat(pnlStr),
              reason: holdResult.reason, timestamp: now,
            }); } catch (e) {}

            try { await sendExitAlert(signal, price, holdResult.reason); } catch (e) {}

            results[pair] = { status: "EXITED", reason: holdResult.reason, price, pnl: pnlStr };
          } else {
            console.log(`[CRON] ${pair} | HOLDING | ${pnlStr}`);
            results[pair] = { status: "HOLDING", pnl: pnlStr, signalId: signal.id };
          }
        }
      } else {
        // ─── Evaluate New Signals ───────────────────────────
        console.log(`[CRON] ${pair} | No active trades — evaluating`);

        // FIX: Await async generateSignal
        const result = await generateSignal(pair, candles1h, candles4h, candles1d, candles15m, activeSignals, price);
        signalResults[pair] = result || { debug: [] };

        if (result?.debug?.length)
          console.log(`[CRON] ${pair} | ${result.debug.join(" | ")}`);

        if (result?.signal) {
          const signal = result.signal;
          activeSignals.push(signal);
          console.log(
            `[CRON] ${pair} | SIGNAL | ${signal.direction} | Entry:$${signal.entry.toFixed(2)} | RR:${signal.rr?.toFixed(2)} | Conf:${signal.confidence}%`
          );
          try { await sendAlert(signal); } catch (e) {}
          results[pair] = {
            status: "SIGNAL", direction: signal.direction,
            entry: signal.entry, stop: signal.stop, target: signal.target,
            rr: signal.rr?.toFixed(2), confidence: signal.confidence,
          };
        } else {
          console.log(`[CRON] ${pair} | NO SIGNAL`);
          results[pair] = { status: "NO_SIGNAL" };
        }
      }

      // ─── Snapshot ─────────────────────────────────────────
      // FIX: Await async getMarketSnapshot
      const snapshot = await getMarketSnapshot(pair, candles1h, candles4h, candles15m, candles1d, price, signalResults[pair]);

      // FIX: Ensure pair is always set
      snapshot.pair = pair;

      // Enrich activeTrade for UI compatibility
      if (results[pair]?.status === "HOLDING" && activeForPair.length > 0) {
        const s = activeForPair[0];
        const rawPnl = s.direction === "LONG"
          ? ((price - s.entry) / s.entry) * 100
          : ((s.entry - price) / s.entry) * 100;
        const pnl = isFinite(rawPnl) ? rawPnl : 0;
        const risk = Math.abs(s.entry - s.stop);
        const currentR = risk > 0 ? (s.direction === "LONG" ? (price - s.entry) / risk : (s.entry - price) / risk) : 0;

        snapshot.activeTrade = {
          signalId: s.id,
          direction: s.direction,
          pnl: (pnl >= 0 ? "+" : "") + pnl.toFixed(2) + "%",
          entry: s.entry,
          stop: s.stop,
          target: s.target,
          entryType: s.entryType || "PULLBACK",
          trendlinePrice: s.entry,
          lockedStop: null,
          currentR: currentR,
          phase: currentR >= 2 ? "TREND" : currentR >= 1 ? "BUILDING" : "ENTRY",
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
    const { active, exited } = filterExpiredSignals(activeSignals, currentPrices);
    for (const { signal, reason } of exited) {
      if (!signal.exited) {
        const price = currentPrices[signal.pair] || signal.entry;
        signal.exited = true; signal.status = "EXITED";
        signal.exitReason = reason; signal.exitTimestamp = now; signal.exitPrice = price;
        const rawPnl = signal.direction === "LONG"
          ? ((price - signal.entry) / signal.entry) * 100
          : ((signal.entry - price) / signal.entry) * 100;
        try { await persistExit({
          id: signal.id, pair: signal.pair, direction: signal.direction,
          entry: signal.entry, exitPrice: price, pnl: parseFloat(rawPnl.toFixed(2)),
          reason, timestamp: now,
        }); } catch (e) {}
        try { await sendExitAlert(signal, price, reason); } catch (e) {}
      }
    }
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
      timestamp: now, iso: new Date(now).toISOString(),
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
    if (r?.status === "HOLDING") console.log(`[CRON]   📊 ${pair} | HOLDING | ${r.pnl}`);
    else if (r?.status === "SIGNAL") console.log(`[CRON]   🔔 ${pair} | SIGNAL | ${r.direction} | Entry:$${r.entry.toFixed(2)}`);
    else if (r?.status === "EXITED") console.log(`[CRON]   🚪 ${pair} | EXITED | ${r.reason} | ${r.pnl}`);
    else if (r?.status === "NO_SIGNAL") console.log(`[CRON]   ⏸️ ${pair} | NO SIGNAL`);
    else if (r?.status === "ERROR") console.log(`[CRON]   ❌ ${pair} | ERROR: ${r.error}`);
  }

  return NextResponse.json({
    ok: true, timestamp: now, iso: new Date(now).toISOString(),
    results, activeTrades: activeTrades.length,
    errors: errors.length > 0 ? errors : undefined,
  });
}

export async function POST(req: NextRequest) {
  return GET(req);
}
