// app/api/signal/route.ts — STEP-BY-STEP IMPORT TEST
// ============================================================

import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Test each import individually
let strategy: any = null;
let kraken: any = null;
let state: any = null;
let importErrors: string[] = [];

try {
  strategy = await import("@/lib/strategy");
} catch (e) {
  importErrors.push("strategy: " + String(e));
}

try {
  kraken = await import("@/lib/kraken");
} catch (e) {
  importErrors.push("kraken: " + String(e));
}

try {
  state = await import("@/lib/state");
} catch (e) {
  importErrors.push("state: " + String(e));
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const pair = searchParams.get("pair") || "BTC/USD";
  const action = searchParams.get("action");

  if (importErrors.length > 0) {
    return NextResponse.json({
      error: "Import failures",
      importErrors,
      pair,
      action,
    }, { status: 500 });
  }

  // If imports work, try to use them
  try {
    if (action === "snapshot") {
      const krakenPair = kraken.krakenPairFormat(pair);
      const [candles1h, candles4h, candles15m, price] = await Promise.all([
        kraken.getCandles(krakenPair, 60),
        kraken.getCandles(krakenPair, 240),
        kraken.getCandles(krakenPair, 15),
        kraken.getCurrentPrice(krakenPair),
      ]);

      const snapshot = await strategy.getMarketSnapshot(pair, candles1h, candles4h, candles15m);
      if (price && snapshot) snapshot.price = Math.round(price * 100) / 100;

      return NextResponse.json({ pair, snapshot });
    }

    if (action === "active-signals") {
      const signals = await state.loadActiveSignals();
      return NextResponse.json({ ok: true, signals });
    }

    return NextResponse.json({ pair, test: "imports_ok", strategy: !!strategy, kraken: !!kraken, state: !!state });
  } catch (e) {
    return NextResponse.json({
      error: String(e),
      stack: e instanceof Error ? e.stack : undefined,
      pair,
      action,
    }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  if (importErrors.length > 0) {
    return NextResponse.json({ error: "Import failures", importErrors }, { status: 500 });
  }
  if (body.action === "active-signals") {
    const signals = await state.loadActiveSignals();
    return NextResponse.json({ ok: true, signals });
  }
  return NextResponse.json({ ok: true, body });
}
