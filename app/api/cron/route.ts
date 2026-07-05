// app/api/cron/route.ts — v29.9 "Always generateSignal + use result.market"
// ============================================================

import { NextResponse } from "next/server";
import {
  getSignals, setSignals, setMarketData,
  getActiveTrades, setActiveTrades,
  getLastCronRun, setLastCronRun,
  addSignalToHistory, setCronLogs, getCronLogs,
} from "@/lib/state";
import {
  generateSignal, filterExpiredSignals, shouldHold, isSignalStillValid, Candle,
} from "@/lib/strategy";
import { sendAlert } from "@/lib/telegram";

// ─── Types ────────────────────────────────────────────────────────────

interface MarketData {
  pair: string; price: number; timestamp: number; phase: string; trend: string;
  htfBias?: "BULLISH" | "BEARISH" | "NEUTRAL";
  adx: number; rsi: number; stochK: number; stochD: number;
  zoneTop: number | null; zoneBottom: number | null;
  zoneScore: number; zoneQuality?: any; closes4h?: number[];
}

// ─── Config ─────────────────────────────────────────────────────────────

const PAIRS = ["BTC", "ETH", "SOL", "HYPE"] as const;
const MIN_CRON_INTERVAL_MS = 10 * 60 * 1000;

// ─── Kraken API ─────────────────────────────────────────────────────────

const KRAKEN_PAIRS: Record<string, string> = {
  BTC: "XBTUSD", ETH: "ETHUSD", SOL: "SOLUSD", HYPE: "HYPEUSD",
};

async function getCandles(pair: string, interval: number): Promise<Candle[]> {
  const kp = KRAKEN_PAIRS[pair] || pair + "USD";
  const res = await fetch(
    `https://api.kraken.com/0/public/OHLC?pair=${kp}&interval=${interval}`,
    { cache: "no-store" }
  );
  const data = await res.json();
  if (data.error?.length) throw new Error(data.error[0]);
  const key = Object.keys(data.result).find((k) => k !== "last")!;
  const raw = data.result[key];
  return raw.map((r: any[]) => ({
    timestamp: r[0] * 1000,
    open: parseFloat(r[1]), high: parseFloat(r[2]),
    low: parseFloat(r[3]), close: parseFloat(r[4]),
    volume: parseFloat(r[6]),
  }));
}

// ─── Helpers ────────────────────────────────────────────────────────────

function roundPrice(n: number): number {
  if (n >= 10000) return Math.round(n);
  if (n >= 1000) return Math.round(n * 10) / 10;
  if (n >= 100) return Math.round(n * 100) / 100;
  return Math.round(n * 1000) / 1000;
}

