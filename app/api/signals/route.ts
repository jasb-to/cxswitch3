// app/api/signal/route.ts — v29.1 Signal REST API
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
} from "@/lib/strategy-consolidated";
import { getOHLC, getTicker, krakenPairFormat } from "@/lib/kraken";
import { persistRegime, loadRegime, persistExit, loadExits as loadExitsState, loadActiveSignals } from "@/lib/state";

setRegimePersistence(persistRegime, loadRegime);
setExitPersistence(persistExit, loadExitsState);

function krakenCandlesToStrategy(candles: any[]): any[] {
  return candles.map(c => ({
    timestamp: c.time * 1000,
    open: parseFloat(c.open),
    high: parseFloat(c.high),
    low: parseFloat(c.low),
    close: parseFloat(c.close),
    volume: parseFloat(c.volume),
  }));
}

// ─── GET /api/signal?pair=BTC/USD ───

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const pair = searchParams.get("pair") || "BTC/USD";
  const action = searchParams.get("action"); // "snapshot" | "regime" | "rejection-logs"

  const krakenPair = krakenPairFormat(pair);

  try {
    if (action === "regime") {
      const regime = getCurrentRegime(pair);
      return NextResponse.json({ pair, regime });
    }

    if (action === "rejection-logs") {
      const since = searchParams.get("since");
      const logs = getRejectionLogs(pair, since ? parseInt(since, 10) : undefined);
      return NextResponse.json({ pair, logs, count: logs.length });
    }

    if (action === "snapshot") {
      const [candles1hRaw, candles4hRaw, candles15mRaw] = await Promise.all([
        getOHLC(krakenPair, 60),
        getOHLC(krakenPair, 240),
        getOHLC(krakenPair, 15),
      ]);

      const snapshot = await getMarketSnapshot(
        pair,
        krakenCandlesToStrategy(candles1hRaw),
        krakenCandlesToStrategy(candles4hRaw),
        krakenCandlesToStrategy(candles15mRaw)
      );

      return NextResponse.json({ pair, snapshot });
    }

    // Default: generate signal
    const [candles1hRaw, candles4hRaw, candles15mRaw, ticker] = await Promise.all([
      getOHLC(krakenPair, 60),
      getOHLC(krakenPair, 240),
      getOHLC(krakenPair, 15),
      getTicker(krakenPair),
    ]);

    const result = await generateSignal(
      pair,
      krakenCandlesToStrategy(candles1hRaw),
      krakenCandlesToStrategy(candles4hRaw),
      krakenCandlesToStrategy(candles15mRaw),
      {},
      ticker.price
    );

    return NextResponse.json({
      pair,
      signal: result.signal || null,
      market: result.market,
      debug: result.debug,
    });
  } catch (err) {
    console.error(`[SIGNAL API] ${pair} error:`, err);
    return NextResponse.json(
      { error: String(err), pair },
      { status: 500 }
    );
  }
}

// ─── POST /api/signal (manual signal or clear logs) ───

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const { action, pair } = body;

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
