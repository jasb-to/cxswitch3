import { evaluate } from "@/lib/engine";
import { placeOrder } from "@/lib/kraken";
import { NextResponse } from "next/server";

const CRON_SECRET = process.env.CRON_SECRET;
const MIN_CONFIDENCE = 60;

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    if (searchParams.get("secret") !== CRON_SECRET) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    console.log("[CRON] Starting execution cycle...");

    const signals = await Promise.all([
      evaluate("BTC"),
      evaluate("ETH"),
      evaluate("SOL"),
    ]);

    const results = [];

    for (const signal of signals) {
      console.log(`[CRON] ${signal.symbol}: state=${signal.state}, confidence=${signal.confidence}%`);

      if (signal.state === "FLAT" || signal.confidence < MIN_CONFIDENCE) {
        results.push({
          symbol: signal.symbol,
          action: "skipped",
          reason: signal.state === "FLAT" ? "no signal" : `confidence ${signal.confidence}% < ${MIN_CONFIDENCE}%`,
        });
        continue;
      }

      try {
        const pair = signal.symbol === "BTC" ? "XXBTZUSD" : signal.symbol === "ETH" ? "XETHZUSD" : "SOLUSD";
        const volume = signal.symbol === "BTC" ? "0.001" : signal.symbol === "ETH" ? "0.01" : "0.1";

        console.log(`[CRON] Executing ${signal.state} on ${signal.symbol} at ${signal.entry}`);

        const order = await placeOrder({
          pair,
          type: signal.state === "LONG" ? "buy" : "sell",
          ordertype: "market",
          volume,
        });

        results.push({
          symbol: signal.symbol,
          action: "executed",
          direction: signal.state,
          entry: signal.entry,
          txid: order.txid,
        });

      } catch (err: any) {
        console.error(`[CRON] Trade failed for ${signal.symbol}:`, err.message);
        results.push({
          symbol: signal.symbol,
          action: "failed",
          error: err.message,
        });
      }
    }

    console.log(`[CRON] Cycle complete: ${results.filter(r => r.action === "executed").length} trades`);

    return NextResponse.json({ results, timestamp: Date.now() });

  } catch (err: any) {
    console.error("[CRON] Fatal error:", err);
    return NextResponse.json({ error: err.message }, { status: 200 });
  }
}
