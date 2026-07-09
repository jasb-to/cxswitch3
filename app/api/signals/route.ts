// app/api/signal/route.ts — v29.1 Signal REST API
// MUST be at: app/api/signal/route.ts
// ============================================================

import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const pair = searchParams.get("pair") || "BTC/USD";
  const action = searchParams.get("action");

  console.log(`[SIGNAL API] GET ${pair} action=${action}`);

  // Minimal response for debugging — proves the route exists
  if (action === "snapshot") {
    return NextResponse.json({
      pair,
      snapshot: {
        pair,
        price: 0,
        trend: "TEST",
        adx: 0,
        rsi: 0,
        stochK: 0,
        stochD: 0,
        regime: { direction: null, strength: "TEST", confidence: 0 },
      },
    });
  }

  if (action === "regime") {
    return NextResponse.json({ pair, regime: null });
  }

  return NextResponse.json({ pair, signal: null, market: null, debug: ["test_mode"] });
}

export async function POST(req: NextRequest) {
  console.log("[SIGNAL API] POST received");
  const body = await req.json().catch(() => ({}));
  const { action } = body;

  if (action === "active-signals") {
    return NextResponse.json({ ok: true, signals: [] });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
