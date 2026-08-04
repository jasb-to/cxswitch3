// app/api/cron/route.ts — v54 "Clean Separation" Cron
// ============================================================
// Architecture: activeSignals (trades) + signalHistory (UI) are separate.
// Cron only manages activeSignals. History is append-only.

import { NextResponse } from "next/server";
import { getCandles, krakenPairFormat } from "@/lib/kraken";
import { generateSignal, isSignalStillValid, shouldHold, getMarketSnapshot, rebuildStateFromTrades, recordTradeExit, Signal, getTradePhase } from "@/lib/strategy";
import { getActiveSignals, addActiveSignal, getSignalHistory, appendSignalHistory, updateSignalHistoryStatus, setMarketData, setActiveSignals, getLastCronRun, setLastCronRun } from "@/lib/state";
import { sendAlert } from "@/lib/telegram";

const PAIRS = ["BTC", "ETH", "SOL", "HYPE"] as const;
const MIN_CRON_INTERVAL_MS = 9 * 60 * 1000;

function roundPrice(n: number): number {
  if (n >= 10000) return Math.round(n);
  if (n >= 1000) return Math.round(n * 10) / 10;
  if (n >= 100) return Math.round(n * 100) / 100;
  return Math.round(n * 1000) / 1000;
}

function toSignalLike(trade: any): Signal {
  return {
    ...trade,
    scale: trade.type,
    adx: 0, rsi: 0, stochK: 0, stochD: 0,
    expectedMove: 0, reason: "", trend: trade.direction,
    location: "", trigger: "",
  } as Signal;
}

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(request: Request) {
  const runStart = Date.now();
  console.log("========================================");
  console.log(`[CRON v54] Started at ${new Date(runStart).toISOString()}`);

  const url = new URL(request.url);
  const querySecret = url.searchParams.get("secret");
  const authHeader = request.headers.get("authorization");
  const forceRun = url.searchParams.get("force") === "true";

  const isAuthorized = querySecret === process.env.CRON_SECRET || authHeader === `Bearer ${process.env.CRON_SECRET}`;
  if (!isAuthorized) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const lastRun = await getLastCronRun();
  if (!forceRun && (runStart - lastRun) < MIN_CRON_INTERVAL_MS) {
    return NextResponse.json({ success: true, skipped: true, reason: "rate_limited" });
  }
  await setLastCronRun(runStart);

  let activeSignals = await getActiveSignals();
  console.log(`[STATE] Active signals:`, activeSignals.map(a => `${a.pair}_${a.direction}`).join(", ") || "none");

  const currentPrices: Record<string, number> = {};

  for (const pair of PAIRS) {
    try {
      const candles = await getCandles(krakenPairFormat(pair + "/USD"), 60);
      if (candles?.length) currentPrices[pair] = candles[candles.length - 1].close;
    } catch (e) { console.log(`[PRICE] ${pair} — failed`); }
  }

  // ─── Exit Management ─────────────────────────────────────
  const remainingActive = [];
  const exitedAlerts = [];

  for (const trade of activeSignals) {
    const price = currentPrices[trade.pair];
    if (price === undefined) {
      remainingActive.push(trade);
      continue;
    }

    const validity = isSignalStillValid(toSignalLike(trade), price, runStart);

    if (!validity.valid) {
      console.log(`[EXIT] ${trade.pair} ${trade.direction} — ${validity.reason}`);
      exitedAlerts.push({ trade, reason: validity.reason, price });

      let status = "FAILED" as const;
      if (validity.reason === "tp_hit") status = "TP_HIT";
      else if (validity.reason === "sl_hit") status = "SL_HIT";
      else if (validity.reason === "expired_ttl") status = "EXPIRED";

      await updateSignalHistoryStatus(trade.id, status, validity.reason, price);

      try {
        const candles4h = await getCandles(krakenPairFormat(trade.pair + "/USD"), 240);
        recordTradeExit(trade.pair, trade.direction, validity.reason, price, candles4h);
      } catch {
        console.log(`[EXIT] ${trade.pair} — recorded direction exit without trend context`);
      }
      continue;
    }

    // Check shouldHold for thesis failure exits
    try {
      const candles4h = await getCandles(krakenPairFormat(trade.pair + "/USD"), 240);
      if (candles4h?.length > 30) {
        const holdResult = shouldHold(toSignalLike(trade), candles4h, price, runStart);
        if (!holdResult.shouldHold) {
          console.log(`[EXIT] ${trade.pair} ${trade.direction} — HOLD EXIT: ${holdResult.reason}`);
          exitedAlerts.push({ trade, reason: holdResult.reason, price });
          await updateSignalHistoryStatus(trade.id, "FAILED", holdResult.reason, price);
          try {
            recordTradeExit(trade.pair, trade.direction, holdResult.reason, price, candles4h);
          } catch {
            console.log(`[EXIT] ${trade.pair} — recorded direction exit without trend context`);
          }
          continue;
        }
      }
    } catch (e) {
      console.log(`[HOLD_CHECK] ${trade.pair} failed:`, e);
    }

    remainingActive.push(trade);
  }

  // ─── Hold Advice Computation ────────────────────────────
  for (const trade of remainingActive) {
    const price = currentPrices[trade.pair];
    if (!price) continue;
    try {
      const candles4h = await getCandles(krakenPairFormat(trade.pair + "/USD"), 240);
      if (candles4h?.length > 30) {
        const holdResult = shouldHold(toSignalLike(trade), candles4h, price, runStart);
        const lifecycle = getTradePhase(toSignalLike(trade), runStart);
        trade.holdAdvice = {
          status: holdResult.shouldHold
            ? (holdResult.reason.startsWith("warning:") ? "warning" : "healthy")
            : "failed",
          reason: holdResult.reason,
          newStop: holdResult.newStop,
          checkedAt: runStart,
          phase: lifecycle.phase,
          ageHours: Math.round(lifecycle.ageHours * 10) / 10,
        };
      }
    } catch (e) {
      console.log(`[HOLD_ADVICE] ${trade.pair} failed:`, e);
    }
  }

  // CRITICAL: Write filtered + enriched list back to KV immediately
  await setActiveSignals(remainingActive);
  activeSignals = remainingActive;
  console.log(`[STATE] Remaining active: ${activeSignals.length}, Exited: ${exitedAlerts.length}`);

  // ─── State Recovery ──────────────────────────────────────
  const activeTrades: Record<string, any> = {};
  for (const trade of activeSignals) {
    activeTrades[`${trade.pair}_${trade.direction}`] = {
      direction: trade.direction,
      timestamp: trade.timestamp,
      entry: trade.entry,
      stop: trade.stop,
      target: trade.target,
      id: trade.id,
      type: trade.type,
      crossHash: trade.context?.crossHash || "",
    };
  }

  rebuildStateFromTrades(activeTrades);
  console.log(`[RECOVERY] In-memory state rebuilt from ${Object.keys(activeTrades).length} trades`);

  const newSignals = [];
  const marketDataList = [];
  const alerts = [];

  for (const pair of PAIRS) {
    try {
      const [candles1h, candles4h, candles15m] = await Promise.all([
        getCandles(krakenPairFormat(pair + "/USD"), 60),
        getCandles(krakenPairFormat(pair + "/USD"), 240),
        getCandles(krakenPairFormat(pair + "/USD"), 15)
      ]);

      if (!candles1h || !candles4h || !candles15m || candles1h.length < 20 || candles4h.length < 30 || candles15m.length < 20) {
        alerts.push({ pair, status: "skip", reason: "insufficient_candles" });
        continue;
      }

      const currentPrice = candles1h[candles1h.length - 1].close;
      const existingForPair = activeSignals.find(a => a.pair === pair) || null;

      if (existingForPair) {
        console.log(`[PAIR] ${pair} — Still valid (${existingForPair.direction}), skipping`);
        const snapshot = getMarketSnapshot(pair, candles1h, candles4h, candles15m);
        if (snapshot) marketDataList.push(snapshot);
        continue;
      }

      // Pass empty activeSignals array — in-memory store already rebuilt
      const result = generateSignal(pair, candles1h, candles4h, candles15m, [], currentPrice);
      const snapshot = result.market || getMarketSnapshot(pair, candles1h, candles4h, candles15m);
      if (snapshot) marketDataList.push(snapshot);

      if (!result.signals || result.signals.length === 0) {
        console.log(`[PAIR] ${pair} — NO SIGNAL (${result.debug?.join(" | ")})`);
        alerts.push({ pair, status: "no_signal", debug: result.debug?.join(" | ") });
        continue;
      }

      for (const signal of result.signals) {
        console.log(`[PAIR] ${pair} — SIGNAL: ${signal.direction} | ${signal.type} @ ${signal.entry} TP${signal.target} SL${signal.stop} RR${signal.rr}`);
        newSignals.push(signal);

        const alertState = signal.type === "ADD" ? "ADD" : "ENTRY";
        const alertEmoji = signal.type === "ENTRY_1" ? "🟢" : signal.type === "ENTRY_2" ? "🟡" : "🔵";

        try {
          await sendAlert({
            symbol: signal.pair,
            state: alertState,
            price: roundPrice(signal.entry),
            bias: signal.direction,
            stopLoss: roundPrice(signal.stop),
            takeProfit: roundPrice(signal.target),
            rr: signal.rr,
            expectedMove: signal.expectedMove,
            adx: signal.adx,
            rsi: signal.rsi,
            stochK: signal.stochK,
            stochD: signal.stochD,
            reason: signal.reason,
            trend: signal.trend,
            location: signal.location,
            trigger: signal.trigger,
            updatedAt: new Date(signal.timestamp).toISOString(),
            signalType: signal.type,
            signalEmoji: alertEmoji,
            context: signal.context,
            marketPhase: signal.context.marketPhase,
            structure: signal.context.structure,
            momentum: signal.context.momentum,
            pullback: signal.context.pullback,
            crossAge: signal.context.crossAge,
          });
          console.log(`[ALERT] ${pair} ${signal.direction} — SENT (${signal.type})`);
          alerts.push({ pair, direction: signal.direction, status: "sent", type: signal.type });
        } catch (err) {
          console.error(`[ALERT] ${pair} ${signal.direction} — FAILED:`, err);
          alerts.push({ pair, direction: signal.direction, status: "alert_failed", error: String(err) });
        }

        // Persist to activeSignals and signalHistory
        await addActiveSignal(signal);
        await appendSignalHistory(signal);
      }
    } catch (err) {
      console.error(`[PAIR] ${pair} — ERROR:`, err);
      alerts.push({ pair, status: "error", error: String(err) });
    }
  }

  // Save final state — activeSignals already written after exit loop;
  // addActiveSignal() during pair loop already added new signals to KV.
  // Just verify count for logging.
  const finalActive = await getActiveSignals();
  await setMarketData(marketDataList);

  console.log(`[CRON] Done. active=${finalActive.length}, marketData=${marketDataList.length}, exited=${exitedAlerts.length}, new=${newSignals.length}`);
  console.log("========================================");

  return NextResponse.json({
    success: true,
    activeSignals: finalActive.length,
    marketData: marketDataList.length,
    exited: exitedAlerts.length,
    newSignals: newSignals.length,
    alerts,
  });
}
