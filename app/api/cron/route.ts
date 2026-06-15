// app/api/cron/route.ts — v20 "MULTI-SETUP"
// ============================================================

import { NextResponse } from "next/server";
import { getCandles } from "@/lib/kraken";
import { generateSignal, isSignalStillValid } from "@/lib/strategy";
import { setSignals, setMarketData, getSignals, getActiveTrades, setActiveTrades } from "@/lib/state";
import { sendAlert } from "@/lib/telegram";

const PAIRS = ["BTC", "ETH", "SOL"] as const;

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

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  console.log("========================================");
  console.log(`[CRON] Started at ${new Date().toISOString()}`);

  const url = new URL(request.url);
  const querySecret = url.searchParams.get("secret");
  const authHeader = request.headers.get("authorization");
  const resetCooldown = url.searchParams.get("reset") === "true";

  const isAuthorized = 
    querySecret === process.env.CRON_SECRET ||
    authHeader === `Bearer ${process.env.CRON_SECRET}`;

  if (!isAuthorized) {
    console.log(`[AUTH] FAILED`);
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  console.log(`[AUTH] PASSED`);

  let activeTrades = await getActiveTrades();
  
  if (resetCooldown) {
    console.log(`[STATE] Resetting all cooldowns`);
    activeTrades = {};
    await setActiveTrades({});
  }
  
  console.log(`[STATE] Active trades:`, Object.keys(activeTrades).join(", ") || "none");

  const existingSignals = await getSignals();
  
  // Respect per-type expiry: REVERSAL = 4h, others = 8h
  const validSignals = existingSignals.filter((s: any) => {
    const ageHours = (Date.now() - s.timestamp) / (1000 * 60 * 60);
    const maxAge = s.type === "REVERSAL" ? 4 : 8;
    return ageHours < maxAge;
  });
  
  console.log(`[STATE] Existing valid signals: ${validSignals.length}`);

  const newSignals: any[] = [];
  const marketDataList: any[] = [];
  const alerts: any[] = [];

  for (const pair of PAIRS) {
    console.log(`[PAIR] ${pair} — fetching candles...`);
    try {
      const candles1h = await getCandles(pair, 60);
      const candles4h = await getCandles(pair, 240);

      console.log(`[PAIR] ${pair} — 1H: ${candles1h?.length ?? 0}, 4H: ${candles4h?.length ?? 0}`);

      if (!candles1h || !candles4h || candles1h.length < 30 || candles4h.length < 30) {
        console.log(`[PAIR] ${pair} — SKIP: insufficient candles`);
        alerts.push({ pair, status: "skip", reason: "insufficient candles" });
        continue;
      }

      const currentPrice = candles1h[candles1h.length - 1].close;
      
      // ALWAYS generate market data from current candles
      const result = generateSignal(pair, candles1h, candles4h, activeTrades);
      const market = result.market;
      
      if (market) {
        marketDataList.push(market);
      }

      const existingForPair = validSignals.find(s => s.pair === pair);
      if (existingForPair && isSignalStillValid(existingForPair, currentPrice)) {
        console.log(`[PAIR] ${pair} — Existing signal still valid (${existingForPair.type}), skipping`);
        alerts.push({ pair, status: "existing_valid", type: existingForPair.type });
        continue;
      }

      const signal = result.signal;
      const debug = result.debug || [];

      console.log(`[DEBUG] ${pair}: ${debug.join(" | ")}`);

      if (!signal) {
        console.log(`[PAIR] ${pair} — NO SIGNAL`);
        alerts.push({ pair, status: "no_signal", debug: debug.join(" | ") });
        continue;
      }

      console.log(`[PAIR] ${pair} — SIGNAL: ${signal.direction} ${signal.type} conf=${signal.confidence}%`);
      newSignals.push(signal);

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

  const mergedSignals = [...validSignals];
  for (const s of newSignals) {
    const idx = mergedSignals.findIndex((x: any) => x.pair === s.pair);
    if (idx >= 0) mergedSignals[idx] = s;
    else mergedSignals.push(s);
  }

  // Respect per-type expiry: REVERSAL = 4h, others = 8h
  const finalSignals = mergedSignals.filter((s: any) => {
    const ageHours = (Date.now() - s.timestamp) / (1000 * 60 * 60);
    const maxAge = s.type === "REVERSAL" ? 4 : 8;
    return ageHours < maxAge;
  });

  console.log(`[STATE] Saving ${finalSignals.length} signals, ${marketDataList.length} market data...`);
  await setSignals(finalSignals);
  await setMarketData(marketDataList);
  await setActiveTrades(activeTrades);
  console.log(`[CRON] Done. signals=${finalSignals.length}, marketData=${marketDataList.length}`);
  console.log("========================================");

  return NextResponse.json({
    success: true,
    timestamp: new Date().toISOString(),
    signals: finalSignals.length,
    marketData: marketDataList.length,
    alerts,
  });
}
