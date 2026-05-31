import { getLatestSignalSnapshots } from "@/lib/persistence";
import type { Signal } from "@/lib/strategy";

export const runtime = "nodejs";

export async function GET() {
  try {
    // PURE PASSTHROUGH: Fetch and return snapshots without any transformation or derivation
    // No state reconstruction, no label generation, no indicator interpretation
    const snapshots = await getLatestSignalSnapshots();

    // Direct mapping - snapshot fields map 1:1 to Signal fields
    // isSetupValid, isSniperCandidate, isSniper come ONLY from engine, never computed here
    // SL/TP/RRR are ONLY populated when isSniper === true, otherwise null
    const signals: Signal[] = snapshots.map((snapshot) => ({
      symbol: snapshot.symbol,
      price: snapshot.price,
      isSetupValid: snapshot.isSetupValid,
      isSniperCandidate: snapshot.isSniperCandidate,
      isSniper: snapshot.isSniper,
      bias: snapshot.bias,
      confidence: snapshot.confidence,
      adx: snapshot.adx,
      stochK: snapshot.stochK,
      stochD: snapshot.stochD,
      reason: snapshot.reason,
      stopLoss: snapshot.stopLoss,
      takeProfit: snapshot.takeProfit,
      riskRewardRatio: snapshot.riskRewardRatio,
      updatedAt: snapshot.updatedAt,
    }));

    // Validation logging at API boundary
    console.log(`[API] ========== EXECUTION GATE VALIDATION ==========`);
    console.log(`[API] Returning ${signals.length} signals from persistence layer`);
    
    // Log full signal objects for critical symbols - check execution gate
    ["BTC", "ETH", "SOL"].forEach((symbolName) => {
      const signal = signals.find((s) => s.symbol === symbolName);
      if (signal) {
        console.log(`[API] ${symbolName}:`);
        console.log(`[API]   Setup: ${signal.isSetupValid}, Candidate: ${signal.isSniperCandidate}, Execution: ${signal.isSniper}`);
        console.log(`[API]   Price: $${signal.price.toFixed(2)}, ADX: ${signal.adx.toFixed(1)}, Bias: ${signal.bias}`);
        if (signal.isSniper) {
          console.log(`[API]   🟢 SNIPER APPROVED - SL: $${signal.stopLoss?.toFixed(2)}, TP: $${signal.takeProfit?.toFixed(2)}, RRR: ${signal.riskRewardRatio}`);
        } else if (signal.isSetupValid) {
          console.log(`[API]   🟡 SETUP ACTIVE - Awaiting trigger (SL/TP: null)`);
        } else {
          console.log(`[API]   ⚪ MONITORING - No setup (SL/TP: null)`);
        }
      } else {
        console.log(`[API] ${symbolName}: NOT IN SNAPSHOTS`);
      }
    });
    
    console.log(`[API] ========== END VALIDATION ==========`);

    return Response.json(
      { signals, updatedAt: new Date().toISOString() },
      {
        headers: {
          "Cache-Control": "public, max-age=5, s-maxage=5",
        },
      }
    );
  } catch (err) {
    console.error(`[API] Error:`, err);
    return Response.json(
      { error: "Failed to fetch signals", signals: [] },
      { status: 500, headers: { "Cache-Control": "no-cache" } }
    );
  }
}
