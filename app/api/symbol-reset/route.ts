import { NextResponse } from "next/server";
import { reconcileSymbolCard } from "@/lib/state";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PAIRS = new Set(["BTC", "ETH", "SOL", "HYPE"]);

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const pair = String(body?.pair || "").toUpperCase();
    if (!PAIRS.has(pair)) return NextResponse.json({ error: "Invalid symbol" }, { status: 400 });

    const result = await reconcileSymbolCard(pair);
    return NextResponse.json({ success: true, ...result, updatedAt: new Date().toISOString() }, {
      headers: { "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate" },
    });
  } catch (error) {
    console.error("[SYMBOL RESET] Failed", error);
    return NextResponse.json({ error: "Symbol reconciliation failed" }, { status: 500 });
  }
}
