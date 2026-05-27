import { evaluate } from "@/lib/engine";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    console.log("[API/SIGNALS] Evaluating all symbols...");

    const signals = await Promise.all([
      evaluate("BTC"),
      evaluate("ETH"),
      evaluate("SOL"),
    ]);

    for (const s of signals) {
      console.log(`[API/SIGNALS] ${s.symbol}: state=${s.state}, confidence=${s.confidence}%, bias=${s.bias4h}`);
    }

    return NextResponse.json({ signals, timestamp: Date.now() });
  } catch (err: any) {
    console.error("[API/SIGNALS] Error:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
