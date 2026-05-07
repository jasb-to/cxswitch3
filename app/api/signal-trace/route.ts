import { NextRequest, NextResponse } from "next/server";
import { traceBuffer, getTraceStats } from "@/lib/signal-trace";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  try {
    const searchParams = new URL(req.url).searchParams;
    const action = searchParams.get("action") || "recent";
    const symbol = searchParams.get("symbol");
    const count = parseInt(searchParams.get("count") || "20", 10);

    let result;

    switch (action) {
      case "recent":
        result = {
          action: "recent",
          traces: traceBuffer.getRecent(count),
          stats: getTraceStats(),
        };
        break;

      case "by-symbol":
        if (!symbol) {
          return NextResponse.json(
            { error: "symbol query parameter required for by-symbol action" },
            { status: 400 }
          );
        }
        result = {
          action: "by-symbol",
          symbol,
          traces: traceBuffer.getBySymbol(symbol, count),
        };
        break;

      case "failures":
        result = {
          action: "failures",
          traces: traceBuffer.getFailures(count),
          stats: getTraceStats(),
        };
        break;

      case "triggered":
        result = {
          action: "triggered",
          traces: traceBuffer.getTriggered(count),
          stats: getTraceStats(),
        };
        break;

      case "stats":
        result = {
          action: "stats",
          stats: getTraceStats(),
        };
        break;

      default:
        return NextResponse.json(
          { error: `Unknown action: ${action}. Use: recent, by-symbol, failures, triggered, stats` },
          { status: 400 }
        );
    }

    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
