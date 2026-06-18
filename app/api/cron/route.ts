// app/api/cron/route.ts — v21.0 "VOLUME + STOCH TURN"
// ============================================================
// Changes from v20.2:
// 1. Fetches 15m candles for Stoch cross timing
// 2. Passes candles15m to generateSignal
// 3. Monitoring state tracking for warm-up signals
// 4. Signal entry at turn, not mid-pullback

import { NextResponse } from "next/server";
import { getCandles } from "@/lib/kraken";
import { generateSignal, isSignalStillValid, shouldHold, getMonitorState, clearMonitorState } from "@/lib/strategy";
import { setSignals, setMarketData, getSignals, getActiveTrades, setActiveTrades, getLastCronRun, setLastCronRun } from "@/lib/state";
import { sendAlert } from "@/lib/telegram";

const PAIRS = ["BTC", "ETH", "SOL"] as const;
const MIN_CRON_INTERVAL_MS = 5 * 60 * 1000;

// ─── Helpers ─────────────────────────────────────────────────

function roundPrice(n: number): number {
  if (n >= 10000) return Math.round(n);
  if (n >= 1000) return Math.round(n * 10) / 10;
  if (n >= 100) return Math.round(n * 100) / 100;
  return Math.round(n * 1000) / 1000;
}

function roundIndicator(n: number): number {
  return Math.round(n * 10) / 10;
}

function roundRR(n: number): number {
  return Math.round(n * 100) / 100;
}

function getSignalMaxAgeHours(signal: any): number {
  return signal.type === "REVERSAL" ? 4 : 8;
}

function isSignalExpired(signal: any): boolean {
  const ageHours = (Date.now() - signal.timestamp) / (1000 * 60 * 60);
  return ageHours >= getSignalMaxAgeHours(signal);
}

