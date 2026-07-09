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
} from "@/lib/strategy";
import { getCandles, getCurrentPrice, krakenPairFormat } from "@/lib/kraken";
import { persistRegime, loadRegime, persistExit, loadExits as loadExitsState, loadActiveSignals } from "@/lib/state";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

setRegimePersistence(persistRegime, loadRegime);
setExitPersistence(persistExit, loadExitsState);

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const pair = searchParams.get("pair") || "BTC/USD";
  const action = searchParams.get("action");

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
      const [candles1h, candles4h, candles15m] = await Promise.all([
        getCandles(krakenPair, 60),
        getCandles(krakenPair, 240),
        getCandles(krakenPair, 15),
      ]);

      const snapshot = await getMarketSnapshot(pair, candles1h, candles4h, candles15m);
      return NextResponse.json({ pair, snapshot });
    }

    const [candles1h, candles4h, candles15m, price] = await Promise.all([
      getCandles(krakenPair, 60),
      getCandles(krakenPair, 240),
      getCandles(krakenPair, 15),
      getCurrentPrice(krakenPair),
    ]);

    const result = await generateSignal(pair, candles1h, candles4h, candles15m, {}, price);

    return NextResponse.json({
      pair,
      signal: result.signal || null,
      market: result.market,
      debug: result.debug,
    });
  } catch (err) {
    console.error("[SIGNAL API] " + pair + " error:", err);
    return NextResponse.json({ error: String(err), pair }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
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
