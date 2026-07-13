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
import { getCandles, getCurrentPrice, krakenPairFormat } from "@/lib/kraken";
import { sendAlert, sendExitAlert, alertError } from "@/lib/telegram";
import {
  saveActiveSignals,
  loadActiveSignals,
  setLastCronRun,
  saveDashboardSnapshot,
} from "@/lib/state";

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
  try { activeSignals = await loadActiveSignals(); } catch (e) { errors.push("loadActiveSignals: " + e); }
  if (!Array.isArray(activeSignals)) activeSignals = [];

  // v37: Check for duplicate active signals per pair
  const pairCounts = new Map<string, number>();
  for (const s of activeSignals) {
    if (!s.exited) {
      pairCounts.set(s.pair, (pairCounts.get(s.pair) || 0) + 1);
    }
  }
  for (const [pair, count] of pairCounts) {
    if (count > 1) {
      console.error(`[CRON] STATE CORRUPTION: ${pair} has ${count} active signals. Keeping most recent.`);
      const pairSignals = activeSignals.filter(s => s.pair === pair && !s.exited);
      pairSignals.sort((a, b) => b.timestamp - a.timestamp);
      for (let i = 1; i < pairSignals.length; i++) {
        pairSignals[i].exited = true;
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

  for (const pair of PAIRS) {
    const krakenPair = krakenPairFormat(pair);
    results[pair] = { status: "pending" };
    console.log(`[CRON] ─── ${pair} ───`);

    try {
      let candles1h: any[] = [], candles4h: any[] = [], candles15m: any[] = [], candles1d: any[] = [], price = 0;

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

      console.log(`[CRON] ${pair} | $${price.toFixed(2)} | 1H:${candles1h.length} 4H:${candles4h.length} 15m:${candles15m.length} 1D:${candles1d.length}`);

      // ─── MANAGE EXISTING TRADES ───
      const activeForPair = activeSignals.filter(s => s.pair === pair && !s.exited);

      if (activeForPair.length > 0) {
        for (const signal of activeForPair) {
          // v37: Pass all timeframes for trend-following exits
          const holdResult = shouldHold(signal, candles4h, candles1d, candles1h, price);
          const ts = holdResult.updatedTradeState || signal.tradeState;

          console.log(`[CRON] ${pair} | shouldHold: ${holdResult.shouldHold} | ${holdResult.reason} | phase: ${ts?.phase || "TREND"}`);

          if (holdResult.updatedTradeState) {
            signal.tradeState = holdResult.updatedTradeState;
          }

          if (!holdResult.shouldHold) {
            const rawPnl = signal.direction === "LONG"
              ? ((price - signal.entry) / signal.entry * 100)
              : ((signal.entry - price) / signal.entry * 100);
            const pnlStr = (isFinite(rawPnl) ? rawPnl.toFixed(2) : "0.00") + "%";
            console.log(`[CRON] ${pair} | EXITING | ${holdResult.reason} | ${pnlStr}`);

            try { await sendExitAlert(signal, price, holdResult.reason); } catch (e) {}
            signal.exited = true;
            if (signal.tradeState) {
              signal.tradeState.phase = "EXIT";
              signal.tradeState.phaseEnteredAt = now;
            }

            results[pair] = {
              status: "EXITED",
              reason: holdResult.reason,
              price,
              signalId: signal.id,
              pnl: pnlStr,
              phase: ts?.phase || "EXIT",
            };
          } else {
            const rawPnl = signal.direction === "LONG"
              ? ((price - signal.entry) / signal.entry * 100)
              : ((signal.entry - price) / signal.entry * 100);
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
      } else {
        const allForPair = activeSignals.filter(s => s.pair === pair && !s.exited);
        if (allForPair.length > 0) {
          console.warn(`[CRON] ${pair} | SIGNAL BLOCKED: ${allForPair.length} active trade(s) already exist`);
          results[pair] = { status: "BLOCKED", reason: "active_trade_exists", signalId: allForPair[0].id };
        } else {
          console.log(`[CRON] ${pair} | No active trades — evaluating`);
          // v37: Pass candles15m for 15m execution timing
          const result = generateSignal(pair, candles1h, candles4h, candles1d, candles15m, activeSignals, price);
          signalResults[pair] = result || { debug: [] };

          if (result?.debug?.length) console.log(`[CRON] ${pair} | Debug: ${result.debug.join(" | ")}`);

          if (result?.signal) {
            const signal = result.signal;
            activeSignals.push(signal);
            const rr = signal.rr || ((signal.target - signal.entry) / (signal.entry - signal.stop));
            console.log(`[CRON] ${pair} | SIGNAL | ${signal.direction} ${signal.entryType || signal.entryMode} | Entry:$${signal.entry.toFixed(2)} | RR:${rr.toFixed(2)} | Conf:${signal.confidence}%`);

            if (signal.entryTier !== "NO_TRADE") {
              try { await sendAlert(signal); } catch (e) {}
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
      }

      // ─── SNAPSHOT ───
      const snapshot = getMarketSnapshot(pair, candles1h, candles4h, candles15m, candles1d, price, signalResults[pair]);

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
        };
        snapshot.regime.direction = activeSignal.direction;
        snapshot.regime.strength = "ACTIVE";
        snapshot.regime.confidence = activeSignal.confidence;
        snapshot.recommendedAction = activeSignal.direction + " " + (ts.phase || "TREND");
        snapshot.entryTier = activeSignal.entryTier;
        snapshot.entryMode = activeSignal.entryMode || activeSignal.entryType;
        snapshot.positionSize = activeSignal.positionSizePct ? (activeSignal.positionSizePct * 100).toFixed(0) + "%" : null;
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

  // ─── FILTER EXPIRED (SL/TP HITS) ───
  try {
    const { active, exited } = filterExpiredSignals(activeSignals, currentPrices);
    if (exited.length > 0) {
      for (const { signal, reason } of exited) {
        if (!signal.exited) {
          const price = currentPrices[signal.pair] || signal.entry;
          try { await sendExitAlert(signal, price, reason); } catch (e) {}
          signal.exited = true;
          if (signal.tradeState) {
            signal.tradeState.phase = "EXIT";
            signal.tradeState.phaseEnteredAt = now;
          }
        }
      }
    }
    activeSignals = active;
  } catch (e) { errors.push("filterExpired: " + e); }

  // ─── CLEAN OLD EXITED ───
  const cleaned = activeSignals.filter(s => !s.exited || (now - s.timestamp) < EXITED_TTL_MS);
  const pruned = activeSignals.length - cleaned.length;

  try {
    await saveActiveSignals(cleaned);
    await setLastCronRun(now);
  } catch (e) { errors.push("save state: " + e); }

  // ─── DASHBOARD SNAPSHOT ───
  const dashboardSnapshot = {
    timestamp: now,
    iso: new Date(now).toISOString(),
    markets: marketSnapshots,
    activeSignals: cleaned.filter(s => !s.exited),
    errors: errors.length > 0 ? errors : undefined,
  };

  try { await saveDashboardSnapshot(dashboardSnapshot); } catch (e) { errors.push("save snapshot: " + e); }

  // ─── SUMMARY ───
  const activeTrades = cleaned.filter(s => !s.exited);
  console.log("[CRON] FINISHED | Active trades: " + activeTrades.length);
  for (const pair of PAIRS) {
    const r = results[pair];
    if (r?.status === "HOLDING") console.log(`[CRON]   📊 ${pair} | HOLDING | ${r.phase} | ${r.pnl}`);
    else if (r?.status === "SIGNAL") console.log(`[CRON]   🔔 ${pair} | SIGNAL | ${r.direction} | Entry:$${r.entry.toFixed(2)} | ${r.entryType}`);
    else if (r?.status === "EXITED") console.log(`[CRON]   🚪 ${pair} | EXITED | ${r.reason} | ${r.pnl} | ${r.phase}`);
    else if (r?.status === "BLOCKED") console.log(`[CRON]   🛡️ ${pair} | BLOCKED | ${r.reason}`);
    else if (r?.status === "NO_SIGNAL") console.log(`[CRON]   ⏸️ ${pair} | NO SIGNAL`);
    else if (r?.status === "ERROR") console.log(`[CRON]   ❌ ${pair} | ERROR: ${r.error}`);
  }

  return NextResponse.json({
    ok: true,
    timestamp: now,
    iso: new Date(now).toISOString(),
    results,
    activeTrades: activeTrades.length,
    prunedExited: pruned || undefined,
    errors: errors.length > 0 ? errors : undefined,
  });
}

export async function POST(req: NextRequest) {
  return GET(req);
}
