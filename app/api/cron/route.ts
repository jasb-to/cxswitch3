// app/api/cron/route.ts — v56 "v28 Entries + Safe Position State"
// ============================================================
// v56 changes:
// - Exchange sync is opt-in and fail-safe. Missing/unavailable credentials never
//   delete a locally tracked position.
// - Active positions are never evaluated as "missed entries". Once entered,
//   only TTL, hard SL/TP and thesis management can close the position.
// - Existing v28 entry architecture is unchanged.
// - Alert deduplication remains separate from signal/position state.

import { NextResponse } from "next/server";
import { getCandles, krakenPairFormat, getExchangePositions, isExchangeSyncConfigured } from "@/lib/kraken";
import {
  generateSignalCompat,
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
  removeActiveSignalById,
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
const API_DELAY_MS = 600;
const ACTIVE_TRADE_TTL = 24 * 60 * 60 * 1000;
const ADD_TRADE_TTL = 4 * 60 * 60 * 1000;

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
  console.log(`[CRON v56] Started at ${new Date(runStart).toISOString()}`);

  const url = new URL(request.url);
  const querySecret = url.searchParams.get("secret");
  const authHeader = request.headers.get("authorization");
  const forceRun = url.searchParams.get("force") === "true";

  const isAuthorized =
    querySecret === process.env.CRON_SECRET ||
    authHeader === `Bearer ${process.env.CRON_SECRET}`;
  if (!isAuthorized) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const lastRun = await getLastCronRun();
  if (!forceRun && runStart - lastRun < MIN_CRON_INTERVAL_MS) {
    return NextResponse.json({ success: true, skipped: true, reason: "rate_limited" });
  }
  await setLastCronRun(runStart);

  let activeSignals = await getActiveSignals();
  console.log(
    `[STATE] Active signals on entry:`,
    activeSignals.map((a) => `${a.pair}_${a.direction}`).join(", ") || "none"
  );

  // ─── Current prices ──────────────────────────────────────
  const currentPrices: Record<string, number> = {};
  for (const pair of PAIRS) {
    try {
      const candles = await getCandles(krakenPairFormat(pair + "/USD"), 60);
      if (candles?.length) currentPrices[pair] = candles[candles.length - 1].close;
      await sleep(API_DELAY_MS);
    } catch {
      console.log(`[PRICE] ${pair} — failed`);
    }
  }

  // ─── Optional exchange sync ──────────────────────────────
  // CRITICAL: an empty result is only authoritative when the exchange call
  // actually succeeded. Without credentials, Redis is the source of truth.
  if (isExchangeSyncConfigured()) {
    try {
      const exchangePositions = await getExchangePositions();
      console.log(
        `[SYNC] Exchange positions:`,
        exchangePositions.map((p: any) => `${p.symbol}_${p.side?.toUpperCase()}`).join(", ") || "none"
      );

      for (const signal of [...activeSignals]) {
        const hasPosition = exchangePositions.some(
          (p: any) =>
            (p.symbol === signal.pair || p.symbol === krakenPairFormat(signal.pair + "/USD")) &&
            p.side?.toUpperCase() === signal.direction
        );

        if (!hasPosition) {
          console.log(`[SYNC] ${signal.pair} ${signal.direction} not found on exchange — removing tracked position`);
          await removeActiveSignalById(signal.id);
          await updateSignalHistoryStatus(signal.id, "FAILED", "manual_close_or_desync", currentPrices[signal.pair]);
          const cooldowns = (await getCooldowns()) || {};
          cooldowns[`${signal.pair}_${signal.direction}`] = runStart + EXIT_COOLDOWN_MS;
          await setCooldowns(cooldowns);
          resetAlertProgression(signal.pair, signal.direction);
        }
      }

      activeSignals = await getActiveSignals();
      console.log(
        `[STATE] Active signals after exchange sync:`,
        activeSignals.map((a) => `${a.pair}_${a.direction}`).join(", ") || "none"
      );
    } catch (e) {
      // Never mutate position state on an exchange/API failure.
      console.error(`[SYNC] Exchange sync failed — preserving local positions:`, e);
    }
  } else {
    console.log(`[SYNC] Exchange credentials not configured — preserving local position state`);
  }

  // ─── Exit management ────────────────────────────────────
  const remainingActive: any[] = [];
  const exitedAlerts: any[] = [];

  for (const trade of activeSignals) {
    const price = currentPrices[trade.pair];
    if (price === undefined) {
      remainingActive.push(trade);
      continue;
    }

    // Once a signal is ACTIVE it is a position, not an entry opportunity.
    // Do NOT use isSignalStillValid() here because its missed_entry rule is
    // intentionally for unfilled entries and would close profitable positions
    // after they move beyond the entry buffer.
    const ageMs = runStart - trade.timestamp;
    const ttl = trade.type === "ADD" ? ADD_TRADE_TTL : ACTIVE_TRADE_TTL;
    let exitReason: string | null = null;

    if (ageMs > ttl) exitReason = "expired_ttl";
    else if (trade.direction === "LONG" && price <= trade.stop) exitReason = "sl_hit";
    else if (trade.direction === "SHORT" && price >= trade.stop) exitReason = "sl_hit";
    else if (trade.direction === "LONG" && price >= trade.target) exitReason = "tp_hit";
    else if (trade.direction === "SHORT" && price <= trade.target) exitReason = "tp_hit";

    if (exitReason) {
      console.log(`[EXIT] ${trade.pair} ${trade.direction} — ${exitReason}`);
      exitedAlerts.push({ trade, reason: exitReason, price });

      let status = "FAILED" as const;
      if (exitReason === "tp_hit") status = "TP_HIT";
      else if (exitReason === "sl_hit") status = "SL_HIT";
      else if (exitReason === "expired_ttl") status = "EXPIRED";

      await updateSignalHistoryStatus(trade.id, status, exitReason, price);

      try {
        const candles4h = await getCandles(krakenPairFormat(trade.pair + "/USD"), 240);
        recordTradeExit(trade.pair, trade.direction, exitReason, price, candles4h);
        await sleep(API_DELAY_MS);
      } catch {
        console.log(`[EXIT] ${trade.pair} — recorded without trend context`);
      }

      try {
        const cooldowns = (await getCooldowns()) || {};
        cooldowns[`${trade.pair}_${trade.direction}`] = runStart + EXIT_COOLDOWN_MS;
        await setCooldowns(cooldowns);
        resetAlertProgression(trade.pair, trade.direction);
      } catch {
        console.log(`[COOLDOWN] ${trade.pair} — failed to persist`);
      }
      continue;
    }

    // Thesis management remains exactly where the existing strategy defines it.
    let holdResult = { shouldHold: true as boolean, reason: "active" } as any;
    try {
      const candles4h = await getCandles(krakenPairFormat(trade.pair + "/USD"), 240);
      if (candles4h?.length) holdResult = shouldHold(toSignalLike(trade), candles4h, price, runStart);
      await sleep(API_DELAY_MS);
    } catch {
      // On an analysis failure, preserve the position rather than inventing an exit.
      console.log(`[HOLD] ${trade.pair} — analysis failed, preserving position`);
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
      } catch {
        console.log(`[COOLDOWN] ${trade.pair} — failed to persist`);
      }
      continue;
    }

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
  console.log(`[STATE] Remaining active: ${activeSignals.length}, Exited: ${exitedAlerts.length}`);

  // ─── Rebuild in-memory strategy state from persisted positions ────────────
  const activeTrades: Record<string, any> = {};
  for (const trade of activeSignals) {
    if (!["LONG", "SHORT"].includes(trade.direction)) {
      console.error(`[STATE BUG] Invalid direction for ${trade.pair}: ${trade.direction}, removing`);
      await removeActiveSignalById(trade.id);
      continue;
    }
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

      if (!candles1h || !candles4h || !candles15m || candles1h.length < 20 || candles4h.length < 30 || candles15m.length < 20) {
        alerts.push({ pair, status: "skip", reason: "insufficient_candles" });
        continue;
      }

      const currentPrice = candles1h[candles1h.length - 1].close;
      const existingForPair = activeSignals.find((a) => a.pair === pair) || null;

      // A live position owns this pair. Still refresh market context, but never
      // ask the entry engine to generate another entry every cron run.
      if (existingForPair) {
        console.log(`[PAIR] ${pair} — POSITION ACTIVE (${existingForPair.direction}), entry engine paused`);
        const snapshot = getMarketSnapshot(pair, candles1h, candles4h, candles15m);
        if (snapshot) {
          snapshot.positionState = "ACTIVE";
          snapshot.positionDirection = existingForPair.direction;
          snapshot.positionEntry = existingForPair.entry;
          snapshot.positionStop = existingForPair.stop;
          snapshot.positionTarget = existingForPair.target;
          snapshot.positionId = existingForPair.id;
          marketDataList.push(snapshot);
        }
        continue;
      }

      let cooldowns: Record<string, number> = {};
      try { cooldowns = (await getCooldowns()) || {}; } catch {}
      const now = Date.now();

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
        const last4h = candles4h[candles4h.length - 1];
        const priceDrift = Math.abs(last4h.close - signal.entry) / signal.entry;
        if (priceDrift > MAX_PRICE_DRIFT) {
          console.log(`[PAIR] ${pair} — REJECTED: price drift ${(priceDrift * 100).toFixed(2)}% > ${(MAX_PRICE_DRIFT * 100).toFixed(2)}%`);
          alerts.push({ pair, status: "rejected", reason: "price_drift", drift: priceDrift });
          continue;
        }

        const freshActive = await getActiveSignals();
        if (freshActive.some(a => a.pair === signal.pair && a.direction === signal.direction)) {
          console.log(`[DUPE] ${pair} — already active in Redis, skipping alert`);
          alerts.push({ pair, direction: signal.direction, status: "rejected", reason: "race_duplicate" });
          continue;
        }

        console.log(`[PAIR] ${pair} — SIGNAL: ${signal.direction} | ${signal.type} @ ${signal.entry} TP${signal.target} SL${signal.stop} RR${signal.rr}`);
        newSignals.push(signal);

        // Notification is deliberately separate from position state. ENTRY_2
        // remains internal/silent; ENTRY_1 and ADD alert once when the position
        // is created.
        if (signal.type !== "ENTRY_2") {
          const alertState = signal.type === "ADD" ? "ADD" : "ENTRY";
          const alertEmoji = signal.type === "ENTRY_1" ? "🟢" : "🔵";
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
        } else {
          console.log(`[INTERNAL] ${pair} ${signal.direction} — ENTRY_2 tracked (no alert)`);
          alerts.push({ pair, direction: signal.direction, status: "internal", type: signal.type });
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