// ─── Main Handler ────────────────────────────────────────────

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const runStart = Date.now();
  console.log("========================================");
  console.log(`[CRON] Started at ${new Date(runStart).toISOString()}`);

  const url = new URL(request.url);
  const querySecret = url.searchParams.get("secret");
  const authHeader = request.headers.get("authorization");
  const resetCooldown = url.searchParams.get("reset") === "true";
  const forceRun = url.searchParams.get("force") === "true";

  // ─── Auth ──────────────────────────────────────────────────
  const isAuthorized = 
    querySecret === process.env.CRON_SECRET ||
    authHeader === `Bearer ${process.env.CRON_SECRET}`;

  if (!isAuthorized) {
    console.log(`[AUTH] FAILED`);
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  console.log(`[AUTH] PASSED`);

  // ─── Rate Limit ────────────────────────────────────────────
  const lastRun = await getLastCronRun();
  const timeSinceLastRun = runStart - lastRun;
  
  if (!forceRun && timeSinceLastRun < MIN_CRON_INTERVAL_MS) {
    const waitSeconds = Math.ceil((MIN_CRON_INTERVAL_MS - timeSinceLastRun) / 1000);
    console.log(`[RATE LIMIT] Too soon. Last run ${(timeSinceLastRun/1000).toFixed(0)}s ago. Wait ${waitSeconds}s.`);
    return NextResponse.json({ 
      error: "Rate limited", 
      retryAfter: waitSeconds,
      lastRun: new Date(lastRun).toISOString()
    }, { status: 429 });
  }

  await setLastCronRun(runStart);

  // ─── State Init ────────────────────────────────────────────
  let activeTrades = await getActiveTrades();
  
  if (resetCooldown) {
    console.log(`[STATE] Resetting all cooldowns`);
    activeTrades = {};
    await setActiveTrades({});
  }
  
  console.log(`[STATE] Active trades:`, Object.keys(activeTrades).join(", ") || "none");

  const existingSignals = await getSignals();
  
  let validSignals = existingSignals.filter((s: any) => !isSignalExpired(s));
  console.log(`[STATE] Existing valid signals: ${validSignals.length} (filtered ${existingSignals.length - validSignals.length} expired)`);

  const newSignals: any[] = [];
  const marketDataList: any[] = [];
  const alerts: any[] = [];
  const exitedSignals: any[] = [];

  // ─── Per-Pair Loop ─────────────────────────────────────────
  for (const pair of PAIRS) {
    console.log(`[PAIR] ${pair} — fetching candles...`);
    
    try {
      // ─── FETCH ALL TIMEFRAMES ──────────────────────────────
      const [candles1h, candles4h, candles15m] = await Promise.all([
        getCandles(pair, 60),
        getCandles(pair, 240),
        getCandles(pair, 15)   // NEW: 15m for Stoch timing
      ]);

      console.log(`[PAIR] ${pair} — 1H: ${candles1h?.length ?? 0}, 4H: ${candles4h?.length ?? 0}, 15m: ${candles15m?.length ?? 0}`);

      if (!candles1h || !candles4h || !candles15m || 
          candles1h.length < 30 || candles4h.length < 30 || candles15m.length < 50) {
        console.log(`[PAIR] ${pair} — SKIP: insufficient candles (need 30/30/50, got ${candles1h?.length ?? 0}/${candles4h?.length ?? 0}/${candles15m?.length ?? 0})`);
        alerts.push({ pair, status: "skip", reason: "insufficient_candles" });
        continue;
      }

      const currentPrice = candles1h[candles1h.length - 1].close;
      
      // ─── Check Existing Signal ───────────────────────────────
      const existingIdx = validSignals.findIndex(s => s.pair === pair);
      const existingForPair = existingIdx >= 0 ? validSignals[existingIdx] : null;
      
      if (existingForPair) {
        // Check 1: Stop/Target hit
        if (!isSignalStillValid(existingForPair, currentPrice)) {
          console.log(`[PAIR] ${pair} — Existing signal INVALID (target=${roundPrice(existingForPair.target)} hit or stop=${roundPrice(existingForPair.stop)} hit at price=${roundPrice(currentPrice)}), removing`);
          validSignals.splice(existingIdx, 1);
          clearMonitorState(`${pair}_LONG`);
          clearMonitorState(`${pair}_SHORT`);
          alerts.push({ pair, status: "existing_invalid", reason: "target_or_stop_hit" });
        } 
        // Check 2: shouldHold exit
        else {
          const holdResult = shouldHold(existingForPair, candles4h, candles1h, currentPrice);
          if (!holdResult.shouldHold) {
            console.log(`[PAIR] ${pair} — HOLD EXIT: ${holdResult.reason}`);
            validSignals.splice(existingIdx, 1);
            clearMonitorState(`${pair}_LONG`);
            clearMonitorState(`${pair}_SHORT`);
            exitedSignals.push({ pair, reason: holdResult.reason, signal: existingForPair });
            alerts.push({ pair, status: "hold_exit", reason: holdResult.reason });
          } else {
            console.log(`[PAIR] ${pair} — Existing signal still valid (${existingForPair.type}), skipping`);
            alerts.push({ pair, status: "existing_valid", type: existingForPair.type, holdReason: holdResult.reason });
            
            // Still generate market data
            const result = generateSignal(pair, candles1h, candles4h, candles15m, activeTrades);
            if (result.market) marketDataList.push(result.market);
            continue;
          }
        }
      }

      // ─── Generate New Signal ─────────────────────────────────
      // NEW: Pass candles15m for Stoch cross + volume timing
      const result = generateSignal(pair, candles1h, candles4h, candles15m, activeTrades);
      const market = result.market;
      const debug = result.debug || [];
      
      if (market) {
        marketDataList.push(market);
      }

      // Log monitor state if present
      const monitorLong = getMonitorState(`${pair}_LONG`);
      const monitorShort = getMonitorState(`${pair}_SHORT`);
      if (monitorLong) {
        console.log(`[MONITOR] ${pair} LONG: ${monitorLong.reason} K=${monitorLong.stochK.toFixed(1)} age=${((Date.now()-monitorLong.startedAt)/60000).toFixed(1)}min`);
      }
      if (monitorShort) {
        console.log(`[MONITOR] ${pair} SHORT: ${monitorShort.reason} K=${monitorShort.stochK.toFixed(1)} age=${((Date.now()-monitorShort.startedAt)/60000).toFixed(1)}min`);
      }

      if (!result.signal) {
        console.log(`[PAIR] ${pair} — NO SIGNAL (${debug.join(" | ")})`);
        alerts.push({ pair, status: "no_signal", debug: debug.join(" | ") });
        continue;
      }

      const signal = result.signal;
      console.log(`[PAIR] ${pair} — SIGNAL: ${signal.direction} ${signal.type} entry=${roundPrice(signal.entry)} conf=${signal.confidence}%`);
      newSignals.push(signal);

      // ─── Send Alert ──────────────────────────────────────────
      console.log(`[ALERT] ${pair} — sending alert...`);

      const alertPayload = {
        symbol: signal.pair,
        state: signal.type,
        price: roundPrice(signal.entry),
        bias: signal.direction,
        confidence: signal.confidence,
        stopLoss: roundPrice(signal.stop),
        takeProfit: roundPrice(signal.target),
        rr: roundRR(signal.rr),
        adx: roundIndicator(signal.adx),
        rsi: roundIndicator(signal.rsi),
        stochK: roundIndicator(signal.stochK),
        stochD: roundIndicator(signal.stochD),
        expectedMove: roundIndicator(signal.expectedMove),
        reason: signal.reason,
        updatedAt: new Date(signal.timestamp).toISOString(),
      };

      console.log(`[ALERT] Payload:`, JSON.stringify(alertPayload, null, 2));

      try {
        await sendAlert(alertPayload);
        console.log(`[ALERT] ${pair} — SENT`);
        
        activeTrades[pair] = {
          direction: signal.direction,
          timestamp: Date.now(),
        };
        
        alerts.push({ pair, status: "sent", type: signal.type });
      } catch (alertErr) {
        console.error(`[ALERT] ${pair} — FAILED:`, alertErr);
        alerts.push({ pair, status: "alert_failed", error: String(alertErr) });
      }

    } catch (err) {
      console.error(`[PAIR] ${pair} — ERROR:`, err);
      alerts.push({ pair, status: "error", error: err instanceof Error ? err.message : "Unknown" });
    }
  }

  // ─── Merge & Final Filter ──────────────────────────────────
  const mergedSignals = [...validSignals];
  for (const s of newSignals) {
    const idx = mergedSignals.findIndex((x: any) => x.pair === s.pair);
    if (idx >= 0) mergedSignals[idx] = s;
    else mergedSignals.push(s);
  }

  const finalSignals = mergedSignals.filter((s: any) => !isSignalExpired(s));

  // ─── Persist State ─────────────────────────────────────────
  console.log(`[STATE] Saving ${finalSignals.length} signals, ${marketDataList.length} market data...`);
  console.log(`[STATE] Exited signals: ${exitedSignals.length}`);
  
  await Promise.all([
    setSignals(finalSignals),
    setMarketData(marketDataList),
    setActiveTrades(activeTrades),
  ]);

  const runDuration = Date.now() - runStart;
  console.log(`[CRON] Done in ${runDuration}ms. signals=${finalSignals.length}, marketData=${marketDataList.length}, exited=${exitedSignals.length}`);
  console.log("========================================");

  return NextResponse.json({
    success: true,
    timestamp: new Date().toISOString(),
    durationMs: runDuration,
    signals: finalSignals.length,
    marketData: marketDataList.length,
    exited: exitedSignals.length,
    alerts,
  });
}