// ─── Main Handler ───────────────────────────────────────────────────────

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(request: Request) {
  const runStart = Date.now();
  const runId = `${runStart}-${Math.random().toString(36).slice(2, 8)}`;
  const logs: string[] = [];

  const log = (msg: string) => {
    const line = `[${new Date().toISOString()}] ${msg}`;
    logs.push(line); console.log(line);
  };

  log("========================================");
  log(`[CRON] Started runId=${runId} v29.9`);

  const url = new URL(request.url);
  const querySecret = url.searchParams.get("secret");
  const authHeader = request.headers.get("authorization");
  const forceRun = url.searchParams.get("force") === "true";

  const isAuthorized = querySecret === process.env.CRON_SECRET ||
    authHeader === `Bearer ${process.env.CRON_SECRET}`;

  if (!isAuthorized) {
    log("[CRON] Unauthorized");
    await persistLog(runId, logs, "unauthorized");
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const lastRun = await getLastCronRun();
  if (!forceRun && runStart - lastRun < MIN_CRON_INTERVAL_MS) {
    log(`[CRON] Rate limited, lastRun=${lastRun}, diff=${runStart - lastRun}ms`);
    await persistLog(runId, logs, "rate_limited");
    return NextResponse.json({ success: true, skipped: true, reason: "rate_limited" });
  }
  await setLastCronRun(runStart);
  log(`[CRON] lastRun set, force=${forceRun}`);

  let activeTrades = await getActiveTrades();
  log(`[STATE] Active trades: ${Object.keys(activeTrades).join(", ") || "none"}`);

  const existingSignals = await getSignals();
  const currentPrices: Record<string, number> = {};

  log("[CRON] Fetching current prices...");
  for (const pair of PAIRS) {
    try {
      const candles = await getCandles(pair, 240);
      if (candles?.length) {
        currentPrices[pair] = candles[candles.length - 1].close;
        log(`[PRICE] ${pair} = ${currentPrices[pair]}`);
      }
    } catch (e: any) {
      log(`[PRICE] ${pair} — ERROR: ${e.message}`);
    }
  }

  log(`[CRON] Filtering ${existingSignals.length} existing signals...`);
  const { active: validSignals, exited: preExited } = filterExpiredSignals(
    existingSignals, currentPrices, runStart
  );
  log(`[STATE] Valid: ${validSignals.length}, Expired: ${preExited.length}`);

  for (const { signal, reason } of preExited) {
    log(`[EXIT] ${signal.pair} — ${reason}`);
    await addSignalToHistory(signal, reason as any, currentPrices[signal.pair] || signal.entry);
    if (activeTrades[signal.pair]) delete activeTrades[signal.pair];
  }

  const newSignals: any[] = [];
  const marketDataList: MarketData[] = [];
  const alerts: any[] = [];

  for (const pair of PAIRS) {
    log(`[PAIR] ${pair} — starting processing`);
    try {
      log(`[FETCH] ${pair} — requesting 1H/4H/15M candles`);
      const [candles1h, candles4h, candles15m] = await Promise.all([
        getCandles(pair, 60), getCandles(pair, 240), getCandles(pair, 15),
      ]);
      log(`[FETCH] ${pair} — received: 1H=${candles1h?.length}, 4H=${candles4h?.length}, 15M=${candles15m?.length}`);

      if (!candles1h || !candles4h || !candles15m || candles4h.length < 30) {
        log(`[PAIR] ${pair} — SKIP: insufficient candles`);
        alerts.push({ pair, status: "skip", reason: "insufficient_candles" });
        continue;
      }

      const currentPrice = candles4h[candles4h.length - 1].close;

      // ── ALWAYS call generateSignal for fresh market data ────────
      const result = await generateSignal(pair, candles1h, candles4h, candles15m, currentPrice);

      for (const line of result.debug) {
        log(`[STRAT] ${pair} ${line}`);
      }

      // Always save market data from generateSignal
      if (result.market) {
        marketDataList.push(result.market as MarketData);
        log(`[MARKET] ${pair} ADX=${result.market.adx} HTF=${result.market.htfBias} phase=${result.market.phase}`);
      }

      const existingIdx = validSignals.findIndex((s: any) => s.pair === pair);
      const existingForPair = existingIdx >= 0 ? validSignals[existingIdx] : null;

      // ── Handle existing signal ──────────────────────────────────
      if (existingForPair) {
        log(`[PAIR] ${pair} — has existing signal ${existingForPair.id}`);
        const validity = isSignalStillValid(existingForPair, currentPrice, runStart);

        if (!validity.valid) {
          log(`[PAIR] ${pair} — INVALID: ${validity.reason}`);
          await addSignalToHistory(existingForPair, validity.reason as any, currentPrice);
          if (activeTrades[pair]) delete activeTrades[pair];
          validSignals.splice(existingIdx, 1);
          alerts.push({ pair, status: "expired", reason: validity.reason });
        } else {
          const holdResult = shouldHold(pair, existingForPair, candles4h, currentPrice);
          if (!holdResult.shouldHold) {
            log(`[PAIR] ${pair} — FORCED EXIT: ${holdResult.reason}`);
            await addSignalToHistory(existingForPair, "forced_exit" as any, currentPrice);
            if (activeTrades[pair]) delete activeTrades[pair];
            validSignals.splice(existingIdx, 1);
            alerts.push({ pair, status: "forced_exit", reason: holdResult.reason });
          } else {
            log(`[PAIR] ${pair} — Still valid, skipping new signal`);
            continue;
          }
        }
      }

      // ── Handle new signal ───────────────────────────────────────
      if (!result.signal) {
        log(`[PAIR] ${pair} — NO SIGNAL (${result.debug[result.debug.length - 1] || "no breakout"})`);
        alerts.push({ pair, status: "no_signal", debug: result.debug.join(" | ") });
        continue;
      }

      const signal = result.signal;
      log(`[PAIR] ${pair} — SIGNAL: ${signal.direction} ${signal.stage} entry=${signal.entry} TP=${signal.target} SL=${signal.stop} trail=${signal.trail} RR=${signal.rr}`);

      // Send alert
      try {
        await sendAlert({
          symbol: signal.pair, state: signal.stage, scale: "ENTRY_1",
          price: roundPrice(signal.entry), bias: signal.direction,
          confidence: signal.confidence,
          stopLoss: roundPrice(signal.stop), takeProfit: roundPrice(signal.target),
          rr: signal.rr, reason: signal.explanation,
          updatedAt: new Date(signal.timestamp).toISOString(),
        });
        log(`[ALERT] ${pair} — SENT`);
        activeTrades[pair] = {
          direction: signal.direction, timestamp: Date.now(),
          entry: signal.entry, stop: signal.stop,
          target: signal.target, trail: signal.trail,
          id: signal.id, stage: signal.stage,
        };
        alerts.push({ pair, status: "sent" });
        newSignals.push(signal);
      } catch (err: any) {
        log(`[ALERT] ${pair} — FAILED: ${err.message}`);
        alerts.push({ pair, status: "alert_failed", error: err.message });
      }
    } catch (err: any) {
      log(`[PAIR] ${pair} — ERROR: ${err.message}`);
      alerts.push({ pair, status: "error", error: err.message });
    }
  }

  log("[CRON] Merging signals...");
  const merged = [...validSignals];
  for (const s of newSignals) {
    const idx = merged.findIndex((x: any) => x.pair === s.pair);
    if (idx >= 0) merged[idx] = s;
    else merged.push(s);
  }

  log("[CRON] Persisting state...");
  await Promise.all([
    setSignals(merged),
    setMarketData(marketDataList),
    setActiveTrades(activeTrades),
  ]);

  log(`[CRON] Done. signals=${merged.length}, marketData=${marketDataList.length}, exited=${preExited.length}`);
  log("========================================");

  const response = { success: true, signals: merged.length, marketData: marketDataList.length, exited: preExited.length, alerts, runId };
  await persistLog(runId, logs, "complete", response);
  return NextResponse.json(response);
}

async function persistLog(runId: string, logs: string[], status: string, response?: any) {
  try {
    const existing = await getCronLogs();
    const entry = {
      runId, time: new Date().toISOString(), status,
      logCount: logs.length, logs: logs.slice(-50),
      response: response ? JSON.stringify(response) : undefined,
    };
    await setCronLogs([entry, ...(existing || [])].slice(0, 20));
  } catch (e) {
    console.error("[CRON] Failed to persist log:", e);
  }
}
