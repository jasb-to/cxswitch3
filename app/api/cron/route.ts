// app/api/cron/route.ts — v50 "First Wave" Cron
// ============================================================

import { NextResponse } from "next/server";
import { getCandles } from "@/lib/kraken";
import { generateSignal, generateAddSignal, isSignalStillValid, shouldHold, filterExpiredSignals, getMarketSnapshot } from "@/lib/strategy";
import { getSignals, setSignals, getMarketData, setMarketData, getActiveTrades, setActiveTrades, getLastCronRun, setLastCronRun, addSignalToHistory } from "@/lib/state";
import { sendAlert } from "@/lib/telegram";

const PAIRS = ["BTC", "ETH", "SOL"] as const;
const MIN_CRON_INTERVAL_MS = 14 * 60 * 1000;

function roundPrice(n: number): number {
  if (n >= 10000) return Math.round(n);
  if (n >= 1000) return Math.round(n * 10) / 10;
  if (n >= 100) return Math.round(n * 100) / 100;
  return Math.round(n * 1000) / 1000;
}

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(request: Request) {
  const runStart = Date.now();
  console.log("========================================");
  console.log(`[CRON v50] Started at ${new Date(runStart).toISOString()}`);

  const url = new URL(request.url);
  const querySecret = url.searchParams.get("secret");
  const authHeader = request.headers.get("authorization");
  const forceRun = url.searchParams.get("force") === "true";

  const isAuthorized = querySecret === process.env.CRON_SECRET || authHeader === `Bearer ${process.env.CRON_SECRET}`;
  if (!isAuthorized) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const lastRun = await getLastCronRun();
  if (!forceRun && (runStart - lastRun) < MIN_CRON_INTERVAL_MS) {
    return NextResponse.json({ success: true, skipped: true, reason: "rate_limited" });
  }
  await setLastCronRun(runStart);

  let activeTrades = await getActiveTrades();
  console.log(`[STATE] Active trades:`, Object.keys(activeTrades).join(", ") || "none");

  const existingSignals = await getSignals();
  const currentPrices: Record<string, number> = {};

  for (const pair of PAIRS) {
    try {
      const candles = await getCandles(pair, 60);
      if (candles?.length) currentPrices[pair] = candles[candles.length - 1].close;
    } catch (e) { console.log(`[PRICE] ${pair} — failed`); }
  }

  const { active: validSignals, exited: preExited } = filterExpiredSignals(existingSignals, currentPrices, runStart);
  console.log(`[STATE] Valid: ${validSignals.length}, Expired: ${preExited.length}`);

  for (const { signal, reason } of preExited) {
    console.log(`[EXIT] ${signal.pair} — ${reason}`);
    await addSignalToHistory(signal, reason as any, currentPrices[signal.pair] || signal.entry);
    if (activeTrades[signal.pair]) delete activeTrades[signal.pair];
  }

  const newSignals: any[] = [];
  const marketDataList: any[] = [];
  const alerts: any[] = [];

  for (const pair of PAIRS) {
    try {
      const [candles1h, candles4h, candles15m] = await Promise.all([
        getCandles(pair, 60), getCandles(pair, 240), getCandles(pair, 15)
      ]);

      if (!candles1h || !candles4h || !candles15m || candles1h.length < 20 || candles4h.length < 30 || candles15m.length < 20) {
        alerts.push({ pair, status: "skip", reason: "insufficient_candles" });
        continue;
      }

      const currentPrice = candles1h[candles1h.length - 1].close;
      const existingIdx = validSignals.findIndex(s => s.pair === pair);
      const existingForPair = existingIdx >= 0 ? validSignals[existingIdx] : null;

      if (existingForPair) {
        const validity = isSignalStillValid(existingForPair, currentPrice, runStart);
        if (!validity.valid) {
          console.log(`[PAIR] ${pair} — INVALID: ${validity.reason}`);
          await addSignalToHistory(existingForPair, validity.reason as any, currentPrice);
          if (activeTrades[pair]) delete activeTrades[pair];
          validSignals.splice(existingIdx, 1);
          alerts.push({ pair, status: "expired", reason: validity.reason });
        } else {
          const holdResult = shouldHold(existingForPair, candles4h, currentPrice, runStart);
          if (!holdResult.shouldHold) {
            console.log(`[PAIR] ${pair} — HOLD EXIT: ${holdResult.reason}`);
            await addSignalToHistory(existingForPair, "hold_exit", currentPrice);
            if (activeTrades[pair]) delete activeTrades[pair];
            validSignals.splice(existingIdx, 1);
            alerts.push({ pair, status: "hold_exit", reason: holdResult.reason });
          } else {
            if (existingForPair.scale === "ENTRY") {
              const addResult = generateAddSignal(pair, candles4h, candles15m, existingForPair, currentPrice);
              if (addResult.signal) {
                console.log(`[PAIR] ${pair} — ADD SIGNAL`);
                newSignals.push(addResult.signal);
                try {
                  await sendAlert({
                    symbol: addResult.signal.pair,
                    state: "ADD",
                    price: roundPrice(addResult.signal.entry),
                    bias: addResult.signal.direction,
                    stopLoss: roundPrice(addResult.signal.stop),
                    takeProfit: roundPrice(addResult.signal.target),
                    rr: addResult.signal.rr,
                    expectedMove: addResult.signal.expectedMove,
                    adx: addResult.signal.adx,
                    rsi: addResult.signal.rsi,
                    stochK: addResult.signal.stochK,
                    stochD: addResult.signal.stochD,
                    reason: addResult.signal.reason,
                    trend: addResult.signal.trend,
                    location: addResult.signal.location,
                    trigger: addResult.signal.trigger,
                    updatedAt: new Date(addResult.signal.timestamp).toISOString(),
                  });
                  console.log(`[ALERT] ${pair} — ADD SENT`);
                  alerts.push({ pair, status: "add_sent" });
                } catch (err) {
                  console.error(`[ALERT] ${pair} — ADD FAILED:`, err);
                  alerts.push({ pair, status: "add_alert_failed", error: String(err) });
                }
              }
            }
            console.log(`[PAIR] ${pair} — Still valid, skipping`);
            const snapshot = getMarketSnapshot(pair, candles1h, candles4h, candles15m);
            marketDataList.push(snapshot);
            continue;
          }
        }
      }

      const result = generateSignal(pair, candles1h, candles4h, candles15m, validSignals, currentPrice);
      const snapshot = result.market || getMarketSnapshot(pair, candles1h, candles4h, candles15m);
      if (snapshot) marketDataList.push(snapshot);

      if (!result.signal) {
        console.log(`[PAIR] ${pair} — NO SIGNAL (${result.debug?.join(" | ")})`);
        alerts.push({ pair, status: "no_signal", debug: result.debug?.join(" | ") });
        continue;
      }

      const signal = result.signal;
      console.log(`[PAIR] ${pair} — SIGNAL: ${signal.direction} ${signal.entry} TP${signal.target} SL${signal.stop} RR${signal.rr}`);
      newSignals.push(signal);

      try {
        await sendAlert({
          symbol: signal.pair,
          state: "ENTRY",
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
        });
        console.log(`[ALERT] ${pair} — SENT`);
        activeTrades[pair] = { direction: signal.direction, timestamp: Date.now(), entry: signal.entry, stop: signal.stop, target: signal.target, id: signal.id };
        alerts.push({ pair, status: "sent" });
      } catch (err) {
        console.error(`[ALERT] ${pair} — FAILED:`, err);
        alerts.push({ pair, status: "alert_failed", error: String(err) });
      }
    } catch (err) {
      console.error(`[PAIR] ${pair} — ERROR:`, err);
      alerts.push({ pair, status: "error", error: String(err) });
    }
  }

  const merged = [...validSignals];
  for (const s of newSignals) {
    const idx = merged.findIndex((x: any) => x.pair === s.pair);
    if (idx >= 0) merged[idx] = s; else merged.push(s);
  }

  await Promise.all([setSignals(merged), setMarketData(marketDataList), setActiveTrades(activeTrades)]);

  console.log(`[CRON] Done. signals=${merged.length}, marketData=${marketDataList.length}, exited=${preExited.length}`);
  console.log("========================================");

  return NextResponse.json({ success: true, signals: merged.length, marketData: marketDataList.length, exited: preExited.length, alerts });
}
