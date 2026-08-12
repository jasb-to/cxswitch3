// app/api/cron/route.ts — v55 "v28 Entries + Rate Limit Fix"
// ============================================================
// Changes from v54.5:
// - Uses generateSignalCompat (ENTRY_2 suppressed, anti-hedge built-in)
// - v28 hysteresis: 24h ENTRY lock, 4h ADD lock
// - v28 stops: ATR×2 ENTRY, ATR×1.5 ADD
// - v34.5 fixed stoch exit + v32.37 scale-out

import { NextResponse } from "next/server";
import { getCandles, krakenPairFormat } from "@/lib/kraken";
import {
  generateSignalCompat,
  isSignalStillValid,
  shouldHold,
  getMarketSnapshot,
  rebuildStateFromTrades,
  recordTradeExit,
  resetAlertProgression,
  Signal,
} from "@/lib/strategy";
import {
  getActiveSignals,
  addActiveSignal,
  getSignalHistory,
  appendSignalHistory,
  updateSignalHistoryStatus,
  setMarketData,
  setActiveSignals,
  getLastCronRun,
  setLastCronRun,
  getCooldowns,
  setCooldowns,
} from "@/lib/state";
import { sendAlert } from "@/lib/telegram";

const PAIRS = ["BTC", "ETH", "SOL", "HYPE"] as const;
const MIN_CRON_INTERVAL_MS = 9 * 60 * 1000;
const MAX_PRICE_DRIFT = 0.010;
const EXIT_COOLDOWN_MS = 4 * 60 * 60 * 1000;
const API_DELAY_MS = 300;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function roundPrice(n: number): number {
  if (n >= 10000) return Math.round(n);
  if (n >= 1000) return Math.round(n * 10) / 10;
  if (n >= 100) return Math.round(n * 100) / 100;
  return Math.round(n * 1000) / 1000;
}

