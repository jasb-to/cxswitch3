// app/api/signal/route.ts — v29.1 Signal REST API (DIAGNOSTIC)
// ============================================================

import { NextRequest, NextResponse } from "next/server";
import {
  generateSignal,
  getMarketSnapshot,
  getCurrentRegime,
  getRejectionLogs,
  clearRejectionLogs,
  loadExits,
  setRegimePersistence,
  setExitPersistence,
} from "@/lib/strategy";
import { getCandles, getCurrentPrice, krakenPairFormat } from "@/lib/kraken";
import { persistRegime, loadRegime, persistExit, loadExits as loadExitsState, loadActiveSignals } from "@/lib/state";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

console.log("[SIGNAL API] Module loading...");

setRegimePersistence(persistRegime, loadRegime);
setExitPersistence(persistExit, loadExitsState);

console.log("[SIGNAL API] Persistence set up complete");

export async function GET(req: NextRequest) {
  const start = Date.now();
  const { searchParams } = new URL(req.url);
  const pair = searchParams.get("pair") || "BTC/USD";
  const action = searchParams.get("action");

  console.log(`[SIGNAL API] GET ${pair} action=${action}`);

  const krakenPair = krakenPairFormat(pair);
  console.log(`[SIGNAL API] Kraken pair format: ${krakenPair}`);

  try {
    if (action === "regime") {
      console.log(`[SIGNAL API] Returning regime for ${pair}`);
      const regime = getCurrentRegime(pair);
      return NextResponse.json({ pair, regime });
    }

    if (action === "rejection-logs") {
      const since = searchParams.get("since");
      const logs = getRejectionLogs(pair, since ? parseInt(since, 10) : undefined);
      return NextResponse.json({ pair, logs, count: logs.length });
    }

    if (action === "snapshot") {
      console.log(`[SIGNAL API] Fetching snapshot for ${pair}`);
      let candles1h, candles4h, candles15m, price;

      try {
        [candles1h, candles4h, candles15m, price] = await Promise.all([
          getCandles(krakenPair, 60),
          getCandles(krakenPair, 240),
          getCandles(krakenPair, 15),
          getCurrentPrice(krakenPair),
        ]);
        console.log(`[SIGNAL API] Data fetched: 1h=${candles1h?.length}, 4h=${candles4h?.length}, 15m=${candles15m?.length}, price=${price}`);
      } catch (fetchErr) {
        console.error(`[SIGNAL API] Kraken fetch failed for ${pair}:`, fetchErr);
        return NextResponse.json({
          pair,
          error: `Kraken API error: ${String(fetchErr)}`,
          snapshot: null,
        }, { status: 500 });
      }

      let snapshot;
      try {
        snapshot = await getMarketSnapshot(pair, candles1h, candles4h, candles15m);
        if (price && snapshot) {
          snapshot.price = Math.round(price * 100) / 100;
        }
        console.log(`[SIGNAL API] Snapshot built for ${pair}:`, JSON.stringify(snapshot));
      } catch (snapErr) {
        console.error(`[SIGNAL API] getMarketSnapshot failed for ${pair}:`, snapErr);
        return NextResponse.json({
          pair,
          error: `Snapshot build error: ${String(snapErr)}`,
          snapshot: null,
        }, { status: 500 });
      }

      console.log(`[SIGNAL API] Snapshot success for ${pair} in ${Date.now() - start}ms`);
      return NextResponse.json({ pair, snapshot });
    }

    // Default: generate signal
    console.log(`[SIGNAL API] Generating signal for ${pair}`);
    const [candles1h, candles4h, candles15m, price] = await Promise.all([
      getCandles(krakenPair, 60),
      getCandles(krakenPair, 240),
      getCandles(krakenPair, 15),
      getCurrentPrice(krakenPair),
    ]);

    const activeSignals = await loadActiveSignals();
    const activeTrades: Record<string, any> = {};
    for (const s of activeSignals) {
      if (!s.exited) activeTrades[s.pair] = s;
    }

    const result = await generateSignal(pair, candles1h, candles4h, candles15m, activeTrades, price);

    return NextResponse.json({
      pair,
      signal: result.signal || null,
      market: result.market,
      debug: result.debug,
    });
  } catch (err) {
    console.error(`[SIGNAL API] UNHANDLED ERROR for ${pair}:`, err);
    return NextResponse.json({
      error: String(err),
      pair,
      stack: err instanceof Error ? err.stack : undefined,
    }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  console.log("[SIGNAL API] POST received");
  const body = await req.json().catch(() => ({}));
  const { action } = body;

  if (action === "clear-rejection-logs") {
    clearRejectionLogs();
    return NextResponse.json({ ok: true, message: "Rejection logs cleared" });
  }

  if (action === "load-exits") {
    await loadExits();
    return NextResponse.json({ ok: true, message: "Exits loaded" });
  }

  if (action === "active-signals") {
    const signals = await loadActiveSignals();
    return NextResponse.json({ ok: true, signals });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
