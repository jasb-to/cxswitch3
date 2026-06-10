import { NextResponse } from "next/server";
import { setSignals } from "@/lib/state";

export const dynamic = "force-dynamic";

export async function GET() {
  const fakeSignal = {
    pair: "BTC",
    direction: "SHORT",
    type: "PRIMARY",
    confidence: 85,
    entry: 61490,
    stop: 63800,
    target: 55200,
    rr: 2.5,
    reason: "TEST SIGNAL — verifying KV→UI pipeline",
    timestamp: Date.now(),
    structure: "RANGE",
    adx: 28.3,
    rsi: 48.0,
    stochK: 36.1,
    stochD: 46.6,
    expectedMove: 10.2,
    price: 61490,
  };

  await setSignals([fakeSignal]);

  return NextResponse.json({
    success: true,
    message: "Test signal injected for BTC",
    signal: fakeSignal,
  });
}
