import { evaluate } from "@/lib/engine";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    console.log("[SIGNALS] Fetching signals...");

    const signals = await Promise.all([
      evaluate("BTC"),
      evaluate("ETH"),
      evaluate("SOL"),
    ]);

    return NextResponse.json(
      { signals, timestamp: Date.now() },
      { headers: { "Cache-Control": "public, max-age=10" } }
    );
  } catch (err: any) {
    console.error("[SIGNALS] Error:", err.message);
    return NextResponse.json(
      { error: err.message, signals: [] },
      { status: 500 }
    );
  }
}
