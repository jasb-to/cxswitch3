import { evaluateSignal } from "@/lib/engine";
import { placeOrder } from "@/lib/kraken";

export const dynamic = "force-dynamic";

const SECRET = process.env.CRON_SECRET;
const MIN_CONFIDENCE = 60;

// Simple in-memory position tracking (restart on deploy)
const positions = new Map<string, boolean>();

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  if (searchParams.get("secret") !== SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }
  
  try {
    const signals = await Promise.all([
      evaluateSignal("BTC"),
      evaluateSignal("ETH"),
      evaluateSignal("SOL"),
    ]);
    
    const results = [];
    
    for (const signal of signals) {
      if (signal.state === "FLAT" || signal.confidence < MIN_CONFIDENCE) {
        results.push({ symbol: signal.symbol, action: "skipped", reason: "below threshold" });
        continue;
      }
      
      // Check if we already have a position
      if (positions.get(signal.symbol)) {
        results.push({ symbol: signal.symbol, action: "skipped", reason: "already positioned" });
        continue;
      }
      
      try {
        const pairMap = {
          BTC: "XXBTZUSD",
          ETH: "XETHZUSD",
          SOL: "SOLUSD",
        };
        
        const volumeMap = {
          BTC: "0.001",
          ETH: "0.01",
          SOL: "0.1",
        };
        
        const order = await placeOrder({
          pair: pairMap[signal.symbol],
          type: signal.state === "LONG" ? "buy" : "sell",
          ordertype: "market",
          volume: volumeMap[signal.symbol],
        });
        
        // Mark position open
        positions.set(signal.symbol, true);
        
        console.log(`[CRON] Trade executed: ${signal.symbol} ${signal.state} @ ${signal.entry}`);
        
        results.push({ symbol: signal.symbol, action: "executed", txid: order.txid });
        
      } catch (err) {
        results.push({ symbol: signal.symbol, action: "failed", error: (err as Error).message });
      }
    }
    
    return Response.json({ results, timestamp: Date.now() });
  } catch (error) {
    console.error("[CRON] Error:", error);
    return Response.json({ error: "Cron execution failed" }, { status: 500 });
  }
}
