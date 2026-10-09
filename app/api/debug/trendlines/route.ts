import { NextRequest, NextResponse } from "next/server";
import { getCandles, krakenPairFormat } from "@/lib/kraken";
import { getTrendlineDebug } from "@/lib/strategy";

export const dynamic = "force-dynamic";
export const revalidate = 0;

// Temporary, read-only research endpoint. Never expose it from production.
const ALLOWED_PAIRS = ["BTC", "ETH", "SOL", "HYPE", "DOGE", "LINK", "VIRTUAL", "ZEC"] as const;

export async function GET(request: NextRequest) {
  if (process.env.VERCEL_ENV === "production") {
    return new NextResponse("Not found", { status: 404 });
  }

  const requested = (request.nextUrl.searchParams.get("pairs") ?? "HYPE")
    .split(",")
    .map(x => x.trim().toUpperCase())
    .filter(Boolean);
  const pairs = [...new Set(requested)];
  if (!pairs.length || pairs.some(p => !(ALLOWED_PAIRS as readonly string[]).includes(p))) {
    return NextResponse.json({ error: "Use pairs from the supported market list." }, { status: 400 });
  }
  if (pairs.length > 4) {
    return NextResponse.json({ error: "Request at most four pairs per call." }, { status: 400 });
  }

  const results: Record<string, unknown> = {};
  for (const pair of pairs) {
    try {
      const candles = await getCandles(krakenPairFormat(`${pair}/USD`), 240);
      const debug = getTrendlineDebug(pair, candles, "LONG");
      results[pair] = {
        candleCount: candles.length,
        latestCandle: candles.at(-1) ?? null,
        recentCandles: candles.slice(-80),
        ...debug
      };
    } catch (error) {
      results[pair] = { error: error instanceof Error ? error.message : "Unknown error" };
    }
  }

  return NextResponse.json({
    purpose: "read-only trendline research; preview only",
    generatedAt: new Date().toISOString(),
    results
  }, { headers: { "Cache-Control": "no-store, max-age=0" } });
}
