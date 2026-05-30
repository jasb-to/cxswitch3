import { getLatestSignalSnapshots } from "@/lib/persistence";
import type { Signal } from "@/lib/strategy";

export const runtime = "nodejs";

export async function GET() {
  try {
    // PURE PASSTHROUGH: Fetch and return snapshots without any transformation or derivation
    // No state reconstruction, no label generation, no indicator interpretation
    const snapshots = await getLatestSignalSnapshots();

    // Direct mapping - snapshot fields map 1:1 to Signal fields
    // isSetupValid and isSniper come ONLY from engine, never computed here
    const signals: Signal[] = snapshots.map((snapshot) => ({
      symbol: snapshot.symbol,
      price: snapshot.price,
      isSetupValid: snapshot.isSetupValid,  // From engine only
      isSniper: snapshot.isSniper,          // From engine only
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
    console.log(`[API] ========== VALIDATION LOG ==========`);
    console.log(`[API] Returning ${signals.length} signals from persistence layer`);
    
    // Log full signal objects for critical symbols
    ["BTC", "ETH", "SOL"].forEach((symbolName) => {
      const signal = signals.find((s) => s.symbol === symbolName);
      if (signal) {
        console.log(`[API] ${symbolName}: {`);
        console.log(`[API]   isSetupValid: ${signal.isSetupValid}`);
        console.log(`[API]   isSniper: ${signal.isSniper}`);
        console.log(`[API]   price: $${signal.price.toFixed(2)}`);
        console.log(`[API]   adx: ${signal.adx.toFixed(1)}`);
        console.log(`[API]   stochK: ${signal.stochK.toFixed(1)}`);
        console.log(`[API]   stochD: ${signal.stochD.toFixed(1)}`);
        console.log(`[API]   bias: ${signal.bias}`);
        console.log(`[API]   confidence: ${signal.confidence}%`);
        console.log(`[API]   stopLoss: $${signal.stopLoss.toFixed(2)}`);
        console.log(`[API]   takeProfit: $${signal.takeProfit.toFixed(2)}`);
        console.log(`[API]   riskRewardRatio: ${signal.riskRewardRatio.toFixed(2)}`);
        console.log(`[API]   reason: ${signal.reason}`);
        console.log(`[API] }`);
      } else {
        console.log(`[API] ${symbolName}: NOT IN SNAPSHOTS`);
      }
    });
    
    console.log(`[API] ========== END VALIDATION LOG ==========`);

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