function toSignalLike(trade: any): Signal {
  return {
    ...trade,
    scale: trade.type || trade.scale,
    adx: trade.adx ?? 0,
    rsi: trade.rsi ?? 0,
    stochK: trade.stochK ?? 0,
    stochD: trade.stochD ?? 0,
    expectedMove: trade.expectedMove ?? 0,
    reason: trade.reason || "",
    trend: trade.trend || trade.direction,
    location: trade.location || "",
    trigger: trade.trigger || "",
  } as Signal;
}

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(request: Request) {
  const runStart = Date.now();
  console.log("========================================");
  console.log(`[CRON v55] Started at ${new Date(runStart).toISOString()}`);

  const url = new URL(request.url);
  const querySecret = url.searchParams.get("secret");
  const authHeader = request.headers.get("authorization");
  const forceRun = url.searchParams.get("force") === "true";

  const isAuthorized =
    querySecret === process.env.CRON_SECRET ||
    authHeader === `Bearer ${process.env.CRON_SECRET}`;
  if (!isAuthorized)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const lastRun = await getLastCronRun();
  if (!forceRun && runStart - lastRun < MIN_CRON_INTERVAL_MS) {
    return NextResponse.json({ success: true, skipped: true, reason: "rate_limited" });
  }
  await setLastCronRun(runStart);

  let activeSignals = await getActiveSignals();
  console.log(
    `[STATE] Active signals:`,
    activeSignals.map((a) => `${a.pair}_${a.direction}`).join(", ") || "none"
  );

  // ─── Fetch current prices (sequential) ───────────────────
  const currentPrices: Record<string, number> = {};
  for (const pair of PAIRS) {
    try {
      const candles = await getCandles(krakenPairFormat(pair + "/USD"), 60);
      if (candles?.length) currentPrices[pair] = candles[candles.length - 1].close;
      await sleep(API_DELAY_MS);
    } catch (e) {
      console.log(`[PRICE] ${pair} — failed`);
    }
  }

  // ─── Exit Management ─────────────────────────────────────
  const remainingActive: any[] = [];
  const exitedAlerts: any[] = [];

  for (const trade of activeSignals) {
    const price = currentPrices[trade.pair];
    if (price === undefined) {
      remainingActive.push(trade);
      continue;
    }

    // 1. Hard exits (SL, TP, TTL, missed entry)
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
        await sleep(API_DELAY_MS);
      } catch {
        console.log(`[EXIT] ${trade.pair} — recorded without trend context`);
      }
      try {
        const cooldowns = (await getCooldowns()) || {};
        cooldowns[`${trade.pair}_${trade.direction}`] = runStart + EXIT_COOLDOWN_MS;
        await setCooldowns(cooldowns);
        resetAlertProgression(trade.pair, trade.direction);
        console.log(`[COOLDOWN] ${trade.pair} ${trade.direction} until ${new Date(runStart + EXIT_COOLDOWN_MS).toISOString()}`);
      } catch {
        console.log(`[COOLDOWN] ${trade.pair} — failed to persist`);
      }
      continue;
    }

    // 2. Thesis exits (TL reclaim, bias flip, stoch extreme opposite)
    let holdResult = { shouldHold: true as boolean, reason: "active" };
    try {
      const candles4h = await getCandles(krakenPairFormat(trade.pair + "/USD"), 240);
      if (candles4h?.length) {
        holdResult = shouldHold(toSignalLike(trade), candles4h, price, runStart);
      }
      await sleep(API_DELAY_MS);
    } catch {
      // keep holding if shouldHold fails
    }

    if (!holdResult.shouldHold) {
      console.log(`[EXIT] ${trade.pair} ${trade.direction} — ${holdResult.reason}`);
      exitedAlerts.push({ trade, reason: holdResult.reason, price });
      await updateSignalHistoryStatus(trade.id, "FAILED", holdResult.reason, price);

      try {
        const candles4h = await getCandles(krakenPairFormat(trade.pair + "/USD"), 240);
        recordTradeExit(trade.pair, trade.direction, holdResult.reason, price, candles4h);
        await sleep(API_DELAY_MS);
      } catch {
        console.log(`[EXIT] ${trade.pair} — recorded without trend context`);
      }
      try {
        const cooldowns = (await getCooldowns()) || {};
        cooldowns[`${trade.pair}_${trade.direction}`] = runStart + EXIT_COOLDOWN_MS;
        await setCooldowns(cooldowns);
        resetAlertProgression(trade.pair, trade.direction);
        console.log(`[COOLDOWN] ${trade.pair} ${trade.direction} until ${new Date(runStart + EXIT_COOLDOWN_MS).toISOString()}`);
      } catch {
        console.log(`[COOLDOWN] ${trade.pair} — failed to persist`);
      }
      continue;
    }

    // 3. Position management (breakeven lock, scale-out)
    if (holdResult.newStop && holdResult.newStop !== trade.stop) {
      trade.stop = holdResult.newStop;
      console.log(`[MGT] ${trade.pair} — new stop ${trade.stop}`);
    }
    if (holdResult.scaleOut) {
      console.log(`[MGT] ${trade.pair} — scale out ${holdResult.scaleOut.label}`);
      try {
        await sendAlert({
          symbol: trade.pair,
          state: "SCALE_OUT",
          price: roundPrice(price),
          bias: trade.direction,
          stopLoss: roundPrice(trade.stop),
          takeProfit: roundPrice(trade.target),
          rr: trade.rr || 0,
          expectedMove: trade.expectedMove || 0,
          adx: trade.adx || 0,
          rsi: trade.rsi || 0,
          stochK: trade.stochK || 0,
          stochD: trade.stochD || 0,
          reason: holdResult.reason,
          trend: trade.trend,
          location: trade.location,
          trigger: trade.trigger,
          updatedAt: new Date(runStart).toISOString(),
          signalType: trade.type,
          signalEmoji: "🔶",
          context: trade.context,
          marketPhase: trade.context?.marketPhase,
          structure: trade.context?.structure,
          momentum: trade.context?.momentum,
          pullback: trade.context?.pullback,
          crossAge: trade.context?.crossAge,
        });
      } catch (err) {
        console.error(`[SCALE_OUT] ${trade.pair} — alert failed:`, err);
      }
    }

    remainingActive.push(trade);
  }

  await setActiveSignals(remainingActive);
  activeSignals = remainingActive;
  console.log(
    `[STATE] Remaining active: ${activeSignals.length}, Exited: ${exitedAlerts.length}`
  );

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
  console.log(`[RECOVERY] In-memory rebuilt from ${Object.keys(activeTrades).length} trades`);

  const newSignals: Signal[] = [];
  const marketDataList: any[] = [];
  const alerts: any[] = [];

  for (const pair of PAIRS) {
    try {
      const candles1h = await getCandles(krakenPairFormat(pair + "/USD"), 60);
      await sleep(API_DELAY_MS);
      const candles4h = await getCandles(krakenPairFormat(pair + "/USD"), 240);
      await sleep(API_DELAY_MS);
      const candles15m = await getCandles(krakenPairFormat(pair + "/USD"), 15);
      await sleep(API_DELAY_MS);

      if (
        !candles1h ||
        !candles4h ||
        !candles15m ||
        candles1h.length < 20 ||
        candles4h.length < 30 ||
        candles15m.length < 20
      ) {
        alerts.push({ pair, status: "skip", reason: "insufficient_candles" });
        continue;
      }

      const currentPrice = candles1h[candles1h.length - 1].close;
      const existingForPair = activeSignals.find((a) => a.pair === pair) || null;

      if (existingForPair) {
        console.log(`[PAIR] ${pair} — Still valid (${existingForPair.direction}), skipping`);
        const snapshot = getMarketSnapshot(pair, candles1h, candles4h, candles15m);
        if (snapshot) marketDataList.push(snapshot);
        continue;
      }

      // Check post-exit cooldown
      let cooldowns: Record<string, number> = {};
      try { cooldowns = (await getCooldowns()) || {}; } catch {}
      const now = Date.now();

      // v55: use generateSignalCompat — ENTRY_2 suppressed, anti-hedge built-in
      const result = await generateSignalCompat(pair, candles1h, candles4h, candles15m, activeSignals, currentPrice);

      if (result.signals) {
        result.signals = result.signals.filter((s) => {
          const key = `${s.pair}_${s.direction}`;
          const cd = cooldowns[key];
          if (cd && now < cd) {
            console.log(`[PAIR] ${pair} — COOLDOWN: ${s.direction} blocked until ${new Date(cd).toISOString()}`);
            alerts.push({ pair, direction: s.direction, status: "cooldown", until: cd });
            return false;
          }
          return true;
        });
      }

      const snapshot = result.market || getMarketSnapshot(pair, candles1h, candles4h, candles15m);
      if (snapshot) marketDataList.push(snapshot);

      if (!result.signals || result.signals.length === 0) {
        console.log(`[PAIR] ${pair} — NO SIGNAL (${result.debug?.join(" | ")})`);
        alerts.push({ pair, status: "no_signal", debug: result.debug?.join(" | ") });
        continue;
      }

      for (const signal of result.signals) {
        // ─── QUALITY GATES ──────────────────────────────────
        const last4h = candles4h[candles4h.length - 1];
        const priceDrift = Math.abs(last4h.close - signal.entry) / signal.entry;
        if (priceDrift > MAX_PRICE_DRIFT) {
          console.log(`[PAIR] ${pair} — REJECTED: price drift ${(priceDrift * 100).toFixed(2)}% > ${(MAX_PRICE_DRIFT * 100).toFixed(2)}%`);
          alerts.push({ pair, status: "rejected", reason: "price_drift", drift: priceDrift });
          continue;
        }

        // ─── RACE-CONDITION DUPE CHECK ─────────────────────
        const freshActive = await getActiveSignals();
        if (freshActive.some(a => a.pair === signal.pair && a.direction === signal.direction)) {
          console.log(`[DUPE] ${pair} — already active in Redis, skipping alert`);
          alerts.push({ pair, direction: signal.direction, status: "rejected", reason: "race_duplicate" });
          continue;
        }

        console.log(
          `[PAIR] ${pair} — SIGNAL: ${signal.direction} | ${signal.type} @ ${signal.entry} TP${signal.target} SL${signal.stop} RR${signal.rr}`
        );
        newSignals.push(signal);

        const alertState = signal.type === "ADD" ? "ADD" : "ENTRY";
        const alertEmoji =
          signal.type === "ENTRY_1" ? "🟢" : signal.type === "ENTRY_2" ? "🟡" : "🔵";

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
            marketPhase: signal.context?.marketPhase,
            structure: signal.context?.structure,
            momentum: signal.context?.momentum,
            pullback: signal.context?.pullback,
            crossAge: signal.context?.crossAge,
          });
          console.log(`[ALERT] ${pair} ${signal.direction} — SENT (${signal.type})`);
          alerts.push({ pair, direction: signal.direction, status: "sent", type: signal.type });
        } catch (err) {
          console.error(`[ALERT] ${pair} ${signal.direction} — FAILED:`, err);
          alerts.push({ pair, direction: signal.direction, status: "alert_failed", error: String(err) });
        }

        await addActiveSignal(signal);
        await appendSignalHistory(signal);
      }
    } catch (err) {
      console.error(`[PAIR] ${pair} — ERROR:`, err);
      alerts.push({ pair, status: "error", error: String(err) });
    }
  }

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
