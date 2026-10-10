import { NextResponse } from "next/server";
import { reconcileSymbolCard, getMarketData, getActiveSignals } from "@/lib/state";
import { runJarvis } from "@/lib/jarvis";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Keep this allowlist aligned with the symbol cards rendered by app/page.tsx.
const PAIRS = new Set(["BTC", "ETH", "SOL", "HYPE", "LINK", "VIRTUAL", "AVAX", "DOGE", "ZEC"]);

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const pair = String(body?.pair || "").toUpperCase();
    if (!PAIRS.has(pair)) return NextResponse.json({ error: "Invalid symbol" }, { status: 400 });

    const result = await reconcileSymbolCard(pair);
    // Refresh the persisted Jarvis snapshot immediately so the card returns to
    // normal scanning state without waiting for the next cron cycle.
    const marketData = await getMarketData();
    const activeSignals = await getActiveSignals();
    await runJarvis(marketData, activeSignals);
    return NextResponse.json({ success: true, ...result, updatedAt: new Date().toISOString() }, {
      headers: { "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate" },
    });
  } catch (error) {
    console.error("[SYMBOL RESET] Failed", error);
    return NextResponse.json({ error: "Symbol reconciliation failed" }, { status: 500 });
  }
}
